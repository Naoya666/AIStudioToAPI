const test = require("node:test");
const assert = require("node:assert/strict");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
function setup(t, count) {
    const scheduler = new ModelScheduler(
        { ...loadConfig({}), dailyResetEnabled: false, statePath: null },
        { accountNameMap: new Map(), getRotationIndices: () => Array.from({ length: count }, (_, i) => i) },
        { error() {}, warn() {} }
    );
    t.after(() => scheduler.close());
    return { scheduler };
}
test("summary view is reused only inside one synchronous projection", t => {
    const { scheduler } = setup(t, 3);
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
