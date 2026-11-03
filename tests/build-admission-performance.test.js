const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BuildRecoveryManager } = require("../src/core/codeAssistant/BuildRecoveryManager");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const BrowserManager = require("../src/core/BrowserManager");
const loadConfig = require("../src/core/SchedulerConfig");
function setup(t, count = 3, entries = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admission-perf-"));
    const statePath = path.join(dir, "projects.json");
    fs.writeFileSync(statePath, JSON.stringify(entries));
    const auth = { accountNameMap: new Map(), getRotationIndices: () => Array.from({ length: count }, (_, i) => i) };
    const scheduler = new ModelScheduler(
        {
            ...loadConfig({ BUILD_MAX_CONCURRENCY: "10", GLOBAL_MAX_CONCURRENCY: "20", MAX_BROWSER_WORKERS: "6" }),
            dailyResetEnabled: false,
            statePath: null,
        },
        auth,
        { error() {}, warn() {} }
    );
    const browser = {
        contexts: new Map(),
        finishRecoveryContext() {},
        isContextReady: () => true,
        requestRecoveryContext() {},
    };
    const manager = new BuildRecoveryManager({ authSource: auth, browserManager: browser, scheduler }, { statePath });
    clearInterval(manager.timer);
    scheduler.buildRecoveryManager = manager;
    scheduler.browserManager = browser;
    t.after(async () => {
        scheduler.close();
        await manager.close();
        fs.rmSync(dir, { force: true, recursive: true });
    });
    return { browser, manager, scheduler, statePath };
}
const entry = (account, app = "app") => ({
    account,
    app,
    attempts: {},
    cleanupStage: "delete_pending",
    complete: true,
    revision: 1,
    schemaVersion: 3,
    task: null,
});
test("real journal hot path reads and validates once until the file changes", async t => {
    const entries = Object.fromEntries(
        Array.from({ length: 150 }, (_, i) => [
            "op" + i,
            { ...entry("auth-" + (i % 236)), diagnosticPadding: "x".repeat(1400) },
        ])
    );
    const { manager, scheduler, statePath } = setup(t, 236, entries);
    await new Promise(resolve => setTimeout(resolve, 20));
    const read = fs.readFileSync;
    let reads = 0;
    t.mock.method(fs, "readFileSync", function (file, ...args) {
        if (file === statePath) reads++;
        return read.call(this, file, ...args);
    });
    for (let n = 0; n < 1000; n++) manager.admission(scheduler.account(n % 236));
    assert.equal(reads, 1);
    const e = manager.store.read().op0;
    e.deleteConfirmedAt = Date.now();
    e.cleanupStage = "done";
    manager.store.save("op0", e);
    const afterSave = reads;
    assert.equal(manager.admission(scheduler.account(0)).debt, 0);
    assert.equal(reads, afterSave + 1);
});
test("external replacement, corruption and deletion cannot reuse a valid admission cache", t => {
    const { manager, scheduler, statePath } = setup(t, 1, { op: entry("auth-0") });
    const a = scheduler.account(0);
    assert.equal(manager.admission(a).debt, 1);
    const doc = JSON.parse(fs.readFileSync(statePath));
    doc.op.deleteConfirmedAt = Date.now();
    doc.op.cleanupStage = "done";
    const replacement = statePath + ".replacement";
    fs.writeFileSync(replacement, JSON.stringify(doc));
    fs.renameSync(replacement, statePath);
    assert.equal(manager.admission(a).debt, 0);
    const valid = fs.readFileSync(statePath);
    fs.writeFileSync(statePath, "{".repeat(valid.length));
    assert.equal(manager.admission(a).allowed, false);
    assert.equal(manager.fault, "recovery_storage_unavailable");
    fs.writeFileSync(statePath, valid);
    manager.fault = null;
    assert.equal(manager.admission(a).allowed, true);
    fs.unlinkSync(statePath);
    assert.equal(manager.admission(a).allowed, false);
});
test("ownership swaps of equal Set size immediately update active unknown reservations", t => {
    const { manager, scheduler } = setup(t, 2, { a: entry("auth-0", null), b: entry("auth-1", null) });
    manager.store.active.add("a");
    assert.equal(manager.admission(scheduler.account(0)).used, 1);
    manager.store.active.delete("a");
    manager.store.active.add("b");
    assert.equal(manager.admission(scheduler.account(0)).used, 0);
    assert.equal(manager.admission(scheduler.account(1)).used, 1);
    manager.store.active.clear();
    assert.equal(manager.admission(scheduler.account(1)).used, 0);
});
test("global reservation cap is checked between synchronous dispatches and released immediately", async t => {
    const { manager, scheduler } = setup(t, 2);
    manager.nodeDebtLimit = 2;
    const model = "build/gemini-3.8-flash";
    const first = await scheduler.acquire(model);
    const second = await scheduler.acquire(model);
    for (let i = 0; i < 2; i++) assert.equal(manager.admission(scheduler.account(i)).allowed, false);
    scheduler.release(first);
    assert.equal(manager.admission(scheduler.account(0)).allowed, true);
    const third = await scheduler.acquire(model);
    assert.equal(first.released, true);
    assert.equal(manager.admission(scheduler.account(1)).allowed, false);
    scheduler.release(second);
    scheduler.release(third);
    assert.equal(manager.admission(scheduler.account(0)).used, 0);
});
test("recovery sticks to the accepted cold-context demand across round-robin ticks", async t => {
    const { manager, scheduler, browser } = setup(t, 3, { a: entry("auth-0"), b: entry("auth-1"), c: entry("auth-2") });
    browser.contextInitTotalTimeoutMs = 180000;
    browser._pumpContextPool = () => {};
    browser.requestRecoveryContext = BrowserManager.prototype.requestRecoveryContext;
    browser.isContextReady = () => false;
    for (let n = 0; n < 4; n++) {
        await manager.run();
        assert.equal(browser.recoveryContextDemand.index, 0);
    }
    const deadline = browser.recoveryContextDemand.until;
    browser.requestRecoveryContext(0);
    assert.equal(browser.recoveryContextDemand.until, deadline, "ticks must not extend the bounded lease");
    assert.equal(browser.requestRecoveryContext(1), false);
    browser.recoveryContextDemand.until = Date.now() - 1;
    assert.equal(browser.requestRecoveryContext(1), true);
    assert.equal(browser.recoveryContextDemand.index, 1);
    assert.equal(browser.contextDemand.has(0), false);
    assert.ok(browser.recoveryContextDemand.until > Date.now() + 170000);
    assert.equal(scheduler.account(0).disabled, false);
});
test("summary view is reused only inside one synchronous projection", t => {
    const { scheduler, manager } = setup(t, 3);
    const model = "build/gemini-3.8-flash";
    scheduler.slot(scheduler.account(0), model);
    const first = scheduler.summarySnapshot();
    assert.ok(first.models.some(row => row.model === model));
    assert.equal(scheduler._snapshotViewDepth, undefined);
    scheduler.hiddenModels.add(model);
    assert.ok(!scheduler.summarySnapshot().models.some(row => row.model === model));
    scheduler.hiddenModels.delete(model);
    assert.ok(scheduler.summarySnapshot().models.some(row => row.model === model));
    assert.throws(
        () =>
            scheduler._withSnapshotView(() => {
                throw new Error("fixture");
            }),
        /fixture/
    );
    assert.equal(scheduler._snapshotViewDepth, undefined);
    manager.nodeDebtLimit = 1;
    manager.store.save("debt", entry("auth-0"));
    const row = scheduler.publicSummarySnapshot().models.find(row => row.model === model);
    assert.equal(row.availableAccounts, 0, "new debt is visible on the next projection");
});
test("snapshot date memoization preserves Pacific day boundaries and clock changes", t => {
    const { scheduler } = setup(t, 1);
    const before = Date.parse("2026-11-03T07:59:59.999Z");
    const after = Date.parse("2026-11-03T08:00:00.000Z");
    assert.equal(scheduler.getPacificDateKey(before), "2026-11-02");
    assert.equal(scheduler.getPacificDateKey(before), "2026-11-02");
    assert.equal(scheduler.getPacificDateKey(after), "2026-11-03");
    assert.equal(scheduler.getPacificDateKey(before), "2026-11-02");
});
