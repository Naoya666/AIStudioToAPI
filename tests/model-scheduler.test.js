const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    calculateNextPacificResetAt,
    ModelScheduler,
    classifyError,
    getModelDailyQuota,
} = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const logger = { error() {}, warn() {} };
const upstream401 = {
    message: "Proxy browser error: Google API returned error: 401 UNAUTHENTICATED",
    status: 401,
};
function setup(overrides = {}, count = 8) {
    const config = { ...loadConfig({ MAX_BROWSER_WORKERS: "6" }), statePath: null, ...overrides };
    const auth = {
        accountNameMap: new Map(),
        availableIndices: Array.from({ length: count }, (_, i) => i),
        getRotationIndices() {
            return this.availableIndices;
        },
    };
    return new ModelScheduler(config, auth, logger);
}

const dailyQuotaError = {
    message:
        "You exceeded your current quota, please check your plan and billing details.\n" +
        "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_model_per_user, " +
        "limit: 100, model: gemini-3.8-flash\nPlease retry in 15h8m4.376717497s.",
    status: 429,
};

test("daily quota 429 uses the next configured Pacific reset even when bulk reset is disabled", async t => {
    for (const [timestamp, resetTime, expected] of [
        ["2026-01-15T07:00:00Z", "00:00", "2026-01-15T08:00:00Z"],
        ["2026-07-15T06:00:00Z", "00:00", "2026-07-15T07:00:00Z"],
        ["2026-07-15T07:00:00Z", "00:00", "2026-07-16T07:00:00Z"],
        ["2026-07-15T07:00:30Z", "00:00", "2026-07-16T07:00:00Z"],
        ["2026-07-15T08:00:00Z", "02:30", "2026-07-15T09:30:00Z"],
        ["2026-03-08T09:00:00Z", "02:30", "2026-03-08T10:00:00Z"],
        ["2026-03-08T08:00:00Z", "00:00", "2026-03-09T07:00:00Z"],
        ["2026-11-01T07:00:00Z", "00:00", "2026-11-02T08:00:00Z"],
    ]) {
        let now = Date.parse(timestamp);
        const scheduler = setup({ dailyResetEnabled: false, dailyResetTime: resetTime, now: () => now }, 1);
        t.after(() => scheduler.close());
        const lease = await scheduler.acquire("flash");
        scheduler.failure(lease, dailyQuotaError);
        assert.equal(lease.slot.cooldown_until, Date.parse(expected), timestamp);
        assert.equal(lease.slot.rate_limit_type, "daily_quota");
        assert.equal(scheduler.dailyResetTimer, null);
        const detail = scheduler.accountsSnapshot().accounts[0].models[0];
        assert.equal(detail.rate_limit_type, "daily_quota");
        assert.equal(detail.cooldown_until, Date.parse(expected));
        assert.equal(detail.status, "RATE_LIMITED");
        now = Date.parse(expected);
        assert.equal(scheduler.slot(lease.account, "flash", now).rate_limited, false);
        assert.equal(lease.slot.rate_limit_type, null);
        scheduler.release(lease);
    }
});

test("short and unknown 429 errors use configured temporary cooldown without guessing from retry hints", async t => {
    const now = Date.now();
    for (const message of [
        "Quota exceeded",
        "RESOURCE_EXHAUSTED",
        "You exceeded your current quota. Please retry in 15h8m4.376717497s.",
        "Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_minute, limit: 10",
        "Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_model_per_user_other",
    ]) {
        const scheduler = setup({ now: () => now, rateLimitCooldownMs: 90000 }, 1);
        t.after(() => scheduler.close());
        const lease = await scheduler.acquire("flash");
        scheduler.failure(lease, { message, status: 429 });
        assert.equal(lease.slot.cooldown_until, now + 90000);
        assert.equal(lease.slot.rate_limit_type, "temporary");
        assert.equal(lease.account.healthy, true);
        const other = await scheduler.acquire("other");
        scheduler.release(other);
        scheduler.release(lease);
    }
    assert.equal(loadConfig({}).rateLimitCooldownMs, 60000);
    assert.equal(loadConfig({ RATE_LIMIT_COOLDOWN: "86400" }).rateLimitCooldownMs, 86400000);
});

test("daily quota identification survives upstream error envelopes", async t => {
    for (const error of [
        { status: 429, upstreamError: { message: dailyQuotaError.message } },
        { error: { code: 429, message: dailyQuotaError.message, status: "RESOURCE_EXHAUSTED" } },
        { message: JSON.stringify({ error: dailyQuotaError }), status: 429 },
    ]) {
        const scheduler = setup({}, 1);
        t.after(() => scheduler.close());
        const lease = await scheduler.acquire("flash");
        scheduler.failure(lease, error);
        assert.equal(lease.slot.rate_limit_type, "daily_quota");
        scheduler.release(lease);
    }
});

test("concurrent temporary 429 and success cannot shorten a daily quota block", async t => {
    for (const dailyFirst of [true, false]) {
        const scheduler = setup({}, 1);
        t.after(() => scheduler.close());
        const leases = await Promise.all(Array.from({ length: 3 }, () => scheduler.acquire("flash")));
        leases.forEach(lease => scheduler.startAttempt(lease));
        const errors = dailyFirst
            ? [dailyQuotaError, { message: "Quota exceeded", status: 429 }]
            : [{ message: "Quota exceeded", status: 429 }, dailyQuotaError];
        errors.forEach((error, index) => scheduler.failure(leases[index], error));
        const deadline = leases[0].slot.cooldown_until;
        assert.equal(leases[0].slot.rate_limit_type, "daily_quota");
        assert.equal(deadline, calculateNextPacificResetAt(Date.now(), "00:00", null, true));
        scheduler.release(leases[2], true);
        assert.equal(leases[0].slot.rate_limit_type, "daily_quota");
        assert.equal(leases[0].slot.cooldown_until, deadline);
        leases.forEach(lease => scheduler.release(lease));
    }
});

test("all reset paths still clear both daily and temporary rate limits", async t => {
    for (const reset of [
        scheduler => scheduler.resetDailyCooldowns(),
        scheduler => scheduler.resetAllRateLimits(),
        scheduler => scheduler.resetAllAccounts(),
        scheduler => scheduler.reset(0),
    ]) {
        const scheduler = setup({}, 1);
        t.after(() => scheduler.close());
        const daily = await scheduler.acquire("daily");
        const temporary = await scheduler.acquire("temporary");
        scheduler.failure(daily, dailyQuotaError);
        scheduler.failure(temporary, { message: "Quota exceeded", status: 429 });
        scheduler.release(daily);
        scheduler.release(temporary);
        reset(scheduler);
        for (const { slot } of [daily, temporary]) {
            assert.equal(slot.cooldown_until, 0);
            assert.equal(slot.rate_limited, false);
            assert.equal(slot.rate_limit_type, null);
        }
    }
});

test("rate limit reason and deadline survive restart and legacy states remain readable", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-quota-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const statePath = path.join(directory, "state.json");
    const first = setup({ statePath }, 1);
    const lease = await first.acquire("flash");
    first.failure(lease, dailyQuotaError);
    const deadline = lease.slot.cooldown_until;
    first.release(lease);
    first.close();
    const second = setup({ statePath }, 1);
    assert.equal(second.account(0).models.flash.rate_limit_type, "daily_quota");
    assert.equal(second.account(0).models.flash.cooldown_until, deadline);
    second.close();
    const legacy = JSON.parse(fs.readFileSync(statePath));
    delete legacy.accounts[0].models.flash.rate_limit_type;
    fs.writeFileSync(statePath, JSON.stringify(legacy));
    const third = setup({ statePath }, 1);
    t.after(() => third.close());
    assert.equal(third.account(0).models.flash.rate_limit_type, null);
    assert.equal(third.account(0).models.flash.cooldown_until, deadline);
});

test("upstream UNAUTHENTICATED expires the request session once", async t => {
    const scheduler = setup({}, 1);
    t.after(() => scheduler.close());
    scheduler.authSource.accountLoginService = { state: { accounts: [{ authIndex: 0, sessionVersion: 7 }] } };
    const calls = [];
    scheduler.authSource.markAsExpired = async (...args) => calls.push(args);
    const lease = await scheduler.acquire("flash");
    scheduler.startAttempt(lease);
    await Promise.all([scheduler.failure(lease, upstream401), scheduler.failure(lease, upstream401)]);
    assert.deepEqual(calls, [[0, 7]]);
    assert.equal(lease.account.healthy, false);
    await assert.rejects(scheduler.acquire("other"));
    scheduler.release(lease);
});

test("late upstream 401 cannot disable or expire a replacement session", async t => {
    const scheduler = setup({}, 1);
    t.after(() => scheduler.close());
    const session = { authIndex: 0, sessionVersion: 7 };
    scheduler.authSource.accountLoginService = { state: { accounts: [session] } };
    let expired = false;
    scheduler.authSource.markAsExpired = async () => {
        expired = true;
    };
    const lease = await scheduler.acquire("flash");
    scheduler.startAttempt(lease);
    session.sessionVersion++;
    await scheduler.failure(lease, upstream401);
    assert.equal(expired, false);
    assert.equal(lease.account.healthy, true);
    assert.equal(lease.slot.failure_count, 0);
    scheduler.release(lease);
});

test("only Google upstream UNAUTHENTICATED triggers session expiration", async t => {
    for (const error of [
        { message: "Invalid API key", status: 401 },
        { message: "UNAUTHENTICATED", status: 401 },
        { message: "Google API returned error: 403 PERMISSION_DENIED", status: 403 },
        { message: "Google API returned error: 429 RESOURCE_EXHAUSTED", status: 429 },
        { message: upstream401.message, reason: "client_disconnect" },
        { kind: "transport", message: upstream401.message },
    ]) {
        const scheduler = setup({}, 1);
        t.after(() => scheduler.close());
        scheduler.authSource.markAsExpired = () => assert.fail("Unexpected session expiration");
        const lease = await scheduler.acquire("flash");
        await scheduler.failure(lease, error);
        scheduler.release(lease);
    }
});

test("expiration storage failures are logged without an unhandled rejection", async t => {
    const scheduler = setup({}, 1);
    t.after(() => scheduler.close());
    const errors = [];
    scheduler.logger = { ...logger, error: message => errors.push(message) };
    scheduler.authSource.markAsExpired = async () => {
        throw new Error("storage unavailable");
    };
    const lease = await scheduler.acquire("flash");
    await scheduler.failure(lease, upstream401);
    assert.match(errors[0], /Failed to expire auth #0.*storage unavailable/);
    scheduler.release(lease);
});

test("concurrent reservations isolate accounts and cap global workers", async () => {
    const scheduler = setup();
    const leases = await Promise.all(Array.from({ length: 6 }, () => scheduler.acquire("flash")));
    assert.equal(new Set(leases.map(lease => lease.account.index)).size, 6);
    const queued = scheduler.acquire("other");
    assert.equal(scheduler.pending.length, 1);
    scheduler.release(leases[0]);
    const next = await queued;
    assert.equal(scheduler.snapshot().active_workers, 6);
    scheduler.release(next);
    leases.forEach(lease => scheduler.release(lease));
    assert.equal(scheduler.snapshot().active_workers, 0);
    scheduler.close();
});

test("429 only cools one model and recovers after deadline", async () => {
    const scheduler = setup({}, 1);
    const a = await scheduler.acquire("a");
    scheduler.startAttempt(a);
    scheduler.failure(a, { status: 429 });
    scheduler.release(a);
    await assert.rejects(scheduler.acquire("a"), /No eligible/);
    const b = await scheduler.acquire("b");
    assert.equal(b.account.healthy, true);
    scheduler.release(b);
    a.slot.cooldown_until = Date.now() - 1;
    const probe = await scheduler.acquire("a");
    assert.equal(probe.slot.rate_limited, false);
    scheduler.release(probe);
    scheduler.close();
});

test("permissions, account failures and manual recovery have distinct scope", async () => {
    const scheduler = setup({}, 1);
    const a = await scheduler.acquire("a");
    scheduler.failure(a, { message: "PERMISSION_DENIED", status: 403 });
    assert.equal(a.account.healthy, true);
    assert.equal(a.slot.unsupported, false);
    assert.ok(a.slot.cooldown_until > Date.now());
    scheduler.release(a);
    await assert.rejects(scheduler.acquire("a"));
    const b = await scheduler.acquire("b");
    scheduler.failure(b, { isAuthExpired: true });
    scheduler.release(b);
    await assert.rejects(scheduler.acquire("c"));
    scheduler.reset(0, "a");
    await assert.rejects(scheduler.acquire("a"));
    scheduler.reset(0);
    const recovered = await scheduler.acquire("a");
    scheduler.release(recovered);
    assert.equal(classifyError({ message: "Forbidden", status: 403 }), "risk_controlled");
    assert.equal(classifyError({ message: "PERMISSION_DENIED", status: 403 }), "risk_controlled");
    assert.equal(classifyError({ message: "[403] Proxy browser error" }), "risk_controlled");
    assert.equal(
        classifyError({ message: "Proxy browser error: Google API returned error: 403 PERMISSION_DENIED" }),
        "risk_controlled"
    );
    assert.equal(classifyError({ message: "model unsupported for account" }), "unsupported");
    assert.equal(classifyError({ message: "Invalid request", status: 400 }), "request");
    assert.equal(classifyError({ status: 503 }), "temporary");
    scheduler.close();
});

test("temporary failure backs off without disabling account", async () => {
    const scheduler = setup({ tempErrorCooldownMs: 1000 }, 1);
    for (let i = 0; i < 4; i++) {
        const lease = await scheduler.acquire("a");
        scheduler.failure(lease, { status: 503 });
        assert.equal(lease.account.healthy, true);
        assert.ok(lease.slot.cooldown_until - Date.now() <= 1000 * Math.min(4, 2 ** i));
        assert.ok(lease.slot.cooldown_until > Date.now());
        scheduler.release(lease);
        lease.slot.cooldown_until = 0;
    }
    scheduler.close();
});

test("403 risk control uses independent deterministic backoff and resets only on success", async () => {
    const scheduler = setup(
        {
            riskControlCooldownMs: 600000,
            riskControlJitter: false,
            riskControlMaxCooldownMs: 10800000,
            tempErrorCooldownMs: 1000,
        },
        1
    );
    const expected = [600000, 1800000, 3600000, 10800000, 10800000];
    for (let i = 0; i < expected.length; i++) {
        const lease = await scheduler.acquire("a");
        const before = Date.now();
        scheduler.failure(lease, { status: 403 });
        assert.ok(lease.slot.cooldown_until - before >= expected[i]);
        assert.ok(lease.slot.cooldown_until - before <= expected[i] + 20);
        assert.equal(lease.slot.risk_control_failures, i + 1);
        assert.equal(lease.slot.consecutive_failures, 0);
        assert.equal(lease.slot.last_error_kind, "risk_controlled");
        assert.equal(lease.account.healthy, true);
        assert.equal(lease.slot.unsupported, false);
        scheduler.release(lease);
        lease.slot.cooldown_until = 0;
    }
    const temporary = await scheduler.acquire("a");
    scheduler.failure(temporary, { status: 503 });
    assert.equal(temporary.slot.risk_control_failures, 5);
    assert.equal(temporary.slot.consecutive_failures, 1);
    scheduler.release(temporary);
    temporary.slot.cooldown_until = 0;
    const success = await scheduler.acquire("a");
    scheduler.startAttempt(success);
    scheduler.release(success, true);
    assert.equal(success.slot.risk_control_failures, 0);
    assert.equal(success.slot.last_error_kind, null);
    scheduler.close();
});

test("continuous 403 is account-wide, threshold-derived, and cleared only by observed non-403 results", async () => {
    let now = 1_800_000_000_000;
    const scheduler = setup({ now: () => now, riskControlJitter: false }, 1);
    const first = await scheduler.acquire("a");
    scheduler.startAttempt(first);
    scheduler.failure(first, { status: 403 });
    scheduler.release(first);
    assert.equal(first.account.continuous_403_since, now);
    assert.equal(scheduler.accountsOverviewSnapshot().accounts[0].persistent_403, false);

    first.slot.cooldown_until = 0;
    now += 24 * 60 * 60 * 1000;
    const second = await scheduler.acquire("b");
    scheduler.failure(second, { message: "[403] denied" });
    scheduler.release(second);
    assert.equal(second.account.continuous_403_since, 1_800_000_000_000);

    now += 24 * 60 * 60 * 1000;
    const overview = scheduler.accountsOverviewSnapshot();
    assert.equal(overview.accounts[0].persistent_403, true);
    assert.equal(overview.accounts[0].continuous_403_duration_ms, 48 * 60 * 60 * 1000);
    assert.equal(overview.summary.persistent_403, 1);
    const eligibleBefore = scheduler.eligibleAccounts("probe").length;
    assert.equal(eligibleBefore, 1);

    scheduler.reset(0);
    scheduler.resetAllAccounts();
    scheduler.resetAllRateLimits();
    scheduler.resetDailyCooldowns();
    assert.equal(second.account.continuous_403_since, 1_800_000_000_000);

    const transport = await scheduler.acquire("transport");
    scheduler.failure(transport, { kind: "transport" });
    scheduler.release(transport);
    assert.equal(transport.account.continuous_403_since, 1_800_000_000_000);

    const non403 = await scheduler.acquire("non403");
    scheduler.failure(non403, { status: 500 });
    scheduler.release(non403);
    assert.equal(non403.account.continuous_403_since, null);

    non403.slot.cooldown_until = 0;
    const again = await scheduler.acquire("success");
    scheduler.startAttempt(again);
    scheduler.failure(again, { status: 403 });
    scheduler.release(again);
    again.slot.cooldown_until = 0;
    const success = await scheduler.acquire("success");
    scheduler.startAttempt(success);
    scheduler.release(success, true);
    assert.equal(success.account.continuous_403_since, null);
    scheduler.close();
});

test("daily cooldown reset preserves administrative, health, unsupported, usage, lease and 403 history", async () => {
    const scheduler = setup({ globalConcurrency: 2 }, 1);
    const active = await scheduler.acquire("a");
    scheduler.startAttempt(active);
    Object.assign(active.account, {
        continuous_403_since: Date.now() - 3 * 86400000,
        disabled: true,
        disabled_at: 123,
        disabled_reason: "manual",
        healthy: false,
        last_error: "login required",
    });
    Object.assign(active.slot, {
        consecutive_failures: 3,
        cooldown_until: Date.now() + 60000,
        failure_count: 9,
        last_error: "temporary",
        last_error_kind: "temporary",
        last_http_status: 503,
        rate_limited: true,
        risk_control_failures: 2,
        success_count: 4,
        unsupported: true,
    });
    const counts = {
        daily: active.slot.daily_request_count,
        failures: active.slot.failure_count,
        requests: active.slot.request_count,
        success: active.slot.success_count,
    };
    assert.deepEqual(scheduler.resetDailyCooldowns(), { affected_account_count: 1, affected_slot_count: 1 });
    assert.equal(active.account.disabled, true);
    assert.equal(active.account.healthy, false);
    assert.equal(active.account.last_error, "login required");
    assert.ok(active.account.continuous_403_since);
    assert.equal(active.slot.unsupported, true);
    assert.equal(active.slot.inflight, 1);
    assert.equal(active.worker.lease, active);
    assert.deepEqual(
        {
            daily: active.slot.daily_request_count,
            failures: active.slot.failure_count,
            requests: active.slot.request_count,
            success: active.slot.success_count,
        },
        counts
    );
    assert.equal(active.slot.cooldown_until, 0);
    assert.equal(active.slot.last_error, null);
    scheduler.failure(active, { status: 429 });
    assert.equal(active.slot.rate_limited, true);
    assert.ok(active.slot.cooldown_until > Date.now());
    scheduler.release(active);
    scheduler.close();
});

test("manual account disable is lease-safe and only account-wide recovery clears it", async () => {
    const scheduler = setup({ globalConcurrency: 2 }, 2);
    const active = await scheduler.acquire("a");
    const result = scheduler.disable(active.account.index);
    assert.deepEqual(result, { account_id: 0, changed: true, disabled: true });
    assert.equal(active.account.inflight, 1);
    assert.equal(scheduler.disable(0).changed, false);
    const replacement = await scheduler.acquire("a");
    assert.equal(replacement.account.index, 1);
    scheduler.release(replacement);
    scheduler.release(active, true);

    scheduler.reset(0, "a");
    assert.equal(scheduler.account(0).disabled, true);
    assert.equal(
        scheduler.eligibleAccounts("a").some(account => account.index === 0),
        false
    );
    scheduler.resetAllRateLimits();
    assert.equal(scheduler.account(0).disabled, true);
    const revisionBeforeReset = scheduler.accountsOverviewSnapshot().revision;
    const sequenceBeforeReset = scheduler.sequence;
    assert.deepEqual(scheduler.reset(0), { account_id: 0, changed: true, scope: "account" });
    assert.equal(scheduler.account(0).disabled, false);
    assert.equal(scheduler.account(0).disabled_at, null);
    assert.equal(scheduler.account(0).healthy, true);
    assert.equal(scheduler.sequence, sequenceBeforeReset + 1);
    assert.notEqual(scheduler.accountsOverviewSnapshot().revision, revisionBeforeReset);
    assert.deepEqual(scheduler.reset(0), { account_id: 0, changed: false, scope: "account" });
    assert.equal(scheduler.sequence, sequenceBeforeReset + 1);
    scheduler.close();
});

test("model recovery invalidates account details only when observable state changes", () => {
    const scheduler = setup({}, 1);
    const slot = scheduler.slot(scheduler.account(0), "flash");
    Object.assign(slot, {
        consecutive_failures: 2,
        cooldown_until: Date.now() + 60000,
        last_error: "limited",
        last_error_kind: "rate_limited",
        last_http_status: 429,
        rate_limited: true,
    });
    const revision = scheduler.accountsOverviewSnapshot().revision;
    const sequence = scheduler.sequence;
    assert.deepEqual(scheduler.reset(0, "flash"), {
        account_id: 0,
        changed: true,
        model: "flash",
        scope: "model",
    });
    assert.equal(scheduler.sequence, sequence + 1);
    assert.notEqual(scheduler.accountsOverviewSnapshot().revision, revision);
    assert.deepEqual(scheduler.reset(0, "flash"), {
        account_id: 0,
        changed: false,
        model: "flash",
        scope: "model",
    });
    assert.equal(scheduler.sequence, sequence + 1);
    scheduler.close();
});

test("manual account disable survives version 7 persistence and bulk enable clears it", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-disabled-"));
    const statePath = path.join(directory, "state.json");
    const first = setup({ statePath }, 1);
    first.disable(0);
    first.close();
    const persisted = JSON.parse(fs.readFileSync(statePath));
    assert.equal(persisted.version, 7);
    assert.equal(persisted.accounts[0].disabled, true);

    const second = setup({ statePath }, 1);
    assert.equal(second.account(0).disabled, true);
    assert.deepEqual(second.resetAllAccounts(), { reset_account_count: 1, reset_model_count: 0 });
    assert.equal(second.account(0).disabled, false);
    second.close();
    fs.rmSync(directory, { recursive: true });
});

test("minimum allocation gets next free worker and idle capacity can be borrowed", async () => {
    const scheduler = setup({ allocation: { a: { min: 3, preferred: 5 }, b: { min: 1, preferred: 1 } } });
    const borrowed = await Promise.all(Array.from({ length: 6 }, () => scheduler.acquire("a")));
    const hot = scheduler.acquire("a");
    const minority = scheduler.acquire("b");
    scheduler.release(borrowed[0]);
    const b = await minority;
    assert.equal(scheduler.pending[0].model, "a");
    scheduler.release(b);
    const a = await hot;
    scheduler.release(a);
    borrowed.forEach(lease => scheduler.release(lease));
    scheduler.close();
});

test("static allocation and per-model concurrency limit active work", async () => {
    const scheduler = setup({
        allocation: { a: { min: 0, preferred: 1 } },
        dynamic: false,
        modelConcurrency: { b: 1 },
    });
    const a = await scheduler.acquire("a");
    const b = await scheduler.acquire("b");
    const controller = new AbortController();
    const waitingA = scheduler.acquire("a", new Set(), controller.signal);
    const waitingB = scheduler.acquire("b", new Set(), controller.signal);
    assert.equal(scheduler.pending.length, 2);
    controller.abort();
    await Promise.all([assert.rejects(waitingA), assert.rejects(waitingB)]);
    scheduler.release(a);
    scheduler.release(b);
    scheduler.close();
});

test("cancellation, queue bounds and timeout do not leak reservations", async () => {
    const scheduler = setup({ globalConcurrency: 1, queueSize: 1, queueTimeoutMs: 10 }, 1);
    const lease = await scheduler.acquire("a");
    const waiting = scheduler.acquire("a");
    await assert.rejects(scheduler.acquire("a"), /Queue full/);
    await assert.rejects(waiting, /Queue timeout/);
    const controller = new AbortController();
    const cancelled = scheduler.acquire("a", new Set(), controller.signal);
    controller.abort();
    await assert.rejects(cancelled, /Client disconnected/);
    assert.equal(scheduler.pending.length, 0);
    scheduler.release(lease);
    scheduler.release(lease);
    assert.equal(lease.account.inflight, 0);
    scheduler.close();
});

test("already attempted accounts are never reused", async () => {
    const scheduler = setup({}, 1);
    await assert.rejects(scheduler.acquire("a", new Set(["auth-0"])), /No eligible/);
    scheduler.close();
});

test("state persists across restart but leases never do", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-scheduler-"));
    const statePath = path.join(directory, "state.json");
    const first = setup({ statePath }, 1);
    const lease = await first.acquire("a");
    first.startAttempt(lease);
    first.failure(lease, { message: "quota", status: 429 });
    first.flush();
    const second = setup({ statePath }, 1);
    const slot = second.slot(second.account(0), "a");
    assert.equal(slot.request_count, 1);
    assert.equal(slot.daily_request_count, 1);
    assert.equal(slot.daily_request_date, first.getPacificDateKey());
    assert.equal(slot.failure_count, 1);
    assert.equal(slot.inflight, 0);
    assert.equal(slot.rate_limited, true);
    await assert.rejects(second.acquire("a"));
    first.close();
    second.close();
    fs.rmSync(directory, { recursive: true });
});

test("hidden models preserve history and reject new leases until restored", async () => {
    const scheduler = setup(
        {
            allocation: {
                "gemini-3-flash": { min: 0, preferred: 1 },
                "gemini-3-pro": { min: 0, preferred: 1 },
            },
        },
        1
    );
    const account = scheduler.account(0);
    const slot = scheduler.slot(account, "gemini-3-flash");
    Object.assign(slot, {
        cooldown_until: Date.now() + 60000,
        daily_failure_count: 2,
        daily_request_count: 7,
        failure_count: 3,
        last_error: "quota",
        rate_limited: true,
        request_count: 9,
    });
    const before = { ...slot };

    const revision = scheduler.sequence;
    assert.deepEqual(scheduler.hideModel(" models/gemini-3-flash "), {
        changed: true,
        hidden: true,
        model: "gemini-3-flash",
    });
    assert.ok(scheduler.sequence > revision);
    assert.deepEqual(scheduler.hideModel("gemini-3-flash"), {
        changed: false,
        hidden: true,
        model: "gemini-3-flash",
    });
    assert.deepEqual(scheduler.hiddenModelsSnapshot(), ["gemini-3-flash"]);
    assert.equal(scheduler._snapshotModels().has("gemini-3-flash"), true);
    assert.equal(
        scheduler.summarySnapshot().models.some(model => model.model === "gemini-3-flash"),
        false
    );
    assert.equal(
        scheduler.summarySnapshot().quota_by_model.some(model => model.model === "gemini-3-flash"),
        false
    );
    assert.equal(Object.hasOwn(scheduler.snapshot().accounts[0].models, "gemini-3-flash"), false);
    assert.deepEqual(slot, before);

    slot.cooldown_until = 0;
    slot.rate_limited = false;
    await assert.rejects(scheduler.acquire("gemini-3-flash"), error => error.status === 403);
    assert.equal(scheduler.isModelHidden("gemini-3-flash"), true);
    assert.equal(slot.request_count, 9);
    assert.equal(
        scheduler.summarySnapshot().models.some(model => model.model === "gemini-3-flash"),
        false
    );

    assert.deepEqual(scheduler.showModel("gemini-3-flash"), {
        changed: true,
        hidden: false,
        model: "gemini-3-flash",
    });
    const lease = await scheduler.acquire("gemini-3-flash");
    scheduler.startAttempt(lease);
    scheduler.release(lease, true);
    assert.equal(scheduler.snapshot().accounts[0].models["gemini-3-flash"].request_count, 10);
    assert.equal(scheduler.showModel("gemini-3-flash").changed, false);
    assert.throws(
        () => scheduler.hideModel("__files__"),
        error => error.status === 400
    );
    assert.throws(
        () => scheduler.hideModel("missing-model"),
        error => error.status === 404
    );
    scheduler.hideModel("gemini-3-flash");
    scheduler.hideModel("gemini-3-pro");
    const emptySnapshot = scheduler.snapshot();
    assert.deepEqual(emptySnapshot.models, []);
    assert.deepEqual(emptySnapshot.quota_by_model, []);
    assert.equal(emptySnapshot.estimated_remaining_quota, 0);
    assert.equal(emptySnapshot.quota_tracked_models, 0);
    assert.deepEqual(emptySnapshot.accounts[0].models, {});
    scheduler.close();
});

test("hidden models persist in version 7 state and legacy states default to visible", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-hidden-"));
    const statePath = path.join(directory, "state.json");
    const first = setup({ allocation: { flash: { min: 0, preferred: 1 } }, statePath }, 1);
    first.hideModel("flash");
    assert.equal(JSON.parse(fs.readFileSync(statePath)).version, 7);
    const second = setup({ allocation: { flash: { min: 0, preferred: 1 } }, statePath }, 1);
    assert.deepEqual(second.hiddenModelsSnapshot(), ["flash"]);
    first.close();
    second.close();

    const legacy = JSON.parse(fs.readFileSync(statePath));
    legacy.version = 3;
    delete legacy.hiddenModels;
    fs.writeFileSync(statePath, JSON.stringify(legacy));
    const third = setup({ allocation: { flash: { min: 0, preferred: 1 } }, statePath }, 1);
    assert.deepEqual(third.hiddenModelsSnapshot(), []);
    third.close();
    fs.rmSync(directory, { recursive: true });
});

test("Pacific date keys honor PST, PDT and daylight-saving transitions", () => {
    const scheduler = setup({}, 1);
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-01-01T07:59:59Z")), "2025-12-31");
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-01-01T08:00:00Z")), "2026-01-01");
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-07-01T06:59:59Z")), "2026-06-30");
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-07-01T07:00:00Z")), "2026-07-01");
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-03-08T07:59:59Z")), "2026-03-07");
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-03-08T08:00:00Z")), "2026-03-08");
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-11-01T09:30:00Z")), "2026-11-01");
    scheduler.close();
});

test("next Pacific reset honors standard time, daylight time, missing and repeated wall times", () => {
    assert.equal(
        calculateNextPacificResetAt(Date.parse("2026-01-15T07:00:00Z"), "00:00"),
        Date.parse("2026-01-15T08:00:00Z")
    );
    assert.equal(
        calculateNextPacificResetAt(Date.parse("2026-07-15T06:00:00Z"), "00:00"),
        Date.parse("2026-07-15T07:00:00Z")
    );
    assert.equal(
        calculateNextPacificResetAt(Date.parse("2026-03-08T08:01:00Z"), "02:30"),
        Date.parse("2026-03-08T10:00:00Z")
    );
    assert.equal(
        calculateNextPacificResetAt(Date.parse("2026-11-01T07:00:00Z"), "01:30"),
        Date.parse("2026-11-01T08:30:00Z")
    );
});

test("daily reset timer fires once per Pacific date, replans, and is cleared on close", () => {
    let now = Date.parse("2026-01-15T07:59:00Z");
    const timers = [];
    const cleared = [];
    const scheduler = setup(
        {
            clearTimer: timer => cleared.push(timer),
            dailyResetTime: "00:00",
            now: () => now,
            setTimer(callback, delay) {
                const timer = {
                    callback,
                    delay,
                    unref() {
                        this.unrefCalled = true;
                    },
                    unrefCalled: false,
                };
                timers.push(timer);
                return timer;
            },
        },
        1
    );
    assert.equal(timers[0].delay, 60000);
    assert.equal(timers[0].unrefCalled, true);
    const slot = scheduler.slot(scheduler.account(0), "a");
    Object.assign(slot, { cooldown_until: now + 600000, last_error: "quota", rate_limited: true });
    now += 60000;
    timers[0].callback();
    assert.equal(slot.cooldown_until, 0);
    assert.equal(timers.length, 2);
    assert.equal(timers[1].delay, 24 * 60 * 60 * 1000);
    scheduler.close();
    assert.equal(cleared.at(-1), timers[1]);
});

test("daily attempts count once per lease and roll over without changing cumulative usage", async () => {
    const scheduler = setup({ allocation: { flash: { min: 0, preferred: 1 } } }, 1);
    const lease = await scheduler.acquire("flash");
    scheduler.startAttempt(lease);
    scheduler.startAttempt(lease);
    assert.equal(lease.slot.daily_request_count, 1);
    assert.equal(lease.slot.request_count, 1);
    scheduler.release(lease);

    lease.slot.daily_request_date = "2000-01-01";
    lease.slot.daily_request_count = 9;
    lease.slot.request_count = 10;
    const snapshot = scheduler.snapshot();
    assert.equal(lease.slot.daily_request_count, 0);
    assert.equal(lease.slot.request_count, 10);
    assert.equal(snapshot.models.find(model => model.model === "flash").daily_requests, 0);
    assert.equal(snapshot.accounts[0].models.flash.daily_requests, 0);
    scheduler.close();
});

test("upstream failures use the Pacific daily window while aborts and transport errors do not", async () => {
    const scheduler = setup({}, 1);
    const lease = await scheduler.acquire("gemini-3-flash");
    scheduler.startAttempt(lease);
    scheduler.failure(lease, { message: "quota", status: 429 });
    assert.equal(lease.slot.daily_failure_count, 1);
    assert.equal(scheduler.accountsSnapshot([lease.account.index]).accounts[0].models[0].daily_failures, 1);
    scheduler.release(lease);

    const aborted = { account: lease.account, recorded: false, slot: lease.slot };
    scheduler.failure(aborted, { reason: "client_disconnect" });
    assert.equal(aborted.slot.daily_failure_count, 1);

    aborted.slot.daily_request_date = "2000-01-01";
    const cumulativeFailures = aborted.slot.failure_count;
    scheduler.summarySnapshot();
    assert.equal(aborted.slot.daily_failure_count, 0);
    assert.equal(aborted.slot.failure_count, cumulativeFailures);
    scheduler.close();
});

test("account details expose one model list with aggregate 403 and 429 flags", () => {
    const scheduler = setup({}, 1);
    const account = scheduler.account(0);
    const riskControlled = scheduler.slot(account, "risk-model");
    riskControlled.last_error_kind = "risk_controlled";
    riskControlled.risk_control_failures = 1;
    riskControlled.cooldown_until = Date.now() + 60_000;
    const rateLimited = scheduler.slot(account, "rate-model");
    rateLimited.rate_limited = true;
    rateLimited.cooldown_until = Date.now() + 60_000;

    const details = scheduler.accountsSnapshot([0]).accounts[0];
    assert.equal(details.has_403, true);
    assert.equal(details.has_429, true);
    assert.deepEqual(scheduler.accountsOverviewSnapshot().summary, {
        disabled: 0,
        healthy: 0,
        persistent_403: 0,
        rate_limited: 0,
        risk_controlled: 1,
        total: 1,
        unhealthy: 0,
    });
    assert.deepEqual(
        details.models.map(slot => [slot.model, slot.status]),
        [
            ["rate-model", "RATE_LIMITED"],
            ["risk-model", "RISK_CONTROLLED"],
        ]
    );
    scheduler.close();
});

test("version 5 state migrates structured status from strict legacy 403 errors", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-v5-403-"));
    const statePath = path.join(directory, "state.json");
    fs.writeFileSync(
        statePath,
        JSON.stringify({
            accounts: [
                {
                    healthy: true,
                    key: "auth-0",
                    last_error: "[403] Proxy browser error",
                    models: {
                        flash: {
                            consecutive_failures: 0,
                            cooldown_until: 0,
                            daily_failure_count: 1,
                            daily_request_count: 1,
                            daily_request_date: "2026-09-15",
                            failure_count: 1,
                            inflight: 0,
                            last_error: "[403] Proxy browser error: Google API returned error: 403 PERMISSION_DENIED",
                            last_used_at: 0,
                            rate_limited: false,
                            request_count: 1,
                            success_count: 0,
                            unsupported: true,
                        },
                    },
                },
            ],
            fileAffinities: [],
            hiddenModels: [],
            version: 5,
        })
    );

    const scheduler = setup({ statePath }, 1);
    const slot = scheduler.account(0).models.flash;
    assert.equal(slot.last_error_kind, "risk_controlled");
    assert.equal(slot.last_http_status, 403);
    assert.equal(slot.risk_control_failures, 1);
    assert.equal(slot.unsupported, false);
    assert.equal(scheduler.accountsOverviewSnapshot().summary.risk_controlled, 1);
    scheduler.close();
    fs.rmSync(directory, { recursive: true });
});

test("version 1 state preserves cumulative values and initializes daily usage at zero", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-v1-"));
    const statePath = path.join(directory, "state.json");
    fs.writeFileSync(
        statePath,
        JSON.stringify({
            accounts: [
                {
                    healthy: true,
                    key: "auth-0",
                    last_error: null,
                    models: { flash: { inflight: 3, request_count: 42 } },
                },
            ],
            fileAffinities: [],
            version: 1,
        })
    );
    const scheduler = setup({ statePath }, 1);
    const slot = scheduler.slot(scheduler.account(0), "flash");
    assert.equal(slot.request_count, 42);
    assert.equal(slot.daily_request_count, 0);
    assert.equal(slot.daily_request_date, scheduler.getPacificDateKey());
    assert.equal(slot.inflight, 0);
    scheduler.close();
    fs.rmSync(directory, { recursive: true });
});

test("quota estimates use valid accounts, hyphen segments and clamp each slot at zero", () => {
    assert.equal(getModelDailyQuota("gemini-3-flash"), 100);
    assert.equal(getModelDailyQuota("gemini-3-flash-lite"), 100);
    assert.equal(getModelDailyQuota("gemini-3-pro-preview"), 10);
    assert.equal(getModelDailyQuota("gemini-profile"), null);
    assert.equal(getModelDailyQuota("flashlight"), null);
    assert.equal(getModelDailyQuota("imagen-flash"), null);
    assert.equal(getModelDailyQuota("__files__"), null);

    const auth = {
        accountNameMap: new Map([
            [0, "first@example.com"],
            [2, "second@example.com"],
        ]),
        availableIndices: [0, 1, 2, 3],
        getRotationIndices: () => [0, 2],
    };
    const config = {
        ...loadConfig({ MAX_BROWSER_WORKERS: "4" }),
        allocation: {
            "gemini-3-flash": { min: 0, preferred: 1 },
            "gemini-3-flash-lite": { min: 0, preferred: 1 },
            "gemini-3-pro-preview": { min: 0, preferred: 1 },
            "text-embedding": { min: 0, preferred: 1 },
        },
        statePath: null,
    };
    const scheduler = new ModelScheduler(config, auth, logger);
    const firstFlash = scheduler.slot(scheduler.account(0), "gemini-3-flash");
    const secondFlash = scheduler.slot(scheduler.account(2), "gemini-3-flash");
    firstFlash.daily_request_count = 120;
    secondFlash.daily_request_count = 3;
    scheduler.account(0).healthy = false;
    firstFlash.rate_limited = true;
    const snapshot = scheduler.snapshot();
    assert.equal(snapshot.quota_tracked_accounts, 2);
    assert.equal(snapshot.quota_tracked_models, 3);
    assert.equal(snapshot.estimated_remaining_quota, 317);
    assert.deepEqual(
        snapshot.quota_by_model.map(item => item.model),
        ["gemini-3-flash", "gemini-3-flash-lite", "gemini-3-pro-preview"]
    );
    assert.equal(snapshot.quota_by_model.find(item => item.model === "gemini-3-flash").estimated_remaining_quota, 97);
    assert.equal(snapshot.models.find(model => model.model === "gemini-3-flash").daily_requests, 123);
    scheduler.close();
});

test("configuration validates capacity and honors legacy mode", () => {
    assert.equal(loadConfig({ ACCOUNT_ROTATION_STRATEGY: "legacy" }).enabled, false);
    assert.equal(loadConfig({}).dailyResetEnabled, true);
    assert.equal(loadConfig({}).dailyResetTime, "00:00");
    assert.equal(loadConfig({ SCHEDULER_DAILY_RESET_ENABLED: "false" }).dailyResetEnabled, false);
    assert.equal(loadConfig({ SCHEDULER_DAILY_RESET_ENABLED: "FALSE" }).dailyResetEnabled, true);
    assert.equal(loadConfig({ SCHEDULER_DAILY_RESET_TIME: "23:59" }).dailyResetTime, "23:59");
    assert.throws(() => loadConfig({ SCHEDULER_DAILY_RESET_TIME: "24:00" }), /SCHEDULER_DAILY_RESET_TIME/);
    assert.throws(() => loadConfig({ SCHEDULER_DAILY_RESET_TIME: "1:00" }), /SCHEDULER_DAILY_RESET_TIME/);
    assert.throws(() => loadConfig({ SCHEDULER_DAILY_RESET_TIME: "" }), /SCHEDULER_DAILY_RESET_TIME/);
    assert.throws(() => loadConfig({ MAX_BROWSER_WORKERS: "0" }));
    assert.throws(() => loadConfig({ MODEL_WORKER_ALLOCATION: '{"a":2}' }));
    assert.throws(() => loadConfig({ MODEL_MAX_CONCURRENCY: '{"a":0}' }));
    assert.equal(loadConfig({ MAX_RETRIES_PER_REQUEST: "0" }).maxRetries, 0);
});

test("version 6 starts continuous 403 tracking empty while version 7 preserves and validates it", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-v7-403-"));
    const statePath = path.join(directory, "state.json");
    const first = setup({ statePath }, 1);
    const lease = await first.acquire("a");
    first.failure(lease, { status: 403 });
    const since = lease.account.continuous_403_since;
    first.release(lease);
    first.close();
    assert.equal(JSON.parse(fs.readFileSync(statePath)).version, 7);

    const second = setup({ statePath }, 1);
    assert.equal(second.account(0).continuous_403_since, since);
    second.close();

    const legacy = JSON.parse(fs.readFileSync(statePath));
    legacy.version = 6;
    legacy.accounts[0].continuous_403_since = since;
    fs.writeFileSync(statePath, JSON.stringify(legacy));
    const upgraded = setup({ statePath }, 1);
    assert.equal(upgraded.account(0).continuous_403_since, null);
    upgraded.close();

    const invalid = JSON.parse(fs.readFileSync(statePath));
    invalid.accounts[0].continuous_403_since = -1;
    fs.writeFileSync(statePath, JSON.stringify(invalid));
    const rejected = setup({ statePath }, 1);
    assert.equal(rejected.accounts.size, 0);
    assert.ok(fs.readdirSync(directory).some(name => name.includes(".corrupt-")));
    rejected.close();
    fs.rmSync(directory, { recursive: true });
});

test("corrupt state is backed up and inflight reset does not persist a lock", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-corrupt-"));
    const statePath = path.join(directory, "state.json");
    fs.writeFileSync(statePath, "{partial");
    const scheduler = setup({ statePath });
    assert.equal(scheduler.accounts.size, 0);
    assert.ok(fs.readdirSync(directory).some(name => name.includes(".corrupt-")));
    scheduler.close();
    assert.equal(JSON.parse(fs.readFileSync(statePath)).version, 7);
    fs.rmSync(directory, { recursive: true });
});

test("bulk 429 reset preserves other failures, statistics and active leases", async () => {
    const scheduler = setup({}, 2);
    const active = await scheduler.acquire("running");
    for (const index of [0, 1]) {
        const slot = scheduler.slot(scheduler.account(index), "limited");
        Object.assign(slot, {
            cooldown_until: Date.now() + 60000,
            failure_count: 4,
            last_error: "quota",
            rate_limited: true,
        });
    }
    const other = scheduler.slot(scheduler.account(0), "temporary");
    Object.assign(other, { cooldown_until: Date.now() + 30000, unsupported: true });
    scheduler.account(1).healthy = false;
    const before = { ...other };
    const sequenceBeforeReset = scheduler.sequence;
    assert.equal(scheduler.resetAllRateLimits(), 2);
    assert.equal(scheduler.sequence, sequenceBeforeReset + 1);
    for (const index of [0, 1]) {
        const slot = scheduler.account(index).models.limited;
        assert.equal(slot.rate_limited, false);
        assert.equal(slot.cooldown_until, 0);
        assert.equal(slot.failure_count, 4);
        assert.equal(slot.last_error, "quota");
    }
    assert.deepEqual(other, before);
    assert.equal(scheduler.account(1).healthy, false);
    assert.equal(active.account.inflight, 1);
    assert.equal(scheduler.resetAllRateLimits(), 0);
    assert.equal(scheduler.sequence, sequenceBeforeReset + 1);
    scheduler.startAttempt(active);
    scheduler.failure(active, { status: 429 });
    assert.equal(active.slot.rate_limited, true);
    scheduler.release(active);
    scheduler.close();
});

test("enabling all rotation accounts clears scheduler blocks but preserves usage and active leases", async () => {
    const scheduler = setup({ globalConcurrency: 2, maxWorkers: 1 }, 2);
    const active = await scheduler.acquire("flash");
    scheduler.startAttempt(active);
    Object.assign(active.account, { healthy: false, last_error: "login failed" });
    Object.assign(active.slot, {
        consecutive_failures: 3,
        cooldown_until: Date.now() + 60000,
        failure_count: 7,
        last_error: "risk",
        rate_limited: true,
        success_count: 5,
        unsupported: true,
    });
    const second = scheduler.slot(scheduler.account(1), "pro");
    second.cooldown_until = Date.now() + 30000;
    second.consecutive_failures = 1;
    second.last_error = "temporary";
    const usageBefore = {
        daily: active.slot.daily_request_count,
        failures: active.slot.failure_count,
        requests: active.slot.request_count,
        success: active.slot.success_count,
    };

    const sequenceBeforeReset = scheduler.sequence;
    assert.deepEqual(scheduler.resetAllAccounts(), { reset_account_count: 1, reset_model_count: 2 });
    assert.equal(scheduler.sequence, sequenceBeforeReset + 1);
    assert.equal(active.account.healthy, true);
    assert.equal(active.account.last_error, null);
    assert.equal(active.account.inflight, 1);
    assert.equal(active.slot.inflight, 1);
    assert.equal(active.worker.lease, active);
    assert.equal(active.slot.unsupported, false);
    assert.equal(active.slot.rate_limited, false);
    assert.equal(active.slot.cooldown_until, 0);
    assert.equal(active.slot.consecutive_failures, 0);
    assert.equal(active.slot.last_error, null);
    assert.deepEqual(
        {
            daily: active.slot.daily_request_count,
            failures: active.slot.failure_count,
            requests: active.slot.request_count,
            success: active.slot.success_count,
        },
        usageBefore
    );
    assert.deepEqual(scheduler.resetAllAccounts(), { reset_account_count: 0, reset_model_count: 0 });
    assert.equal(scheduler.sequence, sequenceBeforeReset + 1);

    scheduler.failure(active, { status: 403 });
    assert.ok(active.slot.cooldown_until > Date.now());
    scheduler.release(active);
    scheduler.close();
});

test("one account fills global concurrency independently of context capacity", async () => {
    const scheduler = setup({ globalConcurrency: 12, maxWorkers: 1 }, 1);
    const leases = await Promise.all(Array.from({ length: 12 }, () => scheduler.acquire("a")));
    assert.equal(scheduler.account(0).inflight, 12);
    assert.equal(scheduler.pending.length, 0);
    scheduler.startAttempt(leases[0]);
    scheduler.startAttempt(leases[0]);
    scheduler.failure(leases[0], { status: 429 });
    scheduler.failure(leases[0], { status: 429 });
    scheduler.release(leases[1], true);
    await assert.rejects(scheduler.acquire("a"), /No eligible/);
    const other = await scheduler.acquire("b");
    assert.equal(other.account.index, 0);
    assert.equal(leases[0].slot.request_count, 1);
    assert.equal(leases[0].slot.failure_count, 1);
    assert.equal(leases[0].slot.rate_limited, true);
    scheduler.release(other);
    leases.forEach(lease => scheduler.release(lease));
    assert.equal(scheduler.account(0).inflight, 0);
    scheduler.close();
});

test("account and model caps queue independently and zero model cap overrides inheritance", async () => {
    const scheduler = setup({ accountConcurrency: 3, accountModelConcurrency: { a: 1, b: 0 } }, 1);
    const a = await scheduler.acquire("a");
    const queued = scheduler.acquire("a");
    const b = await scheduler.acquire("b");
    const c = await scheduler.acquire("b");
    assert.equal(scheduler.pending.length, 1);
    scheduler.release(a);
    const next = await queued;
    [b, c, next].forEach(lease => scheduler.release(lease));
    scheduler.close();
});

test("context reservations reuse busy accounts instead of overbooking browser capacity", async () => {
    const scheduler = setup({ globalConcurrency: 12, maxWorkers: 2 });
    const leases = await Promise.all(Array.from({ length: 12 }, () => scheduler.acquire("a")));
    assert.equal(new Set(leases.map(lease => lease.account.index)).size, 2);
    assert.equal(scheduler.account(0).inflight, 6);
    assert.equal(scheduler.account(1).inflight, 6);
    leases.forEach(lease => scheduler.release(lease));
    const rotated = await scheduler.acquire("a");
    assert.equal(rotated.account.index, 2);
    scheduler.release(rotated);
    scheduler.close();
});

test("concurrency config accepts independent capacities and rejects invalid account limits", () => {
    const config = loadConfig({ GLOBAL_MAX_CONCURRENCY: "24", MAX_BROWSER_WORKERS: "1" });
    assert.equal(config.globalConcurrency, 24);
    assert.equal(config.accountConcurrency, 0);
    assert.throws(() => loadConfig({ ACCOUNT_MAX_CONCURRENCY: "-1" }));
    assert.throws(() => loadConfig({ ACCOUNT_MODEL_MAX_CONCURRENCY: '{"a":-1}' }));
    assert.throws(() => loadConfig({ ACCOUNT_MODEL_MAX_CONCURRENCY: '{"a":"2"}' }));
});

test("a model needing a cold account eventually gets a context under sustained hot traffic", async () => {
    const scheduler = setup({ globalConcurrency: 3, maxWorkers: 1 }, 2);
    scheduler.slot(scheduler.account(0), "b").unsupported = true;
    const running = await Promise.all([scheduler.acquire("a"), scheduler.acquire("a")]);
    const minority = scheduler.acquire("b");
    const hot = scheduler.acquire("a");
    assert.equal(scheduler.pending.length, 2);
    scheduler.release(running[0]);
    assert.equal(scheduler.pending.length, 2);
    scheduler.release(running[1]);
    const b = await minority;
    assert.equal(b.account.index, 1);
    const a = await hot;
    scheduler.release(a);
    scheduler.release(b);
    scheduler.close();
});

test("ready-only scheduling spreads leases and signals cold context demand", async () => {
    const scheduler = setup(
        { contextMaxConcurrency: 0, globalConcurrency: 12, maxWorkers: 3, readyContextOnly: true },
        4
    );
    const ready = new Set([0, 1, 2]);
    const demands = [];
    scheduler.browserManager = {
        isContextReady: index => ready.has(index),
        requestContext: (index, model) => demands.push({ index, model }),
    };
    const leases = await Promise.all(Array.from({ length: 12 }, () => scheduler.acquire("a")));
    assert.deepEqual(
        [0, 1, 2].map(index => scheduler.account(index).inflight),
        [4, 4, 4]
    );
    leases.forEach(lease => scheduler.release(lease));
    ready.clear();
    const controller = new AbortController();
    const waiting = scheduler.acquire("cold", new Set(), controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(demands.at(-1), { index: 0, model: "cold" });
    controller.abort();
    await assert.rejects(waiting, /Client disconnected/);
    scheduler.close();
});

test("local queue and WebSocket failures never cool account-model state", async () => {
    const scheduler = setup({}, 1);
    for (const reason of ["page_closed", "connection_lost", "grace_period_timeout"]) {
        const lease = await scheduler.acquire("a");
        scheduler.failure(lease, { code: "QUEUE_CLOSED", reason });
        assert.equal(lease.slot.cooldown_until, 0);
        assert.equal(lease.slot.failure_count, 0);
        scheduler.release(lease);
    }
    assert.equal(scheduler.metrics.local_transport, 3);
    scheduler.close();
});

test("new context configuration validates pool and capacity limits", () => {
    const defaults = loadConfig({});
    assert.equal(defaults.browserRpcFailureThreshold, 2);
    assert.equal(defaults.browserRpcFailureWindowMs, 60000);
    assert.equal(defaults.contextCleanupTimeoutMs, 5000);
    assert.equal(defaults.contextCreationTimeoutMs, 120000);
    assert.equal(defaults.contextInitTotalTimeoutMs, 180000);
    assert.equal(defaults.contextOperationTimeoutMs, 10000);
    assert.equal(defaults.riskControlCooldownMs, 600000);
    assert.equal(defaults.riskControlMaxCooldownMs, 10800000);
    const config = loadConfig({
        CONTEXT_CREATION_TIMEOUT_MS: "90000",
        CONTEXT_INIT_CONCURRENCY: "3",
        CONTEXT_MAX_CONCURRENCY: "5",
        CONTEXT_POOL_MIN_READY: "4",
        MAX_BROWSER_WORKERS: "6",
        REQUEST_DISPATCH_TIMEOUT_MS: "25000",
    });
    assert.equal(config.contextCreationTimeoutMs, 90000);
    assert.equal(config.contextInitConcurrency, 3);
    assert.equal(config.contextMaxConcurrency, 5);
    assert.equal(config.contextPoolMinReady, 4);
    assert.equal(config.queueTimeoutMs, 25000);
    assert.throws(() => loadConfig({ CONTEXT_POOL_MIN_READY: "3", MAX_BROWSER_WORKERS: "2" }));
    assert.throws(() => loadConfig({ CONTEXT_CREATION_TIMEOUT_MS: "0" }), /Invalid CONTEXT_CREATION_TIMEOUT_MS/);
    assert.throws(
        () =>
            loadConfig({
                CONTEXT_INIT_TOTAL_TIMEOUT_MS: "10000",
                CONTEXT_OPERATION_TIMEOUT_MS: "10000",
            }),
        /must exceed/
    );
});

test("100 requests spread across 12 ready contexts without header-style serialization", async () => {
    const scheduler = setup(
        { contextMaxConcurrency: 0, globalConcurrency: 100, maxWorkers: 12, readyContextOnly: true },
        12
    );
    scheduler.browserManager = { isContextReady: () => true, requestContext() {} };
    const leases = await Promise.all(Array.from({ length: 100 }, () => scheduler.acquire("a")));
    const distribution = Array.from({ length: 12 }, (_, index) => scheduler.account(index).inflight);
    assert.equal(
        distribution.reduce((sum, value) => sum + value, 0),
        100
    );
    assert.ok(Math.max(...distribution) - Math.min(...distribution) <= 1);
    leases.forEach(lease => scheduler.release(lease));
    scheduler.close();
});

test("cold model demand does not block requests using an existing ready context", async () => {
    const scheduler = setup({ contextPoolMinReady: 1, globalConcurrency: 2, maxWorkers: 2, readyContextOnly: true }, 2);
    scheduler.slot(scheduler.account(0), "cold-model").unsupported = true;
    const demanded = [];
    scheduler.browserManager = {
        isContextReady: index => index === 0,
        requestContext: index => demanded.push(index),
    };
    const controller = new AbortController();
    const cold = scheduler.acquire("cold-model", new Set(), controller.signal);
    const hot = await scheduler.acquire("hot-model");
    assert.equal(hot.account.index, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(demanded.includes(1));
    controller.abort();
    await assert.rejects(cold);
    scheduler.release(hot);
    scheduler.close();
});

test("visible quota exhaustion is pure and requires actual unexpired 429 for every model", () => {
    const scheduler = setup({ allocation: { flash: { min: 0, preferred: 1 }, pro: { min: 0, preferred: 1 } } }, 1);
    const account = scheduler.account(0);
    assert.equal(scheduler.isAccountQuotaExhausted(account, 1000), false);
    assert.deepEqual(Object.keys(account.models), []);
    account.models.pro = { cooldown_until: 2000, rate_limited: true };
    assert.equal(scheduler.isAccountQuotaExhausted(account, 1000), false);
    account.models.flash = { cooldown_until: 2000, rate_limited: true };
    account.models.__files__ = {};
    assert.deepEqual([...scheduler.getVisibleModels()].sort(), ["flash", "pro"]);
    assert.equal(scheduler.isAccountQuotaExhausted(account, 1000), true);
    assert.equal(scheduler.isAccountQuotaExhausted(account, 2000), false);
    for (const kind of ["risk_controlled", "temporary", "transport", "unsupported"]) {
        account.models.flash = {
            cooldown_until: 2000,
            daily_request_count: 100,
            last_error_kind: kind,
            rate_limited: false,
            unsupported: kind === "unsupported",
        };
        assert.equal(scheduler.isAccountQuotaExhausted(account, 1000), false);
    }
    scheduler.hiddenModels = new Set(["flash", "pro"]);
    assert.equal(scheduler.isAccountQuotaExhausted(account, 1000), false);
    scheduler.close();
});

test("hidden model queues reject immediately while existing leases finish", async () => {
    const scheduler = setup({ allocation: {}, globalConcurrency: 1 }, 1);
    const lease = await scheduler.acquire("gemini-3-pro");
    const pending = scheduler.acquire("gemini-3-pro");
    scheduler.hideModel("models/gemini-3-pro-high-fake-search");
    await assert.rejects(pending, error => error.status === 403);
    await assert.rejects(scheduler.acquire("gemini-3-pro-high-real-code"), error => error.status === 403);
    assert.equal(lease.released, false);
    assert.equal(lease.account.inflight, 1);
    scheduler.release(lease, true);
    assert.equal(scheduler.pending.length, 0);
    scheduler.close();
});

test("persisted cooldown rebuilds a single wake timer on restart and clears it at shutdown", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-wake-"));
    const statePath = path.join(directory, "state.json");
    const now = Date.now();
    const first = setup({ dailyResetEnabled: false, statePath }, 1);
    const slot = first.slot(first.account(0), "pro");
    Object.assign(slot, { cooldown_until: now + 60000, rate_limited: true });
    first.close();
    const timers = [];
    const cleared = [];
    const second = setup(
        {
            clearTimer: timer => {
                if (timer) cleared.push(timer);
            },
            dailyResetEnabled: false,
            now: () => now,
            setTimer(callback, delay) {
                const timer = { callback, delay, unref() {} };
                timers.push(timer);
                return timer;
            },
            statePath,
        },
        1
    );
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 60000);
    assert.equal(second.nextCooldownCheckAt, now + 60000);
    assert.equal(second.isAccountPoolResident(0), false);
    second.hideModel("pro");
    second._scheduleCooldownWake();
    assert.equal(second.nextCooldownCheckAt, null);
    second.showModel("pro");
    second._scheduleCooldownWake();
    assert.equal(timers.length, 2);
    second.close();
    assert.equal(cleared.at(-1), timers[1]);
    fs.rmSync(directory, { recursive: true });
});

test("structured upstream UNAUTHENTICATED preserves session expiry and late-session guards", async t => {
    for (const replace of [false, true]) {
        const scheduler = setup({}, 1);
        t.after(() => scheduler.close());
        const session = { authIndex: 0, sessionVersion: 7 };
        scheduler.authSource.accountLoginService = { state: { accounts: [session] } };
        const calls = [];
        scheduler.authSource.markAsExpired = async (...args) => calls.push(args);
        const lease = await scheduler.acquire("flash");
        scheduler.startAttempt(lease);
        if (replace) session.sessionVersion++;
        await scheduler.failure(lease, {
            message: "Credentials expired",
            status: 401,
            upstreamError: { code: 401, message: "Credentials expired", status: "UNAUTHENTICATED" },
        });
        assert.deepEqual(calls, replace ? [] : [[0, 7]]);
        assert.equal(lease.account.healthy, replace);
        scheduler.release(lease);
    }
});

test("permission denials share model-independent jittered, capped cooldown and expire naturally", async t => {
    for (const model of ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.1-pro-preview"]) {
        for (const transport of ["makersuite", "build"]) {
            let now = Date.now();
            const since = now;
            const scheduler = setup(
                {
                    now: () => now,
                    random: () => 1,
                    riskControlCooldownMs: 1000,
                    riskControlMaxCooldownMs: 10000,
                },
                1
            );
            t.after(() => scheduler.close());
            scheduler.authSource.accountLoginService = { state: { accounts: [{ authIndex: 0, manualTier: "pro" }] } };
            for (const [index, error] of [
                { message: "model unsupported PERMISSION_DENIED", status: 403 },
                { message: "PERMISSION_DENIED" },
                { message: "RPC failed: Code 7" },
                { code: 7 },
                { error: { code: 403, message: "denied" } },
            ].entries()) {
                const lease = await scheduler.acquire(model);
                scheduler.failure(lease, { ...error, transport });
                assert.equal(lease.slot.unsupported, false);
                assert.equal(lease.account.healthy, true);
                assert.equal(lease.slot.last_error_kind, "risk_controlled");
                assert.equal(lease.slot.last_http_status, 403);
                assert.equal(lease.slot.risk_control_failures, index + 1);
                assert.equal(lease.account.continuous_403_since, since);
                const cooldown = Math.min(10000, [1, 3, 6, 18, 18][index] * 1100);
                assert.equal(lease.slot.cooldown_until, now + cooldown);
                scheduler.release(lease);
                assert.equal(scheduler.isResourceEligible(lease.account, model), false);
                now += cooldown;
                assert.equal(scheduler.isResourceEligible(lease.account, model), true);
            }
        }
    }
});

test("historical permission exclusions are backed up and recovered without clearing unrelated state", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-permission-recovery-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const statePath = path.join(directory, "state.json");
    const seed = setup({ statePath }, 1);
    const account = seed.account(0);
    account.continuous_403_since = 1234;
    account.disabled = true;
    for (const [model, error] of [
        ["gemini-4-argon", { last_http_status: 403 }],
        ["gemini-3.8-flash", { last_error: "PERMISSION_DENIED" }],
        ["gemini-3.1-pro-preview", { last_error: "RPC failed: Code 7" }],
        ["unsupported-model", { last_error: "model unsupported for account" }],
    ]) {
        Object.assign(seed.slot(account, model), {
            cooldown_until: Date.now() + 86400000,
            daily_failure_count: 2,
            daily_request_count: 3,
            failure_count: 4,
            last_error_kind: "unsupported",
            rate_limit_type: "daily_quota",
            rate_limited: true,
            request_count: 5,
            unsupported: true,
            ...error,
        });
    }
    seed.close();
    const original = fs.readFileSync(statePath, "utf8");
    const restored = setup({ statePath }, 1);
    const backups = fs.readdirSync(directory).filter(name => name.includes(".before-403-backoff-"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(directory, backups[0]), "utf8"), original);
    const expected = JSON.parse(original).accounts[0];
    for (const [model, slot] of Object.entries(expected.models)) {
        if (model === "unsupported-model") continue;
        Object.assign(slot, {
            last_error_kind: "risk_controlled",
            last_http_status: 403,
            risk_control_failures: 1,
            unsupported: false,
        });
    }
    assert.deepEqual(JSON.parse(JSON.stringify(restored.account(0))), expected);
    restored.close();
    const restarted = setup({ statePath }, 1);
    restarted.close();
    assert.equal(fs.readdirSync(directory).filter(name => name.includes(".before-403-backoff-")).length, 1);
});

test("failed recovery backup retains historical exclusions and all accounts", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-permission-backup-failure-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const statePath = path.join(directory, "state.json");
    const seed = setup({ statePath }, 2);
    Object.assign(seed.slot(seed.account(0), "flash"), {
        last_error_kind: "unsupported",
        last_http_status: 403,
        unsupported: true,
    });
    seed.account(1).disabled = true;
    seed.close();
    const original = fs.readFileSync(statePath, "utf8");
    const copy = t.mock.method(fs, "copyFileSync", () => {
        throw new Error("backup unavailable");
    });
    const restored = setup({ statePath }, 2);
    copy.mock.restore();
    assert.equal(restored.account(0).models.flash.unsupported, true);
    assert.equal(restored.account(1).disabled, true);
    assert.equal(fs.readFileSync(statePath, "utf8"), original);
    restored.close();
});

const usageLimitSample = require("./fixtures/makersuite/model-usage-limit.json");
const usageLimitError = { message: usageLimitSample.message, status: usageLimitSample.httpStatus };

test("explicit usage reset countdown applies to every model and error envelope and expires naturally", async t => {
    for (const model of ["gemini-4-argon", "gemini-3.8-flash"]) {
        for (const error of [
            usageLimitError,
            { status: 429, upstreamError: { message: usageLimitSample.message } },
            { error: { code: 429, message: usageLimitSample.message } },
            { message: JSON.stringify({ error: usageLimitError }), status: 429 },
        ]) {
            let now = Date.parse("2026-10-30T06:30:00Z");
            const scheduler = setup({ dailyResetEnabled: false, now: () => now }, 1);
            t.after(() => scheduler.close());
            scheduler.authSource.accountLoginService = { state: { accounts: [{ authIndex: 0, manualTier: "pro" }] } };
            const lease = await scheduler.acquire(model);
            scheduler.failure(lease, error);
            assert.equal(lease.slot.rate_limit_type, "usage_limit");
            assert.equal(lease.slot.cooldown_until, now + 94 * 60000);
            assert.equal(lease.account.healthy, true);
            assert.equal(lease.slot.unsupported, false);
            const detail = scheduler.accountsSnapshot().accounts[0].models.find(slot => slot.model === model);
            assert.equal(detail.rate_limit_type, "usage_limit");
            assert.equal(detail.cooldown_until, lease.slot.cooldown_until);
            scheduler.release(lease);
            now += 94 * 60000 - 1;
            assert.equal(scheduler.isResourceEligible(lease.account, model), false);
            now++;
            assert.equal(scheduler.isResourceEligible(lease.account, model), true);
            const recovered = await scheduler.acquire(model);
            assert.equal(recovered.slot.rate_limited, false);
            assert.equal(recovered.slot.rate_limit_type, null);
            scheduler.release(recovered);
        }
    }
});

test("usage countdown parser validates units and rejects ambiguous or malformed hints", async t => {
    for (const [duration, expected] of [
        ["1 hour", 3600000],
        ["2 hours, 1 minute", 7260000],
        ["34 minutes", 2040000],
        ["1 minute, 1 second", 61000],
        ["1 day, 2 hours, 3 minutes and 4 seconds", 93784000],
        ["0.5 seconds", 500],
        ["0 minutes", 60000],
        ["-1 hour", 60000],
        ["1 hour, 2 hours", 60000],
        ["1 hour, garbage", 60000],
        ["Infinity hours", 60000],
        ["999999999999999999 hours", 60000],
        ["1 month", 60000],
        ["", 60000],
    ]) {
        const now = Date.now();
        const scheduler = setup({ now: () => now }, 1);
        t.after(() => scheduler.close());
        const lease = await scheduler.acquire("flash");
        scheduler.failure(lease, {
            message: `You've reached your usage limit for this model (resets in ${duration}).`,
            status: 429,
        });
        assert.equal(lease.slot.cooldown_until, now + expected, duration);
        assert.equal(lease.slot.rate_limit_type, expected === 60000 ? "temporary" : "usage_limit", duration);
        scheduler.release(lease);
    }
    for (const message of [
        "RESOURCE_EXHAUSTED (resets in 1 hour)",
        "Please retry in 1 hour",
        "You've reached your usage limit for this model",
    ]) {
        const scheduler = setup({}, 1);
        t.after(() => scheduler.close());
        const lease = await scheduler.acquire("flash");
        scheduler.failure(lease, { message, status: 429 });
        assert.equal(lease.slot.rate_limit_type, "temporary");
        scheduler.release(lease);
    }
});

test("concurrent quota responses preserve the longest confirmed block and ignore temporary limits and success", async t => {
    for (const usageFirst of [true, false]) {
        const now = Date.parse("2026-10-30T06:30:00Z");
        const scheduler = setup({ now: () => now }, 1);
        t.after(() => scheduler.close());
        const leases = await Promise.all(Array.from({ length: 4 }, () => scheduler.acquire("flash")));
        leases.forEach(lease => scheduler.startAttempt(lease));
        const errors = usageFirst ? [usageLimitError, dailyQuotaError] : [dailyQuotaError, usageLimitError];
        errors.forEach((error, index) => scheduler.failure(leases[index], error));
        scheduler.failure(leases[2], { message: "Quota exceeded", status: 429 });
        scheduler.release(leases[3], true);
        assert.equal(leases[0].slot.rate_limit_type, "usage_limit");
        assert.equal(leases[0].slot.cooldown_until, now + 94 * 60000);
        leases.forEach(lease => scheduler.release(lease));
    }
});

test("automatic daily reset preserves explicit usage deadlines, manual reset overrides them, and restart does not restart countdown", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-usage-reset-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const statePath = path.join(directory, "state.json");
    let now = Date.parse("2026-10-30T06:30:00Z");
    const first = setup({ dailyResetEnabled: false, now: () => now, statePath }, 1);
    const lease = await first.acquire("flash");
    first.failure(lease, usageLimitError);
    const deadline = lease.slot.cooldown_until;
    first.release(lease);
    first.close();
    now += 30 * 60000;
    const restored = setup({ dailyResetEnabled: false, now: () => now, statePath }, 1);
    t.after(() => restored.close());
    const slot = restored.account(0).models.flash;
    assert.equal(slot.rate_limit_type, "usage_limit");
    assert.equal(slot.cooldown_until, deadline);
    const beforeReset = JSON.stringify(slot);
    restored.resetDailyCooldowns();
    assert.equal(JSON.stringify(slot), beforeReset);
    for (const reset of [
        scheduler => scheduler.resetAllRateLimits(),
        scheduler => scheduler.resetAllAccounts(),
        scheduler => scheduler.reset(0),
        scheduler => scheduler.reset(0, "flash"),
    ]) {
        Object.assign(slot, { cooldown_until: deadline, rate_limit_type: "usage_limit", rate_limited: true });
        reset(restored);
        assert.equal(slot.cooldown_until, 0);
        assert.equal(slot.rate_limited, false);
        assert.equal(slot.rate_limit_type, null);
    }
    Object.assign(slot, { cooldown_until: now - 1, rate_limit_type: "usage_limit", rate_limited: true });
    restored.resetDailyCooldowns();
    assert.equal(slot.cooldown_until, 0);
});

test("shorter usage countdown cannot shorten a daily block and later confirmed usage can extend it", async t => {
    const now = Date.parse("2026-10-30T03:00:00Z");
    const scheduler = setup({ now: () => now }, 1);
    t.after(() => scheduler.close());
    const leases = await Promise.all(Array.from({ length: 4 }, () => scheduler.acquire("flash")));
    scheduler.failure(leases[0], dailyQuotaError);
    const midnight = leases[0].slot.cooldown_until;
    scheduler.failure(leases[1], usageLimitError);
    assert.equal(leases[0].slot.cooldown_until, midnight);
    assert.equal(leases[0].slot.rate_limit_type, "daily_quota");
    scheduler.failure(leases[2], {
        message: "You've reached your usage limit for this model (resets in 5 hours).",
        status: 429,
    });
    scheduler.failure(leases[3], usageLimitError);
    assert.equal(leases[0].slot.cooldown_until, now + 5 * 3600000);
    assert.equal(leases[0].slot.rate_limit_type, "usage_limit");
    leases.forEach(lease => scheduler.release(lease));
});
