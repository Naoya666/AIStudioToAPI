const { fork } = require("node:child_process");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Each attempt owns a separate POSIX process group, including its browser descendants.
class AccountLoginQueue {
    constructor(service, workerPath = path.join(__dirname, "AccountLoginWorker.js")) {
        this.service = service;
        this.workerPath = workerPath;
        this.running = new Map();
        this.faults = new Map();
    }
    start() {
        this.timer = setInterval(
            () =>
                this.tick().catch(() =>
                    this.service.logger.error("[Accounts] Queue persistence or supervision failure")
                ),
            5000
        );
        this.timer.unref();
        return this.tick();
    }
    async tick() {
        if (this.ticking || this.stopped) return;
        this.ticking = true;
        try {
            for (const slot of this.running.values())
                if (performance.now() >= slot.deadline && !slot.finishing)
                    this.finish(slot, { error: "attempt_timeout", retryable: true });
            const recoveredTasks = [];
            for (const slot of this.faults.values()) {
                if (await this.terminate(slot)) {
                    this.faults.delete(slot.token);
                    this.running.delete(slot.taskId);
                    recoveredTasks.push(slot.taskId);
                }
            }
            await this.service.exclusive(async () => {
                for (const id of recoveredTasks) {
                    const task = this.service.state.tasks.find(item => item.taskId === id);
                    if (task) delete task.executor;
                }
                await this.service.scanRecovery();
                const { state } = this.service;
                if (this.service.deduplicating) return;
                for (const task of state.tasks)
                    if (["queued", "retry_wait"].includes(task.status) && task.deadline && task.deadline <= Date.now())
                        this.service.failTask(task, "recovery_deadline");
                await this.service.save();
                if (state.config.paused) return;
                for (const task of state.tasks) {
                    if (this.stopped) break;
                    if (this.running.size >= state.config.concurrency) break;
                    if (!["queued", "retry_wait"].includes(task.status) || task.nextAttemptAt > Date.now()) continue;
                    if (task.deadline && task.deadline <= Date.now()) {
                        this.service.failTask(task, "recovery_deadline");
                        continue;
                    }
                    const account = state.accounts.find(item => item.accountId === task.accountId);
                    if (
                        account &&
                        task.source === "expired" &&
                        account.authIndex !== null &&
                        this.service.system.scheduler?.isAccountManuallyDisabled(account.authIndex)
                    ) {
                        task.status = "cancelled";
                        task.finishedAt = Date.now();
                        account.currentTaskId = null;
                        account.recoveryState = "idle";
                        continue;
                    }
                    if (
                        !account ||
                        account.credentialVersion !== task.credentialVersion ||
                        account.sessionVersion !== task.sessionVersion
                    ) {
                        task.status = "cancelled";
                        continue;
                    }
                    if (
                        ["new", "expired"].includes(task.source) &&
                        (!state.config.autoRecovery || !account.autoRecovery)
                    )
                        continue;
                    const config = { ...state.config };
                    const timeout = Math.min(
                        config.attemptTimeout,
                        task.deadline ? task.deadline - Date.now() : config.recoveryTimeout
                    );
                    if (timeout < Math.min(config.stepTimeout, config.attemptTimeout)) {
                        this.service.failTask(task, "recovery_deadline");
                        continue;
                    }
                    if (this.service.system.browserManager?.benefitCheckingIndices?.has(account.authIndex)) continue;
                    task.deadline ||= Date.now() + config.recoveryTimeout;
                    task.startedAt ||= Date.now();
                    task.attempts++;
                    task.status = "running";
                    task.phase = "browser_launch";
                    account.recoveryState = "running";
                    const token = randomUUID();
                    task.token = token;
                    const slot = {
                        config,
                        deadline: performance.now() + timeout,
                        finishing: false,
                        startedAt: Date.now(),
                        taskId: task.taskId,
                        token,
                    };
                    this.running.set(task.taskId, slot);
                    await this.service.save();
                    if (this.stopped || slot.finishing || task.token !== token || task.status !== "running") {
                        this.running.delete(task.taskId);
                        break;
                    }
                    try {
                        const proxy = this.service.resolveProxy(account);
                        slot.child = fork(this.workerPath, [], {
                            detached: true,
                            execArgv: [...process.execArgv, "--max-http-header-size=65536"],
                            serialization: "advanced",
                            stdio: ["ignore", "ignore", "ignore", "ipc"],
                        });
                        slot.watchdog = setTimeout(
                            () => this.finish(slot, { error: "attempt_timeout", retryable: true }),
                            timeout
                        );
                        slot.watchdog.unref();
                        slot.child.on("message", message => {
                            if (message.token !== token) return;
                            if (message.phase && !slot.finishing)
                                this.service
                                    .exclusive(async () => {
                                        if (task.token === token) {
                                            task.phase = message.phase;
                                            await this.service.save();
                                        }
                                    })
                                    .catch(() => {});
                            if (message.result) this.finish(slot, message.result);
                            if (message.screenshot) slot.screenshot = message.screenshot;
                        });
                        slot.child.on("error", () => this.finish(slot, { error: "browser_exit", retryable: true }));
                        slot.child.on("exit", (code, signal) =>
                            this.finish(slot, {
                                error: "browser_exit",
                                executorExit: { code, signal },
                                retryable: true,
                            })
                        );
                        const stat = await fs.readFile(`/proc/${slot.child.pid}/stat`, "utf8");
                        task.executor = {
                            pid: slot.child.pid,
                            startTime: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
                        };
                        await this.service.save();
                        if (slot.finishing || this.stopped || !slot.child.connected) continue;
                        slot.child.send({
                            config,
                            credentials: {
                                email: account.email,
                                password: account.password,
                                recoveryEmail: account.recoveryEmail,
                                totp: account.totp,
                            },
                            executablePath: this.service.system.browserManager?._getBrowserExecutablePath(),
                            proxy,
                            targetUrl: this.service.system.browserManager?.targetUrl,
                            token,
                        });
                    } catch {
                        this.finish(slot, { error: "proxy_configuration", retryable: false });
                    }
                }
                await this.service.save();
            });
        } finally {
            this.ticking = false;
        }
    }
    async terminate(slot) {
        if (slot.unsafe) {
            try {
                process.kill(-slot.child.pid, 0);
                return false;
            } catch (cause) {
                return cause.code === "ESRCH";
            }
        }
        if (!slot.child) return true;
        const pid = slot.child.pid;
        if (!pid) return true;
        try {
            process.kill(-pid, "SIGKILL");
        } catch (error) {
            if (error.code !== "ESRCH") return false;
        }
        const until = performance.now() + slot.config.cleanupTimeout;
        while (performance.now() < until) {
            try {
                process.kill(-pid, 0);
            } catch (error) {
                if (error.code === "ESRCH") return true;
                return false;
            }
            await wait(50);
        }
        // Container PID 1 may not reap adopted zombies promptly. They cannot
        // execute or hold browser resources, so inspect living group members.
        try {
            for (const entry of await fs.readdir("/proc"))
                if (/^\d+$/.test(entry)) {
                    const stat = await fs.readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
                    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
                    if (Number(fields[2]) === pid && fields[0] !== "Z") return false;
                }
            return slot.child.exitCode !== null || !slot.child.connected;
        } catch {
            return false;
        }
    }
    async recover(task) {
        if (!task.executor) return;
        const { pid, startTime } = task.executor;
        const slot = {
            child: { pid },
            config: this.service.state.config,
            finishing: true,
            taskId: task.taskId,
            token: randomUUID(),
        };
        try {
            const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
            if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] !== startTime) slot.unsafe = true;
        } catch (cause) {
            if (cause.code === "ENOENT") {
                try {
                    process.kill(-pid, 0);
                } catch (error) {
                    if (error.code === "ESRCH") {
                        delete task.executor;
                        return;
                    }
                }
            }
            slot.unsafe = true;
        }
        if (await this.terminate(slot)) {
            delete task.executor;
            return;
        }
        this.faults.set(slot.token, slot);
        this.running.set(slot.taskId, slot);
        if (task.status !== "cancelled") this.service.failTask(task, "executor_cleanup_failed");
    }
    async finish(slot, result) {
        if (slot.finishing) return slot.done;
        slot.finishing = true;
        clearTimeout(slot.watchdog);
        slot.done = (async () => {
            // Revoke success permission synchronously, before diagnostic work.
            const task = this.service.state.tasks.find(item => item.taskId === slot.taskId);
            const authorized = task?.token === slot.token && performance.now() < slot.deadline && !result.error;
            if (task?.token === slot.token) task.token = null;
            if (result.error && result.error !== "cancelled" && slot.child?.connected && !slot.screenshot) {
                slot.child.send({ abort: true, token: slot.token });
                const until = performance.now() + slot.config.screenshotTimeout;
                while (!slot.screenshot && slot.child.exitCode === null && performance.now() < until) await wait(50);
            }
            if (!(await this.terminate(slot))) {
                slot.cleanupFailed = true;
                this.service.logger.error(
                    `[Accounts] Executor cleanup unconfirmed for task ${slot.taskId}; slot quarantined`
                );
                this.faults.set(slot.token, slot);
                result = { error: "executor_cleanup_failed", retryable: false };
            } else this.running.delete(slot.taskId);
            await this.service.exclusive(async () => {
                await this.service.completeAttempt(
                    slot,
                    authorized
                        ? result
                        : { ...result, error: result.error || "stale_execution", storageState: undefined }
                );
            });
            if (!this.stopped) setImmediate(() => this.tick().catch(() => {}));
        })().catch(() => {
            this.faults.set(slot.token, slot);
            this.service.logger.error("[Accounts] Attempt completion failed; executor slot retained for supervision");
        });
        return slot.done;
    }
    async cancel(taskId) {
        const slot = this.running.get(taskId);
        if (slot) await this.finish(slot, { error: "cancelled", retryable: false });
    }
    snapshot() {
        return {
            ...this.service.state.config,
            configurationVersion: this.service.system.configurationService?.document.version,
            executions: [...this.running.values()].map(slot => {
                const task = this.service.state.tasks.find(item => item.taskId === slot.taskId);
                return {
                    accountId: task?.accountId,
                    attempts: task?.attempts,
                    elapsedMs: slot.startedAt ? Date.now() - slot.startedAt : null,
                    fault: this.faults.has(slot.token),
                    phase: task?.phase,
                    taskId: slot.taskId,
                };
            }),
            faultSlots: this.faults.size,
            queued: this.service.state.tasks.filter(task => task.status === "queued").length,
            retryWait: this.service.state.tasks.filter(task => task.status === "retry_wait").length,
            running: this.running.size,
            source: this.service.state.configSource,
        };
    }
    async close() {
        this.stopped = true;
        clearInterval(this.timer);
        await Promise.all(
            [...this.running.values()].map(slot => this.finish(slot, { error: "interrupted", retryable: true }))
        );
    }
}
module.exports = AccountLoginQueue;
