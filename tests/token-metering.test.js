const test = require("node:test"),
    assert = require("node:assert/strict");
const fs = require("node:fs"),
    os = require("node:os"),
    path = require("node:path");
const { dailyBudgets } = require("../src/accounts/QuotaPolicy");
const { modelQuota } = require("../src/accounts/AccountTierPolicy");
const Usage = require("../src/core/TokenUsage");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const UsageStatsStorage = require("../src/core/UsageStatsStorage");
const UsageStatsService = require("../src/core/UsageStatsService");
const { validateTokenQuota, mergeTokenQuotas } = require("../src/public/TokenQuotaProjection");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-meter-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    return dir;
}
function scheduler(t, { tier = "pro", statePath = null } = {}) {
    const auth = {
        accountLoginService: { state: { accounts: [{ authIndex: 0, manualTier: tier }] } },
        accountNameMap: new Map(),
        getRotationIndices: () => [0],
    };
    const s = new ModelScheduler({ ...loadConfig({ GLOBAL_MAX_CONCURRENCY: "3" }), statePath }, auth, logger);
    t.after(() => s.close());
    return s;
}
test("operator PG requests and token budgets are exact; Ultra and Free Build stay unknown", () => {
    const flash = [
        "gemini-3.8-flash",
        "gemini-3.6-flash",
        "gemini-3-flash-preview",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
    ];
    for (const model of flash) {
        assert.equal(dailyBudgets(model, "free").tokens, 11000000);
        assert.equal(modelQuota(model, { manualTier: "pro" }), 150);
        assert.equal(dailyBudgets(model, "pro").tokens, 25000000);
    }
    for (const [tier, requests, tokens] of [
        ["free", 10, 5000000],
        ["pro", 50, 13000000],
    ]) {
        assert.equal(dailyBudgets("gemini-3.1-pro-preview", tier).requests, requests);
        assert.equal(dailyBudgets("gemini-3.1-pro-preview", tier).tokens, tokens);
    }
    assert.equal(dailyBudgets("gemini-4-argon", "pro").tokens, 15000000);
    for (const tier of ["ultra", "ultra20"])
        for (const m of [...flash, "gemini-3.1-pro-preview", "gemini-4-argon"]) {
            assert.equal(modelQuota(m, { manualTier: tier }), null);
            assert.equal(dailyBudgets(m, tier).tokens, null);
        }
    assert.equal(dailyBudgets("build/gemini-4-argon", "pro").tokens, 20000000);
    assert.equal(dailyBudgets("build/gemini-3.8-flash", "free").tokens, null);
});
test("Gemini totals remain authoritative; cached and reasoning are subsets, missing metrics remain absent", () => {
    const u = Usage.normalize(
        {
            cachedContentTokenCount: 40,
            candidatesTokenCount: 20,
            promptTokenCount: 100,
            thoughtsTokenCount: 10,
            totalTokenCount: 130,
        },
        true
    );
    assert.deepEqual(u, {
        cached_tokens: 40,
        completion_tokens: 30,
        prompt_tokens: 100,
        reasoning_tokens: 10,
        total_tokens: 130,
    });
    assert.equal(Usage.normalize({ totalTokenCount: 0 }, true).total_tokens, 0);
    assert.equal(Usage.normalize({ promptTokenCount: 3 }, true).total_tokens, undefined);
    assert.equal(Usage.normalize(null), null);
});
test("cumulative snapshots, alias sharing and separate PG quota survive scheduler restart", async t => {
    const file = path.join(temp(t), "scheduler.json"),
        s = scheduler(t, { statePath: file });
    const a = await s.acquire("build-st/gemini-3.8-flash-high");
    s.startAttempt(a);
    for (const total of [100, 100, 120, 110])
        s.recordTokenUsage(a, { completion_tokens: 40, prompt_tokens: 80, total_tokens: total }, "task");
    s.release(a);
    const b = await s.acquire("build/gemini-4-argon");
    s.startAttempt(b);
    s.recordTokenUsage(b, { total_tokens: 30 }, "other");
    s.release(b);
    const q = s.tokenQuotaSnapshot("build/gemini-3.8-flash");
    assert.equal(q.observed_tokens.total_tokens, 150);
    assert.equal(q.known_usage_requests, 2);
    assert.equal(q.limit, 20000000);
    assert.equal(q.estimated_remaining, 19999850);
    assert.equal(q.scope, "build/account");
    assert.equal(q.window.reset_verified, false);
    assert.equal(s.tokenQuotaSnapshot("gemini-3.8-flash").observed_tokens, null);
    s.flush();
    const restored = scheduler(t, { statePath: file });
    assert.equal(restored.tokenQuotaSnapshot("build/gemini-4-argon").observed_tokens.total_tokens, 150);
});
test("missing usage creates an upper bound, never an exact remaining balance or local enforcement", async t => {
    const s = scheduler(t);
    const lease = await s.acquire("gemini-3.8-flash");
    s.startAttempt(lease);
    s.recordTokenUsage(lease, { prompt_tokens: 20 }, "a");
    s.release(lease);
    const q = s.tokenQuotaSnapshot("gemini-3.8-flash");
    assert.equal(q.estimated_remaining, null);
    assert.equal(q.unknown_usage_requests, 1);
    assert.equal(q.observed_tokens, null);
    assert.equal(s.canLease(lease.account, lease.model), true);
    const free = scheduler(t, { tier: "free" });
    assert.equal(free.tokenQuotaSnapshot("build/gemini-3.8-flash").limit, null);
});
test("day windows preserve late usage and separate new-day requests", async t => {
    const s = scheduler(t),
        l = await s.acquire("gemini-3.8-flash");
    const before = Date.parse("2026-11-01T06:59:59Z"),
        after = Date.parse("2026-11-01T07:00:01Z");
    s.recordTokenUsage(l, { total_tokens: 20 }, "old", before);
    s.recordTokenUsage(l, { total_tokens: 30 }, "old", after);
    s.recordTokenUsage(l, { total_tokens: 5 }, "new", after);
    assert.equal(s.tokenQuotaSnapshot(l.model, [0], before).observed_tokens.total_tokens, 30);
    assert.equal(s.tokenQuotaSnapshot(l.model, [0], after).observed_tokens.total_tokens, 5);
    s.release(l);
});
const rec = (id, extra = {}) => ({
    accountKey: "fixture",
    durationMs: 60000,
    finishedAt: "2026-11-02T01:01:00Z",
    model: "build-st/gemini-3.8-flash-high",
    requestCategory: "generation",
    requestId: id,
    startedAt: "2026-11-02T01:00:00Z",
    ...extra,
});
test("SQLite token aggregates canonicalize aliases, retain unknown coverage, and deduplicate retries/imports", async t => {
    const dbPath = path.join(temp(t), "usage.sqlite");
    let db = new UsageStatsStorage({ dbPath });
    const record = rec("one", {
        tokenAttempts: [
            {
                accountKey: "free-account",
                day: "2026-11-01",
                model: "build-st/gemini-3.8-flash-high",
                tier: "free",
                usage: { cached_tokens: 40, completion_tokens: 30, prompt_tokens: 100, total_tokens: 130 },
            },
            { accountKey: "pro-account", day: "2026-11-01", model: "build/gemini-4-argon", tier: "pro", usage: null },
        ],
        usage: {
            cached_tokens: 40,
            completion_tokens: 30,
            prompt_tokens: 100,
            reasoning_tokens: 10,
            total_tokens: 130,
        },
    });
    await db.call("insert", record);
    await db.call("insert", record);
    let rows = (await db.call("token_statistics", {})).models;
    assert.equal(rows.length, 2);
    assert.equal(rows.find(r => r.tier === "free").total, 130);
    assert.equal(rows.find(r => r.tier === "pro").unknown_requests, 1);
    assert.equal(rows[0].model.startsWith("build-st/"), false);
    await db.call("cleanup", { now: Date.parse("2027-01-01T00:00:00Z") });
    await db.close();
    db = new UsageStatsStorage({ dbPath });
    t.after(() => db.close());
    rows = (await db.call("token_statistics", {})).models;
    assert.equal(rows.find(r => r.tier === "free").total, 130);
});
test("existing SQLite usage_json backfills once, with unknown tiers and unknown metrics preserved", async t => {
    const { DatabaseSync } = require("node:sqlite"),
        dbPath = path.join(temp(t), "old.sqlite");
    let worker = new UsageStatsStorage({ dbPath });
    await worker.call("insert", rec("old", { usage: { total_tokens: 9 } }));
    await worker.close();
    const direct = new DatabaseSync(dbPath);
    direct.exec("DROP TABLE token_daily; DELETE FROM storage_meta WHERE key='token_aggregate_version'");
    direct.close();
    for (let n = 0; n < 2; n++) {
        worker = new UsageStatsStorage({ dbPath });
        const rows = (await worker.call("token_statistics", {})).models;
        assert.equal(rows[0].tier, "unknown");
        assert.equal(rows[0].total, 9);
        assert.equal(rows[0].input_observations, 0);
        await worker.close();
    }
});
test("per-attempt service usage merges snapshots without moving charges to the final account", async t => {
    const dir = temp(t),
        service = new UsageStatsService(null, logger, dir, true, { dbPath: path.join(dir, "db.sqlite") });
    await service.ready;
    t.after(() => service.close());
    service.startRequest("req", { model: "gemini-3.8-flash", requestCategory: "generation" });
    service.recordAttempt("req", 0);
    service.recordAttempt("req", 1);
    service.recordTokenUsage(
        "req",
        "a",
        { total_tokens: 100 },
        { accountKey: "first", day: "2026-11-01", model: "gemini-3.8-flash", tier: "free" }
    );
    service.recordTokenUsage("req", "a", { total_tokens: 120 });
    service.recordTokenUsage("req", "b", null, {
        accountKey: "second",
        day: "2026-11-01",
        model: "gemini-3.8-flash",
        tier: "pro",
    });
    const done = service.finishRequest("req", { outcome: "error", usage: { total_tokens: 0 } });
    assert.equal(done.usage.total_tokens, 120);
    assert.equal(done.usage.partial, true);
    const rows = (await service.getTokenStatistics({ day: "2026-11-01" })).models;
    assert.equal(rows.find(r => r.tier === "free").total, 120);
    assert.equal(rows.find(r => r.tier === "pro").unknown_requests, 1);
});
test("cluster token quota merging keeps missing nodes and old agents partial; pool totals never duplicate cached tokens", async t => {
    const s = scheduler(t),
        l = await s.acquire("gemini-3.8-flash");
    s.startAttempt(l);
    s.recordTokenUsage(l, { cached_tokens: 10, total_tokens: 30 }, "a");
    s.release(l);
    const q = s.tokenQuotaSnapshot(l.model);
    assert.equal(validateTokenQuota(q), true);
    const merged = mergeTokenQuotas([q, q]);
    assert.equal(merged.observed_tokens.total_tokens, 60);
    assert.equal(merged.limit, 50000000);
    assert.equal(merged.estimated_remaining, 49999940);
    const partial = mergeTokenQuotas([q, null]);
    assert.equal(partial.limit, null);
    assert.equal(partial.estimated_remaining, null);
    assert.equal(partial.coverage, "partial");
    assert.equal(validateTokenQuota({ ...q, observed_tokens: { secret: "bad" } }), false);
});

test("unknown upstream attempts stay unknown even when another attempt on the same lease reports usage", async t => {
    const s = scheduler(t),
        l = await s.acquire("gemini-3.8-flash");
    s.startAttempt(l);
    s.recordTokenUsage(l, null, "missing");
    s.recordTokenUsage(l, { total_tokens: 20 }, "known");
    s.release(l);
    const q = s.tokenQuotaSnapshot(l.model);
    assert.equal(q.known_usage_requests, 1);
    assert.equal(q.unknown_usage_requests, 1);
    assert.equal(q.estimated_remaining, null);
});
test("Free Build manual estimate is opt-in, shared and display-only", async t => {
    const { ConfigurationService } = require("../src/config/ConfigurationService");
    const service = new ConfigurationService({ logger }, { env: {}, file: path.join(temp(t), "config.json") });
    assert.equal(service.running.scheduler.buildFreeDailyTokenEstimate, 0);
    assert.equal(
        service.snapshot().definitions.some(d => d.name === "BUILD_FREE_DAILY_TOKEN_ESTIMATE"),
        false
    );
    service.save({ changes: { BUILD_FREE_DAILY_TOKEN_ESTIMATE: 1000000 }, version: service.document.version });
    assert.equal(service.running.scheduler.buildFreeDailyTokenEstimate, 1000000);
    const s = scheduler(t, { tier: "free" });
    s.config.buildFreeDailyTokenEstimate = 1000000;
    assert.equal(s.tokenQuotaSnapshot("build/gemini-3.8-flash").limit, 1000000);
    assert.equal(s.tokenQuotaSnapshot("build/gemini-4-argon").pool, "build");
    assert.equal(s.canLease(s.account(0), "build/gemini-3.8-flash"), true);
});

test("Free observation statistics retain distinct account evidence rather than pooling their daily limits", async t => {
    const db = new UsageStatsStorage({ dbPath: path.join(temp(t), "free.sqlite") });
    t.after(() => db.close());
    for (const accountKey of ["free-a", "free-b"])
        await db.call(
            "insert",
            rec(accountKey, {
                tokenAttempts: [
                    {
                        accountKey,
                        day: "2026-11-01",
                        model: "build/gemini-3.8-flash",
                        tier: "free",
                        usage: { total_tokens: 50 },
                    },
                ],
            })
        );
    const rows = (await db.call("token_statistics", { day: "2026-11-01" })).models;
    assert.equal(rows.length, 2);
    assert.deepEqual(
        rows.map(r => r.account_key),
        ["free-a", "free-b"]
    );
    assert.ok(rows.every(r => r.total === 50));
});
