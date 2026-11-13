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
        ["ultra", [null, null, 200]],
        ["ultra20", [null, null, 200]],
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
    assert.equal(argon.total_quota, 450);
    assert.equal(argon.unknown_limit_accounts, 0);
    assert.equal(argon.tracked_accounts, 3);
    assert.equal(argon.quota_per_account, null);
    assert.equal(argon.estimated_remaining_quota, 246);
    assert.equal(argon.known_estimated_remaining_quota, 246);
    assert.equal(admin.find(item => item.model === "gemini-3-pro").total_quota, null);
    assert.equal(publicModels.find(item => item.model === "text-embedding-004").estimatedRemaining, null);
    const account = scheduler.account(4);
    assert.equal(scheduler.isResourceEligible(account, "gemini-4-argon"), true);
    metadata[4].manualTier = "free";
    assert.equal(scheduler.slot(account, "gemini-4-argon").daily_request_count, 300);
    assert.equal(
        scheduler.summarySnapshot().quota_by_model.find(item => item.model === "gemini-4-argon").total_quota,
        250
    );
    assert.equal(scheduler.isResourceEligible(account, "gemini-4-argon"), false);
});

test("verification removes PG request and token budgets from admin and public projections while retaining usage", async t => {
    const metadata = ["free", "ultra", "pro"].map((manualTier, authIndex) => ({ authIndex, manualTier }));
    const auth = {
        accountLoginService: { state: { accounts: metadata } },
        accountNameMap: new Map(),
        getRotationIndices: () => [0, 1, 2],
    };
    const model = "gemini-3.8-flash";
    const build = "build/gemini-3.8-flash";
    const scheduler = new ModelScheduler(
        {
            ...loadConfig({
                GLOBAL_MAX_CONCURRENCY: "3",
                MODEL_WORKER_ALLOCATION: JSON.stringify({ [build]: 1, [model]: 1 }),
            }),
            statePath: null,
        },
        auth,
        { debug() {}, error() {}, info() {}, warn() {} }
    );
    t.after(() => scheduler.close());
    const buildBefore = scheduler.tokenQuotaSnapshot(build);
    const lease = await scheduler.acquire(model);
    assert.equal(lease.account.index, 0);
    scheduler.startAttempt(lease);
    scheduler.recordTokenUsage(lease, { total_tokens: 100 });
    scheduler.failure(lease, {
        message: "Your account must be verified before it can continue using the Gemini API.",
        status: 403,
    });
    scheduler.release(lease);
    const blocked = { detected_at: Date.now(), reason: "verification_required" };
    scheduler.account(1).playground_verification = blocked;
    // An unknown-usage attempt on a blocked account must not hide the usable pool's budget.
    scheduler.slot(scheduler.account(1), model).daily_request_count = 1;
    const row = scheduler.summarySnapshot().quota_by_model.find(item => item.model === model);
    assert.equal(row.tracked_accounts, 1);
    assert.equal(row.total_quota, 150);
    assert.equal(row.estimated_remaining_quota, 150);
    assert.equal(row.unknown_limit_accounts, 0);
    assert.equal(row.daily_requests, 2);
    const tokens = scheduler.tokenQuotaSnapshot(model);
    assert.equal(tokens.limit, 25000000);
    assert.equal(tokens.estimated_remaining, 25000000);
    assert.equal(tokens.observed_tokens.total_tokens, 100);
    assert.equal(tokens.known_usage_requests, 1);
    assert.equal(tokens.unknown_usage_requests, 1);
    assert.deepEqual(scheduler.tokenQuotaSnapshot(build), buildBefore);
    const publicBefore = JSON.stringify([...scheduler.accounts]);
    const projected = scheduler.publicSummarySnapshot().models.find(item => item.model === model);
    assert.equal(projected.estimatedRemaining, 150);
    assert.equal(projected.todayRequests, 2);
    assert.deepEqual(projected.tokenQuota, tokens);
    assert.equal(JSON.stringify([...scheduler.accounts]), publicBefore);

    const PublicDashboardService = require("../src/public/PublicDashboardService");
    const UsageStatsService = require("../src/core/UsageStatsService");
    const service = new PublicDashboardService(
        scheduler,
        new UsageStatsService(null, { debug() {}, error() {}, info() {}, warn() {} }, null, false),
        { cacheTtlMs: 0 }
    );
    let dashboard = await service.getSnapshot();
    assert.equal(dashboard.models.find(item => item.model === model).quota.estimated_remaining, 150);
    scheduler.account(2).playground_verification = blocked;
    const empty = scheduler.summarySnapshot().quota_by_model.find(item => item.model === model);
    assert.equal(empty.total_quota, 0);
    assert.equal(empty.tracked_accounts, 0);
    assert.equal(empty.estimated_remaining_quota, 0);
    assert.equal(scheduler.tokenQuotaSnapshot(model).estimated_remaining, 0);
    dashboard = await service.getSnapshot();
    assert.equal(dashboard.models.find(item => item.model === model).quota.estimated_remaining, 0);
    assert.equal(dashboard.models.find(item => item.model === model).token_quota.limit, 0);
    scheduler.reset(0);
    assert.equal(scheduler.publicSummarySnapshot().models.find(item => item.model === model).estimatedRemaining, 49);
    assert.equal(scheduler.tokenQuotaSnapshot(model).estimated_remaining, 4999900);
});
