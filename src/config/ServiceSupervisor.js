const { fork } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { atomicWrite, storagePath } = require("./ConfigurationService");

// Playwright launches detached browser groups. Remember descendants while their
// parent still exists, and verify start time before signalling a possibly reused PID.
function processInfo(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
        return { parent: Number(fields[1]), start: fields[19] };
    } catch {
        return null;
    }
}
function collectDescendants(owner) {
    if (process.platform !== "linux") return;
    const entries = new Map();
    for (const name of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        const info = processInfo(name);
        if (info) entries.set(Number(name), info);
    }
    const parents = new Set();
    if (processInfo(owner.child.pid)?.start === owner.start) parents.add(owner.child.pid);
    for (const [pid, start] of owner.descendants) if (processInfo(pid)?.start === start) parents.add(pid);
    let changed = true;
    while (changed) {
        changed = false;
        for (const [pid, info] of entries) {
            if (!parents.has(info.parent) || parents.has(pid)) continue;
            parents.add(pid);
            owner.descendants.set(pid, info.start);
            changed = true;
        }
    }
}
function terminate(owner) {
    collectDescendants(owner);
    for (const [pid, start] of owner.descendants) {
        if (processInfo(pid)?.start !== start) continue;
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            /* Already exited. */
        }
    }
    try {
        if (process.platform !== "win32") process.kill(-owner.child.pid, "SIGKILL");
        else owner.child.kill("SIGKILL");
    } catch (error) {
        if (error.code !== "ESRCH") console.error("Failed to terminate service process group:", error.message);
    }
}

function supervise(entry) {
    const data = path.dirname(storagePath());
    const goodPath = path.join(data, "managed-config.last-good.json");
    const errorPath = path.join(data, "restart-status.json");
    let current,
        stopping = false,
        automaticRestarts = 0;
    const sessionSecret = crypto.randomBytes(32).toString("hex");
    const recordError = error => atomicWrite(errorPath, { error, failedAt: new Date().toISOString() });
    const launch = (recovery, runtimeRecovery = false) => {
        const child = fork(entry, [], {
            detached: process.platform !== "win32",
            env: {
                ...process.env,
                AISTUDIO_CONFIG_RECOVERY: recovery ? "1" : "0",
                AISTUDIO_SERVICE_CHILD: "1",
                AISTUDIO_SESSION_SECRET: sessionSecret,
            },
            stdio: ["inherit", "inherit", "inherit", "ipc"],
        });
        const owner = {
            child,
            descendants: new Map(),
            healthy: false,
            lastProgress: Date.now(),
            lastReply: Date.now(),
            policy: {
                browserRecoveryStableMs: 300000,
                contextInitTotalTimeoutMs: 180000,
                supervisorHeartbeatMs: 5000,
                supervisorMaxRestarts: 3,
                supervisorShutdownMs: 45000,
                supervisorTimeoutMs: 60000,
            },
            recovery,
            sequence: 0,
            start: processInfo(child.pid)?.start,
        };
        current = owner;
        const send = message => {
            if (child.connected) child.send(message, () => {});
        };
        const stop = reason => {
            if (owner.restart || stopping || current !== owner) return;
            collectDescendants(owner);
            owner.restart = reason;
            if (reason === "runtime") recordError("运行健康检查失败，正在恢复应用");
            send({ type: "shutdown" });
            owner.killTimer = setTimeout(() => terminate(owner), owner.policy.supervisorShutdownMs);
        };
        owner.bootTimer = setTimeout(() => {
            recordError("服务启动超时");
            terminate(owner);
        }, 300000);
        owner.watchTimer = setInterval(() => {
            if (current !== owner || stopping) return;
            collectDescendants(owner);
            if (!owner.healthy || owner.restart || !owner.watchEnabled) return;
            const now = Date.now();
            if (
                now - owner.lastReply >= owner.policy.supervisorTimeoutMs ||
                (owner.healthEndpoint && now - owner.lastHttpReply >= owner.policy.supervisorTimeoutMs)
            ) {
                stop("runtime");
                return;
            }
            if (
                owner.waiting &&
                now - owner.lastProgress >=
                    Math.max(owner.policy.supervisorTimeoutMs, owner.policy.contextInitTotalTimeoutMs * 2)
            ) {
                stop("runtime");
                return;
            }
            if (!owner.waiting && now - owner.readyAt >= owner.policy.browserRecoveryStableMs) automaticRestarts = 0;
            if (now - (owner.lastProbe || 0) >= owner.policy.supervisorHeartbeatMs) {
                owner.lastProbe = now;
                send({ sequence: ++owner.sequence, type: "health-probe" });
                if (owner.healthEndpoint && !owner.httpProbe) {
                    const request = http.get(
                        {
                            agent: false,
                            hostname: owner.healthEndpoint.host,
                            path: "/livez",
                            port: owner.healthEndpoint.port,
                        },
                        response => {
                            response.resume();
                            if (response.statusCode === 200 && current === owner) owner.lastHttpReply = Date.now();
                        }
                    );
                    owner.httpProbe = request;
                    request.setTimeout(Math.min(5000, owner.policy.supervisorTimeoutMs), () => request.destroy());
                    request.on("error", () => {});
                    request.on("close", () => {
                        if (owner.httpProbe === request) owner.httpProbe = null;
                    });
                }
            }
        }, 1000);
        child.on("message", message => {
            if (current !== owner || stopping) return;
            if (message?.type === "supervision-policy") {
                // Sent by the child after loading validated managed configuration.
                for (const key of Object.keys(owner.policy)) {
                    if (Number.isSafeInteger(message.policy?.[key]) && message.policy[key] > 0)
                        owner.policy[key] = message.policy[key];
                }
                owner.watchEnabled = true;
            }
            if (message?.type === "ready") {
                owner.healthy = true;
                owner.readyAt = owner.lastReply = owner.lastProgress = owner.lastHttpReply = Date.now();
                if (
                    typeof message.healthEndpoint?.host === "string" &&
                    Number.isInteger(message.healthEndpoint.port) &&
                    message.healthEndpoint.port > 0 &&
                    message.healthEndpoint.port <= 65535
                )
                    owner.healthEndpoint = message.healthEndpoint;
                clearTimeout(owner.bootTimer);
                atomicWrite(goodPath, message.configuration);
                if (!recovery || runtimeRecovery) atomicWrite(errorPath, { error: null });
            }
            if (message?.type === "health-reply" && message.sequence === owner.sequence && !owner.restart) {
                owner.lastReply = Date.now();
                const progress = `${message.progress?.completed || 0}:${message.progress?.ready || 0}:${message.progress?.generation || 0}`;
                if (progress !== owner.progressKey) {
                    owner.progressKey = progress;
                    owner.lastProgress = Date.now();
                }
                owner.waiting = Boolean(message.progress?.pending && !message.progress?.ready);
            }
            if (message?.type === "configuration-applied" && owner.healthy && !owner.restart)
                atomicWrite(goodPath, message.configuration);
            if (message?.type === "startup-error") recordError(message.error);
            if (message?.type === "runtime-recovery" && owner.healthy) stop("runtime");
            if (message?.type === "restart" && !owner.restart) {
                if (message.configuration && owner.healthy) atomicWrite(goodPath, message.configuration);
                stop("manual");
            }
        });
        child.once("exit", code => {
            clearTimeout(owner.bootTimer);
            clearTimeout(owner.killTimer);
            clearInterval(owner.watchTimer);
            owner.httpProbe?.destroy();
            terminate(owner);
            if (stopping) {
                process.exit(code || 0);
                return;
            }
            if (owner.restart === "manual") {
                launch(false);
                return;
            }
            if (owner.restart === "runtime" || owner.healthy) {
                if (++automaticRestarts > owner.policy.supervisorMaxRestarts) {
                    recordError("应用自动恢复预算耗尽，停止自动重启");
                    console.error("Application recovery budget exhausted; waiting for an operator restart.");
                    // Stay alive so Docker restart policies cannot turn this budget into an endless loop.
                    owner.exhaustedTimer = setInterval(() => {}, 60000);
                    return;
                }
                const delay = Math.min(60000, 1000 * 2 ** (automaticRestarts - 1));
                setTimeout(() => {
                    if (!stopping) launch(true, true);
                }, delay);
                return;
            }
            if (code !== 0 && fs.existsSync(goodPath) && !recovery) {
                console.error("Service startup failed; restoring last usable configuration once.");
                launch(true);
                return;
            }
            process.exit(code || 0);
        });
    };
    for (const signal of ["SIGTERM", "SIGINT"])
        process.on(signal, () => {
            if (stopping) return;
            stopping = true;
            const owner = current;
            if (owner.child.exitCode !== null || owner.child.signalCode !== null) {
                process.exit(0);
                return;
            }
            collectDescendants(owner);
            owner.child.kill(signal);
            owner.killTimer = setTimeout(() => terminate(owner), owner.policy.supervisorShutdownMs);
        });
    launch(false);
}
module.exports = { supervise };
