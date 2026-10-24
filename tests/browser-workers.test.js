const { test } = require("node:test");
const assert = require("node:assert/strict");
const BrowserManager = require("../src/core/BrowserManager");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadSchedulerConfig = require("../src/core/SchedulerConfig");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
function browserFixture(limit) {
    const manager = Object.create(BrowserManager.prototype);
    Object.assign(manager, {
        _contextInitTasks: new Map(),
        async _ensureBrowser() {
            this.browser = {};
        },
        async _initializeContext(index) {
            assert.ok(this.browser);
            this.activeInitializations = (this.activeInitializations || 0) + 1;
            this.peakInitializations = Math.max(this.peakInitializations || 0, this.activeInitializations);
            await new Promise(resolve => setImmediate(resolve));
            this.contexts.set(index, { page: { isClosed: () => false }, state: "READY" });
            this.activeInitializations--;
            this.peak = Math.max(this.peak || 0, this.contexts.size);
        },
        async _startBackgroundWakeup() {},
        _startHealthMonitor() {},
        abortedContexts: new Set(),
        authSource: { getRotationIndices: () => [0, 1, 2] },
        async closeContext(index, options) {
            this.contexts.delete(index);
            if (!this.contexts.size && !options?.keepBrowser) this.browser = null;
        },
        connectionRegistry: { getConnectionByAuth: index => (manager.contexts.has(index) ? {} : null) },
        contextDemand: new Map(),
        contexts: new Map(),
        contextUnavailable: new Map(),
        initializingContexts: new Set(),
        logger,
        pendingContextClosures: new Map(),
        scheduler: {
            account: index => ({ inflight: index === 0 ? 1 : 0 }),
            closed: false,
            config: {
                contextInitConcurrency: 2,
                contextPoolMinReady: 0,
                maxWorkers: limit,
                queueTimeoutMs: 100,
            },
            drain() {},
        },
    });
    return manager;
}

async function waitForPool(manager, expectedReady, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while ((manager.contexts.size !== expectedReady || manager._contextInitTasks.size !== 0) && Date.now() < deadline) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

test("context setup is bounded parallel and never evicts leased contexts", async () => {
    const manager = browserFixture(2);
    manager.requestContext(0);
    manager.requestContext(1);
    manager.requestContext(2);
    while (manager._contextInitTasks.size || manager.initializingContexts.size) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(manager.peak, 2);
    assert.equal(manager.peakInitializations, 2);
    assert.deepEqual([...manager.contexts.keys()], [0, 2]);
});

test("warm pool reaches all 16 workers after init markers are released", async () => {
    const manager = browserFixture(16);
    manager.authSource.getRotationIndices = () => Array.from({ length: 100 }, (_, index) => index);
    manager.scheduler.config.contextPoolMinReady = 16;
    manager.scheduler.config.contextInitConcurrency = 2;
    manager.scheduler.account = () => ({ healthy: true, inflight: 0, models: {} });

    manager.startContextPool();
    await waitForPool(manager, 16);

    assert.equal(manager.contexts.size, 16);
    assert.equal(manager.initializingContexts.size, 0);
    assert.equal(manager._contextInitTasks.size, 0);
    assert.ok(manager.peakInitializations <= 2);
    assert.ok(manager.peak <= 16);
});

test("warm pool reaches exact targets across concurrency and enabled-account limits", async t => {
    const cases = [
        { concurrency: 1, enabled: 100, expected: 1, target: 1 },
        { concurrency: 2, enabled: 100, expected: 2, target: 2 },
        { concurrency: 2, enabled: 100, expected: 15, target: 15 },
        { concurrency: 2, enabled: 100, expected: 16, target: 16 },
        { concurrency: 1, enabled: 100, expected: 16, target: 16 },
        { concurrency: 4, enabled: 100, expected: 16, target: 16 },
        { concurrency: 2, enabled: 10, expected: 10, target: 16 },
    ];

    for (const entry of cases) {
        await t.test(JSON.stringify(entry), async () => {
            const manager = browserFixture(16);
            manager.authSource.getRotationIndices = () => Array.from({ length: 100 }, (_, index) => index);
            manager.scheduler.config.contextPoolMinReady = entry.target;
            manager.scheduler.config.contextInitConcurrency = entry.concurrency;
            manager.scheduler.account = () => ({ healthy: true, inflight: 0, models: {} });
            manager.scheduler.isAccountManuallyDisabled = index => index >= entry.enabled;
            let peakTasks = 0;
            const startPooledContext = manager._startPooledContext.bind(manager);
            manager._startPooledContext = index => {
                const task = startPooledContext(index);
                peakTasks = Math.max(peakTasks, manager._contextInitTasks.size);
                return task;
            };

            manager.startContextPool();
            await waitForPool(manager, entry.expected);

            assert.equal(manager.contexts.size, entry.expected);
            assert.equal(manager.initializingContexts.size, 0);
            assert.equal(manager._contextInitTasks.size, 0);
            assert.ok(peakTasks <= entry.concurrency);
            assert.ok(manager.contexts.size <= manager.scheduler.config.maxWorkers);
            assert.ok([...manager.contexts.keys()].every(index => index < entry.enabled));
        });
    }
});

test("warm pool continues with another account after one initialization fails", async () => {
    const manager = browserFixture(2);
    manager.authSource.getRotationIndices = () => [0, 1, 2];
    manager.scheduler.config.contextPoolMinReady = 2;
    manager.scheduler.config.contextInitConcurrency = 1;
    manager.scheduler.account = () => ({ healthy: true, inflight: 0, models: {} });
    const initialize = manager._initializeContext.bind(manager);
    manager._initializeContext = async (index, ...args) => {
        if (index === 0) throw new Error("expected init failure");
        return initialize(index, ...args);
    };

    manager.startContextPool();
    await waitForPool(manager, 2);

    assert.deepEqual([...manager.contexts.keys()], [1, 2]);
    assert.equal(manager._contextInitTasks.size, 0);
    assert.equal(manager.initializingContexts.size, 0);
});

test("capacity blocking does not synchronously repump the context pool", async () => {
    const manager = browserFixture(1);
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    manager.scheduler.account = index => ({ healthy: true, inflight: index === 0 ? 1 : 0, models: {} });
    let pumps = 0;
    manager._pumpContextPool = () => pumps++;

    await manager._startPooledContext(1);

    assert.equal(pumps, 0);
    assert.equal(manager._contextInitTasks.size, 0);
    assert.equal(manager.initializingContexts.size, 0);
    assert.deepEqual([...manager.contexts.keys()], [0]);
});

test("real scheduler waits for capacity release without an initialization microtask loop", async t => {
    for (const stale of [false, true]) {
        await t.test(stale ? "stale context still has inflight requests" : "full pool has no idle context", async t => {
            const manager = browserFixture(1);
            manager.authSource.accountNameMap = new Map();
            manager.authSource.getRotationIndices = () => (stale ? [0] : [0, 1]);
            const scheduler = new ModelScheduler(
                {
                    ...loadSchedulerConfig({ MAX_BROWSER_WORKERS: "1", SCHEDULER_DAILY_RESET_ENABLED: "false" }),
                    contextPoolMinReady: 0,
                    queueTimeoutMs: 2000,
                    statePath: null,
                },
                manager.authSource,
                logger
            );
            manager.scheduler = scheduler;
            scheduler.browserManager = manager;
            t.after(() => scheduler.close());
            // Keep a regression bounded even when microtasks starve timers and setImmediate.
            let attempts = 0;
            manager.logger = {
                ...logger,
                info(message) {
                    if (!message.includes(" init_started ")) return;
                    attempts++;
                    if (attempts >= 8) scheduler.paused = true;
                },
            };
            let creations = 0;
            const initialize = manager._initializeContext.bind(manager);
            manager._initializeContext = async (...args) => {
                creations++;
                return initialize(...args);
            };
            manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
            const busy = await scheduler.acquire("busy");
            if (stale) manager.contexts.get(0).state = "RECONNECTING";
            else scheduler.slot(scheduler.account(0), "waiting").unsupported = true;

            const waiting = scheduler.acquire("waiting");
            waiting.catch(() => {});
            await new Promise(resolve => setImmediate(resolve));

            assert.equal(attempts, 0);
            assert.equal(creations, 0);
            assert.equal(scheduler.pending.length, 1);
            assert.equal(scheduler.account(0).inflight, 1);
            assert.equal(manager.contexts.has(0), true);
            assert.equal(manager._contextInitTasks.size, 0);
            assert.equal(manager.initializingContexts.size, 0);
            assert.equal(manager.contextDemand.has(stale ? 0 : 1), true);

            scheduler.release(busy);
            const next = await waiting;
            assert.equal(next.account.index, stale ? 0 : 1);
            assert.equal(creations, 1);
            assert.equal(manager.isContextReady(next.account.index), true);
            assert.equal(manager.contextDemand.size, 0);
            assert.equal(scheduler.pending.length, 0);
            scheduler.release(next);
        });
    }
});

test("release callback cannot restart the pool after scheduler shutdown", async () => {
    const manager = browserFixture(2);
    manager.authSource.getRotationIndices = () => [0, 1];
    manager.scheduler.config.contextPoolMinReady = 2;
    manager.scheduler.config.contextInitConcurrency = 1;
    manager.scheduler.account = () => ({ healthy: true, inflight: 0, models: {} });
    const initialize = manager._initializeContext.bind(manager);
    manager._initializeContext = async (index, ...args) => {
        const result = await initialize(index, ...args);
        manager.scheduler.closed = true;
        return result;
    };

    manager.startContextPool();
    await waitForPool(manager, 0);

    assert.equal(manager.contexts.size, 0);
    assert.equal(manager.contextCapacityReservations.size, 0);
    assert.equal(manager._contextInitTasks.size, 0);
    assert.equal(manager.initializingContexts.size, 0);
});

test("disabled accounts are excluded from context demand and warm candidates", () => {
    const manager = browserFixture(2);
    manager.scheduler.config.contextPoolMinReady = 2;
    manager.scheduler.isAccountManuallyDisabled = index => index === 1;
    manager.requestContext(1, "flash");
    assert.equal(manager.contextDemand.has(1), false);
    manager.contextDemand.set(1, { model: "flash" });
    manager.contextDemand.set(2, { model: "flash" });
    assert.deepEqual(manager._poolCandidates(), [2, 0]);
    manager.scheduler.closed = true;
});

test("context eviction ranks disabled state, demand, and true request LRU", () => {
    const manager = browserFixture(3);
    const accounts = new Map(
        [0, 1, 2].map(index => [index, { disabled: false, healthy: true, inflight: 0, models: {} }])
    );
    manager.scheduler.account = index => accounts.get(index);
    manager.scheduler.isAccountManuallyDisabled = index => accounts.get(index).disabled;
    manager.contexts = new Map([
        [0, { createdAt: 10, lastRequestAt: 300, page: { isClosed: () => false }, state: "READY" }],
        [1, { createdAt: 20, lastRequestAt: 100, page: { isClosed: () => false }, state: "READY" }],
        [2, { createdAt: 30, lastRequestAt: 200, page: { isClosed: () => false }, state: "READY" }],
    ]);
    assert.deepEqual(
        [0, 1, 2].sort((a, b) => manager._compareContextEviction(a, b)),
        [1, 2, 0]
    );
    manager.contextDemand.set(1, { model: "flash" });
    assert.deepEqual(
        [0, 1, 2].sort((a, b) => manager._compareContextEviction(a, b)),
        [2, 0, 1]
    );
    accounts.get(0).disabled = true;
    assert.equal([0, 1, 2].sort((a, b) => manager._compareContextEviction(a, b))[0], 0);
    manager.markContextRequest(2, 400);
    assert.equal(manager.contexts.get(2).lastRequestAt, 400);
});

test("disabling a busy context drains without interrupting it and closes after release", async () => {
    const manager = browserFixture(1);
    const account = { disabled: true, healthy: true, inflight: 1, models: {} };
    manager.scheduler.account = () => account;
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    manager.handleAccountDisabled(0);
    assert.equal(manager.contexts.get(0).draining, true);
    assert.equal(manager.pendingContextClosures.get(0), "account_disabled");
    assert.equal(manager.contexts.has(0), true);

    let pumps = 0;
    manager._isSystemBusyProvider = () => true;
    manager._pumpContextPool = () => pumps++;
    account.inflight = 0;
    manager.handleAccountLeaseReleased(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.has(0), false);
    assert.equal(pumps, 1);
});
test("one-worker account rotation keeps browser alive while replacing last context", async () => {
    const manager = browserFixture(1);
    await manager.ensureWorkerContext(1);
    await manager.ensureWorkerContext(2);
    assert.ok(manager.browser);
    assert.deepEqual([...manager.contexts.keys()], [2]);
});
test("shutdown prevents queued context launches", async () => {
    const manager = browserFixture(1);
    manager.scheduler.closed = true;
    await assert.rejects(manager.ensureWorkerContext(1), /shutting down/);
    assert.equal(manager.contexts.size, 0);
});
test("a delayed WebSocket close cannot remove a replacement connection", () => {
    const registry = new ConnectionRegistry(logger);
    const replacement = { _authIndex: 0 };
    registry.connectionsByAuth.set(0, replacement);
    registry._removeConnection({ _authIndex: 0 });
    assert.equal(registry.connectionsByAuth.get(0), replacement);
});

test("message queues are isolated by WebSocket connection epoch", async () => {
    const registry = new ConnectionRegistry(logger);
    const socket = () => {
        const ws = new (require("node:events").EventEmitter)();
        ws.readyState = 1;
        ws.close = () => {};
        return ws;
    };
    const first = socket();
    registry.addConnection(first, { address: "test", authIndex: 0 });
    const oldQueue = registry.createMessageQueue("old", 0, "attempt-1");
    const oldWait = oldQueue.dequeue(100);
    const second = socket();
    registry.addConnection(second, { address: "test", authIndex: 0 });
    await assert.rejects(oldWait, error => error.reason === "connection_lost");
    const newQueue = registry.createMessageQueue("new", 0, "attempt-2");
    registry._removeConnection(first);
    assert.equal(newQueue.closed, false);
    assert.equal(registry.getConnectionEpoch(0), 2);
    registry.removeMessageQueue("new");
});

test("same account concurrent initialization creates only one context", async () => {
    const manager = browserFixture(1);
    let launches = 0;
    const initialize = manager._initializeContext.bind(manager);
    manager._initializeContext = async index => {
        launches++;
        await initialize(index);
    };
    await Promise.all(Array.from({ length: 20 }, () => manager.ensureWorkerContext(0)));
    assert.equal(launches, 1);
    assert.equal(manager.contexts.size, 1);
});

test("context initialization failure stays local and marks only the context unavailable", async () => {
    const manager = browserFixture(1);
    manager._initializeContext = async () => {
        throw new Error("Build initialization failed");
    };
    manager.requestContext(0);
    await manager._contextInitTasks.get(0);
    assert.equal(manager.contextUnavailable.get(0).error.message, "Build initialization failed");
    assert.equal(manager.scheduler.account(0).healthy, undefined);
});

test("browser context creation is serialized while later initialization can remain parallel", async () => {
    const manager = Object.create(BrowserManager.prototype);
    const pending = [];
    let activeCreations = 0;
    let peakCreations = 0;
    manager._contextCreationQueue = Promise.resolve();
    manager.contextCreationTimeoutMs = 1000;
    manager.browser = {
        newContext() {
            activeCreations++;
            peakCreations = Math.max(peakCreations, activeCreations);
            return new Promise(resolve => {
                pending.push(() => {
                    activeCreations--;
                    resolve({ close: async () => {} });
                });
            });
        },
    };

    const first = manager._createBrowserContext({}, 0);
    const second = manager._createBrowserContext({}, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 1);

    pending.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 1);

    pending.shift()();
    await Promise.all([first, second]);
    assert.equal(peakCreations, 1);
});

test("browser context creation timeout releases the lock and closes a late orphan", async () => {
    const manager = Object.create(BrowserManager.prototype);
    let resolveStalled;
    let lateContextClosed = false;
    let calls = 0;
    manager._contextCreationQueue = Promise.resolve();
    manager.contextCreationTimeoutMs = 10;
    manager.browser = {
        newContext() {
            calls++;
            if (calls === 1) {
                return new Promise(resolve => {
                    resolveStalled = resolve;
                });
            }
            return Promise.resolve({ close: async () => {} });
        },
    };

    await assert.rejects(manager._createBrowserContext({}, 0), error => {
        assert.equal(error.code, "CONTEXT_CREATION_TIMEOUT");
        return true;
    });
    await manager._createBrowserContext({}, 1);
    assert.equal(calls, 2);

    resolveStalled({
        async close() {
            lateContextClosed = true;
        },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lateContextClosed, true);
});

function singleFlightFixture() {
    const manager = Object.create(BrowserManager.prototype);
    Object.assign(manager, {
        _contextInitSequence: 0,
        _contextInitTasks: new Map(),
        _wsInitState: new Map(),
        abortedContexts: new Set(),
        initializingContexts: new Set(),
        logger,
    });
    return manager;
}

function websocketWaitFixture(registry = null) {
    const manager = Object.create(BrowserManager.prototype);
    Object.assign(manager, {
        _backgroundPreloadAbort: false,
        _checkPageErrors: async () => ({}),
        _clickButtonByTextIfVisible: async () => false,
        _findAndClickButtonByText: async () => ({ clicked: false, found: false }),
        _simulateHumanMovement: async () => {},
        abortedContexts: new Set(),
        connectionRegistry: registry,
        consentRetryIntervalMs: 0,
        consentTimeoutGraceMs: 5,
        logger,
    });
    return manager;
}

function waitPage() {
    return {
        viewportSize: () => ({ height: 10, width: 10 }),
        async waitForTimeout() {
            await new Promise(resolve => setTimeout(resolve, 2));
        },
    };
}

test("single-flight publishes one exact Promise and result to 20 same-account callers", async () => {
    const manager = singleFlightFixture();
    let creations = 0;
    const result = { context: {}, page: {} };
    manager._initializeContext = async () => {
        creations++;
        await new Promise(resolve => setImmediate(resolve));
        return result;
    };

    const tasks = Array.from({ length: 20 }, () => manager._getOrStartContextInit(7));
    assert.ok(tasks.every(task => task === tasks[0]));
    assert.ok((await Promise.all(tasks)).every(value => value === result));
    assert.equal(creations, 1);
    assert.equal(manager.initializingContexts.size, 0);
});

test("single-flight settled callback runs only after ownership markers are released", async () => {
    const manager = singleFlightFixture();
    let releasedState = null;
    let drains = 0;
    manager.scheduler = { drain: () => drains++ };

    await manager._getOrStartContextInit(4, {
        onSettledAfterRelease: () => {
            releasedState = {
                initializing: manager.initializingContexts.has(4),
                task: manager._contextInitTasks.has(4),
            };
            manager.scheduler.drain();
        },
        runner: async () => "ready",
    });

    assert.deepEqual(releasedState, { initializing: false, task: false });
    assert.equal(drains, 1);
});

test("initialization without a settled callback uses default drain on success and failure", async () => {
    const manager = singleFlightFixture();
    let drains = 0;
    manager.scheduler = { drain: () => drains++ };
    await manager._getOrStartContextInit(4, { runner: async () => "ready" });
    assert.equal(drains, 1);
    await assert.rejects(
        manager._getOrStartContextInit(4, {
            runner: async () => {
                throw new Error("expected init failure");
            },
        }),
        /expected init failure/
    );
    assert.equal(drains, 2);
});

test("pool warmup and foreground switch join the same account initialization", async () => {
    const manager = browserFixture(2);
    manager.connectionRegistry.getConnectionEpoch = () => null;
    manager.authSource.isExpired = () => false;
    manager.authSource.markAsExpired = async () => {};
    manager.authSource.unmarkAsExpired = async () => {};
    manager._cancelPendingContextClosure = () => {};
    manager._flushPendingContextClosures = async () => {};
    manager._updateAuthFile = async () => {};
    manager._activateContext = () => {};
    let creations = 0;
    manager._initializeContext = async index => {
        creations++;
        await new Promise(resolve => setImmediate(resolve));
        const context = {};
        const page = {
            isClosed: () => false,
            title: async () => "AI Studio",
            url: () => "https://ai.studio/apps/test",
        };
        manager.contexts.set(index, { context, page, state: "READY" });
        return { context, page };
    };

    const warmup = manager._startPooledContext(0);
    const foreground = manager.launchOrSwitchContext(0);
    await Promise.all([warmup, foreground]);
    assert.equal(creations, 1);
});

test("an account-level observability overwrite cannot replace an attempt's success state", async () => {
    const manager = websocketWaitFixture();
    const attempt = { authIndex: 3, id: "3:1", ws: { failed: false, success: true } };
    manager._wsInitState = new Map([[3, { failed: false, success: false }]]);
    assert.equal(await manager._waitForWebSocketInit(waitPage(), "[Test]", 5, attempt, false), true);
});

test("a failed old attempt closes only its local context and preserves a newer map entry", async () => {
    const manager = singleFlightFixture();
    let localClosed = false;
    const localContext = {
        addInitScript: async () => {},
        close: async () => {
            localClosed = true;
        },
        newPage: async () => ({
            addInitScript: async () => {},
            bringToFront: async () => {},
            evaluate: async () => {},
            exposeBinding: async () => {},
            isClosed: () => true,
            off() {},
            on: () => {},
            once() {},
            removeListener() {},
            route: async () => {},
            unroute: async () => {},
            viewportSize: () => ({ height: 10, width: 10 }),
        }),
        on() {},
        once() {},
        removeListener() {},
    };
    Object.assign(manager, {
        _backgroundPreloadAbort: false,
        _createBrowserContext: async () => localContext,
        _getPrivacyProtectionScript: () => "",
        _navigateAndWakeUpPage: async () => {
            throw new Error("navigation failed");
        },
        _saveDebugArtifacts: async () => {},
        _simulateHumanMovement: async () => {},
        authSource: { getAuth: () => ({}) },
        contexts: new Map([[0, { attemptId: "0:2", context: {}, page: {} }]]),
        stickyProxyManager: { getProxyForAuth: () => null },
    });
    await assert.rejects(
        manager._initializeContext(0, true, {
            authIndex: 0,
            connectionEpoch: null,
            id: "0:1",
            ws: { failed: false, success: false },
        }),
        error => error.reason === "navigation_timeout"
    );
    assert.equal(manager.contexts.get(0).attemptId, "0:2");
    assert.equal(localClosed, true);
});

test("a newer OPEN registry epoch succeeds even when the console event is missing", async () => {
    const registry = {
        getConnectionByAuth: () => ({ readyState: 1 }),
        getConnectionEpoch: () => 2,
    };
    const manager = websocketWaitFixture(registry);
    const attempt = { authIndex: 0, connectionEpoch: 1, id: "0:1", ws: { failed: false, success: false } };
    assert.equal(await manager._waitForWebSocketInit(waitPage(), "[Test]", 5, attempt, false), true);
});

test("an old registry epoch is not accepted as initialization success", async () => {
    const registry = {
        getConnectionByAuth: () => ({ readyState: 1 }),
        getConnectionEpoch: () => 4,
    };
    const manager = websocketWaitFixture(registry);
    const attempt = { authIndex: 0, connectionEpoch: 4, id: "0:1", ws: { failed: false, success: false } };
    assert.equal(await manager._waitForWebSocketInit(waitPage(), "[Test]", 5, attempt, false), false);
    assert.equal(attempt.failureReason, "ws_connection_timeout");
});

test("consent is retried after an ineffective click and succeeds on the second click", async () => {
    const manager = websocketWaitFixture();
    const attempt = { authIndex: 0, connectionEpoch: null, id: "0:1", ws: { failed: false, success: false } };
    let clicks = 0;
    manager._findAndClickButtonByText = async (_page, text, _prefix, _name, click) => {
        if (text !== "Continue to the app") return { clicked: false, found: false };
        if (click) clicks++;
        if (clicks === 2) attempt.ws.success = true;
        return { clicked: click, found: true };
    };
    assert.equal(await manager._waitForWebSocketInit(waitPage(), "[Test]", 20, attempt, false), true);
    assert.equal(clicks, 2);
});

test("consent appearing at the timeout boundary can connect during the bounded grace period", async () => {
    const manager = websocketWaitFixture();
    const attempt = { authIndex: 0, connectionEpoch: null, id: "0:1", ws: { failed: false, success: false } };
    let checks = 0;
    manager._findAndClickButtonByText = async (_page, text, _prefix, _name, click) => {
        if (text !== "Continue to the app") return { clicked: false, found: false };
        checks++;
        const found = checks >= 2;
        if (found && click && checks >= 3) attempt.ws.success = true;
        return { clicked: found && click, found };
    };
    assert.equal(await manager._waitForWebSocketInit(waitPage(), "[Test]", 3, attempt, false), true);
});

test("a consent dialog that never closes reports consent_dialog_timeout", async () => {
    const manager = websocketWaitFixture();
    const attempt = { authIndex: 0, connectionEpoch: null, id: "0:1", ws: { failed: false, success: false } };
    manager._findAndClickButtonByText = async (_page, text, _prefix, _name, click) => ({
        clicked: text === "Continue to the app" && click,
        found: text === "Continue to the app",
    });
    assert.equal(await manager._waitForWebSocketInit(waitPage(), "[Test]", 3, attempt, false), false);
    assert.equal(attempt.failureReason, "consent_dialog_timeout");
});

test("100 cold accounts with 16-worker capacity and two launchers never overlap attempts per account", async () => {
    const manager = singleFlightFixture();
    manager.scheduler = { config: { contextInitConcurrency: 2, maxWorkers: 16 } };
    const active = new Map();
    const peak = new Map();
    manager._initializeContext = async index => {
        active.set(index, (active.get(index) || 0) + 1);
        peak.set(index, Math.max(peak.get(index) || 0, active.get(index)));
        await new Promise(resolve => setImmediate(resolve));
        active.set(index, active.get(index) - 1);
        return index;
    };
    const accounts = Array.from({ length: 100 }, (_, index) => index);
    let cursor = 0;
    const launcher = async () => {
        while (cursor < accounts.length) {
            const index = accounts[cursor++];
            await Promise.all([manager._getOrStartContextInit(index), manager._getOrStartContextInit(index)]);
        }
    };
    await Promise.all([launcher(), launcher()]);
    assert.ok([...peak.values()].every(value => value === 1));
    assert.equal(peak.size, 100);
});

test("init locator and evaluate RPCs that never settle are interrupted by operation hard timeouts", async () => {
    const manager = singleFlightFixture();
    manager.contextOperationTimeoutMs = 10;
    const attempt = { aborted: false, authIndex: 2, id: "2:1", phase: "ws_initialization" };
    manager._contextInitAttempts = new Map([[2, attempt]]);

    for (const operation of ["continue_button.locator.count", "launch_button.evaluate"]) {
        await assert.rejects(
            manager._runInitOperation(attempt, operation, () => new Promise(() => {})),
            error => {
                assert.equal(error.code, "PLAYWRIGHT_RPC_TIMEOUT");
                assert.equal(error.reason, "playwright_rpc_timeout");
                assert.equal(error.operation, operation);
                assert.equal(error.attemptId, "2:1");
                return true;
            }
        );
    }
});

test("total init watchdog releases ownership even when runner and context close never settle", async () => {
    const messages = [];
    const manager = singleFlightFixture();
    manager.contextInitTotalTimeoutMs = 10;
    manager.contextCleanupTimeoutMs = 10;
    manager.contexts = new Map();
    manager.logger = {
        debug() {},
        error(message) {
            messages.push(message);
        },
        info() {},
        warn() {},
    };

    await assert.rejects(
        manager._getOrStartContextInit(5, {
            runner: async attempt => {
                attempt.phase = "ws_initialization";
                attempt.operation = "continue_button.locator.count";
                attempt.context = { close: () => new Promise(() => {}) };
                await new Promise(() => {});
            },
        }),
        error => error.code === "CONTEXT_INIT_TOTAL_TIMEOUT"
    );

    assert.equal(manager._contextInitTasks.size, 0);
    assert.equal(manager._contextInitAttempts.size, 0);
    assert.equal(manager.initializingContexts.size, 0);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.ok(messages.some(message => message.includes("context_init_timeout")));
    assert.ok(messages.some(message => message.includes("context_cleanup_timeout")));
});

test("a runner resolving after its watchdog cannot overwrite a newer attempt", async () => {
    const manager = singleFlightFixture();
    manager.contextInitTotalTimeoutMs = 10;
    manager.contextCleanupTimeoutMs = 5;
    manager.contexts = new Map();
    let releaseOld;
    const old = manager._getOrStartContextInit(6, {
        runner: async attempt => {
            await new Promise(resolve => {
                releaseOld = resolve;
            });
            if (manager._isCurrentInitAttempt(attempt)) {
                manager.contexts.set(6, { attemptId: attempt.id, value: "old" });
            }
        },
    });
    await assert.rejects(old, error => error.code === "CONTEXT_INIT_TOTAL_TIMEOUT");

    manager.contextInitTotalTimeoutMs = 100;
    await manager._getOrStartContextInit(6, {
        runner: async attempt => {
            manager.contexts.set(6, { attemptId: attempt.id, value: "new" });
        },
    });
    releaseOld();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.get(6).value, "new");
});

test("distinct account RPC timeouts request independent evidence before recovery", () => {
    const manager = singleFlightFixture();
    manager.browserRpcFailureThreshold = 2;
    manager.browserRpcFailureWindowMs = 60000;
    manager._browserRpcFailures = [];
    const recoveries = [];
    manager._confirmBrowserFault = reason => recoveries.push(reason);

    manager._recordBrowserRpcTimeout({ authIndex: 1 }, { operation: "page.evaluate" });
    manager._recordBrowserRpcTimeout({ authIndex: 1 }, { operation: "locator.count" });
    assert.deepEqual(recoveries, []);
    manager._recordBrowserRpcTimeout({ authIndex: 2 }, { operation: "locator.count" });
    assert.deepEqual(recoveries, ["playwright_rpc_timeout"]);
});

function quotaPoolFixture(overrides = {}) {
    const manager = browserFixture(3);
    manager.authSource.accountNameMap = new Map();
    const scheduler = new ModelScheduler(
        {
            ...loadSchedulerConfig({ MAX_BROWSER_WORKERS: "3" }),
            contextPoolMinReady: 3,
            dailyResetEnabled: false,
            statePath: null,
            ...overrides,
        },
        manager.authSource,
        logger
    );
    manager.scheduler = scheduler;
    scheduler.browserManager = manager;
    manager.closingContexts = new Set();
    manager.connectionRegistry.getConnectionEpoch = () => null;
    manager.closedIndices = [];
    manager.closeContext = async function (index) {
        assert.equal(this._isContextIdle(index), true);
        this.closedIndices.push(index);
        this.pendingContextClosures.delete(index);
        this.contexts.delete(index);
    };
    return { manager, scheduler };
}

function exhaust(scheduler, index, model = "pro", deadline = scheduler.now() + 60000) {
    Object.assign(scheduler.slot(scheduler.account(index), model, scheduler.now()), {
        cooldown_until: deadline,
        rate_limited: true,
    });
}

test("stale cold demands give a newly ready twelfth context a dispatch opportunity", async t => {
    const { manager, scheduler } = quotaPoolFixture({
        contextMaxConcurrency: 10,
        contextPoolMinReady: 12,
        maxWorkers: 12,
    });
    t.after(() => scheduler.close());
    manager.authSource.getRotationIndices = () => Array.from({ length: 15 }, (_, index) => index);
    for (let index = 0; index < 12; index++) {
        manager.contexts.set(index, { lastRequestAt: 0, page: { isClosed: () => false }, state: "READY" });
        scheduler.account(index).inflight = index === 11 ? 0 : 10;
    }
    scheduler.paused = true;
    const pending = scheduler.acquire("pro");
    pending.catch(() => {});
    for (const index of [12, 13, 14]) manager.contextDemand.set(index, { model: "pro" });
    scheduler.paused = false;
    manager._pumpContextPool();
    assert.equal(manager.contexts.get(11).draining, undefined);
    scheduler.drain();
    const lease = await pending;
    assert.equal(lease.account.index, 11);
    scheduler.release(lease);
    for (let round = 0; round < 8; round++) {
        manager.reconcileContextPool();
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.deepEqual(manager.closedIndices, []);
    assert.equal(manager.contextDemand.size, 0);
    assert.equal(manager._contextInitTasks.size, 0);
});

test("warm deficit caused by draining occupancy never evicts a serviceable idle context", async t => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 2, maxWorkers: 2 });
    t.after(() => scheduler.close());
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    manager.contexts.set(1, {
        draining: true,
        drainReason: "visible_models_rate_limited",
        page: { isClosed: () => false },
        state: "READY",
    });
    scheduler.account(1).inflight = 1;
    manager._pumpContextPool();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(manager.closedIndices, []);
    assert.equal(manager.isContextReady(0), true);
    assert.equal(manager._contextInitTasks.size, 0);
});

test("a pool candidate is revalidated when the request disappears before admission", async t => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 0, maxWorkers: 1 });
    t.after(() => scheduler.close());
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    scheduler.slot(scheduler.account(0), "pro").unsupported = true;
    scheduler.paused = true;
    const controller = new AbortController();
    const pending = scheduler.acquire("pro", new Set(), controller.signal);
    pending.catch(() => {});
    manager.contextDemand.set(1, { model: "pro" });
    assert.ok(manager._poolCandidates().includes(1));
    controller.abort();
    scheduler.paused = false;
    await manager._startPooledContext(1);
    assert.deepEqual(manager.closedIndices, []);
    assert.equal(manager.isContextReady(0), true);
    await assert.rejects(pending, /Client disconnected/);
});

test("multi-model demand checks each pending request's exclusions and cancellation", async t => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 0 });
    t.after(() => scheduler.close());
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    scheduler.paused = true;
    const controller = new AbortController();
    const pro = scheduler.acquire("pro", new Set([scheduler.account(0).key]), controller.signal);
    pro.catch(() => {});
    const flash = scheduler.acquire("flash");
    flash.catch(() => {});
    manager.contextDemand.set(1, { model: "flash", models: new Set(["pro", "flash"]) });
    manager.contextDemand.set(2, { model: "pro" });
    scheduler.slot(scheduler.account(2), "pro").unsupported = true;
    assert.equal(manager._hasValidContextDemand(1), true);
    assert.equal(manager._hasValidContextDemand(2), false);
    controller.abort();
    assert.equal(manager._hasValidContextDemand(1), false);
    scheduler.paused = false;
    scheduler.drain();
    const lease = await flash;
    assert.equal(lease.account.index, 0);
    scheduler.release(lease);
    await assert.rejects(pro, /Client disconnected/);
    assert.deepEqual(manager.closedIndices, []);
});

test("replacement rechecks newly available ready capacity after candidate selection", async t => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 0, maxWorkers: 1 });
    t.after(() => scheduler.close());
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "UNAVAILABLE" });
    scheduler.paused = true;
    const pending = scheduler.acquire("pro");
    pending.catch(() => {});
    manager.contextDemand.set(1, { model: "pro" });
    assert.ok(manager._poolCandidates().includes(1));
    manager.contexts.get(0).state = "READY";
    manager._reserveContextCapacity(1, "demand");
    assert.equal(manager.contexts.get(0).draining, undefined);
    scheduler.paused = false;
    scheduler.drain();
    const lease = await pending;
    assert.equal(lease.account.index, 0);
    scheduler.release(lease);
    assert.deepEqual(manager.closedIndices, []);
});

test("dispatching the last ready slot expands for remaining requests without waiting for release", async t => {
    const { manager, scheduler } = quotaPoolFixture({
        contextMaxConcurrency: 1,
        contextPoolMinReady: 0,
        maxWorkers: 2,
    });
    t.after(() => scheduler.close());
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    scheduler.paused = true;
    const pending = [scheduler.acquire("pro"), scheduler.acquire("pro")];
    for (const promise of pending) promise.catch(() => {});
    manager.contextDemand.set(1, { model: "pro" });
    scheduler.paused = false;
    scheduler.drain();
    const leases = await Promise.all(pending);
    assert.deepEqual(
        leases.map(lease => lease.account.index),
        [0, 1]
    );
    assert.equal(leases[0].released, false);
    assert.deepEqual(manager.closedIndices, []);
    for (const lease of leases) scheduler.release(lease);
});

test("one in-flight initializer covers concurrent stale demands until it can dispatch", async t => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 0 });
    t.after(() => scheduler.close());
    let finishInit;
    const gate = new Promise(resolve => {
        finishInit = resolve;
    });
    t.after(() => finishInit());
    let creations = 0;
    const initialize = manager._initializeContext;
    manager._initializeContext = async function (...args) {
        creations++;
        await gate;
        return initialize.apply(this, args);
    };
    scheduler.paused = true;
    const pending = [scheduler.acquire("pro"), scheduler.acquire("pro")];
    for (const promise of pending) promise.catch(() => {});
    for (const index of [0, 1, 2]) manager.contextDemand.set(index, { model: "pro" });
    scheduler.paused = false;
    manager._pumpContextPool();
    scheduler.drain();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(creations, 1);
    assert.equal(manager._contextInitTasks.size, 1);
    finishInit();
    const leases = await Promise.all(pending);
    assert.ok(leases.every(lease => lease.account.index === 0));
    assert.equal(creations, 1);
    assert.deepEqual(manager.closedIndices, []);
    for (const lease of leases) scheduler.release(lease);
});

test("a genuine model deficit replaces an unrelated idle context and obtains a lease", async t => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 0, maxWorkers: 1 });
    t.after(() => scheduler.close());
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    scheduler.slot(scheduler.account(0), "pro").unsupported = true;
    const lease = await scheduler.acquire("pro");
    assert.equal(lease.account.index, 1);
    assert.deepEqual(manager.closedIndices, [0]);
    assert.equal(manager._contextCapacityIndices().size, 1);
    scheduler.release(lease);
});

test("a request canceled during replacement does not initialize the old cold candidate", async t => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 0, maxWorkers: 1 });
    t.after(() => scheduler.close());
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    scheduler.slot(scheduler.account(0), "pro").unsupported = true;
    let finishClose;
    const closing = new Promise(resolve => {
        finishClose = resolve;
    });
    t.after(() => finishClose());
    const close = manager.closeContext;
    manager.closeContext = async function (...args) {
        await closing;
        return close.apply(this, args);
    };
    let creations = 0;
    const initialize = manager._initializeContext;
    manager._initializeContext = async function (...args) {
        creations++;
        return initialize.apply(this, args);
    };
    const controller = new AbortController();
    const pending = scheduler.acquire("pro", new Set(), controller.signal);
    pending.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager._contextPoolReplacements.size, 1);
    controller.abort();
    finishClose();
    for (let round = 0; round < 4; round++) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(pending, /Client disconnected/);
    assert.equal(creations, 0);
    assert.equal(manager.contextDemand.size, 0);
    assert.equal(manager._contextCapacityIndices().size, 0);
});

test("background recovery demand cannot displace a healthy full pool and expires", async t => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 0, maxWorkers: 1 });
    t.after(() => scheduler.close());
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    manager.requestContext(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(manager.closedIndices, []);
    assert.equal(manager.contextDemand.has(1), true);
    manager.contextDemand.get(1).unscopedUntil = Date.now() - 1;
    assert.deepEqual(manager._poolCandidates(), []);
    assert.equal(manager.contextDemand.has(1), false);
});

test("a foreground waiter can replace idle capacity and leaves no unscoped demand", async t => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 0, maxWorkers: 1 });
    t.after(() => scheduler.close());
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    await Promise.all([manager.ensureWorkerContext(1), manager.ensureWorkerContext(1)]);
    assert.deepEqual(manager.closedIndices, [0]);
    assert.equal(manager.isContextReady(1), true);
    assert.equal(manager._foregroundContextWaiters.size, 0);
    assert.equal(manager.contextDemand.size, 0);
});

test("a timed-out foreground waiter cannot cause a later idle replacement", async t => {
    const { manager, scheduler } = quotaPoolFixture({
        contextPoolMinReady: 0,
        maxWorkers: 1,
        queueTimeoutMs: 10,
    });
    t.after(() => scheduler.close());
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    scheduler.account(0).inflight = 1;
    await assert.rejects(manager.ensureWorkerContext(1), /Timeout waiting for ready context/);
    assert.equal(manager._foregroundContextWaiters.size, 0);
    assert.equal(manager.contextDemand.size, 0);
    scheduler.account(0).inflight = 0;
    manager._pumpContextPool();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(manager.closedIndices, []);
});

test("foreground timeout removes only its unscoped portion of a mixed demand", async t => {
    const { manager, scheduler } = quotaPoolFixture({
        contextPoolMinReady: 0,
        maxWorkers: 1,
        queueTimeoutMs: 10,
    });
    t.after(() => scheduler.close());
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    scheduler.account(0).inflight = 10;
    manager.contextDemand.set(1, { model: "pro", models: new Set(["pro"]) });
    await assert.rejects(manager.ensureWorkerContext(1), /Timeout waiting for ready context/);
    const demand = manager.contextDemand.get(1);
    assert.ok(demand.models.has("pro"));
    assert.equal(demand.unscopedUntil, 0);
    assert.equal(manager._hasValidContextDemand(1), false);
    scheduler.account(0).inflight = 0;
    manager._pumpContextPool();
    assert.equal(manager.contextDemand.size, 0);
    assert.deepEqual(manager.closedIndices, []);
});

test("quota eviction releases every idle context and never rewarms exhausted accounts", async () => {
    const { manager, scheduler } = quotaPoolFixture();
    manager.startContextPool();
    await waitForPool(manager, 3);
    for (const index of [0, 1, 2]) exhaust(scheduler, index);
    // Internal slots must not prevent quota eviction.
    scheduler.slot(scheduler.account(0), "__files__");
    scheduler.coordinateContextPool();
    await waitForPool(manager, 0);
    assert.equal(manager.contexts.size, 0);
    assert.deepEqual(manager._poolCandidates(), []);
    assert.equal(scheduler.summarySnapshot().contexts_summary.effective_warm_target, 0);
    assert.equal(scheduler.summarySnapshot().contexts_summary.all_visible_models_rate_limited, true);
    manager._pumpContextPool();
    await waitForPool(manager, 0);
    assert.equal(manager.closedIndices.length, 3);
    scheduler.resetAllRateLimits();
    await waitForPool(manager, 3);
    assert.equal(manager.contexts.size, 3);
    scheduler.close();
});

test("multiple exhausted accounts drain leases and message queues independently", async () => {
    const { manager, scheduler } = quotaPoolFixture();
    manager.startContextPool();
    await waitForPool(manager, 3);
    const leases = await Promise.all([scheduler.acquire("pro"), scheduler.acquire("pro")]);
    const queuedAuth = leases[1].account.index;
    let queueBusy = true;
    manager.connectionRegistry.hasMessageQueueForAuth = index => index === queuedAuth && queueBusy;
    for (const lease of leases) exhaust(scheduler, lease.account.index);
    scheduler.coordinateContextPool();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.pendingContextClosures.size, 2);
    assert.equal(manager.closedIndices.length, 0);
    for (const lease of leases) assert.equal(scheduler.canLease(lease.account, "pro"), false);
    scheduler.release(leases[0]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.has(leases[0].account.index), false);
    scheduler.release(leases[1]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.has(queuedAuth), true);
    queueBusy = false;
    manager.handleAccountLeaseReleased(queuedAuth);
    await waitForPool(manager, 1);
    assert.equal(manager.contexts.size, 1);
    assert.equal(scheduler.summarySnapshot().contexts_summary.effective_warm_target, 1);
    scheduler.close();
});

test("quota recovery cancels pending drains while preserving capacity and disabled drains", async () => {
    const { manager, scheduler } = quotaPoolFixture();
    manager.startContextPool();
    await waitForPool(manager, 3);
    const lease = await scheduler.acquire("pro");
    exhaust(scheduler, lease.account.index);
    scheduler.coordinateContextPool();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.get(lease.account.index).draining, true);
    // A new, unknown model restores resident eligibility without creating its slot.
    scheduler.config.allocation.flash = { min: 0, preferred: 1 };
    scheduler.coordinateContextPool();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.get(lease.account.index).draining, false);
    assert.equal(lease.account.models.flash, undefined);
    manager.beginAccountDrain(lease.account.index, "context_capacity");
    scheduler.coordinateContextPool();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.get(lease.account.index).draining, true);
    scheduler.disable(lease.account.index);
    scheduler.resetAllRateLimits();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.get(lease.account.index).drainReason, "account_disabled");
    scheduler.release(lease);
    await waitForPool(manager, 2);
    scheduler.close();
});

test("zero context pool wakes at natural cooldown expiry even with daily reset disabled", async () => {
    let now = Date.now();
    const timers = [];
    const { manager, scheduler } = quotaPoolFixture({
        clearTimer() {},
        now: () => now,
        setTimer(callback, delay) {
            const timer = { callback, delay, unref() {} };
            timers.push(timer);
            return timer;
        },
    });
    for (const index of [0, 1, 2]) exhaust(scheduler, index, "pro", now + 1000);
    manager.startContextPool();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.size, 0);
    assert.equal(timers.at(-1).delay, 1000);
    now += 1000;
    timers.at(-1).callback();
    await waitForPool(manager, 3);
    assert.equal(manager.contexts.size, 3);
    assert.equal(scheduler.nextCooldownCheckAt, null);
    scheduler.close();
});

test("new model and internal file demand can initialize a fully exhausted pool", async t => {
    for (const model of ["flash", "__files__"])
        await t.test(model, async () => {
            const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 0 });
            for (const index of [0, 1, 2]) exhaust(scheduler, index);
            manager.startContextPool();
            const lease = await scheduler.acquire(model);
            assert.equal(manager.contexts.size, 1);
            assert.equal(manager.isContextReady(lease.account.index), true);
            scheduler.release(lease, true);
            scheduler.coordinateContextPool();
            await new Promise(resolve => setImmediate(resolve));
            if (model === "__files__") {
                await waitForPool(manager, 0);
                assert.equal(manager.contexts.size, 0);
            } else assert.equal(manager.contexts.size, 1);
            scheduler.close();
        });
});

test("quota changes during initialization prevent publication without transport failures", async () => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 1 });
    const initialize = manager._initializeContext;
    manager._initializeContext = async function (index, ...args) {
        await initialize.call(this, index, ...args);
        for (const candidate of [0, 1, 2]) exhaust(scheduler, candidate);
    };
    manager.startContextPool();
    await waitForPool(manager, 0);
    assert.equal(manager.contexts.size, 0);
    assert.equal(manager.contextUnavailable.size, 0);
    assert.equal(manager._contextInitTasks.size, 0);
    scheduler.close();
});

test("exhausted idle accounts are replaced in the background within capacity", async () => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 2, maxWorkers: 2 });
    manager.startContextPool();
    await waitForPool(manager, 2);
    exhaust(scheduler, 0);
    scheduler.coordinateContextPool();
    await new Promise(resolve => setImmediate(resolve));
    await waitForPool(manager, 2);
    // waitForPool also waits for replacement initialization.
    assert.equal(manager.contexts.has(0), false);
    assert.equal(manager.contexts.has(2), true);
    assert.ok(manager.peak <= 2);
    scheduler.close();
});

test("hiding the only available model drains accounts and hiding all restores empty-set warming", async () => {
    const { manager, scheduler } = quotaPoolFixture({
        allocation: { flash: { min: 0, preferred: 1 }, pro: { min: 0, preferred: 1 } },
    });
    for (const index of [0, 1, 2]) exhaust(scheduler, index);
    manager.startContextPool();
    await waitForPool(manager, 3);
    scheduler.hideModel("flash");
    await new Promise(resolve => setImmediate(resolve));
    await waitForPool(manager, 0);
    assert.equal(manager.contexts.size, 0);
    scheduler.hideModel("pro");
    await waitForPool(manager, 3);
    assert.equal(manager.contexts.size, 3);
    await assert.rejects(scheduler.acquire("pro"), error => error.status === 403);
    scheduler.close();
});

test("quota recovery during an already started close completes closing then reloads once", async () => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 1 });
    manager.startContextPool();
    await waitForPool(manager, 1);
    let finishClose;
    const closing = new Promise(resolve => {
        finishClose = resolve;
    });
    const close = manager.closeContext;
    manager._poolClosingContexts = new Set();
    manager.closeContext = async function (index) {
        this._poolClosingContexts.add(index);
        await close.call(this, index);
        await closing;
        this._poolClosingContexts.delete(index);
        scheduler.coordinateContextPool();
    };
    for (const index of [0, 1, 2]) exhaust(scheduler, index);
    scheduler.coordinateContextPool();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.size, 0);
    scheduler.resetAllRateLimits();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.has(0), false);
    finishClose();
    await waitForPool(manager, 1);
    assert.equal(manager.contexts.size, 1);
    assert.equal(manager.closedIndices.length, 1);
    scheduler.close();
});

test("an actual 429 triggers retirement automatically while a usable Flash keeps its context", async () => {
    const { manager, scheduler } = quotaPoolFixture({
        allocation: { flash: { min: 0, preferred: 1 }, pro: { min: 0, preferred: 1 } },
    });
    manager.startContextPool();
    await waitForPool(manager, 3);
    const lease = await scheduler.acquire("pro");
    scheduler.startAttempt(lease);
    scheduler.failure(lease, { message: "RESOURCE_EXHAUSTED", status: 429 });
    scheduler.release(lease);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.has(lease.account.index), true);
    const flash = await scheduler.acquire("flash", new Set(["auth-1", "auth-2"]));
    assert.equal(flash.account.index, lease.account.index);
    scheduler.startAttempt(flash);
    scheduler.failure(flash, { message: "RESOURCE_EXHAUSTED", status: 429 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.get(flash.account.index).draining, true);
    scheduler.release(flash);
    await waitForPool(manager, 2);
    assert.equal(manager.contexts.has(flash.account.index), false);
    scheduler.close();
});

function capacityFixture({ busy = 9, concurrency = 2, limit = 10, demands = 3 } = {}) {
    const manager = browserFixture(limit);
    const accounts = new Map();
    const indices = Array.from({ length: busy + demands }, (_, index) => index);
    manager.authSource.getRotationIndices = () => indices;
    manager.scheduler.config.contextInitConcurrency = concurrency;
    manager.scheduler.account = index => {
        if (!accounts.has(index)) accounts.set(index, { healthy: true, inflight: index < busy ? 1 : 0 });
        return accounts.get(index);
    };
    manager._hasActiveQueueForAuth = index => manager.scheduler.account(index).inflight > 0;
    for (let index = 0; index < busy; index++)
        manager.contexts.set(index, { page: { isClosed: () => false }, state: "READY" });
    for (let index = busy; index < busy + demands; index++) manager.contextDemand.set(index, { model: null });
    manager.creations = [];
    manager.closedIndices = [];
    const initialize = manager._initializeContext;
    manager._initializeContext = async function (index, ...args) {
        this.creations.push(index);
        assert.ok(this._contextCapacityIndices().size <= limit);
        await initialize.call(this, index, ...args);
        // Keep every new context busy, as a dispatched request would.
        this.scheduler.account(index).inflight = 1;
        assert.ok(this._contextCapacityIndices().size <= limit);
    };
    const close = manager.closeContext;
    manager.closeContext = async function (index, options) {
        assert.equal(this._isContextIdle(index), true);
        this.closedIndices.push(index);
        await close.call(this, index, options);
    };
    return manager;
}

test("two cold demands use the last slot while all nine existing contexts stay busy", async () => {
    const manager = capacityFixture({ demands: 2 });
    manager._pumpContextPool();
    // The second candidate waits without registering a phantom initialization.
    assert.deepEqual([...manager.initializingContexts], [9]);
    assert.equal(manager.contextCapacityReservations.size, 1);
    await waitForPool(manager, 10);
    assert.deepEqual(manager.creations, [9]);
    assert.equal(manager.contexts.size, 10);
    assert.equal(manager.contextCapacityReservations.size, 0);
    assert.equal(manager.contextDemand.has(10), true);
    assert.deepEqual(manager.closedIndices, []);
});

test("capacity and initialization concurrency independently bound cold demand admission", async t => {
    for (const concurrency of [1, 2, 4]) {
        for (const free of [0, 1, 2]) {
            await t.test(`concurrency=${concurrency}, free=${free}`, async () => {
                const manager = capacityFixture({ busy: 10 - free, concurrency, demands: 5 });
                manager._pumpContextPool();
                assert.equal(manager._contextInitTasks.size, Math.min(concurrency, free));
                await waitForPool(manager, 10);
                assert.equal(manager.contexts.size, 10);
                assert.equal(manager.creations.length, free);
                assert.ok((manager.peakInitializations || 0) <= concurrency);
                assert.equal(manager.contextCapacityReservations?.size || 0, 0);
                assert.deepEqual(manager.closedIndices, []);
                // Repeated admission attempts at full capacity cannot create empty attempts.
                const attempts = manager._contextInitSequence;
                for (let index = 0; index < 5; index++) manager._pumpContextPool();
                assert.equal(manager._contextInitSequence, attempts);
            });
        }
    }
});

test("real scheduler dispatches queued Pro through the last slot without interrupting Flash leases", async t => {
    const manager = browserFixture(10);
    manager.authSource.accountNameMap = new Map();
    manager.authSource.getRotationIndices = () => Array.from({ length: 13 }, (_, index) => index);
    const scheduler = new ModelScheduler(
        {
            ...loadSchedulerConfig({
                CONTEXT_MAX_CONCURRENCY: "10",
                GLOBAL_MAX_CONCURRENCY: "100",
                MAX_BROWSER_WORKERS: "10",
                SCHEDULER_DAILY_RESET_ENABLED: "false",
            }),
            contextPoolMinReady: 0,
            queueTimeoutMs: 2000,
            statePath: null,
        },
        manager.authSource,
        logger
    );
    manager.scheduler = scheduler;
    scheduler.browserManager = manager;
    t.after(() => scheduler.close());
    const leases = [];
    t.after(() => leases.forEach(lease => scheduler.release(lease)));
    const closed = [];
    manager.closeContext = async index => {
        assert.equal(scheduler.account(index).inflight, 0);
        closed.push(index);
        manager.contexts.delete(index);
    };
    for (let index = 0; index < 9; index++) {
        manager.contexts.set(index, { page: { isClosed: () => false }, state: "READY" });
        Object.assign(scheduler.slot(scheduler.account(index), "pro"), {
            cooldown_until: Date.now() + 3600000,
            rate_limited: true,
        });
        const excluded = new Set(
            manager.authSource
                .getRotationIndices()
                .filter(other => other !== index)
                .map(other => scheduler.account(other).key)
        );
        leases.push(await scheduler.acquire("flash", excluded));
    }
    const pro = [scheduler.acquire("pro"), scheduler.acquire("pro"), scheduler.acquire("pro")];
    const proLeases = await Promise.all(pro);
    leases.push(...proLeases);
    assert.equal(manager.contexts.size, 10);
    assert.equal(scheduler.pending.length, 0);
    assert.ok(proLeases.every(lease => lease.account.index === 9));
    assert.ok(leases.slice(0, 9).every(lease => !lease.released && lease.account.inflight === 1));
    assert.deepEqual(closed, []);
});

test("replacement retains capacity until close settles and selects each victim only once", async () => {
    const manager = capacityFixture({ busy: 1, demands: 2, limit: 1 });
    manager.scheduler.account(0).inflight = 0;
    let finishClose;
    const closing = new Promise(resolve => {
        finishClose = resolve;
    });
    const close = manager.closeContext;
    manager.closeContext = async function (index, options) {
        await close.call(this, index, options);
        await closing;
    };
    manager._pumpContextPool();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.size, 0);
    assert.equal(manager._contextCapacityIndices().size, 1);
    for (let index = 0; index < 5; index++) manager._pumpContextPool();
    assert.deepEqual(manager.closedIndices, [0]);
    assert.deepEqual(manager.creations, []);
    finishClose();
    await waitForPool(manager, 1);
    assert.equal(manager.contexts.size, 1);
    assert.deepEqual(manager.creations, [1]);
    assert.deepEqual(manager.closedIndices, [0]);
});

test("failed initialization releases its reservation for a different waiting account", async () => {
    const manager = capacityFixture({ busy: 0, demands: 2, limit: 1 });
    const initialize = manager._initializeContext;
    manager._initializeContext = async function (index, ...args) {
        if (index === 0) throw new Error("expected failure");
        return initialize.call(this, index, ...args);
    };
    manager._pumpContextPool();
    await waitForPool(manager, 1);
    assert.deepEqual(manager.creations, [1]);
    assert.equal(manager.contexts.has(1), true);
    assert.equal(manager.contextCapacityReservations.size, 0);
    assert.equal(manager.contextUnavailable.get(0).error.message, "expected failure");
});

test("pooled watchdog holds closing capacity and an old attempt cannot release a newer reservation", async () => {
    const manager = capacityFixture({ busy: 0, demands: 2, limit: 1 });
    manager.contextInitTotalTimeoutMs = 10;
    manager.contextCleanupTimeoutMs = 5;
    let finishClose;
    const closing = new Promise(resolve => {
        finishClose = resolve;
    });
    let finishOld;
    const oldRunner = new Promise(resolve => {
        finishOld = resolve;
    });
    const initialize = manager._initializeContext;
    manager._initializeContext = async function (index, _background, attempt) {
        if (index === 0) {
            attempt.context = { close: () => closing };
            await oldRunner;
            return;
        }
        return initialize.call(this, index);
    };
    manager._pumpContextPool();
    const oldTask = manager._contextInitTasks.get(0);
    await oldTask;
    assert.equal(manager.contextCapacityReservations.size, 0);
    assert.equal(manager.contextUnavailable.get(0).error.code, "CONTEXT_INIT_TOTAL_TIMEOUT");
    assert.equal(manager._contextCapacityIndices().size, 1);
    assert.deepEqual(manager.creations, []);
    manager.contextInitTotalTimeoutMs = 1000;
    finishClose();
    // Hold the next attempt after it has acquired the released capacity.
    let finishNew;
    const newRunner = new Promise(resolve => {
        finishNew = resolve;
    });
    manager._initializeContext = async function (index, ...args) {
        await newRunner;
        return initialize.call(this, index, ...args);
    };
    await new Promise(resolve => setImmediate(resolve));
    const reservation = manager.contextCapacityReservations.get(1);
    assert.ok(reservation);
    finishOld();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contextCapacityReservations.get(1), reservation);
    finishNew();
    await waitForPool(manager, 1);
    assert.equal(manager.contexts.has(1), true);
    assert.equal(manager.contexts.has(0), false);
    assert.equal(manager.contextCapacityReservations.size, 0);
});

test("browser reset cancels pooled ownership and late completion preserves the replacement attempt", async () => {
    const manager = capacityFixture({ busy: 0, demands: 1, limit: 1 });
    manager.closingContexts = new Set();
    manager.contextInitTotalTimeoutMs = 1000;
    let finishOld;
    const oldRunner = new Promise(resolve => {
        finishOld = resolve;
    });
    let finishNew;
    const newRunner = new Promise(resolve => {
        finishNew = resolve;
    });
    let calls = 0;
    const initialize = manager._initializeContext;
    manager._initializeContext = async function (index, ...args) {
        calls++;
        if (calls === 1) {
            await oldRunner;
            return;
        }
        await newRunner;
        return initialize.call(this, index, ...args);
    };
    manager._pumpContextPool();
    const oldTask = manager._contextInitTasks.get(0);
    await new Promise(resolve => setImmediate(resolve));
    manager._cleanupAllContexts();
    await oldTask;
    const replacement = manager._contextInitTasks.get(0);
    const reservation = manager.contextCapacityReservations.get(0);
    assert.ok(replacement && replacement !== oldTask);
    assert.ok(reservation);
    finishOld();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager._contextInitTasks.get(0), replacement);
    assert.equal(manager.contextCapacityReservations.get(0), reservation);
    finishNew();
    await waitForPool(manager, 1);
    assert.equal(manager.creations.length, 1);
    assert.equal(manager.contextCapacityReservations.size, 0);
});

test("shutdown and account disable during admission release capacity without starting creation", async t => {
    for (const reason of ["shutdown", "disable"]) {
        await t.test(reason, async () => {
            const manager = capacityFixture({ busy: 0, demands: 1, limit: 1 });
            let finishEnsure;
            const ensuring = new Promise(resolve => {
                finishEnsure = resolve;
            });
            manager._ensureBrowserForPool = () => ensuring;
            manager.scheduler.isAccountManuallyDisabled = index => manager.scheduler.account(index).disabled === true;
            manager._pumpContextPool();
            const task = manager._contextInitTasks.get(0);
            await new Promise(resolve => setImmediate(resolve));
            if (reason === "shutdown") manager.scheduler.closed = true;
            else manager.scheduler.account(0).disabled = true;
            finishEnsure();
            await task;
            assert.deepEqual(manager.creations, []);
            assert.equal(manager.contextCapacityReservations.size, 0);
            assert.equal(manager._contextInitTasks.size, 0);
            assert.equal(manager.contextUnavailable.size, 0);
        });
    }
});

test("queue drainage wakes capacity admission even without a pending context closure", async () => {
    const manager = capacityFixture({ busy: 1, demands: 1, limit: 1 });
    manager.scheduler.account(0).inflight = 0;
    let queueBusy = true;
    manager._hasActiveQueueForAuth = index => index === 0 && queueBusy;
    const registry = new (require("node:events").EventEmitter)();
    registry.getConnectionByAuth = index => (manager.contexts.has(index) ? {} : null);
    manager.setConnectionRegistry(registry);
    manager.scheduler.coordinateContextPool = () => manager._pumpContextPool();
    manager._pumpContextPool();
    assert.equal(manager._contextInitTasks.size, 0);
    assert.equal(manager.pendingContextClosures.size, 0);
    assert.deepEqual(manager.closedIndices, []);
    queueBusy = false;
    registry.emit("authQueuesDrained", 0);
    await new Promise(resolve => setImmediate(resolve));
    await waitForPool(manager, 1);
    assert.deepEqual(manager.creations, [1]);
    assert.deepEqual(manager.closedIndices, [0]);
});

test("direct initialization cannot bypass pooled capacity admission", async () => {
    const manager = capacityFixture({ busy: 1, demands: 1, limit: 1 });
    manager.scheduler.config.readyContextOnly = true;
    await assert.rejects(manager._getOrStartContextInit(1), /waiting for context capacity/);
    assert.equal(manager._contextInitTasks.size, 0);
    assert.equal(manager.contextCapacityReservations.size, 0);
    assert.deepEqual(manager.creations, []);
    assert.deepEqual(manager.closedIndices, []);
});

test("dashboard distinguishes draining and closing capacity from idle READY and cold failures", () => {
    const { manager, scheduler } = quotaPoolFixture({ contextPoolMinReady: 0 });
    for (const index of [0, 1]) {
        manager.contexts.set(index, { page: { isClosed: () => false }, state: "READY" });
        scheduler.account(index).inflight = 1;
    }
    Object.assign(manager.contexts.get(0), { draining: true, drainReason: "context_capacity" });
    let contexts = manager.getContextPoolSnapshot();
    const draining = contexts.find(context => context.auth_index === 0);
    assert.equal(draining.state, "DRAINING");
    assert.equal(draining.inflight, 1);
    assert.equal(manager.isContextReady(0), false);
    let summary = scheduler.summarySnapshot();
    assert.equal(summary.contexts_summary.occupied, 2);
    assert.equal(summary.contexts_summary.busy, 1);
    assert.equal(summary.contexts_summary.ready, 0);
    assert.equal(summary.contexts_summary.draining, 1);
    assert.equal(summary.active_browser_workers, 2);
    assert.equal(scheduler.contextsSnapshot().contexts.find(context => context.auth_index === 0).state, "DRAINING");

    manager._poolClosingContexts = new Set([0]);
    manager.contexts.delete(0);
    manager.contextUnavailable.set(2, { reason: "previous initialization failure" });
    contexts = manager.getContextPoolSnapshot();
    assert.equal(contexts.find(context => context.auth_index === 0).state, "CLOSING");
    summary = scheduler.summarySnapshot();
    assert.equal(summary.contexts_summary.occupied, 2);
    assert.equal(summary.contexts_summary.closing, 1);
    assert.equal(summary.contexts_summary.draining, 0);
    assert.equal(summary.contexts_summary.unavailable, 1);
    assert.equal(summary.contexts_summary.unavailable_occupied, 0);
    scheduler.close();
});

test("different proxy warm pool initializes distinct exits within the context limit", async t => {
    const manager = browserFixture(2);
    manager.authSource.accountNameMap = new Map();
    const scheduler = new ModelScheduler(
        {
            ...loadSchedulerConfig({ ACCOUNT_ROTATION_STRATEGY: "different_proxy_first", MAX_BROWSER_WORKERS: "2" }),
            dailyResetEnabled: false,
            statePath: null,
        },
        manager.authSource,
        logger
    );
    manager.scheduler = scheduler;
    scheduler.browserManager = manager;
    manager._proxyResolver = index => ({ egressKey: index < 2 ? "P1" : "P2" });
    const initialize = manager._initializeContext;
    manager._initializeContext = async index => {
        await initialize.call(manager, index);
        manager.contexts.get(index).proxyInfo = manager._proxyResolver(index);
    };
    t.after(() => scheduler.close());
    manager.startContextPool();
    await waitForPool(manager, 2);
    assert.equal(manager.contexts.size, 2);
    assert.deepEqual(
        new Set([...manager.contexts.values()].map(context => context.proxyInfo.egressKey)),
        new Set(["P1", "P2"])
    );
    assert.ok(manager.peak <= 2);
    assert.ok(manager.peakInitializations <= 2);
});
