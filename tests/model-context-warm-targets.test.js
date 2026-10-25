const { test } = require("node:test");
const assert = require("node:assert/strict");
const BrowserManager = require("../src/core/BrowserManager");
const loadConfig = require("../src/core/SchedulerConfig");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
function fixture(t, targets, max = 4, count = 8) {
    const indices = Array.from({ length: count }, (_, i) => i);
    const config = {
        ...loadConfig({ MAX_BROWSER_WORKERS: String(max), MODEL_CONTEXT_WARM_TARGETS: JSON.stringify(targets) }),
        statePath: null,
    };
    const auth = { accountNameMap: new Map(), availableIndices: indices, getRotationIndices: () => indices };
    const scheduler = new ModelScheduler(config, auth, logger);
    t.after(() => scheduler.close());
    const manager = Object.assign(Object.create(BrowserManager.prototype), {
        _contextInitTasks: new Map(),
        _isContextIdle(index) {
            return !scheduler.account(index).inflight;
        },
        _pumpContextPool() {},
        authSource: auth,
        async closeContext(index) {
            this.contexts.delete(index);
        },
        contextCapacityReservations: new Map(),
        contextDemand: new Map(),
        contexts: new Map(),
        contextUnavailable: new Map(),
        initializingContexts: new Set(),
        isContextReady(index) {
            return this.contexts.has(index) && !this.contexts.get(index).draining;
        },
        logger,
        pendingContextClosures: new Map(),
        scheduler,
    });
    return { manager, ready: (...values) => values.forEach(index => manager.contexts.set(index, {})), scheduler };
}

test("startup validates integer targets, canonical IDs and capacity including M=1", () => {
    for (const value of [-1, 4, 1.5, "1", null])
        assert.throws(() =>
            loadConfig({ MAX_BROWSER_WORKERS: "4", MODEL_CONTEXT_WARM_TARGETS: JSON.stringify({ flash: value }) })
        );
    assert.throws(() => loadConfig({ MODEL_CONTEXT_WARM_TARGETS: '{"flash":1}' }));
    assert.throws(() => loadConfig({ MAX_BROWSER_WORKERS: "4", MODEL_CONTEXT_WARM_TARGETS: '{"models/flash":1}' }));
    assert.equal(loadConfig({ MODEL_CONTEXT_WARM_TARGETS: '{"flash":0}' }).modelContextWarmTargets.flash, 0);
    assert.doesNotThrow(() => loadConfig({ MAX_BROWSER_WORKERS: "4", MODEL_CONTEXT_WARM_TARGETS: '{"a":3,"b":3}' }));
});

test("coverage counts policy-allowed accounts and scheduled initialization separately", t => {
    const { manager, scheduler, ready } = fixture(t, { a: 3 });
    ready(0, 1, 2);
    manager.initializingContexts.add(3);
    scheduler.slot(scheduler.account(1), "a").cooldown_until = scheduler.now() + 10000;
    scheduler.slot(scheduler.account(2), "a").unsupported = true;
    assert.deepEqual(manager.getModelWarmCoverage("a"), { deficit: 2, initializing: 1, ready: 1, target: 3 });
    scheduler.account(0).inflight = 3;
    assert.equal(manager.getModelWarmCoverage("a").ready, 1);
    scheduler.account(0).disabled = true;
    assert.equal(manager.getModelWarmCoverage("a").ready, 0);
});

test("overlapping coverage wins before proxy dispersion; no per-model forced preflight", t => {
    const { manager, scheduler } = fixture(t, { a: 2, b: 2 });
    scheduler.config.strategy = "different_proxy_first";
    manager._egressKeyForPool = index => (index < 2 ? "A" : "B");
    for (let index = 2; index < 8; index++) scheduler.slot(scheduler.account(index), "b").unsupported = true;
    assert.deepEqual(manager._poolCandidates().slice(0, 2), [0, 1]);
    manager.initializingContexts.add(0);
    manager.initializingContexts.add(1);
    assert.equal(manager.getModelWarmCoverage("b").initializing, 2);
    assert.ok(!manager._poolCandidates().includes(0));
});

test("unavailable target does not block ordinary shared warming and recovery recomputes coverage", t => {
    const { manager, scheduler } = fixture(t, { a: 2, b: 1 });
    for (let index = 0; index < 8; index++)
        scheduler.slot(scheduler.account(index), "a").cooldown_until = scheduler.now() + 1000;
    assert.equal(manager._poolCandidates().length, 4);
    scheduler.slot(scheduler.account(7), "a").cooldown_until = 0;
    assert.equal(manager._poolCandidates()[0], 7);
});

test("background may occupy M including inits, reservations and closing contexts", t => {
    const { manager } = fixture(t, { a: 3, b: 3 });
    manager.initializingContexts.add(0);
    manager.contextCapacityReservations.set(1, {});
    manager._poolClosingContexts = new Set([2]);
    assert.ok(manager._reserveContextCapacity(3, "warm"));
    assert.equal(manager._reserveContextCapacity(3, "foreground"), null);
    assert.equal(manager._contextCapacityIndices().size, 4);
    assert.equal(manager._reserveContextCapacity(4, "foreground"), null);
});

test("zero targets and legacy mode retain the full background capacity", t => {
    const { manager, scheduler, ready } = fixture(t, { a: 0 });
    ready(0, 1, 2);
    assert.ok(manager._reserveContextCapacity(3, "warm"));
    scheduler.config.modelContextWarmTargets = { a: 3 };
    scheduler.config.enabled = false;
    assert.equal(manager._backgroundContextLimit(), 4);
});

test("equal model coverage spreads planned candidates across proxy exits", t => {
    const { manager, scheduler } = fixture(t, { a: 3 });
    scheduler.config.strategy = "different_proxy_first";
    manager._egressKeyForPool = index => (index < 4 ? "A" : "B");
    assert.deepEqual(manager._poolCandidates().slice(0, 3), [0, 4, 1]);
});

test("full pool actively replaces other-model accounts without a lossless-coverage requirement", async t => {
    const { manager, scheduler, ready } = fixture(t, { a: 3 });
    ready(0, 1, 2, 3);
    for (const index of [1, 2, 3]) scheduler.slot(scheduler.account(index), "a").unsupported = true;
    for (const index of [0, 2, 3, 4, 5, 6, 7]) scheduler.slot(scheduler.account(index), "b").unsupported = true;
    // All M slots are occupied. The sole b account is still a legitimate victim.
    const incoming = manager._poolCandidates()[0];
    assert.ok(incoming >= 4);
    assert.equal(manager._reserveContextCapacity(incoming, "warm"), null);
    assert.ok(manager._contextPoolReplacements.has(1));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!manager.contexts.has(1));
    assert.ok(manager._reserveContextCapacity(incoming, "warm"));
    manager.contextCapacityReservations.delete(incoming);
    ready(incoming);
    assert.equal(manager.getModelWarmCoverage("a").ready, 2);
    assert.equal(manager.getModelWarmCoverage("b").ready, 0);
});

test("busy shared account stops accepting leases, then closes after the final request", async t => {
    const { manager, scheduler, ready } = fixture(t, { a: 3 });
    ready(0, 1, 2, 3);
    for (const index of [1, 2, 3]) {
        scheduler.slot(scheduler.account(index), "a").unsupported = true;
        scheduler.account(index).inflight = 1;
    }
    manager._reserveContextCapacity(4, "warm");
    const victim = [...manager.contexts.keys()].find(index => manager.contexts.get(index).poolReplacement);
    assert.notEqual(victim, undefined);
    assert.notEqual(victim, 0);
    assert.ok(manager.contexts.has(victim));
    scheduler.browserManager = manager;
    for (const readyContextOnly of [true, false]) {
        scheduler.config.readyContextOnly = readyContextOnly;
        assert.equal(scheduler.canLease(scheduler.account(victim), "b"), false);
    }
    scheduler.account(victim).inflight = 0;
    manager.handleAccountLeaseReleased(victim);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!manager.contexts.has(victim));
    assert.ok(manager.contexts.has(0));
});

test("shared identity can belong to a target-capable busy account and real demand drains it first", async t => {
    const { manager, scheduler, ready } = fixture(t, { a: 2 }, 3);
    ready(0, 1, 2);
    assert.deepEqual([...manager._modelWarmPlan()], [0, 1]);
    scheduler.account(2).inflight = 1;
    let needed = true;
    scheduler.hasUnmetContextDemand = () => needed;
    manager.contextDemand.set(3, { model: "b", models: new Set(["b"]) });
    manager._reserveContextCapacity(3, "demand");
    assert.equal(manager.contexts.get(2).poolReplacement.incoming, 3);
    assert.ok(!manager.contexts.get(0).draining);
    needed = false; // canceled/expired request must not evict the drained account later.
    assert.equal(manager._cancelObsoletePoolReplacement(2), true);
    assert.equal(manager.contexts.get(2).draining, false);
    scheduler.account(2).inflight = 0;
    manager.handleAccountLeaseReleased(2);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(manager.contexts.has(2));
});

test("target candidate becoming unavailable cancels a pending warm drain", t => {
    const { manager, scheduler, ready } = fixture(t, { a: 2 }, 3);
    ready(0, 1, 2);
    for (const index of [1, 2]) {
        scheduler.slot(scheduler.account(index), "a").unsupported = true;
        scheduler.account(index).inflight = 1;
    }
    manager._reserveContextCapacity(3, "warm");
    const victim = [...manager.contexts.keys()].find(index => manager.contexts.get(index).poolReplacement);
    assert.notEqual(victim, undefined);
    scheduler.slot(scheduler.account(3), "a").cooldown_until = scheduler.now() + 10000;
    assert.equal(manager._cancelObsoletePoolReplacement(victim), true);
    assert.equal(manager.contexts.get(victim).draining, false);
});

test("shortage releases all unused coverage places to ordinary sharing", t => {
    const { manager, scheduler, ready } = fixture(t, { a: 10 }, 12, 18);
    ready(...Array.from({ length: 12 }, (_, index) => index));
    for (let index = 6; index < 18; index++) scheduler.slot(scheduler.account(index), "a").unsupported = true;
    assert.deepEqual(manager.getWarmSharingSnapshot(), {
        protected_contexts: 6,
        shared_contexts: 6,
        shared_minimum: 1,
    });
    assert.deepEqual(manager._poolCandidates(), []);
});

test("conflicting disjoint targets preserve at least one shared place without background churn", async t => {
    const { manager, scheduler, ready } = fixture(t, { a: 2, b: 2 }, 3, 4);
    ready(0, 1, 2);
    for (const index of [0, 1]) scheduler.slot(scheduler.account(index), "b").unsupported = true;
    for (const index of [2, 3]) scheduler.slot(scheduler.account(index), "a").unsupported = true;
    assert.equal(manager._modelWarmPlan().size, 2);
    assert.equal(manager.getWarmSharingSnapshot().shared_contexts, 1);
    for (let n = 0; n < 5; n++) {
        assert.deepEqual(manager._poolCandidates(), []);
        await new Promise(resolve => setImmediate(resolve));
    }
});

test("request cold-account selection values target contribution before proxy diversity", t => {
    const { manager, scheduler, ready } = fixture(t, { a: 3 });
    ready(0, 1, 2, 3);
    scheduler.config.strategy = "different_proxy_first";
    manager._egressKeyForPool = index => (index === 5 ? "A" : "B");
    for (const index of [0, 1, 2, 3, 4, 6, 7]) scheduler.slot(scheduler.account(index), "a").unsupported = true;
    scheduler.browserManager = manager;
    scheduler.pending.push({ excluded: new Set(), model: "b" });
    scheduler.needsContextForRequest = () => true;
    let requests;
    manager.requestContexts = values => {
        requests = values;
    };
    scheduler._signalContextDemand();
    assert.deepEqual(requests, [{ authIndex: 5, model: "b" }]);
    scheduler.pending.length = 0;
});

test("coverage initialization gets an opportunity ahead of unrelated repeated demands", t => {
    const { manager, scheduler } = fixture(t, { a: 2 });
    scheduler.hasUnmetContextDemand = () => true;
    manager.contextDemand.set(0, { model: "b", models: new Set(["b"]) });
    scheduler.slot(scheduler.account(0), "a").unsupported = true;
    assert.deepEqual(manager._poolCandidates().slice(0, 3), [1, 2, 0]);
});
