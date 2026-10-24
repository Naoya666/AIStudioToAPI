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
    assert.equal(manager._poolCandidates().length, 3);
    scheduler.slot(scheduler.account(7), "a").cooldown_until = 0;
    assert.equal(manager._poolCandidates()[0], 7);
});

test("background reserves a physical slot including inits, reservations and closing contexts", t => {
    const { manager } = fixture(t, { a: 3, b: 3 });
    manager.initializingContexts.add(0);
    manager.contextCapacityReservations.set(1, {});
    manager._poolClosingContexts = new Set([2]);
    assert.equal(manager._reserveContextCapacity(3, "warm"), null);
    assert.ok(manager._reserveContextCapacity(3, "foreground"));
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

test("warm replacement improves coverage, protects scarce coverage and cannot oscillate", async t => {
    const { manager, scheduler, ready } = fixture(t, { a: 2, b: 1 });
    ready(0, 1, 2);
    scheduler.slot(scheduler.account(0), "a").unsupported = true;
    scheduler.slot(scheduler.account(1), "a").unsupported = true;
    for (const index of [1, 2, 3]) scheduler.slot(scheduler.account(index), "b").unsupported = true;
    assert.equal(manager._warmReplacementGain(3, 0), -1);
    assert.equal(manager._warmReplacementGain(3, 1), 1);
    assert.equal(manager._reserveContextCapacity(3, "warm"), null);
    assert.ok(manager._contextPoolReplacements.has(1));
    await new Promise(resolve => setImmediate(resolve));
    ready(3);
    assert.equal(manager._warmReplacementGain(1, 3), -1);
    assert.equal(manager.getModelWarmCoverage("a").ready, 2);
    assert.equal(manager.getModelWarmCoverage("b").ready, 1);
});

test("conflicting disjoint targets stay stable; actual demand can replace scarce idle coverage", async t => {
    const { manager, scheduler, ready } = fixture(t, { a: 2, b: 2 }, 3);
    ready(0, 1);
    scheduler.slot(scheduler.account(0), "b").unsupported = true;
    scheduler.slot(scheduler.account(1), "a").unsupported = true;
    scheduler.slot(scheduler.account(2), "a").unsupported = true;
    assert.equal(manager._reserveContextCapacity(2, "warm"), null);
    assert.equal(manager._contextPoolReplacements?.size || 0, 0);
    assert.ok(manager._reserveContextCapacity(2, "foreground"));
    manager.contextCapacityReservations.delete(2);
    ready(2);
    scheduler.account(1).inflight = 1;
    scheduler.account(2).inflight = 1;
    assert.equal(manager._reserveContextCapacity(3, "foreground"), null);
    assert.ok(manager._contextPoolReplacements.has(0));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(manager.contexts.has(1));
    assert.ok(manager.contexts.has(2));
});

test("equal model coverage spreads planned candidates across proxy exits", t => {
    const { manager, scheduler } = fixture(t, { a: 3 });
    scheduler.config.strategy = "different_proxy_first";
    manager._egressKeyForPool = index => (index < 4 ? "A" : "B");
    assert.deepEqual(manager._poolCandidates().slice(0, 3), [0, 4, 1]);
});
