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

test("serial requests rotate exits independently of account counts", async t => {
    const { scheduler } = setup(t, ["P1", "P1", "P1", "P2", "P3"]);
    const chosen = [];
    const accounts = [];
    for (let i = 0; i < 9; i++) {
        const lease = await scheduler.acquire("flash");
        chosen.push(lease.egressKey);
        accounts.push(lease.account.index);
        scheduler.release(lease);
    }
    assert.deepEqual(chosen, ["P1", "P2", "P3", "P1", "P2", "P3", "P1", "P2", "P3"]);
    assert.deepEqual(
        accounts.filter((_, i) => i % 3 === 0),
        [0, 1, 2]
    );
    assert.equal(
        [...scheduler.egress.values()].reduce((n, group) => n + group.inflight, 0),
        0
    );
});

test("a single drain round reserves exits synchronously across workers and models", async t => {
    const { scheduler } = setup(t, ["P1", "P1", "P2", "P3"], { globalConcurrency: 6 });
    scheduler.paused = true;
    const requests = ["flash", "pro", "flash", "pro", "flash", "pro"].map(model => scheduler.acquire(model));
    scheduler.paused = false;
    scheduler.drain();
    const leases = await Promise.all(requests);
    assert.deepEqual(
        leases.map(lease => lease.egressKey),
        ["P1", "P2", "P3", "P1", "P2", "P3"]
    );
    assert.deepEqual(
        [...scheduler.egress.values()].map(group => group.inflight),
        [2, 2, 2]
    );
    const snapshot = scheduler.summarySnapshot();
    assert.equal(
        snapshot.egress.groups.reduce((n, group) => n + group.inflight, 0),
        snapshot.active_workers
    );
    assert.equal(snapshot.egress.groups.find(group => group.key === "P1").ready_accounts, 2);
    for (const lease of leases) {
        scheduler.release(lease);
        scheduler.release(lease);
    }
    assert.ok([...scheduler.egress.values()].every(group => group.inflight === 0));
});

test("exit load precedes account load, while a single exit retains original LRU order", async t => {
    const { scheduler } = setup(t, ["P1", "P1", "P2"], { globalConcurrency: 5 });
    const first = await scheduler.acquire("flash");
    const second = await scheduler.acquire("flash");
    const third = await scheduler.acquire("flash");
    assert.deepEqual([first.egressKey, second.egressKey, third.egressKey], ["P1", "P2", "P1"]);
    // P2 now has less total load, even though P1 has a lower per-account load.
    const fourth = await scheduler.acquire("other");
    assert.equal(fourth.egressKey, "P2");
    for (const lease of [first, second, third, fourth]) scheduler.release(lease);

    const same = setup(t, ["P1", "P1", "P1"]);
    const original = setup(t, ["P1", "P1", "P1"], { strategy: "least_recently_used" });
    for (const pool of [same.scheduler, original.scheduler]) {
        pool.slot(pool.account(0), "flash").last_used_at = 300;
        pool.slot(pool.account(1), "flash").last_used_at = 100;
        pool.slot(pool.account(2), "flash").last_used_at = 200;
    }
    const a = await same.scheduler.acquire("flash");
    const b = await original.scheduler.acquire("flash");
    assert.equal(a.account.index, b.account.index);
    assert.equal(a.account.index, 1);
    assert.equal(same.scheduler.metricsSnapshot().single_egress_fallbacks, 1);
});

test("model cooldown and account exclusions remain hard constraints", async t => {
    const { scheduler } = setup(t, ["P1", "P1", "P2", "P3"]);
    for (const index of [2, 3]) {
        const slot = scheduler.slot(scheduler.account(index), "flash");
        slot.cooldown_until = Date.now() + 60000;
        slot.rate_limited = true;
    }
    const lease = await scheduler.acquire("flash", new Set([scheduler.account(0).key]));
    assert.equal(lease.account.index, 1);
    scheduler.release(lease);
    const other = await scheduler.acquire("other");
    assert.equal(other.egressKey, "P2");
    assert.equal(scheduler.summarySnapshot().models.find(model => model.model === "flash").ready_egress_groups, 1);
});

test("retry exit history is a soft preference after hard account affinity", async t => {
    const { scheduler } = setup(t, ["P1", "P1", "P2"]);
    const busy = await scheduler.acquire("other", new Set([scheduler.account(0).key, scheduler.account(1).key]));
    const retry = await scheduler.acquire("flash", new Set([scheduler.account(0).key]), undefined, {
        attemptedEgress: new Set(["P1"]),
    });
    assert.equal(retry.egressKey, "P2");
    scheduler.release(retry);
    const affinity = await scheduler.acquire(
        "flash",
        new Set([scheduler.account(0).key, scheduler.account(2).key]),
        undefined,
        {
            attemptedEgress: new Set(["P1"]),
        }
    );
    assert.equal(affinity.account.index, 1);
    scheduler.release(affinity);
    scheduler.release(busy);
});

test("binding changes and recovery release the leased exit snapshot exactly once", async t => {
    const { scheduler, manager } = setup(t, ["P1", "P2"]);
    const lease = await scheduler.acquire("flash");
    manager.contexts.get(lease.account.index).proxyInfo = { egressKey: "P3" };
    scheduler.beginRecovery("test");
    scheduler.release(lease);
    assert.equal(scheduler.egress.get("P1").inflight, 0);
    assert.equal(scheduler.egress.has("P3"), false);
    assert.ok(scheduler.workers.every(worker => !worker.lease));
    scheduler.egressSnapshot(new Set(["flash"]));
    assert.equal(scheduler.egress.has("P1"), false);
});

test("cancellation of a queued request creates no exit reservation", async t => {
    const { scheduler } = setup(t, ["P1"], { globalConcurrency: 1 });
    const active = await scheduler.acquire("flash");
    const controller = new AbortController();
    const queued = scheduler.acquire("flash", new Set(), controller.signal);
    controller.abort();
    await assert.rejects(queued, /disconnected/);
    assert.equal(scheduler.egress.get("P1").inflight, 1);
    scheduler.release(active);
    assert.equal(scheduler.egress.get("P1").inflight, 0);
});

test("cold exits do not delay dispatch and invalid routes never become direct", async t => {
    const { scheduler, manager } = setup(t, ["P1", "P2", "P3"]);
    manager.contexts.delete(1);
    manager.contexts.delete(2);
    manager._proxyResolver = index => {
        if (index === 2) throw new Error("node unavailable");
        return { egressKey: "P2" };
    };
    manager.requestContexts = () => {};
    const lease = await scheduler.acquire("flash");
    assert.equal(lease.egressKey, "P1");
    assert.equal(scheduler.accountEgressKey(scheduler.account(2)), null);
    scheduler.release(lease);
});

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

test("warm planning spreads groups and counts admitted initializers", t => {
    const { manager, scheduler } = setup(t, ["P1", "P1", "P2", "P3"], { contextPoolMinReady: 3 });
    manager.contexts.clear();
    assert.deepEqual(manager._poolCandidates(), [0, 2, 3]);
    manager.initializingContexts.add(0);
    manager._contextInitTasks.set(0, Promise.resolve());
    assert.deepEqual(manager._poolCandidates(), [2, 3]);
    assert.equal(scheduler.pending.length, 0);
});

test("full pool repairs duplicated exits without cycling when exits exceed capacity", async t => {
    const { manager, scheduler } = setup(t, ["P1", "P1", "P2", "P3"], { contextPoolMinReady: 2, maxWorkers: 2 });
    manager.contexts.delete(2);
    manager.contexts.delete(3);
    assert.deepEqual(manager._poolCandidates(), [2]);
    manager._pumpContextPool = () => {};
    manager.closeContext = async index => manager.contexts.delete(index);
    assert.equal(manager._reserveContextCapacity(2, "warm"), null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.size, 1);
    assert.equal(scheduler.metrics.egress_diversity_replacements, 1);
    manager.contexts.set(2, { proxyInfo: { egressKey: "P2" }, state: "READY" });
    manager._lastEgressReplacementAt = 0;
    assert.deepEqual(manager._poolCandidates(), []);
    assert.deepEqual(manager._egressDiversityVictims(3), []);
});

test("diversity respects busy contexts, pending model coverage, capacity one and retry backoff", t => {
    const { manager, scheduler } = setup(t, ["P1", "P1", "P2"], { contextPoolMinReady: 2, maxWorkers: 2 });
    manager.contexts.delete(2);
    scheduler.account(0).inflight = 1;
    scheduler.account(1).inflight = 1;
    assert.deepEqual(manager._poolCandidates(), []);
    scheduler.account(0).inflight = 0;
    scheduler.account(1).inflight = 0;
    scheduler.slot(scheduler.account(1), "pro").unsupported = true;
    scheduler.slot(scheduler.account(2), "pro").unsupported = true;
    scheduler.pending.push({ excluded: new Set(), model: "pro" });
    assert.deepEqual(manager._egressDiversityVictims(2), [1]);
    manager.contextUnavailable.set(2, { retryAt: Date.now() + 60000 });
    assert.deepEqual(manager._poolCandidates(), []);
    manager.contextUnavailable.clear();
    scheduler.config.maxWorkers = 1;
    assert.deepEqual(manager._poolCandidates(), []);
    scheduler.pending.length = 0;
});

test("model-specific coverage can improve without changing global group coverage", t => {
    const { manager, scheduler } = setup(t, ["P1", "P2", "P2"], { contextPoolMinReady: 2, maxWorkers: 2 });
    manager.contexts.delete(2);
    scheduler.slot(scheduler.account(1), "pro").unsupported = true;
    scheduler.pending.push({ excluded: new Set(), model: "pro" });
    assert.deepEqual(manager._poolCandidates(), [2]);
    assert.deepEqual(manager._egressDiversityVictims(2), [1]);
    scheduler.pending.length = 0;
});

test("shutdown aborts active leases and returns every exit reservation", async t => {
    const { scheduler } = setup(t, ["P1", "P2"]);
    const lease = await scheduler.acquire("flash");
    let aborted = false;
    lease.abort = () => {
        aborted = true;
        throw new Error("already gone");
    };
    scheduler.close();
    assert.equal(aborted, true);
    assert.equal(lease.released, true);
    assert.equal(scheduler.egress.get("P1").inflight, 0);
    scheduler.release(lease);
    assert.equal(scheduler.egress.get("P1").inflight, 0);
});

test("a changed actual proxy cannot be sent under a stale lease, even without ready-only filtering", async t => {
    const { scheduler, manager } = setup(t, ["P1", "P2"], { readyContextOnly: false });
    const lease = await scheduler.acquire("flash");
    manager.contexts.get(lease.account.index).proxyInfo = { egressKey: "new-proxy" };
    assert.throws(
        () => scheduler.startAttempt(lease),
        error => error.kind === "transport" && error.reason === "context_proxy_changed"
    );
    assert.equal(lease.attempted, false);
    assert.equal(lease.slot.request_count, 0);
    scheduler.release(lease);
    assert.equal(scheduler.egress.get("P1").inflight, 0);
});
