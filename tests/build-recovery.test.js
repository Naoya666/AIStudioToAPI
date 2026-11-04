const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BuildRuntime } = require("../src/core/codeAssistant/BuildRuntime");
const { migrate } = require("../scripts/ops/migrate-build-best-effort");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const CANCEL = "CancelCodeAssistantOfflineGeneration",
    DELETE = "DeleteApplet";
const flush = async () => {
    for (let n = 0; n < 30; n++) await Promise.resolve();
};
function fixture(options = {}) {
    const logs = [];
    const runtime = new BuildRuntime({
        accountIndex: 0,
        accountKey: "account",
        logger: { warn: message => logs.push(message) },
        page: {},
        ...options,
    });
    const entry = { account: "account", app: "private-app", requestId: "request", task: "private-task" };
    return { entry, logs, runtime };
}
for (const failure of [
    Object.assign(new Error("secret response token"), { upstreamError: { rpcCode: 9 } }),
    new Error("network"),
    { status: 403 },
    { status: 504 },
])
    test(`Cancel failure ${failure.status || failure.message} still attempts Delete once`, async () => {
        const { runtime, entry, logs } = fixture();
        const calls = [];
        runtime.rpc = async (method, body, options) => {
            calls.push({ body, method, options });
            if (method === CANCEL) throw failure;
            return "[]";
        };
        await runtime.cleanup("operation", entry);
        await runtime.cleanup("operation", entry);
        assert.deepEqual(
            calls.map(c => c.method),
            [CANCEL, DELETE]
        );
        assert.notEqual(calls[0].options.signal, calls[1].options.signal);
        assert.equal(
            logs.some(line => /private-|secret|token|network/.test(line)),
            false
        );
    });
test("hung Cancel and Delete each own a full 10s budget and abort local RPC waits by call ID", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
    const calls = [],
        cancellations = [];
    const { runtime, entry } = fixture({
        page: {
            evaluate: async (_, source) => {
                if (source.includes(".cancel(")) {
                    cancellations.push(source);
                    return;
                }
                const args = JSON.parse(source.match(/\.run\((.*?)\)\.then/)[1]);
                calls.push({ ...args, at: Date.now() });
                return new Promise(() => {});
            },
        },
    });
    runtime.bridgeId = "original";
    let done = false;
    const task = runtime.cleanup("operation", entry).then(() => {
        done = true;
    });
    await flush();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(9999);
    await flush();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(done, false);
    assert.equal(calls[1].at - calls[0].at, 10000);
    assert.equal(calls[1].timeoutMs, 10000);
    assert.equal(calls[1].expiresAt, 120000);
    assert.notEqual(calls[0].id, calls[1].id);
    assert.equal(cancellations.length, 1);
    t.mock.timers.tick(9999);
    await flush();
    assert.equal(done, false);
    t.mock.timers.tick(1);
    await task;
    assert.equal(cancellations.length, 2);
    t.mock.timers.tick(1000000);
    await flush();
    assert.equal(calls.length, 2);
});
test("cleanup signals are live on entry and independent of an aborted client", async () => {
    const client = new AbortController();
    client.abort();
    const { runtime, entry } = fixture();
    runtime.rpc = async (_, __, { signal }) => {
        assert.notEqual(signal, client.signal);
        assert.equal(signal.aborted, false);
    };
    await runtime.cleanup("op", entry);
});
for (const state of [{ complete: true }, { task: null }])
    test(`terminal or unknown task only deletes ${JSON.stringify(state)}`, async () => {
        const { runtime, entry } = fixture();
        Object.assign(entry, state);
        const methods = [];
        runtime.rpc = async method => {
            methods.push(method);
        };
        await runtime.cleanup("op", entry);
        assert.deepEqual(methods, [DELETE]);
    });
for (const change of ["closed", "identity", "session", "transport"])
    test(`original ${change} unavailable prevents cross-session Delete`, async () => {
        let usable = true;
        const { runtime, entry } = fixture({
            assertCurrent: () => {
                if (!usable) throw new Error(change);
            },
        });
        const methods = [];
        runtime.rpc = async method => {
            methods.push(method);
            usable = false;
            throw new Error("Cancel failed");
        };
        await runtime.cleanup("op", entry);
        assert.deepEqual(methods, [CANCEL]);
    });
test("known authentication failure skips Delete but does not affect account state", async () => {
    const { runtime, entry } = fixture();
    const methods = [];
    runtime.rpc = async method => {
        methods.push(method);
        throw { source: "google_http", status: 401 };
    };
    await runtime.cleanup("op", entry);
    assert.deepEqual(methods, [CANCEL]);
});
test("independent operations can clean concurrently without an account queue; logger failures are contained", async () => {
    const { runtime, entry } = fixture({
        logger: {
            warn() {
                throw new Error("disk full");
            },
        },
    });
    const calls = [],
        releases = [];
    runtime.rpc = (method, body) => {
        calls.push([method, body]);
        return new Promise(resolve => releases.push(resolve));
    };
    const one = runtime.cleanup("one", entry);
    const two = runtime.cleanup("two", { ...entry, app: "second", cleanupStarted: false, task: null });
    await flush();
    assert.equal(calls.length, 2);
    releases.splice(0).forEach(resolve => resolve("[]"));
    await flush();
    releases.splice(0).forEach(resolve => resolve("[]"));
    await Promise.all([one, two]);
    assert.deepEqual(
        calls.map(c => c[1]),
        [["private-task", "private-app"], ["second"], ["private-app"]]
    );
});
test("late RPC results cannot mutate a later operation or a retired runtime", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    let settle;
    const { runtime } = fixture({
        page: {
            evaluate: (_, source) =>
                source.includes(".cancel(")
                    ? Promise.resolve()
                    : new Promise(resolve => {
                          settle = resolve;
                      }),
        },
    });
    runtime.bridgeId = "original";
    const task = runtime.rpc(DELETE, ["old-app"], { bestEffort: true, timeoutMs: 10000 });
    await flush();
    t.mock.timers.tick(10000);
    await assert.rejects(task, { status: 504 });
    runtime.bridgeId = "next";
    settle({ bridgeId: "old", status: 401, text: "[]" });
    await flush();
    assert.equal(runtime.bridgeId, "next");
});
test("explicit migration archives history and removes only cleanup projections; restart never reads journals", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "best-effort-"));
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const history = path.join(root, "history");
    const cfg = {
        ...loadConfig({ BUILD_MAX_CONCURRENCY: "5" }),
        dailyResetEnabled: false,
        statePath: path.join(root, "scheduler-state.json"),
    };
    const auth = { accountNameMap: new Map(), getRotationIndices: () => [0, 1] };
    const logger = { error() {}, warn() {} };
    const first = new ModelScheduler(cfg, auth, logger);
    const account = first.account(0);
    Object.assign(account, {
        buildCleanupDegraded: true,
        buildRecoveryBlocked: true,
        buildRecoveryHoldUntil: Date.now() + 500000,
        buildRecoveryReason: "debt",
        cleanupDebtCount: 9,
    });
    const slot = first.slot(account, "build/gemini-3.8-flash");
    slot.daily_request_count = 7;
    first.account(1).disabled = true;
    first.flush();
    first.close();
    const old = JSON.parse(fs.readFileSync(cfg.statePath));
    const journal = JSON.stringify(
        Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i, { app: `app-${i}`, retryState: "pending" }]))
    );
    fs.writeFileSync(path.join(root, "build-projects.json"), journal);
    const report = migrate(root, history);
    assert.equal(report.changes.length, 1);
    assert.equal(report.unknownDisabled.length, 1);
    assert.equal(fs.readFileSync(path.join(history, "build-projects.json"), "utf8"), journal);
    assert.equal(fs.statSync(history).mode & 0o777, 0o700);
    const current = JSON.parse(fs.readFileSync(cfg.statePath));
    for (const field of report.changes[0].removed) delete old.accounts[0][field];
    assert.deepEqual(current, old);
    // Unreadable/corrupt historical journals cannot cause startup or admission failure.
    fs.writeFileSync(path.join(root, "build-projects.json"), "invalid historical journal");
    const second = new ModelScheduler(cfg, auth, logger);
    t.after(() => second.close());
    assert.equal(second.account(0).buildRecoveryBlocked, undefined);
    assert.equal(second.account(1).disabled, true);
    assert.equal(second.slot(second.account(0), "build/gemini-3.8-flash").daily_request_count, 7);
    assert.equal(second.canLease(second.account(0), "build/gemini-3.8-flash"), true);
    second.snapshot();
    second.publicSummarySnapshot();
    assert.equal(fs.readFileSync(path.join(root, "build-projects.json"), "utf8"), "invalid historical journal");
    assert.equal(fs.existsSync(path.join(root, "build-projects.json.events.json")), false);
});

test("process exit does not wait for best-effort cleanup timers", () => {
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(
        process.execPath,
        [
            "-e",
            `const {BuildRuntime}=require('./src/core/codeAssistant/BuildRuntime'); const r=new BuildRuntime({page:{},accountKey:'account'}); r.rpc=()=>new Promise(()=>{}); void r.cleanup('op',{account:'account',app:'app',task:'task'});`,
        ],
        { cwd: path.resolve(__dirname, ".."), timeout: 1500 }
    );
    assert.equal(result.status, 0, result.error?.message);
});
