const { fork } = require("node:child_process");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Each reusable executor owns a separate POSIX process group, including its browser descendants.
class AccountLoginQueue {
    constructor(service, workerPath = path.join(__dirname, "AccountLoginWorker.js")) {
        this.service = service;
        this.workerPath = workerPath;
        this.running = new Map();
        this.faults = new Map();
        this.executors = new Map();
        this.metrics = {
            attemptDurationMs: 0,
            browserStarts: 0,
            browserStartupMs: 0,
            cleanupDurationMs: 0,
            cleanupFailures: 0,
            completedAttempts: 0,
            retirements: {},
            reusedAttempts: 0,
        };
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
    tick() {
        if (this.stopped) return Promise.resolve();
        this.tickAgain = true;
        if (!this.tickTask) {
            this.tickTask = Promise.resolve()
                .then(async () => {
                    do {
                        this.tickAgain = false;
                        await this.runTick();
                    } while (this.tickAgain && !this.stopped);
                })
                .finally(() => {
                    this.tickTask = null;
                });
        }
        return this.tickTask;
    }
    async runTick() {
        if (this.ticking || this.stopped) return;
        this.ticking = true;
        try {
            for (const slot of this.running.values())
                if (performance.now() >= slot.deadline && !slot.finishing)
                    this.finish(slot, { error: "attempt_timeout", retryable: true });
            // Retiring slots continue to count against capacity until their
            // process group is confirmed dead. Idle slots are trimmed on hot changes.
            let retainedIdle = Math.max(0, this.service.state.config.concurrency - this.running.size);
            for (const executor of this.executors.values()) {
                if (executor.state !== "IDLE") continue;
                const reason = this.rotationReason(executor) || (retainedIdle-- <= 0 ? "concurrency_reduced" : null);
                if (reason) await this.retire(executor, reason);
            }
            const recoveredTasks = [];
            for (const slot of this.faults.values()) {
                if (await this.terminate(slot)) {
                    this.faults.delete(slot.token);
                    this.running.delete(slot.taskId);
                    recoveredTasks.push(slot.taskId);
                    if (slot.executor) this.removeExecutor(slot.executor);
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
                    if (
                        ![...this.executors.values()].some(executor => executor.state === "IDLE") &&
                        this.executors.size + [...this.faults.values()].filter(slot => !slot.executor).length >=
                            state.config.concurrency
                    )
                        break;
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
                    // A hot change or age limit can arrive while this tick is
                    // waiting on storage. Recheck at the actual admission point.
                    let availableExecutor;
                    for (const candidate of this.executors.values()) {
                        if (candidate.state !== "IDLE") continue;
                        const reason = this.rotationReason(candidate);
                        if (reason) await this.retire(candidate, reason);
                        else {
                            availableExecutor = candidate;
                            break;
                        }
                    }
                    if (
                        !availableExecutor &&
                        this.executors.size + [...this.faults.values()].filter(slot => !slot.executor).length >=
                            config.concurrency
                    )
                        break;
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
                        const executablePath = this.service.system.browserManager?._getBrowserExecutablePath();
                        const executor = availableExecutor || (await this.createExecutor(config, executablePath));
                        slot.executor = executor;
                        slot.child = executor.child;
                        clearTimeout(executor.idleTimer);
                        executor.idleSince = null;
                        executor.state = "BUSY";
                        executor.slot = slot;
                        executor.attempts++;
                        executor.record.taskId = task.taskId;
                        if (executor.attempts > 1) this.metrics.reusedAttempts++;
                        task.executor = { ...executor.record };
                        slot.watchdog = setTimeout(
                            () => this.finish(slot, { error: "attempt_timeout", retryable: true }),
                            Math.max(1, slot.deadline - performance.now())
                        );
                        slot.watchdog.unref();
                        await this.service.save();
                        if (slot.finishing || this.stopped || !slot.child.connected) {
                            this.finish(slot, { error: "browser_exit", retryable: true });
                            continue;
                        }
                        slot.child.send({
                            config: { ...config, attemptTimeout: Math.max(1, slot.deadline - performance.now()) },
                            credentials: {
                                email: account.email,
                                password: account.password,
                                recoveryEmail: account.recoveryEmail,
                                totp: account.totp,
                            },
                            executablePath,
                            executorId: executor.id,
                            proxy,
                            targetUrl: this.service.system.browserManager?.targetUrl,
                            taskId: task.taskId,
                            token,
                        });
                    } catch {
                        this.finish(slot, {
                            error: slot.child ? "browser_exit" : "proxy_configuration",
                            retryable: !!slot.child,
                        });
                    }
                }
                await this.service.save();
            });
        } finally {
            this.ticking = false;
        }
    }
    rotationReason(executor) {
        const config = this.service.state.config;
        if (executor.broken) return "browser_exit";
        if (!config.browserReuse) return "reuse_disabled";
        if (executor.attempts >= config.browserMaxAttempts) return "max_attempts";
        if (Date.now() - executor.createdAt >= config.browserMaxAge) return "max_age";
        if (executor.executablePath !== this.service.system.browserManager?._getBrowserExecutablePath())
            return "executable_changed";
        if (executor.idleSince && Date.now() - executor.idleSince >= config.browserIdleTimeout) return "idle_timeout";
        return null;
    }
    async createExecutor(config, executablePath) {
        const executor = {
            attempts: 0,
            config,
            createdAt: Date.now(),
            executablePath,
            id: randomUUID(),
            state: "STARTING",
        };
        const child = fork(this.workerPath, [], {
            detached: true,
            execArgv: [...process.execArgv, "--max-http-header-size=65536"],
            serialization: "advanced",
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        executor.child = child;
        this.executors.set(executor.id, executor);
        child.on("message", message => this.onMessage(executor, message));
        const exited = () => {
            executor.broken = true;
            if (executor.state === "RETIRING" || executor.state === "QUARANTINED") return;
            if (executor.slot) this.finish(executor.slot, { error: "browser_exit", retryable: true });
            else this.service.exclusive(() => this.retire(executor, "browser_exit")).catch(() => {});
        };
        child.on("error", exited);
        child.on("exit", exited);
        try {
            const [stat, bootId] = await Promise.all([
                fs.readFile(`/proc/${child.pid}/stat`, "utf8"),
                fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
            ]);
            executor.record = {
                bootId: bootId.trim(),
                executorId: executor.id,
                pid: child.pid,
                startTime: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
            };
            (this.service.state.executors ||= []).push(executor.record);
            await this.service.save();
            return executor;
        } catch (cause) {
            await this.retire(executor, "startup_failed");
            throw cause;
        }
    }
    onMessage(executor, message) {
        if (message.executorId !== executor.id || !this.executors.has(executor.id)) return;
        const slot = executor.slot;
        if (message.browserDisconnected) {
            if (["RETIRING", "QUARANTINED"].includes(executor.state)) return;
            if (slot && (message.token !== slot.token || message.taskId !== slot.taskId)) return;
            executor.broken = true;
            if (slot) this.finish(slot, { error: "browser_exit", retryable: true });
            else this.service.exclusive(() => this.retire(executor, "browser_disconnected")).catch(() => {});
            return;
        }
        if (!slot || message.token !== slot.token || message.taskId !== slot.taskId) return;
        if (message.screenshot) slot.screenshot = message.screenshot;
        if (slot.finishing) return;
        if (message.protocolError) {
            this.finish(slot, { error: "browser_failure", retryable: true });
            return;
        }
        if (message.browserStarted) {
            this.metrics.browserStarts++;
            this.metrics.browserStartupMs += Date.now() - executor.createdAt;
            this.service.logger.info(`[Accounts] Login browser started executor=${executor.id}`);
        }
        if (message.phase)
            this.service
                .exclusive(async () => {
                    const task = this.service.state.tasks.find(item => item.taskId === slot.taskId);
                    if (task?.token === slot.token) {
                        task.phase = message.phase;
                        await this.service.save();
                    }
                })
                .catch(() => {});
        if (message.result && !slot.result) {
            slot.result = message.result;
            slot.cleanupStartedAt = Date.now();
            executor.state = "CLEANING";
            slot.cleanupWatchdog = setTimeout(
                () => this.finish(slot, { error: "executor_cleanup_failed" }),
                slot.config.cleanupTimeout
            );
            slot.cleanupWatchdog.unref();
        }
        if (message.cleanupFailed) this.finish(slot, { error: "executor_cleanup_failed" });
        if (message.cleaned && slot.result) {
            slot.resourcesCleaned = true;
            const businessFailures = [
                "wrong_password",
                "account_not_found",
                "account_disabled",
                "login_rejected",
                "manual_challenge",
                "credentials_missing",
                "password_change_required",
                "recovery_email_missing",
                "recovery_email_rejected",
                "service_region_restricted",
                "service_permission_required",
                "service_target_missing",
                "terms_or_consent_required",
                "totp_challenge_limit",
                "totp_rejected",
                "unknown_page",
                "workspace_sso_or_unknown_challenge",
                "account_mismatch",
                "account_identity_unverified",
                "network_timeout",
            ];
            this.finish(slot, slot.result, !slot.result.error || businessFailures.includes(slot.result.error));
        }
    }
    removeExecutor(executor) {
        clearTimeout(executor.idleTimer);
        this.executors.delete(executor.id);
        this.service.state.executors = (this.service.state.executors || []).filter(
            record => record.executorId !== executor.id
        );
        for (const task of this.service.state.tasks)
            if (task.executor?.executorId === executor.id) delete task.executor;
    }
    async retire(executor, reason) {
        if (executor.retirement) return executor.retirement;
        const graceful = executor.state === "IDLE" || executor.slot?.resourcesCleaned;
        executor.state = "RETIRING";
        clearTimeout(executor.idleTimer);
        this.metrics.retirements[reason] = (this.metrics.retirements[reason] || 0) + 1;
        this.service.logger.info(
            `[Accounts] Login browser retiring executor=${executor.id} attempts=${executor.attempts} reason=${reason}`
        );
        executor.retirement = (async () => {
            const owner = executor.slot || {
                child: executor.child,
                config: executor.config,
                executor,
                finishing: true,
                taskId: `executor:${executor.id}`,
                token: executor.id,
            };
            const deadline = performance.now() + owner.config.cleanupTimeout;
            if (graceful && executor.child.connected && !owner.unsafe) {
                // Let Playwright remove temporary profiles on normal retirement.
                // Always verify the complete process group afterward.
                await new Promise(resolve => {
                    const done = () => {
                        clearTimeout(timer);
                        executor.child.removeListener("exit", done);
                        resolve();
                    };
                    const timer = setTimeout(done, Math.min(1000, owner.config.cleanupTimeout / 2));
                    executor.child.once("exit", done);
                    try {
                        executor.child.send({ executorId: executor.id, shutdown: true }, error => {
                            if (error) done();
                        });
                    } catch {
                        done(); // A closed IPC channel must not bypass process-group cleanup.
                    }
                });
            }
            if (
                await this.terminate({
                    ...owner,
                    config: { ...owner.config, cleanupTimeout: Math.max(1, deadline - performance.now()) },
                })
            ) {
                this.removeExecutor(executor);
                return true;
            }
            executor.state = "QUARANTINED";
            this.faults.set(owner.token, owner);
            this.service.logger.error("[Accounts] Idle executor cleanup unconfirmed; slot quarantined");
            return false;
        })();
        const result = await executor.retirement;
        await this.service.save();
        return result;
    }
    async releaseExecutor(executor) {
        executor.slot = null;
        delete executor.record.taskId;
        executor.state = "IDLE";
        executor.idleSince = Date.now();
        const reason = this.stopped ? "shutdown" : executor.broken ? "browser_exit" : this.rotationReason(executor);
        if (reason) return this.retire(executor, reason);
        this.scheduleIdle(executor);
        return true;
    }
    scheduleIdle(executor) {
        const config = this.service.state.config;
        executor.idleTimer = setTimeout(
            () => {
                this.service
                    .exclusive(async () => {
                        if (executor.state !== "IDLE" || this.executors.get(executor.id) !== executor) return;
                        const reason = this.rotationReason(executor);
                        if (reason) await this.retire(executor, reason);
                        else this.scheduleIdle(executor);
                    })
                    .catch(() => {});
            },
            Math.max(
                1,
                Math.min(
                    config.browserIdleTimeout - (Date.now() - executor.idleSince),
                    config.browserMaxAge - (Date.now() - executor.createdAt)
                )
            )
        );
        executor.idleTimer.unref();
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
        const { pid, startTime, bootId } = task.executor;
        const slot = {
            child: { pid },
            config: this.service.state.config,
            finishing: true,
            taskId: task.executor.taskId || task.taskId,
            token: randomUUID(),
        };
        try {
            const [stat, currentBootId] = await Promise.all([
                fs.readFile(`/proc/${pid}/stat`, "utf8"),
                bootId ? fs.readFile("/proc/sys/kernel/random/boot_id", "utf8") : Promise.resolve(null),
            ]);
            if (
                stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] !== startTime ||
                (bootId && bootId !== currentBootId.trim())
            )
                slot.unsafe = true;
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
        if (task.executor.executorId) {
            slot.executor = {
                child: slot.child,
                config: slot.config,
                id: task.executor.executorId,
                slot,
                state: "QUARANTINED",
            };
            this.executors.set(slot.executor.id, slot.executor);
        }
        if (await this.terminate(slot)) {
            if (slot.executor) this.removeExecutor(slot.executor);
            delete task.executor;
            return;
        }
        this.faults.set(slot.token, slot);
        this.running.set(slot.taskId, slot);
        const activeTask = this.service.state.tasks.find(item => item.taskId === slot.taskId);
        if (activeTask && ["running", "queued", "retry_wait"].includes(activeTask.status))
            this.service.failTask(activeTask, "executor_cleanup_failed");
    }
    async finish(slot, result, cleaned = false) {
        if (slot.finishing) return slot.done;
        slot.finishing = true;
        if (result.error === "executor_cleanup_failed") this.metrics.cleanupFailures++;
        clearTimeout(slot.watchdog);
        clearTimeout(slot.cleanupWatchdog);
        slot.done = (async () => {
            // Revoke success permission synchronously, before diagnostic work.
            const task = this.service.state.tasks.find(item => item.taskId === slot.taskId);
            const authorized = task?.token === slot.token && performance.now() < slot.deadline && !result.error;
            if (task?.token === slot.token) task.token = null;
            if (!cleaned && result.error && result.error !== "cancelled" && slot.child?.connected && !slot.screenshot) {
                slot.child.send({ abort: true, executorId: slot.executor?.id, taskId: slot.taskId, token: slot.token });
                const until = performance.now() + slot.config.screenshotTimeout;
                while (!slot.screenshot && slot.child.exitCode === null && performance.now() < until) await wait(50);
            }
            let reclaimed = cleaned;
            if (!cleaned) {
                reclaimed = slot.executor
                    ? await this.retire(slot.executor, result.error || "attempt_complete")
                    : await this.terminate(slot);
            }
            if (
                cleaned &&
                slot.executor &&
                (this.stopped || slot.executor.broken || this.rotationReason(slot.executor))
            ) {
                reclaimed = await this.retire(
                    slot.executor,
                    this.stopped
                        ? "shutdown"
                        : slot.executor.broken
                          ? "browser_exit"
                          : this.rotationReason(slot.executor)
                );
                cleaned = false;
            }
            if (!reclaimed) {
                slot.cleanupFailed = true;
                if (slot.executor) slot.executor.state = "QUARANTINED";
                if (result.error !== "executor_cleanup_failed") this.metrics.cleanupFailures++;
                this.service.logger.error(
                    `[Accounts] Executor cleanup unconfirmed for task ${slot.taskId}; slot quarantined`
                );
                this.faults.set(slot.token, slot);
                result = { error: "executor_cleanup_failed", retryable: false };
            }
            if (reclaimed && !cleaned) this.running.delete(slot.taskId);
            await this.service.exclusive(async () => {
                await this.service.completeAttempt(
                    slot,
                    authorized
                        ? result
                        : { ...result, error: result.error || "stale_execution", storageState: undefined }
                );
                if (reclaimed) {
                    if (cleaned && slot.executor) await this.releaseExecutor(slot.executor);
                    this.running.delete(slot.taskId);
                    await this.service.save();
                }
            });
            const durationMs = Date.now() - slot.startedAt;
            const cleanupMs = slot.cleanupStartedAt ? Date.now() - slot.cleanupStartedAt : 0;
            this.metrics.completedAttempts++;
            this.metrics.attemptDurationMs += durationMs;
            this.metrics.cleanupDurationMs += cleanupMs;
            this.service.logger.info(
                `[Accounts] Login attempt finished duration_ms=${durationMs} cleanup_ms=${cleanupMs} reusable=${cleaned} error=${result.error || "none"}`
            );
            if (!this.stopped) setImmediate(() => this.tick().catch(() => {}));
        })().catch(async () => {
            // A persistence/commit failure must never leave an unowned reusable browser.
            if (slot.executor) slot.executor.state = "QUARANTINED";
            await this.terminate(slot);
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
            browserMetrics: this.metrics,
            browsers: [...this.executors.values()].map(executor => ({
                ageMs: executor.createdAt ? Date.now() - executor.createdAt : null,
                attempts: executor.attempts,
                executorId: executor.id,
                pid: executor.child.pid,
                state: executor.state,
            })),
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
        await this.tickTask?.catch(() => {});
        await Promise.all(
            [...this.running.values()].map(slot => this.finish(slot, { error: "interrupted", retryable: true }))
        );
        // Cleanup must also work when persistence has failed and exclusive()
        // rejects new work. Retire every process before propagating save errors.
        const retired = await Promise.allSettled(
            [...this.executors.values()].map(executor => this.retire(executor, "shutdown"))
        );
        const failure = retired.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
    }
}
module.exports = AccountLoginQueue;
