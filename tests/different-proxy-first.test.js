const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const BrowserManager = require("../src/core/BrowserManager");
const loadConfig = require("../src/core/SchedulerConfig");
const ProxyBindingService = require("../src/proxy/ProxyBindingService");
const ProxyPoolService = require("../src/proxy/ProxyPoolService");
const ProxyPoolStore = require("../src/proxy/ProxyPoolStore");
const { egressKey, normalizeGroup, snapshotEgress } = require("../src/proxy/ProxyEgressIdentity");
const logger = { debug() {}, error() {}, info() {}, warn() {} };

function setup(t, groups, overrides = {}) {
    const config = {
        ...loadConfig({ ACCOUNT_ROTATION_STRATEGY: "different_proxy_first", MAX_BROWSER_WORKERS: "4" }),
        dailyResetEnabled: false,
        statePath: null,
        ...overrides,
    };
    const auth = {
        accountNameMap: new Map(),
        availableIndices: groups.map((_, index) => index),
        getRotationIndices() {
            return this.availableIndices;
        },
    };
    const scheduler = new ModelScheduler(config, auth, logger);
    const manager = Object.create(BrowserManager.prototype);
    Object.assign(manager, {
        _contextInitAttempts: new Map(),
        _contextInitTasks: new Map(),
        _proxyResolver: index => ({ egressKey: groups[index] }),
        authSource: auth,
        contextDemand: new Map(),
        contexts: new Map(groups.map((group, index) => [index, { proxyInfo: { egressKey: group }, state: "READY" }])),
        contextUnavailable: new Map(),
        initializingContexts: new Set(),
        isContextReady(index) {
            const data = this.contexts.get(index);
            return !!data && !data.draining;
        },
        logger,
        pendingContextClosures: new Map(),
        // Tests drive pool coordination explicitly, without asynchronous browser work.
        reconcileContextPool() {},

        scheduler,
    });
    scheduler.browserManager = manager;
    t.after(() => scheduler.close());
    return { auth, manager, scheduler };
}

test("new strategy enables model scheduling and keeps existing default", () => {
    assert.equal(loadConfig({ ACCOUNT_ROTATION_STRATEGY: "different_proxy_first" }).enabled, true);
    assert.equal(loadConfig({}).strategy, "least_recently_used");
    assert.equal(loadConfig({ ACCOUNT_ROTATION_STRATEGY: "legacy" }).enabled, false);
});

test("context-spread requests have the same account order as LRU", async t => {
    const groups = ["P1", "P1", "P1", "P2", "P3"];
    const spread = setup(t, groups);
    const lru = setup(t, groups, { strategy: "least_recently_used" });
    let routes = 0;
    spread.manager._proxyResolver = () => {
        routes++;
        throw new Error("cold route must not be read");
    };
    const chosen = [];
    for (let i = 0; i < 15; i++) {
        const a = await spread.scheduler.acquire("flash");
        const b = await lru.scheduler.acquire("flash");
        chosen.push(a.account.index);
        assert.equal(a.account.index, b.account.index);
        spread.scheduler.startAttempt(a);
        spread.scheduler.release(a, true);
        lru.scheduler.startAttempt(b);
        lru.scheduler.release(b, true);
    }
    assert.deepEqual(chosen.slice(0, 5), [0, 1, 2, 3, 4]);
    assert.equal(routes, 0);
});

test("model cooling, account exclusions and concurrency still constrain ordinary dispatch", async t => {
    const { scheduler } = setup(t, ["P1", "P1", "P2"], { accountConcurrency: 1 });
    const slot = scheduler.slot(scheduler.account(2), "flash");
    slot.rate_limited = true;
    slot.cooldown_until = Date.now() + 60000;
    const a = await scheduler.acquire("flash", new Set([scheduler.account(0).key]));
    assert.equal(a.account.index, 1);
    const b = await scheduler.acquire("other");
    assert.equal(b.account.index, 0);
    const c = await scheduler.acquire("other");
    assert.equal(c.account.index, 2);
    assert.ok([a, b, c].every(lease => lease.account.inflight === 1));
    for (const lease of [a, b, c]) scheduler.release(lease);
});

test("existing context snapshots are enough for pool observability", async t => {
    const { scheduler, manager } = setup(t, ["P1", "P1", "P2", "P3"]);
    manager.contexts.delete(3);
    let routes = 0;
    manager._proxyResolver = () => {
        routes++;
        return { egressKey: "changed" };
    };
    const lease = await scheduler.acquire("flash");
    const snapshot = scheduler.summarySnapshot();
    assert.deepEqual(snapshot.egress.groups, [
        { contexts: 2, inflight: 1, key: "P1", ready_contexts: 2 },
        { contexts: 1, inflight: 0, key: "P2", ready_contexts: 1 },
    ]);
    assert.equal(snapshot.models.find(model => model.model === "flash").ready_egress_groups, 2);
    assert.equal(routes, 0);
    scheduler.beginRecovery("test");
    scheduler.release(lease);
    assert.ok(scheduler.workers.every(worker => !worker.lease));
    assert.equal(routes, 0);
});

test("warm planning spreads groups and counts admitted initializers", t => {
    const { manager, scheduler } = setup(t, ["P1", "P1", "P2", "P3"], { contextPoolMinReady: 3 });
    manager.contexts.clear();
    assert.deepEqual(manager._poolCandidates(), [0, 2, 3]);
    manager.initializingContexts.add(0);
    manager._contextInitTasks.set(0, Promise.resolve());
    assert.deepEqual(manager._poolCandidates(), [2, 3]);
    assert.equal(scheduler.pending.length, 0);
});

test("new contexts prefer the least resident exit and fall back within a single exit", t => {
    const { manager } = setup(t, ["P1", "P1", "P1", "P2", "P2", "P3"]);
    for (const index of [2, 4, 5]) manager.contexts.delete(index);
    assert.deepEqual(manager.orderContextCandidates([2, 4, 5], 3), [5, 4, 2]);
    assert.deepEqual(manager.orderContextCandidates([2], 1), [2]);
    assert.deepEqual(manager.orderContextCandidates([], 1), []);
});

test("planning resolves each candidate route once and never silently substitutes direct", t => {
    const { manager } = setup(t, ["P1", "P1", "P2", "P3"]);
    manager.contexts.clear();
    const calls = new Map();
    manager._proxyResolver = index => {
        calls.set(index, (calls.get(index) || 0) + 1);
        if (index === 3) throw new Error("bound node unavailable");
        return { egressKey: index < 2 ? "P1" : "P2" };
    };
    assert.deepEqual(manager.orderContextCandidates([0, 1, 2, 3]), [0, 2, 1]);
    assert.deepEqual([...calls.values()], [1, 1, 1, 1]);
});

test("a full pool is reused without route scans, balancing swaps or pending-model coverage repair", t => {
    const { manager, scheduler } = setup(t, ["P1", "P1", "P2", "P3"], { contextPoolMinReady: 2, maxWorkers: 2 });
    manager.contexts.delete(2);
    manager.contexts.delete(3);
    let routes = 0;
    manager._proxyResolver = () => {
        routes++;
        return { egressKey: "new" };
    };
    scheduler.pending.push({ excluded: new Set(), model: "pro" });
    manager.closeContext = () => assert.fail("Healthy contexts must not be swapped just for diversity");
    assert.deepEqual(manager._poolCandidates(), []);
    manager._replaceIdlePooledContext(2, "warm");
    assert.equal(manager.contexts.size, 2);
    assert.equal(routes, 0);
    scheduler.pending.length = 0;
});

test("a naturally freed slot is filled from an underrepresented exit", t => {
    const { manager } = setup(t, ["P1", "P1", "P2"], { contextPoolMinReady: 2, maxWorkers: 2 });
    manager.contexts.delete(2);
    assert.deepEqual(manager._poolCandidates(), []);
    manager.contexts.delete(1);
    assert.deepEqual(manager._poolCandidates(), [2]);
    manager.contextUnavailable.set(2, { retryAt: Date.now() + 60000 });
    assert.deepEqual(manager._poolCandidates(), [1]);
});

test("cold model preparation is deferred and preserves model eligibility", async t => {
    const { scheduler, manager } = setup(t, ["P1", "P1", "P2", "P3"], { contextPoolMinReady: 0 });
    manager.contexts.delete(2);
    manager.contexts.delete(3);
    for (const index of [0, 1, 3]) scheduler.slot(scheduler.account(index), "pro").unsupported = true;
    const demands = [];
    manager.requestContexts = requests => {
        assert.equal(scheduler._draining, false);
        demands.push(...requests);
    };
    const controller = new AbortController();
    const cold = scheduler.acquire("pro", new Set(), controller.signal);
    const hot = await scheduler.acquire("flash");
    assert.equal(demands.length, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(demands, [{ authIndex: 2, model: "pro" }]);
    scheduler.release(hot);
    controller.abort();
    await assert.rejects(cold, /disconnected/);
});

for (const queueSize of [40, 300, 1000]) {
    test(`218 accounts and ${queueSize} queued requests dispatch without cold proxy reads`, async t => {
        const groups = Array.from({ length: 218 }, (_, index) => `P${index % 5}`);
        const { scheduler, manager, auth } = setup(t, groups, {
            contextMaxConcurrency: 10,
            contextPoolMinReady: 12,
            globalConcurrency: 120,
            globalQueueSize: 1000,
            maxWorkers: 12,
            queueSize: 1000,
        });
        auth.accountLoginService = {
            state: { accounts: groups.map((_, authIndex) => ({ authIndex, manualTier: "free" })) },
        };
        for (let index = 12; index < groups.length; index++) manager.contexts.delete(index);
        let routes = 0;
        manager._proxyResolver = () => {
            routes++;
            throw new Error("Unexpected cold route lookup");
        };
        scheduler.paused = true;
        const requests = Array.from({ length: queueSize }, (_, index) =>
            scheduler.acquire(["flash", "pro", "other"][index % 3])
        );
        scheduler.paused = false;
        let completed = 0;
        const done = requests.map(async request => {
            const lease = await request;
            scheduler.startAttempt(lease);
            scheduler.release(lease, true);
            completed++;
        });
        scheduler.drain();
        await Promise.all(done);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(completed, queueSize);
        assert.equal(scheduler.pending.length, 0);
        assert.equal(scheduler.metrics.dispatch_timeout, 0);
        assert.ok(scheduler.workers.every(worker => !worker.lease));
        assert.equal(routes, 0);
        assert.deepEqual(manager._poolCandidates(), []);
        assert.equal(routes, 0);
    });
}

test("proxy identity normalizes routes without leaking credentials and unifies direct", () => {
    const a = egressKey({ proxy: { server: "HTTP://user:secret@EXAMPLE.COM:80" } });
    const b = egressKey({ proxy: { password: "secret", server: "http://example.com/", username: "user" } });
    assert.equal(a, b);
    assert.doesNotMatch(a, /secret|user|example/);
    assert.notEqual(a, egressKey({ proxy: { password: "secret", server: "http://example.com:81", username: "user" } }));
    assert.notEqual(a, egressKey({ proxy: { password: "secret", server: "http://example.com", username: "other" } }));
    assert.equal(egressKey({ appliedNodeId: "node-direct", egressGroup: "ignored", source: "direct_node" }), "direct");
    assert.equal(
        egressKey({ appliedNodeId: "one", egressGroup: " same ", proxy: { server: "socks5://localhost:10801" } }),
        "group:same"
    );
    assert.equal(normalizeGroup(" same "), "same");
    for (const value of [1, {}, "a".repeat(81), "a\nb"]) assert.throws(() => normalizeGroup(value));
});

test("node and legacy binding groups persist and report pending until context application", async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-test-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const store = new ProxyPoolStore(logger, path.join(dir, "pool.json"));
    const data = store.snapshot();
    data.settings.enabled = true;
    data.nodes.push({
        egressGroup: "shared",
        host: "example.com",
        id: "one",
        localPort: 10801,
        name: "One",
        port: 1080,
        type: "socks5",
    });
    data.bindings.user = { desiredNodeId: "one" };
    await store.replace(data);
    const manager = {
        contexts: new Map(),
        contextUnavailable: new Map(),
        initializingContexts: new Set(),
        stickyProxyManager: { getProxyForAuth: () => ({ proxy: { server: "http://example.com" } }) },
    };
    const auth = { accountNameMap: new Map([[0, "user"]]), availableIndices: [0] };
    const bindings = new ProxyBindingService(store, { status: { ready: true } }, manager, auth);
    const service = Object.assign(Object.create(ProxyPoolService.prototype), { bindings, store });
    const original = bindings.resolve(0);
    manager.contexts.set(0, { proxyInfo: original });
    assert.equal(original.egressKey, "group:shared");
    assert.equal(bindings.list()[0].state, "applied");
    const changed = store.snapshot();
    changed.nodes[0].egressGroup = "new";
    await store.replace(changed);
    assert.equal(bindings.list()[0].state, "pending");
    assert.equal(bindings.list()[0].appliedEgressKey, "group:shared");
    manager.contexts.get(0).proxyInfo = bindings.resolve(0);
    assert.equal(bindings.list()[0].state, "applied");
    await service.setBinding("user", null, "legacy");
    assert.equal(bindings.resolve(0).egressKey, "group:legacy");
    const reloaded = new ProxyPoolStore(logger, store.filePath);
    assert.equal(reloaded.snapshot().bindings.user.egressGroup, "legacy");
    await assert.rejects(service.setBinding("user", null, "x".repeat(81)), /80/);
    const snapshot = snapshotEgress(bindings.resolve(0));
    await service.setBinding("user", null, "next");
    assert.equal(snapshot.egressKey, "group:legacy");
});
