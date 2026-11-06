const fs = require("node:fs/promises");
const path = require("node:path");

const read = async (file, readFile) => {
    try {
        return (await readFile(file, "utf8")).trim();
    } catch {
        return null;
    }
};
const bytes = value => {
    if (!value || !/^\d+$/.test(value)) return null;
    const result = Number(value);
    return Number.isSafeInteger(result) && result >= 0 ? result : null;
};
const unescapePath = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

// Resolve this process's actual cgroup through mountinfo; never substitute host RAM.
async function cgroupMemory(readFile = fs.readFile) {
    const [membership, mounts] = await Promise.all([
        read("/proc/self/cgroup", readFile),
        read("/proc/self/mountinfo", readFile),
    ]);
    if (!membership || !mounts) return null;
    for (const version of [2, 1]) {
        const member = membership.split("\n").find(line => {
            const fields = line.split(":");
            return version === 2 ? fields[0] === "0" && fields[1] === "" : fields[1]?.split(",").includes("memory");
        });
        if (!member) continue;
        const group = member.slice(member.indexOf(":", member.indexOf(":") + 1) + 1);
        for (const line of mounts.split("\n")) {
            const [left, right] = line.split(" - ");
            const fields = left.split(" ");
            const mount = right?.split(" ");
            if (mount?.[0] !== (version === 2 ? "cgroup2" : "cgroup")) continue;
            if (version === 1 && !mount[2]?.split(",").includes("memory")) continue;
            const root = unescapePath(fields[3]);
            if (group !== root && !group.startsWith(root === "/" ? "/" : `${root}/`)) continue;
            const directory = path.join(unescapePath(fields[4]), path.relative(root, group));
            const [used, limit] = await Promise.all([
                read(path.join(directory, version === 2 ? "memory.current" : "memory.usage_in_bytes"), readFile),
                read(path.join(directory, version === 2 ? "memory.max" : "memory.limit_in_bytes"), readFile),
            ]);
            const usedBytes = bytes(used);
            if (usedBytes === null) continue;
            // v1 represents unlimited using a sentinel near LONG_MAX.
            const limitBytes = bytes(limit);
            return {
                limitBytes: limitBytes > 0 && limitBytes < 2 ** 60 ? limitBytes : null,
                limitKnown: limit === "max" || (limit !== null && /^\d+$/.test(limit) && Number(limit) > 0),
                scope: "cgroup",
                usedBytes,
                version,
            };
        }
    }
    return null;
}

async function runtimeStatus(system) {
    const manager = system.browserManager;
    const pool = manager?.getContextInitHealth?.() || null;
    const backend = system.config.callBackend || "browser";
    const engine = backend === "local" ? manager?.engine?.health?.() : null;
    const connected = backend === "local" ? !!engine?.ready : !!manager?.browser?.isConnected?.();
    const recovering = !!pool?.recovering;
    return {
        application: {
            pid: process.pid,
            restartAvailable: typeof process.send === "function",
            restarting: system.restarting === true,
            rssBytes: process.memoryUsage().rss,
            state: system.restarting ? "restarting" : system.ready ? "running" : "starting",
            uptimeSeconds: process.uptime(),
        },
        backend: {
            kind: backend,
            recoveryAttempts: pool?.recoveryAttempts ?? null,
            restarts: engine?.restarts ?? null,
            state: recovering
                ? "recovering"
                : !connected
                  ? "stopped"
                  : pool?.staleInitializing > 0
                    ? "degraded"
                    : pool?.ready === 0
                      ? "starting"
                      : "running",
        },
        contextPool: pool
            ? { initializing: pool.initializing, ready: pool.ready, staleInitializing: pool.staleInitializing }
            : null,
        memory: await cgroupMemory(),
        sampledAt: new Date().toISOString(),
        scheduler: system.scheduler
            ? {
                  active: system.scheduler.workers.filter(worker => worker.lease).length,
                  queued: system.scheduler.pending.length,
                  state: system.restarting ? "restarting" : "running",
              }
            : null,
    };
}

module.exports = { cgroupMemory, runtimeStatus };
