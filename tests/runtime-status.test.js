const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cgroupMemory, runtimeStatus } = require("../src/utils/RuntimeStatus");
const fixture = files => async file => {
    if (!(file in files)) throw new Error("ENOENT");
    return files[file];
};

test("cgroup v2 resolves a nested group relative to the mount root", async () => {
    const memory = await cgroupMemory(
        fixture({
            "/proc/self/cgroup": "0::/docker/app/worker",
            "/proc/self/mountinfo": "23 22 0:20 /docker/app /sys/fs/cgroup rw - cgroup2 cgroup rw",
            "/sys/fs/cgroup/worker/memory.current": "104857600\n",
            "/sys/fs/cgroup/worker/memory.max": "536870912\n",
        })
    );
    assert.deepEqual(memory, {
        limitBytes: 536870912,
        limitKnown: true,
        scope: "cgroup",
        usedBytes: 104857600,
        version: 2,
    });
});

test("namespace root supports unlimited v2 memory without inventing a denominator", async () => {
    const memory = await cgroupMemory(
        fixture({
            "/proc/self/cgroup": "0::/",
            "/proc/self/mountinfo": "23 22 0:20 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
            "/sys/fs/cgroup/memory.current": "0",
            "/sys/fs/cgroup/memory.max": "max",
        })
    );
    assert.equal(memory.usedBytes, 0);
    assert.equal(memory.limitBytes, null);
});

test("v1 memory controller handles escaped mounts and unlimited sentinel", async () => {
    const memory = await cgroupMemory(
        fixture({
            "/proc/self/cgroup": "5:cpu:/host\n6:memory:/app",
            "/proc/self/mountinfo": "23 22 0:20 / /sys/fs/cgroup/memory\\040group rw - cgroup cgroup rw,memory",
            "/sys/fs/cgroup/memory group/app/memory.limit_in_bytes": "9223372036854771712",
            "/sys/fs/cgroup/memory group/app/memory.usage_in_bytes": "2048",
        })
    );
    assert.equal(memory.usedBytes, 2048);
    assert.equal(memory.limitBytes, null);
    assert.equal(memory.version, 1);
});

test("unreadable, malformed or unrelated groups do not fall back to host memory", async () => {
    assert.equal(await cgroupMemory(fixture({})), null);
    for (const group of ["/other", "/app"]) {
        assert.equal(
            await cgroupMemory(
                fixture({
                    "/proc/self/cgroup": `0::${group}`,
                    "/proc/self/mountinfo": "23 22 0:20 /app /sys/fs/cgroup rw - cgroup2 cgroup rw",
                    "/sys/fs/cgroup/memory.current": "invalid",
                    "/sys/fs/cgroup/memory.max": "1024",
                })
            ),
            null
        );
    }
});

test("runtime reports local backend readiness independently of browser connectivity", async () => {
    const system = {
        browserManager: {
            browser: { isConnected: () => false },
            engine: { health: () => ({ ready: true, restarts: 2 }) },
            getContextInitHealth: () => ({
                initializing: 1,
                ready: 3,
                recovering: false,
                recoveryAttempts: 1,
                staleInitializing: 0,
            }),
        },
        config: { callBackend: "local" },
        ready: true,
        scheduler: { pending: [{}, {}], workers: [{ lease: {} }, { lease: null }] },
    };
    const snapshot = await runtimeStatus(system);
    assert.equal(snapshot.backend.state, "running");
    assert.equal(snapshot.backend.restarts, 2);
    assert.equal(snapshot.application.state, "running");
    assert.ok(snapshot.application.rssBytes > 0);
    assert.deepEqual(snapshot.scheduler, { active: 1, queued: 2, state: "running" });
    system.browserManager.getContextInitHealth = () => ({ recovering: true });
    system.restarting = true;
    assert.equal((await runtimeStatus(system)).backend.state, "recovering");
    assert.equal((await runtimeStatus(system)).application.state, "restarting");
    system.scheduler = null;
    assert.equal((await runtimeStatus(system)).scheduler, null);
});

test("runtime endpoint requires authentication and prevents caching", async t => {
    const express = require("express");
    const StatusRoutes = require("../src/routes/StatusRoutes");
    const app = express();
    new StatusRoutes({ browserManager: {}, config: {}, logger: {}, ready: true }).setupRoutes(app, (req, res, next) => {
        if (req.headers.authorization !== "fixture") return res.sendStatus(401);
        next();
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/status/runtime`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: "fixture" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = await response.json();
    assert.equal(data.application.state, "running");
    assert.equal(data.backend.state, "stopped");
    assert.equal(data.scheduler, null);
});

test("an unreadable memory limit remains unknown", async () => {
    const memory = await cgroupMemory(
        fixture({
            "/proc/self/cgroup": "0::/",
            "/proc/self/mountinfo": "23 22 0:20 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
            "/sys/fs/cgroup/memory.current": "1234",
        })
    );
    assert.equal(memory.limitKnown, false);
    assert.equal(memory.limitBytes, null);
});
