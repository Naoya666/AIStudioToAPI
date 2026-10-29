const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { firefox } = require("playwright");
const BrowserManager = require("../src/core/BrowserManager");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
function manager() {
    return new BrowserManager(
        logger,
        { browserExecutablePath: __filename, scheduler: loadConfig({}) },
        {
            accountNameMap: new Map(),
            getRotationIndices: () => [0, 1, 2],
        }
    );
}
function mockBrowser() {
    const browser = new EventEmitter();
    browser.connected = true;
    browser.isConnected = () => browser.connected;
    browser.close = async () => {
        browser.connected = false;
        browser.emit("disconnected");
    };
    return browser;
}

test("concurrent starts share one launch and old disconnect cannot clear a replacement", async t => {
    const pool = manager();
    const browsers = [];
    t.mock.method(firefox, "launch", async () => {
        await tick();
        const browser = mockBrowser();
        browsers.push(browser);
        return browser;
    });
    await Promise.all(Array.from({ length: 20 }, () => pool._ensureBrowser()));
    assert.equal(browsers.length, 1);
    await pool.closeBrowser();
    await pool._ensureBrowser();
    pool.contexts.set(1, { state: "READY" });
    browsers[0].emit("disconnected");
    assert.equal(pool.browser, browsers[1]);
    assert.equal(pool.contexts.size, 1);
    await pool.closeBrowser();
});

test("launch and close serialize, and closing admission prevents pool launches", async t => {
    const pool = manager();
    const browser = mockBrowser();
    let release;
    t.mock.method(
        firefox,
        "launch",
        () =>
            new Promise(resolve => {
                release = () => resolve(browser);
            })
    );
    const start = pool._ensureBrowser();
    await tick();
    const close = pool.closeBrowser();
    assert.equal(pool.isClosingIntentionally, true);
    release();
    await Promise.all([start, close]);
    assert.equal(pool.browser, null);
    assert.equal(browser.connected, false);
});

test("233 accounts and 300 demands do not scan when both initialization slots are full", () => {
    const pool = manager();
    pool.scheduler = { closed: false, config: { contextInitConcurrency: 2 } };
    pool._contextInitTasks.set(0, Promise.resolve());
    pool._contextInitTasks.set(1, Promise.resolve());
    pool._poolCandidates = () => assert.fail("Candidate scan while full");
    pool.authSource.getRotationIndices = () => Array.from({ length: 233 }, (_, i) => i);
    pool.requestContexts(Array.from({ length: 300 }, (_, i) => ({ authIndex: i % 233, model: "gemini-flash" })));
    assert.equal(pool.contextDemand.size, 233);
    assert.equal(pool.poolMetrics.demand_batches, 1);
    assert.equal(pool.poolMetrics.capacity_skips, 1);
});

test("mouse timeouts keep required behavior but cannot trigger a browser recovery", async () => {
    const pool = manager();
    pool.contextOperationTimeoutMs = 5;
    pool._contextInitAttempts = undefined;
    pool._triggerBrowserRecovery = () => assert.fail("Mouse-only full recovery");
    for (let authIndex = 0; authIndex < 3; authIndex++) {
        const attempt = { authIndex, id: `${authIndex}:1`, startedAt: Date.now() };
        let moves = 0;
        await assert.rejects(
            pool._simulateHumanMovement(
                {
                    mouse: {
                        move: () => {
                            moves++;
                            return new Promise(() => {});
                        },
                    },
                },
                1,
                1,
                attempt
            ),
            error => error.code === "PLAYWRIGHT_RPC_TIMEOUT"
        );
        assert.equal(moves, 1, "Do not stack another RPC on a hanging mouse command");
    }
});

test("health evidence preserves responsive pages and escalates shared critical failures", async () => {
    const pool = manager();
    pool.browser = mockBrowser();
    const recoveries = [];
    pool._triggerBrowserRecovery = reason => recoveries.push(reason);
    pool.contexts.set(1, { page: { evaluate: async () => true, isClosed: () => false }, state: "READY" });
    pool.contexts.set(2, {
        page: {
            evaluate: async () => {
                throw new Error("dead");
            },
            isClosed: () => false,
        },
    });
    pool._confirmBrowserFault("critical");
    await pool._browserProbeTask;
    assert.deepEqual(recoveries, []);
    pool.contexts.delete(1);
    pool._confirmBrowserFault("critical");
    await pool._browserProbeTask;
    assert.deepEqual(recoveries, ["critical"]);
});

test("recovery failure keeps admission closed and never reports service ready", async () => {
    const pool = manager();
    pool.config.scheduler.browserRecoveryBackoffMs = 1;
    pool.closeBrowser = async () => {};
    pool._ensureBrowser = async () => {
        throw new Error("launch failed");
    };
    const logs = [];
    pool.logger = { ...logger, info: message => logs.push(message) };
    pool.scheduler = {
        beginRecovery() {
            this.recovering = true;
        },
        closed: false,
    };
    // Avoid sending IPC in a test worker.
    let escalated;
    pool._requestApplicationRecovery = reason => {
        escalated = reason;
    };
    await pool._triggerBrowserRecovery("test");
    assert.equal(pool._recovering, true);
    assert.equal(pool.scheduler.recovering, true);
    assert.equal(escalated, "browser_recovery_failed");
    assert.ok(!logs.some(line => line.includes("service_ready")));
    pool._poolCandidates = () => assert.fail("Pool must stay blocked");
    pool._pumpContextPool();
});

test("full recovery rejects pending requests, aborts active leases and preserves account eligibility", async t => {
    const config = { ...loadConfig({ GLOBAL_MAX_CONCURRENCY: "1", MODEL_QUEUE_SIZE: "2" }), statePath: null };
    const auth = { accountNameMap: new Map(), getRotationIndices: () => [0] };
    const scheduler = new ModelScheduler(config, auth, logger);
    t.after(() => scheduler.close());
    const lease = await scheduler.acquire("gemini-flash");
    let aborted = 0;
    lease.abort = () => aborted++;
    const pending = scheduler.acquire("gemini-flash");
    const rejection = assert.rejects(pending, error => error.status === 503);
    scheduler.beginRecovery("test");
    await rejection;
    assert.equal(aborted, 1);
    assert.equal(lease.released, true);
    assert.equal(lease.account.inflight, 0);
    assert.equal(lease.account.disabled, false);
    assert.equal(lease.account.healthy, true);
    scheduler.release(lease);
    assert.equal(lease.account.inflight, 0);
    await assert.rejects(scheduler.acquire("gemini-flash"), error => error.status === 503);
});

test("queue limits reject before expensive scans and scheduling yields to I/O", async t => {
    const scheduler = new ModelScheduler(
        { ...loadConfig({ GLOBAL_QUEUE_SIZE: "1" }), statePath: null },
        {
            accountNameMap: new Map(),
            getRotationIndices: () => [0],
        },
        logger
    );
    t.after(() => scheduler.close());
    scheduler.paused = true;
    const queued = scheduler.acquire("gemini-flash");
    scheduler.eligibleAccounts = () => assert.fail("Rejected admission must not scan accounts");
    await assert.rejects(scheduler.acquire("gemini-flash"), error => error.status === 429);
    const rejection = assert.rejects(queued);
    scheduler.close();
    await rejection;
});

test("a ready Playground transport still requires mouse completion before publishing READY", async t => {
    const { PlaygroundTransport } = require("../src/core/PlaygroundTransport");
    t.mock.method(PlaygroundTransport.prototype, "bootstrap", async () => {});
    t.mock.method(PlaygroundTransport.prototype, "connect", () => {});
    const pool = manager();
    pool.config.enableAuthUpdate = false;
    pool.authSource.getAuth = () => ({});
    pool._checkPageStatusAndErrors = async () => {};
    pool._navigateAndWakeUpPage = async (_page, _log, attempt) => {
        attempt.ws.success = true;
    };
    let releaseMouse;
    let closed = false;
    const page = {
        addInitScript: async () => {},
        evaluate: async () => false,
        exposeBinding: async () => {},
        isClosed: () => false,
        mouse: {
            move: () =>
                new Promise(resolve => {
                    releaseMouse = resolve;
                }),
        },
        on() {},
        once() {},
        removeListener() {},
        route: async () => {},
        unroute: async () => {},
    };
    pool._createBrowserContext = async () => ({
        addInitScript: async () => {},
        close: async () => {
            closed = true;
        },
        newPage: async () => page,
        on() {},
        once() {},
        removeListener() {},
    });
    const initialization = pool._getOrStartContextInit(0, { isBackgroundTask: true });
    await tick();
    assert.equal(pool.contexts.has(0), false);
    assert.equal(typeof releaseMouse, "function");
    // Complete all three mandatory movement segments.
    for (let n = 0; n < 3; n++) {
        releaseMouse();
        await tick();
    }
    await initialization;
    assert.equal(pool.contexts.get(0).mouseReady, true);
    assert.equal(pool.contexts.get(0).state, "READY");
    assert.equal(closed, false);
    pool.contexts.clear();
});

test("budgeted drain finishes a large queue while allowing other event-loop work", async t => {
    const scheduler = new ModelScheduler(
        {
            ...loadConfig({ GLOBAL_MAX_CONCURRENCY: "100", MODEL_QUEUE_SIZE: "500", SCHEDULER_DRAIN_BUDGET_MS: "1" }),
            statePath: null,
        },
        {
            accountNameMap: new Map(),
            getRotationIndices: () => Array.from({ length: 233 }, (_, i) => i),
        },
        logger
    );
    t.after(() => scheduler.close());
    scheduler.paused = true;
    const requests = Array.from({ length: 300 }, () =>
        scheduler.acquire("gemini-flash").then(lease => scheduler.release(lease))
    );
    scheduler.paused = false;
    let observed = false;
    setImmediate(() => {
        observed = true;
    });
    scheduler.drain();
    await Promise.all(requests);
    assert.equal(observed, true);
    assert.equal(scheduler.pending.length, 0);
    assert.ok(scheduler.metrics.drain_rounds > 1);
});

test("stale browser connections cannot replace a new instance's connection", () => {
    const ConnectionRegistry = require("../src/core/ConnectionRegistry");
    const pool = manager();
    pool.browserGeneration = 2;
    pool.contexts.set(0, { attemptId: "0:2" });
    const registry = new ConnectionRegistry(logger, null, null, pool);
    const replacement = {};
    registry.connectionsByAuth.set(0, replacement);
    const stale = {
        close: () => {
            stale.closed = true;
        },
        readyState: 1,
    };
    registry.addConnection(stale, { attemptId: "0:1", authIndex: 0, browserGeneration: 1 });
    assert.equal(stale.closed, true);
    assert.equal(registry.connectionsByAuth.get(0), replacement);
});

test("failed context cleanup retains physical capacity during the grace interval", async t => {
    const pool = manager();
    pool.browser = mockBrowser();
    pool.scheduler = { config: { maxWorkers: 2 } };
    pool.connectionRegistry = { getConnectionByAuth: () => ({ readyState: 1 }) };
    pool.contexts.set(1, { page: { evaluate: async () => true, isClosed: () => false }, state: "READY" });
    t.after(() => pool._cleanupAllContexts());
    pool._triggerBrowserRecovery = () => assert.fail("Recovery must wait for the cleanup deadline");
    const attempt = {
        authIndex: 0,
        browserGeneration: pool.browserGeneration,
        context: {
            close: async () => {
                throw new Error("close failed");
            },
        },
        id: "0:1",
    };
    const result = await pool._closeAttemptContext(attempt);
    await pool._browserProbeTask;
    assert.equal(result.closed, false);
    assert.equal(pool._contextCapacityClosures.get(attempt), 0);
    assert.equal(pool.isContextReady(1), true);
});

test("recovery reports service ready only after bootstrap readiness and preserves manual pause", async () => {
    const pool = manager();
    pool.config.scheduler.browserRecoveryBackoffMs = 1;
    const logs = [];
    pool.logger = { ...logger, info: message => logs.push(message) };
    pool.scheduler = {
        beginRecovery() {
            this.recovering = true;
        },
        closed: false,
        config: pool.config.scheduler,
        drain() {},
        paused: true,
    };
    pool.connectionRegistry = { getConnectionByAuth: () => ({ readyState: 1 }) };
    pool.closeBrowser = async () => {};
    pool._ensureBrowser = async () => {
        pool.browser = mockBrowser();
    };
    pool._poolCandidates = () => [0];
    let ready;
    pool._startPooledContext = () =>
        new Promise(resolve => {
            ready = () => {
                pool.contexts.set(0, { mouseReady: true, page: { isClosed: () => false }, state: "READY" });
                resolve();
            };
        });
    const recovery = pool._triggerBrowserRecovery("test");
    while (!ready) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(pool.scheduler.recovering, true);
    assert.ok(!logs.some(line => line.includes("service_ready")));
    ready();
    await recovery;
    assert.equal(pool.scheduler.recovering, false);
    assert.equal(pool.scheduler.paused, true);
    assert.ok(logs.some(line => line.includes("service_ready")));
});

test("late old-generation RPC failures cannot count against the current browser", () => {
    const pool = manager();
    pool.browserGeneration = 2;
    pool._recordBrowserRpcTimeout({ authIndex: 0, browserGeneration: 1 }, { operation: "page.title" });
    assert.equal(pool._browserRpcFailures.length, 0);
});

function closingFixture(t, close) {
    const pool = manager();
    pool.browser = mockBrowser();
    pool.contextCleanupTimeoutMs = 10;
    pool.scheduler = {
        account: () => ({ inflight: 0 }),
        config: { contextInitConcurrency: 2, maxWorkers: 2 },
        coordinateContextPool() {},
    };
    pool._pumpContextPool = () => {};
    pool.connectionRegistry = { closeMessageQueuesForAuth() {}, getConnectionByAuth: () => ({ readyState: 1 }) };
    pool.contexts.set(1, { page: { evaluate: async () => true, isClosed: () => false }, state: "READY" });
    const owner = { context: { close }, state: "READY" };
    pool.contexts.set(0, owner);
    const recoveries = [];
    pool._triggerBrowserRecovery = reason => recoveries.push(reason);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => pool._cleanupAllContexts());
    return { owner, pool, recoveries };
}

test("rejected close converges through recovery even while another context is healthy", async t => {
    const { owner, pool, recoveries } = closingFixture(t, async () => {
        throw new Error("Browser.removeBrowserContext failed");
    });
    await pool.closeContext(0, { keepBrowser: true });
    await pool._browserProbeTask;
    assert.equal(pool.isContextReady(1), true);
    assert.equal(pool._contextCapacityClosures.get(owner), 0);
    assert.equal(pool._reserveContextCapacity(0), null);
    assert.deepEqual(recoveries, []);
    t.mock.timers.tick(20);
    assert.deepEqual(recoveries, ["context_cleanup_stalled"]);
    assert.equal(pool._contextCapacityClosures.has(owner), true, "Recovery must close the physical browser first");
    await pool.closeBrowser();
    assert.equal(pool._contextCapacityClosures.size, 0);
    assert.equal(pool._contextClosureTasks.size, 0);
    assert.ok(pool._reserveContextCapacity(0), "Account becomes reservable after physical browser closure");
});

test("synchronous close exceptions also retain capacity and reach the cleanup deadline", async t => {
    const { owner, pool, recoveries } = closingFixture(t, () => {
        throw new Error("sync close failure");
    });
    await pool.closeContext(0, { keepBrowser: true });
    assert.equal(pool._contextCapacityClosures.has(owner), true);
    t.mock.timers.tick(20);
    assert.deepEqual(recoveries, ["context_cleanup_stalled"]);
});

test("successful close releases capacity and cancels cleanup escalation", async t => {
    const { pool, recoveries } = closingFixture(t, async () => {});
    await pool.closeContext(0, { keepBrowser: true });
    assert.equal(pool._contextCapacityClosures.size, 0);
    assert.equal(pool._contextClosureTasks.size, 0);
    t.mock.timers.tick(100);
    assert.deepEqual(recoveries, []);
});

test("close timeout retains capacity until late success and then cancels recovery", async t => {
    let resolveClose;
    const { pool, recoveries } = closingFixture(t, () => new Promise(resolve => (resolveClose = resolve)));
    const closing = pool.closeContext(0, { keepBrowser: true });
    await tick();
    t.mock.timers.tick(10);
    await closing;
    assert.equal(pool._contextCapacityClosures.size, 1);
    resolveClose();
    await tick();
    assert.equal(pool._contextCapacityClosures.size, 0);
    t.mock.timers.tick(100);
    assert.deepEqual(recoveries, []);
});

test("permanently pending close reaches recovery without admitting the occupied account", async t => {
    const { pool, recoveries } = closingFixture(t, () => new Promise(() => {}));
    const closing = pool.closeContext(0, { keepBrowser: true });
    await tick();
    t.mock.timers.tick(10);
    await closing;
    assert.equal(pool._reserveContextCapacity(0), null);
    t.mock.timers.tick(10);
    assert.deepEqual(recoveries, ["context_cleanup_stalled"]);
});

test("browser reset cancels old watchdogs and late success cannot release replacement capacity", async t => {
    let resolveClose;
    const { owner, pool, recoveries } = closingFixture(t, () => new Promise(resolve => (resolveClose = resolve)));
    const closing = pool.closeContext(0, { keepBrowser: true });
    await tick();
    t.mock.timers.tick(10);
    await closing;
    pool._cleanupAllContexts();
    pool.browser = mockBrowser();
    pool.browserGeneration++;
    const replacement = { context: { close: () => new Promise(() => {}) } };
    pool._closeTrackedContext(replacement, 0);
    resolveClose();
    await tick();
    assert.equal(pool._contextCapacityClosures.has(owner), false);
    assert.equal(pool._contextCapacityClosures.get(replacement), 0);
    t.mock.timers.tick(10);
    assert.deepEqual(recoveries, []);
    t.mock.timers.tick(10);
    assert.deepEqual(recoveries, ["context_cleanup_stalled"]);
});

test("duplicate cleanup shares the physical close and cannot postpone the recovery deadline", async t => {
    let calls = 0;
    const { owner, pool, recoveries } = closingFixture(t, () => {
        calls++;
        return new Promise(() => {});
    });
    const first = pool._closeTrackedContext(owner, 0);
    await tick();
    t.mock.timers.tick(10);
    assert.equal(pool._closeTrackedContext(owner, 0), first);
    t.mock.timers.tick(10);
    assert.equal(calls, 1);
    assert.deepEqual(recoveries, ["context_cleanup_stalled"]);
});

test("failed initialization cleanup also converges and stale attempts cannot occupy a new generation", async t => {
    const { pool, recoveries } = closingFixture(t, async () => {});
    const attempt = {
        authIndex: 2,
        browserGeneration: pool.browserGeneration,
        context: {
            close: async () => {
                throw new Error("init cleanup failed");
            },
        },
        id: "2:1",
    };
    assert.equal((await pool._closeAttemptContext(attempt)).closed, false);
    await pool._browserProbeTask;
    t.mock.timers.tick(20);
    assert.deepEqual(recoveries, ["context_cleanup_stalled"]);
    await pool._browserProbeTask;
    pool._cleanupAllContexts();
    pool.browserGeneration++;
    const stale = { ...attempt, cleanupTask: undefined };
    assert.equal((await pool._closeAttemptContext(stale)).closed, false);
    assert.equal(pool._contextCapacityClosures.size, 0);
    t.mock.timers.tick(100);
    assert.equal(recoveries.length, 1);
});

test("browser close failure preserves physical reservations and escalates to application recovery", async t => {
    const { owner, pool } = closingFixture(t, async () => {
        throw new Error("context close failed");
    });
    await pool.closeContext(0, { keepBrowser: true });
    pool.browser.close = async () => {
        throw new Error("browser close failed");
    };
    const escalations = [];
    pool._requestApplicationRecovery = reason => escalations.push(reason);
    await assert.rejects(pool.closeBrowser(), /browser close failed/);
    assert.equal(pool._contextCapacityClosures.has(owner), true);
    assert.deepEqual(escalations, ["browser_close_timeout"]);
});
