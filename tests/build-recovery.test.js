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
    assert.deepEqual(calls, [
        "StreamCodeAssistantOfflineGeneration",
        "CancelCodeAssistantOfflineGeneration",
        "DeleteApplet",
        "DeleteApplet",
    ]);
    assert.deepEqual(restarted.read(), {});
});
test("Cancel failure still crosses to Delete; terminal tasks skip Cancel", async t => {
    const f = fixture(t, { op: entry() });
    const calls = [];
    f.r.rpc = async method => {
        calls.push(method);
        throw unavailable();
    };
    await assert.rejects(f.r.recover());
    assert.equal(f.r.read().op.cancelConfirmedAt, null);
    assert.deepEqual(calls, [
        "StreamCodeAssistantOfflineGeneration",
        "CancelCodeAssistantOfflineGeneration",
        "DeleteApplet",
    ]);
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
    const backup = fs.readdirSync(f.dir).find(name => name.includes("pre-v3"));
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
    assert.deepEqual(calls, ["DeleteApplet"]);
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
    assert.equal(account.buildRecoveryBlocked, false);
    assert.equal(account.buildCleanupDegraded, true);
    advance();
    await m.run();
    assert.equal(f.r.read().op.projectState, "deleted");
    assert.equal(account.buildRecoveryBlocked, false);
});
test("duplicate wakeups respect ownership, backoff and all operations on the account", async t => {
    const f = fixture(t, { active: entry({ app: "active-app" }), op: entry({ complete: true }) });
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
    assert.equal(account.buildRecoveryBlocked, false);
    m.store.active.delete("active");
});
test("unresolved submission remains an audit record with low-frequency protocol review without any generation or cleanup RPC", async t => {
    const f = fixture(t, { op: entry({ app: null, task: null }) });
    const { m, page } = manager(t, f);
    page.evaluate = async () => {
        throw new Error("must not call upstream");
    };
    await m.run();
    assert.equal(f.r.read().op.retryState, "protocol_review");
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
test("orphan scheduler flags retain visible discovery records and a second live manager cannot consume journal", async t => {
    const f = fixture(t);
    const { m, system, account } = manager(t, f);
    account.buildRecoveryBlocked = true;
    m.knownBlocked.delete(account.key); // simulate a persisted orphan flag at startup
    m.reconcile();
    assert.deepEqual(m.snapshot().inconsistent_accounts, [0]);
    assert.equal(m.admission(account).degraded, false);
    assert.equal(m.admission(account).allowed, true);
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
        [400, "protocol_review"],
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
    const f = fixture(t, { a: entry({ complete: true }), b: entry({ app: "app-b", complete: true }) });
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
    assert.equal(f.r.read().op.projectState, "deleted");
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
    assert.equal(f.r.read().op.retryState, "protocol_review");
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
        fs.readdirSync(f.dir).find(name => name.includes("pre-v3"))
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
    assert.deepEqual(calls, [
        "StreamCodeAssistantOfflineGeneration",
        "CancelCodeAssistantOfflineGeneration",
        "DeleteApplet",
    ]);
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
    assert.equal(m.store.read().unknown.retryState, "protocol_review");
    m.retryAccount(0);
    await m.task;
    assert.equal(m.store.read().unknown.retryState, "protocol_review");
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
    assert.equal(account.buildRecoveryBlocked, false);
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
    assert.equal(account.buildRecoveryBlocked, false);
    await m.close();
    system.scheduler.flush = () => true;
    const restarted = new BuildRecoveryManager(system, { statePath: f.statePath });
    clearInterval(restarted.timer);
    assert.equal(restarted.fault, null);
    assert.equal(account.buildRecoveryBlocked, false);
    assert.equal(restarted.store.read().op.projectState, "deleted");
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

function mockRpcPage(page, handler) {
    page.evaluate = async (_fn, expression) => {
        const match = expression.match(/__makerSuiteBridge\.run\((.*)\)$/s);
        if (!match) return;
        const args = JSON.parse(match[1]);
        return handler(args.rpcMethod, args);
    };
}

test("RPC9 cancellation failure persists separately from successful Delete and releases debt", async t => {
    const f = fixture(t, { op: entry() });
    const { m, page, account } = manager(t, f);
    const calls = [];
    mockRpcPage(page, async method => {
        calls.push(method);
        if (method === "StreamCodeAssistantOfflineGeneration") return { status: 503, text: '[14,"Unavailable"]' };
        if (method === "CancelCodeAssistantOfflineGeneration")
            return { status: 200, text: '[9,"Precondition check failed."]' };
        return { status: 200, text: "[null]" };
    });
    await m.run();
    const saved = m.store.read().op;
    assert.deepEqual(calls, [
        "StreamCodeAssistantOfflineGeneration",
        "CancelCodeAssistantOfflineGeneration",
        "DeleteApplet",
    ]);
    assert.equal(saved.cancelConfirmedAt, null);
    assert.equal(saved.taskTerminalAt, undefined);
    assert.equal(saved.taskState, "unknown");
    assert.equal(saved.lastErrorsByMethod.CancelCodeAssistantOfflineGeneration.upstreamError.rpcCode, 9);
    assert.equal(saved.projectState, "deleted");
    assert.equal(saved.deletionEvidence.method, "DeleteApplet");
    assert.equal(m.admission(account).allowed, true);
    assert.equal(account.disabled, undefined);
    assert.equal(m.snapshot().task_stop_unverified, 1);
    const events = JSON.parse(fs.readFileSync(`${f.statePath}.events.json`, "utf8"));
    assert.equal(events.find(e => e.method === "CancelCodeAssistantOfflineGeneration").outcome, "failed");
    assert.equal(events.find(e => e.method === "DeleteApplet").outcome, "confirmed");
});

test("a timed-out Cancel leaves an independent Delete budget and no inherited aborted signal", async t => {
    const f = fixture(t, { op: entry() });
    const { m, page } = manager(t, f);
    m.rpcTimeoutMs = 20;
    const calls = [];
    mockRpcPage(page, async method => {
        calls.push(method);
        if (method === "CancelCodeAssistantOfflineGeneration") return new Promise(() => {});
        return { status: 200, text: "[]" };
    });
    await m.run();
    assert.equal(calls.at(-1), "DeleteApplet");
    const saved = m.store.read().op;
    assert.equal(saved.lastErrorsByMethod.CancelCodeAssistantOfflineGeneration.status, 504);
    assert.equal(saved.cancelConfirmedAt, null);
    assert.ok(saved.deleteConfirmedAt);
});

test("known App with missing submission response deletes without inventing Task evidence", async t => {
    const f = fixture(t, { op: entry({ cleanupStage: "verify_pending", task: null }) });
    const { m, page } = manager(t, f);
    const calls = [];
    mockRpcPage(page, async method => {
        calls.push(method);
        return { status: 200, text: "[]" };
    });
    await m.run();
    assert.deepEqual(calls, ["DeleteApplet"]);
    assert.equal(m.store.read().op.taskState, "unknown");
    assert.equal(m.store.read().op.cancelConfirmedAt, null);
    assert.ok(m.store.read().op.deleteConfirmedAt);
});

test("deleted projects retain low-frequency task audit without blocking new Build admission", async t => {
    const f = fixture(t, { op: entry() });
    const { m, page, account, advance } = manager(t, f);
    const calls = [];
    mockRpcPage(page, async method => {
        calls.push(method);
        return method === "DeleteApplet" ? { status: 200, text: "[]" } : { status: 503, text: '[14,"Unavailable"]' };
    });
    await m.run();
    const initial = calls.length;
    await m.run();
    assert.equal(calls.length, initial);
    advance();
    advance();
    await m.run();
    assert.deepEqual(calls.slice(initial), ["StreamCodeAssistantOfflineGeneration"]);
    assert.equal(m.admission(account).allowed, true);
    assert.equal(m.snapshot().pending_operations, 0);
});

test("legacy v2 isolation migrates known resources to automatic Delete without falsifying facts", async t => {
    const f = fixture(t, {
        op: entry({
            attempts: { CancelCodeAssistantOfflineGeneration: 8 },
            cleanupStage: "verify_pending",
            lastError: { message: "Precondition check failed." },
            nextAttemptAt: Date.now() + 999999999,
            requestId: "old-request",
            retryState: "quarantined",
            schemaVersion: 2,
        }),
    });
    const migrated = f.r.read().op;
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.cleanupStage, "delete_pending");
    assert.equal(migrated.retryState, "scheduled");
    assert.equal(migrated.nextAttemptAt, null);
    assert.equal(migrated.complete, false);
    assert.equal(migrated.cancelConfirmedAt, null);
    assert.equal(migrated.attempts.CancelCodeAssistantOfflineGeneration, 8);
    assert.equal(migrated.requestId, "old-request");
    assert.equal(migrated.lastError.message, "Precondition check failed.");
});

test("Build debt cap includes synchronous dispatch reservations, degrades concurrency, and reopens after Delete", async t => {
    const { ModelScheduler } = require("../src/core/ModelScheduler");
    const loadConfig = require("../src/core/SchedulerConfig");
    const f = fixture(t);
    const auth = { accountNameMap: new Map(), getRotationIndices: () => [0] };
    const scheduler = new ModelScheduler(
        {
            ...loadConfig({
                BUILD_MAX_CONCURRENCY: "10",
                CONTEXT_MAX_CONCURRENCY: "10",
                GLOBAL_MAX_CONCURRENCY: "10",
                MAX_BROWSER_WORKERS: "1",
            }),
            statePath: null,
        },
        auth,
        { error() {}, warn() {} }
    );
    t.after(() => scheduler.close());
    const account = scheduler.account(0);
    const page = { accountSessionVersion: 1, playgroundTransport: { ready: true } };
    const browser = {
        contexts: new Map([[0, { page }]]),
        finishRecoveryContext() {},
        isContextReady: () => true,
        requestRecoveryContext() {},
    };
    const m = new BuildRecoveryManager(
        { authSource: auth, browserManager: browser, scheduler },
        { statePath: f.statePath }
    );
    clearInterval(m.timer);
    f.resources.manager = m;
    scheduler.buildRecoveryManager = m;
    scheduler.browserManager = browser;
    const model = "build/gemini-3.8-flash";
    for (let n = 0; n < 3; n++) m.store.save(`unknown${n}`, entry({ account: account.key, app: null, task: null }));
    assert.equal(m.admission(account).used, 0);
    const leases = await Promise.all(Array.from({ length: 3 }, () => scheduler.acquire(model)));
    assert.equal(account.inflight, 3);
    assert.equal(m.admission(account).used, 3);
    assert.equal(scheduler.canLease(account, model), false);
    leases.forEach(l => scheduler.release(l));
    for (let n = 0; n < 3; n++)
        m.store.save(`old${n}`, entry({ account: account.key, app: `app${n}`, complete: true }));
    m.reconcile();
    assert.equal(m.admission(account).reason, "cleanup_debt_limit");
    const publicCapacity = () =>
        scheduler.publicSummarySnapshot().models.find(row => row.model === model).availableAccounts;
    assert.equal(publicCapacity(), 0);
    assert.ok(account.buildRecoveryHoldUntil <= Date.now() + 300000);
    assert.equal(scheduler.canLease(account, "gemini-3.8-flash"), true);
    mockRpcPage(page, async () => ({ status: 200, text: "[]" }));
    await m.run();
    assert.equal(m.admission(account).debt, 2);
    assert.equal(publicCapacity(), 1);
    assert.equal(scheduler.canLease(account, model), true);
    const one = await scheduler.acquire(model);
    assert.equal(scheduler.canLease(account, model), false);
    assert.equal(publicCapacity(), 0);
    scheduler.release(one);
    assert.equal(publicCapacity(), 1);
    assert.equal(account.disabled, false);
});

test("storage repair automatically resumes recovery without clearing journal debt", async t => {
    const f = fixture(t, { op: entry({ complete: true }) });
    const { m, page } = manager(t, f);
    const intact = fs.readFileSync(f.statePath);
    fs.writeFileSync(f.statePath, "{");
    m.reconcile();
    assert.equal(m.fault, "recovery_storage_unavailable");
    fs.writeFileSync(f.statePath, intact);
    mockRpcPage(page, async () => ({ status: 200, text: "[]" }));
    m.wake();
    await m.task;
    assert.equal(m.fault, null);
    assert.ok(m.store.read().op.deleteConfirmedAt);
});

test("continuous PG dispatch yields the current page to one recovery lease", async t => {
    const f = fixture(t, { op: entry({ complete: true }) });
    const { m, system, account, page } = manager(t, f);
    const { ModelScheduler } = require("../src/core/ModelScheduler");
    const browser = system.browserManager;
    browser.requestRecoveryContext = index => {
        browser.recoveryContextDemand = { index, until: Date.now() + 40000 };
    };
    browser.finishRecoveryContext = () => {
        browser.recoveryContextDemand = null;
    };
    account.inflight = 1;
    mockRpcPage(page, async () => ({ status: 200, text: "[]" }));
    await m.run();
    assert.equal(browser.recoveryContextDemand.index, 0);
    const adapter = { browserManager: browser, buildRecoveryManager: m };
    assert.equal(ModelScheduler.prototype.canLease.call(adapter, account, "gemini-3.8-flash"), false);
    account.inflight = 0;
    await m.run();
    assert.ok(m.store.read().op.deleteConfirmedAt);
    assert.equal(browser.recoveryContextDemand, null);
});

test("an owned project cannot be deleted by a different operation", async t => {
    const f = fixture(t, { active: entry(), debt: entry({ complete: true }) });
    f.r.active.add("active");
    f.r.rpc = () => assert.fail("must not call upstream");
    await assert.rejects(f.r.cleanup("active", f.r.read().active), /foreground ownership/);
    await assert.rejects(f.r.cleanup("debt", f.r.read().debt), /another operation/);
    f.r.active.delete("active");
});

test("exact binding requires verified current-account metadata; mismatches cannot delete a user project", async t => {
    const f = fixture(t, { op: entry({ app: null, task: null }) });
    const { m, system, page, advance } = manager(t, f);
    const appId = "12345678-1234-1234-1234-123456789abc";
    m.wake = () => {}; // drive ticks explicitly
    await assert.rejects(m.bindResource("op", 1, appId, m.store.read().op.revision), { status: 400 });
    await m.bindResource("op", 0, appId, m.store.read().op.revision);
    assert.equal(m.store.read().op.app, null);
    const calls = [];
    mockRpcPage(page, async method => {
        calls.push(method);
        return { status: 200, text: "[]" };
    });
    system.buildResourceVerifier = { lookup: async () => ({ accountKey: "other-account", appId, verified: true }) };
    await m.run();
    assert.deepEqual(calls, []);
    assert.equal(m.store.read().op.app, null);
    system.buildResourceVerifier.lookup = async () => ({ accountKey: "account", appId, verified: true });
    advance();
    advance();
    await m.run();
    assert.deepEqual(calls, ["DeleteApplet"]);
    assert.equal(m.store.read().op.app, appId);
    assert.ok(m.store.read().op.deleteConfirmedAt);
});

test("a stalled event checkpoint is bounded and releases the recovery execution lease", async t => {
    const f = fixture(t, { op: entry({ complete: true }) });
    const { m, page, system } = manager(t, f);
    m.eventTimeoutMs = 10;
    system.usageStatsService = { storage: { call: () => new Promise(() => {}) } };
    mockRpcPage(page, async () => ({ status: 200, text: "[]" }));
    await m.run();
    assert.equal(m.fault, "recovery_storage_unavailable");
    assert.equal(m.activeAccounts.size, 0);
    assert.equal(m.store.executing.size, 0);
    assert.equal(m.store.read().op.deleteConfirmedAt, null);
    assert.ok(m.store.read().op.nextAttemptAt);
});

test("unknown historical projects remain visible without consuming account or node debt slots", async t => {
    const f = fixture(
        t,
        Object.fromEntries(Array.from({ length: 3 }, (_, n) => [`unknown${n}`, entry({ app: null, task: null })]))
    );
    const { m, account } = manager(t, f);
    m.nodeDebtLimit = 1;
    assert.deepEqual(m.admission(account), { allowed: true, debt: 0, degraded: false, reason: null, used: 0 });
    assert.equal(account.buildRecoveryBlocked, false);
    await m.run();
    const snapshot = m.snapshot();
    assert.equal(snapshot.resource_discovery, 3);
    assert.equal(snapshot.cleanup_debt_count, 0);
    assert.equal(snapshot.pending_operations, 3);
    assert.equal(snapshot.blocked_accounts, 0);
    assert.equal(snapshot.degraded_accounts, 0);
    assert.equal(Object.keys(m.store.read()).length, 3);
    assert.ok(m.store.read().unknown0.nextAttemptAt);
    assert.equal(m.admission(account).allowed, true);
});

test("live unknown operations still reserve capacity until foreground handoff without double counting leases", t => {
    const f = fixture(t, { op: entry({ app: null, task: null }) });
    const { m, account, system } = manager(t, f);
    let reserved = 1;
    system.scheduler.channelInflight = () => reserved;
    m.store.active.add("op");
    assert.equal(m.admission(account).used, 1);
    assert.equal(m.admission(account).debt, 0);
    m.store.active.delete("op");
    assert.equal(m.admission(account).used, 1); // foreground lease has not yet been released
    reserved = 0;
    m.reconcile();
    assert.equal(m.admission(account).used, 0);
    assert.equal(m.admission(account).degraded, false);
    assert.ok(m.store.read().op);
});

test("a verified recovered App rejoins known cleanup debt when its Delete fails", async t => {
    const f = fixture(t, { op: entry({ app: null, operationMarker: "gateway-operation:op", task: null }) });
    const { m, account, system, page } = manager(t, f);
    system.buildResourceVerifier = {
        lookup: async () => ({
            accountKey: account.key,
            appId: "12345678-1234-1234-1234-123456789abc",
            operationMarker: "gateway-operation:op",
            verified: true,
        }),
    };
    mockRpcPage(page, async () => ({ status: 503, text: '[14,"Unavailable"]' }));
    assert.equal(m.admission(account).used, 0);
    await m.run();
    assert.equal(m.store.read().op.resourceState, "known");
    assert.equal(m.admission(account).debt, 1);
    assert.equal(m.admission(account).degraded, true);
    assert.equal(m.snapshot().cleanup_debt_count, 1);
    assert.equal(m.snapshot().resource_discovery, 0);
});
