const { test } = require("node:test");
const assert = require("node:assert/strict");
const BrowserManager = require("../src/core/BrowserManager");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const { PlaygroundConnection, PlaygroundTransport } = require("../src/core/PlaygroundTransport");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const { AuthExpiredError } = require("../src/utils/CustomErrors");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, callback = async () => false) {
    const pool = new BrowserManager(
        logger,
        { browserExecutablePath: __filename, scheduler: loadConfig({}) },
        { accountNameMap: new Map(), getRotationIndices: () => [0] }
    );
    pool._closeTrackedContext = async () => {};
    pool._pumpContextPool = () => {};
    const registry = new ConnectionRegistry(logger, callback, () => 0, pool);
    pool.connectionRegistry = registry;
    const grace = [];
    const original = global.setTimeout;
    t.mock.method(global, "setTimeout", (fn, ms, ...args) => {
        if (ms === 10000) {
            grace.push(fn);
            return { unref() {} };
        }
        return original(fn, ms, ...args);
    });
    t.after(() => {
        for (const index of registry.reconnectTasks.keys()) registry.cancelReconnect(index);
        pool._cleanupAllContexts();
    });
    function connect() {
        const transport = { active: new Map(), closed: true, ready: true };
        const connection = new PlaygroundConnection(transport);
        transport.connection = connection;
        transport.dispose = () => PlaygroundTransport.prototype.dispose.call(transport);
        const owner = { context: {}, page: { isClosed: () => false, makerSuiteBridge: transport } };
        pool.contexts.set(0, owner);
        registry.addConnection(connection, { address: "offline", authIndex: 0 });
        return { connection, owner };
    }
    return { connect, grace, pool, registry };
}

test("intentional quota eviction disposes a synchronous Playground close after ending queues", async t => {
    const { pool, registry, grace, connect } = fixture(t);
    const { owner } = connect();
    Object.assign(owner, { draining: true, drainReason: "visible_models_rate_limited" });
    const reasons = [];
    t.mock.method(registry, "closeMessageQueuesForAuth", (_, reason) => reasons.push(reason));
    const dispose = owner.page.makerSuiteBridge.dispose;
    owner.page.makerSuiteBridge.dispose = () => {
        assert.equal(pool.contexts.has(0), false);
        assert.equal(pool.isContextClosing(0), true);
        assert.equal(reasons[0], "context_closed");
        dispose();
    };
    await pool.closeContext(0, { keepBrowser: true });
    assert.equal(grace.length, 0);
    assert.equal(registry.reconnectTasks.size, 0);
    assert.equal(pool.contextDemand.size, 0);
});

test("intentional close cancels an existing grace timer even without a connection", async t => {
    let calls = 0;
    const { pool, registry, grace, connect } = fixture(t, async () => calls++);
    connect().connection.close();
    assert.equal(registry.reconnectGraceTimers.size, 1);
    await pool.closeContext(0, { keepBrowser: true });
    assert.equal(registry.reconnectGraceTimers.size, 0);
    await grace[0](); // Simulate an already queued timer callback.
    assert.equal(calls, 0);
    assert.equal(pool.contextDemand.size, 0);
});

test("late reconnect completion cannot rebuild a retired context or clear a replacement task", async t => {
    let finish;
    const { pool, registry, grace, connect } = fixture(
        t,
        () =>
            new Promise(resolve => {
                finish = resolve;
            })
    );
    connect().connection.close();
    const oldRun = grace[0]();
    await tick();
    await pool.closeContext(0, { keepBrowser: true });
    connect().connection.close();
    const replacementTask = registry.reconnectTasks.get(0);
    finish(false);
    await oldRun;
    assert.equal(pool.contextDemand.size, 0);
    assert.equal(registry.reconnectTasks.get(0), replacementTask);
    assert.equal(registry.reconnectGraceTimers.size, 1);
});

test("manual transport close cancels recovery when the connection has already disappeared", async t => {
    const { registry, grace, connect } = fixture(t);
    connect().connection.close();
    registry.closeConnectionByAuth(0);
    await grace[0]();
    assert.equal(registry.reconnectTasks.size, 0);
    assert.equal(registry.reconnectGraceTimers.size, 0);
});

test("browser cleanup detaches all owners and cancels recovery before transport disposal", async t => {
    const { pool, registry, grace, connect } = fixture(t);
    connect();
    pool._cleanupAllContexts();
    assert.equal(grace.length, 0);
    assert.equal(registry.reconnectTasks.size, 0);
    assert.equal(pool.contextDemand.size, 0);
});

for (const succeeds of [false, true]) {
    test(`unexpected disconnect ${succeeds ? "reconnects" : "requests a replacement after failure"}`, async t => {
        let calls = 0;
        const f = fixture(t, async () => {
            calls++;
            if (succeeds) f.connect();
            return succeeds;
        });
        const requests = [];
        t.mock.method(f.pool, "requestContext", index => requests.push(index));
        f.connect().connection.close();
        await f.grace[0]();
        assert.equal(calls, 1);
        assert.deepEqual(requests, succeeds ? [] : [0]);
        assert.equal(f.registry.reconnectTasks.size, 0);
        assert.equal(f.registry.lightweightReconnectTimeouts.size, 0);
    });
}

test("quota changes during grace or callback prevent automatic recovery", async t => {
    for (const duringCallback of [false, true]) {
        await t.test(String(duringCallback), async t => {
            let eligible = true;
            let calls = 0;
            const { pool, registry, grace, connect } = fixture(t, async () => {
                calls++;
                eligible = false;
                return false;
            });
            pool.scheduler = { closed: false, drain() {} };
            t.mock.method(pool, "_canKeepPooledContext", () => eligible);
            const requests = [];
            t.mock.method(pool, "requestContext", index => requests.push(index));
            connect().connection.close();
            if (!duringCallback) eligible = false;
            await grace[0]();
            assert.equal(calls, duringCallback ? 1 : 0);
            assert.deepEqual(requests, []);
            assert.equal(registry.reconnectTasks.size, 0);
        });
    }
});

test("automatic unscoped demand respects both models' cooldowns while explicit work remains allowed", async t => {
    const { pool } = fixture(t);
    const scheduler = new ModelScheduler(
        { ...loadConfig({}), dailyResetEnabled: false, statePath: null },
        pool.authSource,
        logger
    );
    pool.scheduler = scheduler;
    t.after(() => scheduler.close());
    const account = scheduler.account(0);
    const cooldown = scheduler.now() + 60000;
    for (const model of ["pro", "flash"]) {
        Object.assign(scheduler.slot(account, model), {
            cooldown_until: cooldown,
            rate_limit_type: "daily_quota",
            rate_limited: true,
        });
    }
    assert.equal(scheduler.isAccountPoolResident(0), false);
    pool.requestContext(0);
    assert.equal(pool.contextDemand.size, 0);
    // A recovery demand recorded before exhaustion must also become invalid.
    pool.contextDemand.set(0, { unscoped: true, unscopedUntil: Date.now() + 60000 });
    assert.equal(pool._hasValidContextDemand(0), false);
    assert.equal(pool._canKeepPooledContext(0), false);
    pool.contextDemand.clear();
    pool._foregroundContextWaiters = new Map([[0, 1]]);
    pool.requestContext(0);
    assert.equal(pool.contextDemand.has(0), true);
    assert.equal(pool._canKeepPooledContext(0), true);
    pool._foregroundContextWaiters.clear();
    pool.contextDemand.clear();
    scheduler.workers.push({ lease: { account, model: "__files__" } });
    pool.requestContext(0);
    assert.equal(pool.contextDemand.has(0), true);
    assert.equal(pool._canKeepPooledContext(0), true);
    scheduler.workers.pop();
    scheduler.slot(account, "flash").cooldown_until = scheduler.now() - 1;
    assert.equal(pool._hasValidContextDemand(0), true);
    assert.equal(pool._canKeepPooledContext(0), true);
});

test("late Playground reconnect errors cannot close a replacement context", async t => {
    const { pool, connect } = fixture(t);
    const { owner } = connect();
    owner.page.playgroundTransport = owner.page.makerSuiteBridge;
    pool.browser = {};
    let fail;
    pool._navigateAndWakeUpPage = () =>
        new Promise((_, reject) => {
            fail = reject;
        });
    const reconnect = pool.attemptLightweightReconnect(0);
    await tick();
    const replacement = connect().owner;
    t.mock.method(pool, "closeContext", () => assert.fail("Old reconnect closed replacement"));
    fail(new AuthExpiredError());
    assert.equal(await reconnect, false);
    assert.equal(pool.contexts.get(0), replacement);
    assert.equal(replacement.state, "READY");
    pool.browser = null;
});

test("manual close also cancels recovery scheduled by a synchronous close event", async t => {
    const { registry, connect } = fixture(t);
    connect();
    registry.closeConnectionByAuth(0);
    assert.equal(registry.reconnectTasks.size, 0);
    assert.equal(registry.reconnectGraceTimers.size, 0);
});

test("expired authentication still closes the owning context during reconnect", async t => {
    const { pool, connect } = fixture(t);
    const { owner } = connect();
    owner.page.playgroundTransport = owner.page.makerSuiteBridge;
    pool.browser = {};
    pool.scheduler = { closed: false, drain() {} };
    let eligible = true;
    t.mock.method(pool, "_canKeepPooledContext", () => eligible);
    pool._navigateAndWakeUpPage = async () => {};
    pool._checkPageStatusAndErrors = async () => {
        eligible = false;
        throw new AuthExpiredError();
    };
    let closed = false;
    t.mock.method(pool, "closeContext", async () => {
        closed = true;
    });
    assert.equal(await pool.attemptLightweightReconnect(0), false);
    assert.equal(closed, true);
    pool.browser = null;
});

function playgroundMaintenanceFixture(t) {
    const f = fixture(t);
    const { owner } = f.connect();
    owner.browserGeneration = f.pool.browserGeneration;
    owner.page.playgroundTransport = owner.page.makerSuiteBridge;
    owner.page.playgroundTransport.closed = false;
    owner.page.playgroundTransport.authIndex = 0;
    owner.page.playgroundTransport.dispose = () => {
        owner.page.playgroundTransport.closed = true;
        owner.page.playgroundTransport.ready = false;
        owner.page.playgroundTransport.connection?.close();
    };
    owner.page.playgroundTransport.connection = f.registry.getConnectionByAuth(0, false);
    owner.page.evaluate = () => assert.fail("Background page interaction");
    owner.page.bringToFront = () => assert.fail("Background focus");
    owner.page.mouse = { move: () => assert.fail("Mouse keepalive") };
    f.pool._simulateHumanMovement = () => assert.fail("Mouse keepalive");
    f.pool._handleRequiredMouseFailure = () => assert.fail("Mouse failure recovery");
    const timers = [];
    t.mock.method(global, "setInterval", (callback, ms) => {
        const timer = { callback, ms };
        timers.push(timer);
        return timer;
    });
    t.mock.method(global, "clearInterval", timer => {
        if (timer) timer.cleared = true;
    });
    return { ...f, owner, timers };
}

test("Playground maintenance saves authentication daily without page input or queue cancellation", async t => {
    const { pool, owner, timers, registry } = playgroundMaintenanceFixture(t);
    let saved = 0;
    pool.config.enableAuthUpdate = true;
    pool.authSource.getAuth = () => ({});
    const storage = { cookies: [{ name: "test" }], origins: [] };
    owner.context.storageState = async () => storage;
    pool.authSource.accountLoginService = {
        exclusive: callback => callback(),
        refreshSession: async (index, version, snapshot) => {
            assert.equal(index, 0);
            assert.equal(snapshot, storage);
            saved++;
        },
        state: {},
    };
    const queues = t.mock.method(registry, "closeMessageQueuesForAuth", () =>
        assert.fail("Maintenance cancelled queues")
    );
    pool._startHealthMonitor(0);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 86400000);
    await pool._startBackgroundWakeup(owner);
    await timers[0].callback();
    assert.equal(saved, 1);
    assert.equal(owner.state, "READY");
    assert.equal(pool.isContextReady(0), true);
    queues.mock.restore();
});

test("Playground maintenance cancels duplicate timers and ignores retired owners and generations", async t => {
    const { pool, owner, timers, connect } = playgroundMaintenanceFixture(t);
    let saved = 0;
    pool._updateAuthFile = async () => saved++;
    pool._startHealthMonitor(0);
    pool._startHealthMonitor(0);
    assert.equal(timers[0].cleared, true);
    await timers[0].callback();
    assert.equal(saved, 0);
    await timers[1].callback();
    assert.equal(saved, 1);
    pool.browserGeneration++;
    await timers[1].callback();
    assert.equal(timers[1].cleared, true);
    assert.equal(saved, 1);
    owner.browserGeneration = pool.browserGeneration;
    pool._startHealthMonitor(0);
    connect();
    await timers[2].callback();
    assert.equal(timers[2].cleared, true);
    assert.equal(saved, 1);
});

for (const cleanup of ["close", "browser_cleanup", "page_closed"]) {
    test(`Playground authentication timer stops after ${cleanup}`, async t => {
        const { pool, owner, timers } = playgroundMaintenanceFixture(t);
        let saved = 0;
        pool._updateAuthFile = async () => saved++;
        pool._startHealthMonitor(0);
        if (cleanup === "close") await pool.closeContext(0, { keepBrowser: true });
        if (cleanup === "browser_cleanup") pool._cleanupAllContexts();
        if (cleanup === "page_closed") owner.page.isClosed = () => true;
        await timers[0].callback();
        assert.equal(saved, 0);
        assert.equal(timers[0].cleared, true);
    });
}

test("an authentication snapshot finishing after owner replacement cannot persist stale credentials", async t => {
    const { pool, owner, timers, connect } = playgroundMaintenanceFixture(t);
    pool.config.enableAuthUpdate = true;
    pool.authSource.getAuth = () => ({});
    let release;
    owner.context.storageState = () =>
        new Promise(resolve => {
            release = resolve;
        });
    pool.authSource.accountLoginService = {
        exclusive: () => assert.fail("Stale snapshot persisted"),
        state: {},
    };
    pool._startHealthMonitor(0);
    const save = timers[0].callback();
    await tick();
    connect();
    release({ cookies: [], origins: [] });
    await save;
});

for (const outcome of [
    "success",
    "bootstrap_failure",
    "page_closed",
    "transport_not_ready",
    "registration_rejected",
    "generation",
    "replacement",
    "ineligible",
]) {
    test(`Playground lightweight reconnect ${outcome} uses no mouse input`, async t => {
        const { pool, owner, timers, registry, connect } = playgroundMaintenanceFixture(t);
        pool.browser = {};
        t.after(() => {
            pool.browser = null;
        });
        const transport = owner.page.playgroundTransport;
        pool._navigateAndWakeUpPage = async () => {};
        pool._checkPageStatusAndErrors = async () => {};
        pool._updateAuthFile = async () => {};
        transport.bootstrap = async () => {
            transport.ready = true;
            if (outcome === "bootstrap_failure") throw new Error("WAA failed");
            if (outcome === "page_closed") owner.page.isClosed = () => true;
            if (outcome === "transport_not_ready") transport.ready = false;
            if (outcome === "generation") pool.browserGeneration++;
            if (outcome === "replacement") connect();
            if (outcome === "ineligible") pool._canKeepPooledContext = () => false;
        };
        transport.connect = (r, data) => PlaygroundTransport.prototype.connect.call(transport, r, data);
        if (outcome === "registration_rejected") registry.addConnection = () => {};
        if (outcome === "ineligible") {
            pool.scheduler = { closed: false, drain() {} };
            pool._canKeepPooledContext = () => true;
        }
        pool._startHealthMonitor(0);
        assert.equal(await pool.attemptLightweightReconnect(0), outcome === "success");
        assert.equal(timers[0].cleared, true, "Reconnect stops the background owner's timer");
        if (outcome === "success") {
            assert.equal(pool.isContextReady(0), true);
            assert.equal(timers.length, 2);
        } else {
            assert.equal(timers.length, 1);
            if (outcome !== "replacement") assert.equal(pool.isContextReady(0), false);
        }
    });
}

test("Playground rejects the legacy WebSocket waiter before any Launch or input action", async t => {
    const { pool, owner } = playgroundMaintenanceFixture(t);
    await assert.rejects(pool._waitForWebSocketInit(owner.page), /must use bootstrap/);
    await BrowserManager.prototype._handleRequiredMouseFailure.call(pool, 0, owner, new Error("legacy callback"));
    assert.equal(pool.contexts.get(0), owner);
    assert.equal(owner.draining, undefined);
    assert.equal(owner.state, "READY");
});
