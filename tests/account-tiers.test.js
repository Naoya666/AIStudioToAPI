const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveTier, modelQuota } = require("../src/accounts/AccountTierPolicy");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");

test("manual tier priority, stale sessions and conflict matrix", () => {
    for (const manualTier of [null, "free", "pro", "ultra", "ultra20"]) {
        for (const observation of [
            null,
            { rawTier: null, state: "ready-free" },
            { rawTier: "TIER1", state: "ready-paid" },
            { rawTier: "TIER2", state: "ready-paid" },
        ]) {
            for (const current of [true, false]) {
                const account = {
                    benefitLastCheck: { reason: "query_http", status: "failed" },
                    benefitObservation: observation && {
                        ...observation,
                        sessionVersion: current ? 2 : 1,
                    },
                    manualTier,
                    sessionVersion: 2,
                };
                const result = resolveTier(account);
                const detected = !observation || !current ? null : observation.state === "ready-free" ? "free" : "pro";
                assert.equal(result.effectiveTier, manualTier || detected);
                assert.equal(result.argonEligible, ["pro", "ultra", "ultra20"].includes(manualTier || detected));
                assert.equal(result.conflict, ["pro", "ultra", "ultra20"].includes(manualTier) && detected === "free");
            }
        }
    }
});

test("tier bases are exact per model and never enable other Gemini 4 models", () => {
    for (const [manualTier, quotas] of [
        [null, [100, 10, 0]],
        ["free", [100, 10, 0]],
        ["pro", [100, 50, 50]],
        ["ultra", [500, 100, 100]],
        ["ultra20", [500, 200, 200]],
    ]) {
        assert.deepEqual(
            ["models/gemini-2.5-flash", "gemini-3-pro", "gemini-4-argon"].map(model =>
                modelQuota(model, { manualTier })
            ),
            quotas
        );
        for (const model of ["gemini-4-other", "gemini-4-argon-preview", "text-embedding-004", "imagen-4", "__files__"])
            assert.equal(modelQuota(model, { manualTier }), null);
    }
});

test("mixed-tier admin/public quota estimates agree, preserve attempts and do not block at zero", t => {
    const metadata = [null, "free", "pro", "ultra", "ultra20"].map((manualTier, authIndex) => ({
        authIndex,
        manualTier,
    }));
    const auth = {
        accountLoginService: { state: { accounts: metadata } },
        accountNameMap: new Map(),
        getRotationIndices: () => [0, 1, 2, 3, 4],
    };
    const scheduler = new ModelScheduler({ ...loadConfig({ CONTEXT_POOL_MIN_READY: "0" }), statePath: null }, auth, {
        debug() {},
        error() {},
        info() {},
        warn() {},
    });
    t.after(() => scheduler.close());
    const models = new Set(["gemini-2.5-flash", "gemini-3-pro", "gemini-4-argon", "text-embedding-004"]);
    scheduler._visibleSnapshotModels = () => models;
    const date = scheduler.getPacificDateKey(Date.now());
    for (const index of auth.getRotationIndices()) {
        for (const model of models)
            Object.assign(scheduler.slot(scheduler.account(index), model), {
                daily_request_count: index === 4 ? 300 : 2,
                daily_request_date: date,
            });
    }
    const admin = scheduler.summarySnapshot().quota_by_model;
    const publicModels = scheduler.publicSummarySnapshot().models;
    for (const row of admin)
        assert.equal(
            row.estimated_remaining_quota,
            publicModels.find(item => item.model === row.model).estimatedRemaining
        );
    const argon = admin.find(item => item.model === "gemini-4-argon");
    assert.equal(argon.total_quota, 350);
    assert.equal(argon.tracked_accounts, 3);
    assert.equal(argon.quota_per_account, null);
    assert.equal(argon.estimated_remaining_quota, 146);
    assert.equal(admin.find(item => item.model === "gemini-3-pro").total_quota, 370);
    assert.equal(publicModels.find(item => item.model === "text-embedding-004").estimatedRemaining, null);
    const account = scheduler.account(4);
    assert.equal(scheduler.isResourceEligible(account, "gemini-4-argon"), true);
    metadata[4].manualTier = "free";
    assert.equal(scheduler.slot(account, "gemini-4-argon").daily_request_count, 300);
    assert.equal(
        scheduler.summarySnapshot().quota_by_model.find(item => item.model === "gemini-4-argon").total_quota,
        150
    );
    assert.equal(scheduler.isResourceEligible(account, "gemini-4-argon"), false);
});
