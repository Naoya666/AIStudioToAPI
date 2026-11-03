const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BuildRuntime } = require("../src/core/codeAssistant/BuildRuntime");
const { BuildRecoveryStore } = require("../src/core/codeAssistant/BuildRecoveryStore");
const { BuildRecoveryManager } = require("../src/core/codeAssistant/BuildRecoveryManager");
const { buildError } = require("../src/core/codeAssistant/BuildError");
const UsageStatsStorage = require("../src/core/UsageStatsStorage");
function fixture(t, entries = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-recovery-"));
    const statePath = path.join(dir, "projects.json");
    fs.writeFileSync(statePath, JSON.stringify(entries));
    const resources = {};
    t.after(async () => {
        await resources.manager?.close();
        await resources.storage?.close();
        fs.rmSync(dir, { force: true, recursive: true });
    });
    const r = new BuildRuntime({ accountKey: "account", page: {}, statePath });
    return { dir, r, resources, statePath };
}
const entry = (extra = {}) => ({ account: "account", app: "app", complete: false, task: "task", ...extra });
const unavailable = () => buildError({ httpStatus: 503, message: "Unavailable", rpcCode: 14, source: "google_rpc" });
function manager(t, f) {
    const account = { healthy: true, index: 0, inflight: 0, key: "account", models: {} };
    const page = { accountSessionVersion: 1, playgroundTransport: { ready: true } };
    const system = {
        authSource: { getRotationIndices: () => [0] },
        browserManager: { contexts: new Map([[0, { page }]]), isContextReady: () => true, requestRecoveryContext() {} },
        scheduler: { account: () => account, accounts: new Map([[0, account]]), drain() {}, saveSoon() {} },
    };
    let now = Date.now();
    const m = new BuildRecoveryManager(system, { now: () => now, statePath: f.statePath });
    clearInterval(m.timer);
    f.resources.manager = m;
    return {
        account,
        advance: () => {
            now += 1000000;
        },
        m,
        page,
        system,
    };
}
test("cancel confirmation survives a restart and only Delete is retried", async t => {
    const f = fixture(t, { op: entry() });
    const calls = [];
    f.r.rpc = async method => {
        calls.push(method);
        if (method === "DeleteApplet") throw unavailable();
        return "[]";
    };
    await assert.rejects(f.r.recover());
    assert.ok(f.r.read().op.cancelConfirmedAt);
    const restarted = new BuildRuntime({ accountKey: "account", page: {}, statePath: f.statePath });
    restarted.rpc = async method => {
        calls.push(method);
        return "[]";
    };
    await restarted.recover();
    assert.deepEqual(calls, ["CancelCodeAssistantOfflineGeneration", "DeleteApplet", "DeleteApplet"]);
    assert.deepEqual(restarted.read(), {});
});
test("Cancel failure never crosses to Delete; terminal tasks skip Cancel", async t => {
    const f = fixture(t, { op: entry() });
    const calls = [];
    f.r.rpc = async method => {
        calls.push(method);
        throw unavailable();
    };
    await assert.rejects(f.r.recover());
    assert.equal(f.r.read().op.cancelConfirmedAt, null);
    assert.deepEqual(calls, ["CancelCodeAssistantOfflineGeneration"]);
    f.r.save("op", { ...f.r.read().op, complete: true });
    f.r.rpc = async method => {
        calls.push(method);
        return "[]";
    };
    await f.r.recover();
    assert.equal(calls.at(-1), "DeleteApplet");
});
test("legacy import preserves unknown facts, unknown fields, restricted backup and corrupt journal", t => {
    const f = fixture(t, { op: entry({ extra: 42 }) });
    const imported = f.r.read().op;
    assert.equal(imported.requestId, null);
    assert.equal(imported.createdAt, null);
    assert.equal(imported.generationState, "unknown");
    assert.equal(imported.extra, 42);
    const backup = fs.readdirSync(f.dir).find(name => name.includes("pre-v2"));
    assert.equal(fs.statSync(path.join(f.dir, backup)).mode & 0o777, 0o600);
    fs.writeFileSync(f.statePath, "{");
    assert.throws(() => f.r.read(), /unreadable/);
});
test("proxy 404 is not confirmation; parsed RPC NOT_FOUND still requires Delete", async t => {
    const f = fixture(t, { op: entry() });
    f.r.rpc = async () => {
        throw buildError({ httpStatus: 404, message: "Not found", source: "google_http" });
    };
    await assert.rejects(f.r.recover());
    assert.equal(f.r.read().op.cancelConfirmedAt, null);
    const calls = [];
    f.r.rpc = async method => {
        calls.push(method);
        throw buildError({ httpStatus: 404, message: "Missing", rpcCode: 5, source: "google_rpc" });
    };
    await f.r.recover();
    assert.deepEqual(calls, ["CancelCodeAssistantOfflineGeneration", "DeleteApplet"]);
});
test("page replacement during RPC cannot commit confirmation; current page recovers", async t => {
    const f = fixture(t, { op: entry({ complete: true }) });
    const { m, system, account, advance } = manager(t, f);
    system.browserManager.contexts.get(0).page.evaluate = async () => {
        system.browserManager.contexts.set(0, {
            page: {
                accountSessionVersion: 2,
                evaluate: async () => ({ status: 200, text: "[]" }),
                playgroundTransport: { ready: true },
            },
        });
        return { status: 200, text: "[]" };
    };
    await m.run();
    assert.equal(f.r.read().op.deleteConfirmedAt, null);
    assert.equal(account.buildRecoveryBlocked, true);
    advance();
    await m.run();
    assert.deepEqual(f.r.read(), {});
    assert.equal(account.buildRecoveryBlocked, false);
});
test("duplicate wakeups respect ownership, backoff and all operations on the account", async t => {
    const f = fixture(t, { active: entry(), op: entry({ complete: true }) });
    const { m, page, account, advance } = manager(t, f);
    m.store.active.add("active");
    let calls = 0;
    page.evaluate = async () => {
        calls++;
        return { status: 503, text: JSON.stringify([14, "Unavailable"]) };
    };
    m.wake();
    m.wake();
    await m.task;
    const failedCalls = calls;
    m.wake();
    await m.task;
    assert.equal(calls, failedCalls);
    assert.ok(f.r.read().op.nextAttemptAt);
    page.evaluate = async () => ({ status: 200, text: "[]" });
    advance();
    await m.run();
    assert.ok(f.r.read().active);
    assert.equal(account.buildRecoveryBlocked, true);
    m.store.active.delete("active");
});
test("unresolved submission is quarantined without any generation or cleanup RPC", async t => {
    const f = fixture(t, { op: entry({ app: null, task: null }) });
    const { m, page } = manager(t, f);
    page.evaluate = async () => {
        throw new Error("must not call upstream");
    };
    await m.run();
    assert.equal(f.r.read().op.retryState, "quarantined");
    assert.equal(f.r.read().op.cleanupStage, "verify_pending");
});
test("crash window after upstream deletion retains journal for idempotent replay", async t => {
    const f = fixture(t, { op: entry({ complete: true }) });
    const save = f.r.save.bind(f.r);
    f.r.rpc = async () => "[]";
    f.r.save = (id, value) => {
        if (value?.deleteConfirmedAt) throw new Error("disk failure");
        save(id, value);
    };
    await assert.rejects(f.r.recover(), /disk failure/);
    assert.equal(f.r.read().op.deleteConfirmedAt, null);
    f.r.save = save;
    f.r.rpc = async () => {
        throw buildError({ httpStatus: 404, message: "Missing", rpcCode: 5, source: "google_rpc" });
    };
    await f.r.recover();
    assert.deepEqual(f.r.read(), {});
});
test("orphan scheduler flags remain isolated and a second live manager cannot consume journal", async t => {
    const f = fixture(t);
    const { m, system, account } = manager(t, f);
    account.buildRecoveryBlocked = true;
    m.reconcile();
    assert.equal(account.buildRecoveryReason, "recovery_state_inconsistent");
    const second = new BuildRecoveryManager(system, { statePath: f.statePath });
    assert.equal(second.fault, "recovery_storage_unavailable");
    await second.close();
    assert.ok(fs.existsSync(m.lockPath));
});
test("recovery event table is indexed, bounded and independent of request/token counts", async t => {
    const f = fixture(t);
    const storage = new UsageStatsStorage({ dbPath: path.join(f.dir, "stats.sqlite") });
    f.resources.storage = storage;
    await storage.ready;
    await storage.call("build_recovery_insert", {
        endedAt: Date.now() - 31 * 86400000,
        operationId: "op",
        requestId: "req",
    });
    await storage.call("build_recovery_insert", { endedAt: Date.now(), operationId: "op", requestId: "req" });
    assert.equal((await storage.call("build_recovery_query", { requestId: "req" })).length, 1);
    assert.equal((await storage.call("query", {})).records.length, 0);
    await storage.call("build_recovery_insert", {
        endedAt: Date.now(),
        method: "DeleteApplet",
        operationId: "op",
        outcome: "confirmed",
        requestId: "req",
        startedAt: Date.now() - 5,
    });
    const metric = (await storage.call("build_recovery_metrics", {})).find(row => row.method === "DeleteApplet");
    assert.equal(metric.successes, 1);
    assert.ok(metric.last_progress_at);
    assert.equal((await storage.call("query", {})).records.length, 0);
});
test("classification distinguishes auth, permission, quota, invalid arguments and retryable outage", t => {
    const f = fixture(t);
    const { m } = manager(t, f);
    for (const [status, state] of [
        [401, "waiting_auth"],
        [403, "waiting_permission"],
        [429, "scheduled"],
        [400, "quarantined"],
        [503, "scheduled"],
    ]) {
        const e = entry();
        m.failed("op", e, buildError({ message: "failure", status }));
        assert.equal(f.r.read().op.retryState, state);
        assert.ok(f.r.read().op.nextAttemptAt > Date.now());
    }
});
test("shared journal updates preserve concurrent operations", t => {
    const f = fixture(t);
    const store = BuildRecoveryStore.open(f.statePath);
    f.r.save("a", entry());
    store.save("b", entry());
    assert.deepEqual(Object.keys(store.read()).sort(), ["a", "b"]);
});

test("per-account cleanup execution is serialized across different runtimes", async t => {
    const f = fixture(t, { a: entry({ complete: true }), b: entry({ complete: true }) });
    const second = new BuildRuntime({ accountKey: "account", page: {}, statePath: f.statePath });
    let running = 0,
        peak = 0;
    const rpc = async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise(resolve => setImmediate(resolve));
        running--;
        return "[]";
    };
    f.r.rpc = second.rpc = rpc;
    const state = f.r.read();
    await Promise.all([f.r.cleanup("a", state.a), second.cleanup("b", state.b)]);
    assert.equal(peak, 1);
    assert.deepEqual(f.r.read(), {});
});
test("401 waits for a new session and then resumes without clearing unrelated account state", async t => {
    const f = fixture(t, { op: entry({ complete: true }) });
    const { m, page, advance, account } = manager(t, f);
    account.models.pg = { cooldown_until: Date.now() + 10000000, unsupported: true };
    const original = structuredClone(account.models);
    let calls = 0;
    page.evaluate = async () => {
        calls++;
        return { status: 401, text: JSON.stringify([16, "Unauthenticated"]) };
    };
    await m.run();
    advance();
    await m.run();
    assert.equal(f.r.read().op.retryState, "waiting_auth");
    const attempts = calls;
    await m.run();
    assert.equal(calls, attempts);
    page.accountSessionVersion++;
    page.evaluate = async () => ({ status: 200, text: "[]" });
    await m.run();
    assert.deepEqual(f.r.read(), {});
    assert.deepEqual(account.models, original);
});
test("deleted or corrupted journal fails closed with visible storage fault", async t => {
    const f = fixture(t, { op: entry() });
    const { m, account } = manager(t, f);
    fs.unlinkSync(f.statePath);
    m.reconcile();
    assert.equal(m.fault, "recovery_storage_unavailable");
    assert.equal(account.buildRecoveryBlocked, true);
    assert.equal(m.snapshot().fault, "recovery_storage_unavailable");
});
test("scheduler exposes actual Build admission and requests normal cold accounts despite blocked READY accounts", t => {
    const { ModelScheduler } = require("../src/core/ModelScheduler");
    const loadConfig = require("../src/core/SchedulerConfig");
    const model = "build/gemini-3.8-flash";
    const auth = { accountNameMap: new Map(), getRotationIndices: () => [0, 1] };
    const scheduler = new ModelScheduler({ ...loadConfig({}), readyContextOnly: true, statePath: null }, auth, {
        error() {},
    });
    t.after(() => scheduler.close());
    const requests = [];
    scheduler.browserManager = {
        contexts: new Map([[0, { page: {} }]]),
        getContextPoolSnapshot: () => [],
        isContextReady: index => index === 0,
        requestContexts: batch => requests.push(...batch),
    };
    scheduler.account(0).buildRecoveryBlocked = true;
    scheduler.pending.push({ excluded: new Set(), model });
    scheduler._signalContextDemand();
    assert.equal(requests[0].authIndex, 1);
    assert.equal(scheduler.canLease(scheduler.account(0), model), false);
    assert.equal(scheduler.canLease(scheduler.account(0), "gemini-3.8-flash"), true);
    const snapshot = scheduler.summarySnapshot().models.find(m => m.model === model);
    assert.equal(snapshot.dispatchable_accounts, 0);
    assert.equal(snapshot.cleanup_blocked_accounts, 1);
    assert.equal(snapshot.queue_wait_reason, "waiting_build_cleanup");
    scheduler.pending.length = 0;
});

test("cleanup acknowledgement must match its schema and diagnostics redact resource identifiers", async t => {
    const f = fixture(t, { op: entry({ complete: true }) });
    const { m, page } = manager(t, f);
    page.evaluate = async () => ({ status: 200, text: "not-json" });
    await m.run();
    assert.equal(f.r.read().op.retryState, "quarantined");
    const r = new BuildRuntime({
        accountKey: "account",
        page: {
            evaluate: async () => ({ status: 503, text: JSON.stringify([14, "resource private-task-id unavailable"]) }),
        },
        statePath: f.statePath,
    });
    await assert.rejects(
        r.rpc("CancelCodeAssistantOfflineGeneration", ["private-task-id", "private-app-id"]),
        error => {
            assert.ok(
                !JSON.stringify(require("../src/core/codeAssistant/BuildError").errorInfo(error)).includes(
                    "private-task-id"
                )
            );
            return true;
        }
    );
});
test("migration backup can restore pending work and does not invent past confirmation", async t => {
    const f = fixture(t, { op: entry() });
    const backup = path.join(
        f.dir,
        fs.readdirSync(f.dir).find(name => name.includes("pre-v2"))
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, "utf8")), { op: entry() });
    const restoredPath = path.join(f.dir, "restored.json");
    fs.copyFileSync(backup, restoredPath);
    const r = new BuildRuntime({ accountKey: "account", page: {}, statePath: restoredPath });
    const calls = [];
    r.rpc = async method => {
        calls.push(method);
        return "[]";
    };
    await r.recover();
    assert.deepEqual(calls, ["CancelCodeAssistantOfflineGeneration", "DeleteApplet"]);
    assert.deepEqual(r.read(), {});
});

test("manual retry of known cleanup preserves backoff and never releases unknown submissions", async t => {
    const f = fixture(t, { known: entry({ complete: true }), unknown: entry({ app: null, task: null }) });
    const { m, page } = manager(t, f);
    const known = m.store.read().known;
    m.failed("known", known, buildError({ message: "Invalid ack", status: 400 }));
    const before = m.store.read().known.nextAttemptAt;
    let calls = 0;
    page.evaluate = async () => {
        calls++;
        return { status: 200, text: "[]" };
    };
    m.retryAccount(0);
    await m.task;
    assert.equal(m.store.read().known.nextAttemptAt, before);
    assert.equal(calls, 0);
    assert.equal(m.store.read().unknown.retryState, "quarantined");
    m.retryAccount(0);
    await m.task;
    assert.equal(m.store.read().unknown.retryState, "quarantined");
});
test("OS lock can be reacquired after close while retaining the same lock inode", async t => {
    const f = fixture(t);
    const { m, system } = manager(t, f);
    const inode = fs.statSync(m.lockPath).ino;
    const { spawnSync } = require("node:child_process");
    assert.equal(spawnSync("flock", ["-n", m.lockPath, "true"]).status, 1);
    await m.close();
    assert.equal(spawnSync("flock", ["-n", m.lockPath, "true"]).status, 0);
    const next = new BuildRecoveryManager(system, { statePath: f.statePath });
    assert.equal(next.fault, null);
    assert.equal(fs.statSync(next.lockPath).ino, inode);
    await next.close();
});

test("reconciliation does not classify live generation ownership as abandoned cleanup", async t => {
    const f = fixture(t);
    const { m, account } = manager(t, f);
    const live = entry({ generationState: "active" });
    m.store.save("live", live);
    m.store.active.add("live");
    m.reconcile();
    assert.equal(!!account.buildRecoveryBlocked, false);
    assert.equal(m.snapshot().pending_operations, 0);
    m.block(account.key);
    m.reconcile();
    assert.equal(account.buildRecoveryBlocked, true);
    m.store.active.delete("live");
});

test("completed proof survives the crash window before scheduler unblock is persisted", async t => {
    const f = fixture(t, { op: entry({ complete: true }) });
    const { m, page, system, account } = manager(t, f);
    page.evaluate = async () => ({ status: 200, text: "[]" });
    system.scheduler.flush = () => false;
    await m.run();
    assert.equal(m.store.read().op.cleanupStage, "done");
    assert.ok(m.store.read().op.deleteConfirmedAt);
    assert.equal(account.buildRecoveryBlocked, true);
    await m.close();
    system.scheduler.flush = () => true;
    const restarted = new BuildRecoveryManager(system, { statePath: f.statePath });
    clearInterval(restarted.timer);
    assert.equal(restarted.fault, null);
    assert.equal(account.buildRecoveryBlocked, false);
    assert.deepEqual(restarted.store.read(), {});
    await restarted.close();
});

test("reused account index never cleans an old account resource under a new identity", async t => {
    const f = fixture(t, { op: entry({ complete: true }) });
    const { m, system, page } = manager(t, f);
    system.scheduler.account = () => ({ healthy: true, index: 0, key: "new-account", models: {} });
    page.evaluate = async () => {
        throw new Error("must not send cleanup as another account");
    };
    await m.run();
    assert.equal(m.store.read().op.retryState, "waiting_auth");
    assert.deepEqual(m.store.read().op.attempts, {});
});
