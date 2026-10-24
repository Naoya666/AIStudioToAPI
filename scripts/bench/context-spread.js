// Local synthetic benchmark. Does not connect to browsers, upstream APIs or servers.
const { performance } = require("node:perf_hooks");
const { ModelScheduler } = require("../../src/core/ModelScheduler");
const BrowserManager = require("../../src/core/BrowserManager");
const loadConfig = require("../../src/core/SchedulerConfig");
const ProxyBindingService = require("../../src/proxy/ProxyBindingService");
const ProxyPoolStore = require("../../src/proxy/ProxyPoolStore");
const models = ["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.8-flash"];
const logger = { debug() {}, error() {}, info() {}, warn() {} };

async function sample(strategy, queueSize) {
    const indices = Array.from({ length: 218 }, (_, index) => index);
    const auth = {
        accountLoginService: { state: { accounts: indices.map(authIndex => ({ authIndex, manualTier: "free" })) } },
        accountNameMap: new Map(indices.map(index => [index, `synthetic-${index}`])),
        getRotationIndices: () => indices,
        isExpired: () => false,
    };
    const scheduler = new ModelScheduler(
        {
            ...loadConfig({
                ACCOUNT_ROTATION_STRATEGY: strategy,
                CONTEXT_MAX_CONCURRENCY: "10",
                GLOBAL_MAX_CONCURRENCY: "120",
                MAX_BROWSER_WORKERS: "12",
            }),
            dailyResetEnabled: false,
            globalQueueSize: 1000,
            queueSize: 1000,
            registeredModels: models,
            statePath: null,
        },
        auth,
        logger
    );
    const manager = Object.assign(Object.create(BrowserManager.prototype), {
        _contextInitAttempts: new Map(),
        _contextInitTasks: new Map(),
        authSource: auth,
        connectionRegistry: { getConnectionByAuth: () => ({ readyState: 1 }) },
        contextDemand: new Map(),
        contexts: new Map(),
        contextUnavailable: new Map(),
        initializingContexts: new Set(),
        logger,
        pendingContextClosures: new Map(),
        reconcileContextPool() {
            this._poolCandidates();
        },
        scheduler,
    });
    const data = {
        bindings: Object.fromEntries(
            indices.map(index => [`synthetic-${index}`, { desiredNodeId: `proxy-${index % 5}` }])
        ),
        nodes: Array.from({ length: 5 }, (_, index) => ({
            id: `proxy-${index}`,
            localPort: 10801 + index,
            name: `P${index}`,
            type: "socks5",
        })),
        settings: { enabled: true },
    };
    const store = Object.assign(Object.create(ProxyPoolStore.prototype), { data });
    const bindings = new ProxyBindingService(store, { status: { ready: true } }, manager, auth);
    let routeReads = 0,
        snapshots = 0;
    manager._proxyResolver = index => {
        routeReads++;
        return bindings.resolve(index);
    };
    for (const index of indices) for (const model of models) scheduler.slot(scheduler.account(index), model);
    for (let index = 0; index < 12; index++)
        manager.contexts.set(index, {
            page: { isClosed: () => false },
            proxyInfo: bindings.resolve(index),
            state: "READY",
        });
    for (const name of ["snapshot", "snapshotForAccount"]) {
        const original = store[name];
        store[name] = function (...args) {
            snapshots++;
            return original.apply(this, args);
        };
    }
    scheduler.browserManager = manager;
    routeReads = 0;
    scheduler.paused = true;
    const pending = Array.from({ length: queueSize }, (_, index) => scheduler.acquire(models[index % models.length]));
    const waits = [];
    const started = performance.now();
    try {
        const completed = pending.map(async request => {
            const lease = await request;
            waits.push(performance.now() - started);
            scheduler.startAttempt(lease);
            scheduler.release(lease, true);
        });
        scheduler.paused = false;
        scheduler.drain();
        await Promise.all(completed);
        await new Promise(resolve => setImmediate(resolve));
        const dispatchMs = performance.now() - started;
        const poolSamples = [];
        for (let round = 0; round < 21; round++) {
            const begin = performance.now();
            manager._poolCandidates();
            poolSamples.push(performance.now() - begin);
        }
        waits.sort((a, b) => a - b);
        poolSamples.sort((a, b) => a - b);
        if (routeReads || snapshots || scheduler.metrics.dispatch_timeout)
            throw new Error("Unexpected proxy work or dispatch timeout");
        return {
            cold_route_reads: routeReads,
            dispatch_ms: +dispatchMs.toFixed(3),
            dispatch_timeouts: scheduler.metrics.dispatch_timeout,
            full_pool_planning_p50_ms: +poolSamples[10].toFixed(3),
            proxy_snapshots: snapshots,
            queue: queueSize,
            selected: waits.length,
            strategy,
            wait_p95_ms: +waits[Math.ceil(waits.length * 0.95) - 1].toFixed(3),
        };
    } finally {
        scheduler.close();
    }
}

(async () => {
    console.log(
        JSON.stringify({
            accounts: 218,
            contexts: 12,
            exits: 5,
            node: process.version,
            note: "Local synthetic dispatch; immediate request completion; excludes paused enqueue time and upstream I/O",
        })
    );
    // Alternate strategies to reduce ordering bias. Larger queues also exercise continuation across 8ms rounds.
    for (const queueSize of [40, 300, 1000]) {
        for (let round = 0; round < (queueSize === 1000 ? 1 : 3); round++) {
            for (const strategy of round % 2
                ? ["different_proxy_first", "least_recently_used"]
                : ["least_recently_used", "different_proxy_first"]) {
                console.log(JSON.stringify({ round, ...(await sample(strategy, queueSize)) }));
            }
        }
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
