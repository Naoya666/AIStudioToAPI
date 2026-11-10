const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { firefox } = require("playwright");
const { ConfigurationService } = require("../src/config/ConfigurationService");
const { LocalTransport } = require("../src/core/backends/LocalTransport");
const { LocalSessionManager, proxyURL } = require("../src/core/backends/LocalSessionManager");
const { unavailable } = require("../src/core/backends/LocalEngine");
const { classifyError } = require("../src/core/ModelScheduler");
const { BuildRuntime } = require("../src/core/codeAssistant/BuildRuntime");
const { encode } = require("../src/core/codeAssistant/BuildCodec");
const { buildBody } = require("../src/core/MakerSuiteCodec");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const logger = { debug() {}, error() {}, info() {}, setDisplayLimit() {}, warn() {} };
const catalog = { Tier: Buffer.from("[1]").toString("base64") };
function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-backend-test-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    return dir;
}
function pgWire(text) {
    return JSON.stringify([[[[[[[null, text]], "model"], 1]], null, [10, 2, 12]]]);
}
function transport(stream) {
    return new LocalTransport({
        authIndex: 0,
        catalog,
        engine: { stream },
        logger,
        session: "fixture-session",
        timeoutMs: 1000,
    });
}
test("backend defaults and saved restart boundary survive both directions and version conflicts", t => {
    const dir = temp(t),
        file = path.join(dir, "config.json");
    const usage = path.join(dir, "usage.json");
    fs.writeFileSync(usage, '{"kept":true}');
    let config = new ConfigurationService({ logger }, { env: {}, file });
    assert.equal(config.running.callBackend, "browser");
    const version = config.document.version;
    config.save({ changes: { CALL_BACKEND: "local" }, version });
    assert.equal(config.running.callBackend, "browser");
    assert.equal(config.snapshot().saved.CALL_BACKEND, "local");
    assert.ok(config.snapshot().pending.some(x => x.name === "CALL_BACKEND"));
    assert.throws(() => config.save({ changes: { CALL_BACKEND: "browser" }, version }), { status: 409 });
    assert.throws(() => config.save({ changes: { CALL_BACKEND: "remote" }, version: config.document.version }), {
        status: 400,
    });
    config = new ConfigurationService({ logger }, { env: {}, file });
    assert.equal(config.running.callBackend, "local");
    config.save({ changes: { CALL_BACKEND: "browser" }, version: config.document.version });
    assert.equal(config.running.callBackend, "local");
    config = new ConfigurationService({ logger }, { env: {}, file });
    assert.equal(config.running.callBackend, "browser");
    assert.equal(fs.readFileSync(usage, "utf8"), '{"kept":true}');
});
test("local PG shares full codec and stream semantics, and supplies binding from the final wire", async () => {
    const input = {
        contents: [{ parts: [{ text: "你好" }], role: "user" }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
    };
    const calls = [];
    const local = transport(async function* (_session, args) {
        calls.push(args);
        yield { text: pgWire("你好") };
        yield { result: { status: 200, text: "" } };
    });
    const request = {
        body: JSON.stringify(input),
        method: "POST",
        path: "/v1beta/models/gemini-3.8-flash:generateContent",
        request_attempt_id: "a",
    };
    const result = await local.generate(request);
    assert.equal(result.candidates[0].content.parts[0].text, "你好");
    const expected = buildBody("gemini-3.8-flash", input);
    assert.deepEqual(calls[0].body, expected.body);
    assert.equal(calls[0].ht, expected.ht);
    assert.equal(calls[0].rpcMethod, "GenerateContent");
    const chunks = [];
    await local.generate({ ...request, path: request.path.replace(":generateContent", ":streamGenerateContent") }, c =>
        chunks.push(c)
    );
    assert.equal(chunks[0].candidates[0].content.parts[0].text, "你好");
    assert.equal(local.operations.size, 0);
    assert.equal(local.active.size, 0);
    assert.equal("page" in local, false);
});
test("403 remains risk cooldown, diagnosed 401 expires auth, local signer faults stay transport failures", async () => {
    const statuses = [403, 401];
    for (const status of statuses) {
        const calls = [];
        const local = transport(async function* (_id, args) {
            calls.push(args.rpcMethod);
            yield { result: { status, text: status === 403 ? '[7,"temporary risk"]' : '[16,"expired"]' } };
        });
        await assert.rejects(
            local.generate({
                body: '{"contents":[{"parts":[{"text":"test"}]}]}',
                method: "POST",
                path: "/v1beta/models/gemini-3.8-flash:generateContent",
            }),
            e => {
                assert.equal(e.status, status);
                assert.equal(classifyError(e), status === 403 ? "risk_controlled" : "account");
                if (status === 401) assert.match(e.message, /session_expired/);
                return true;
            }
        );
        assert.equal(calls.filter(x => x === "GenerateContent").length, 1);
        if (status === 403) assert.equal(calls.length, 1);
    }
    const error = unavailable(503, "proof_runtime_unavailable");
    assert.equal(classifyError(error), "transport");
    assert.equal(error.retryable, false);
    assert.equal(error.cooldown, false);
});
test("account and proxy sessions remain separate and never launch Firefox", async t => {
    t.mock.method(firefox, "launch", () => {
        throw Error("Browser launch forbidden in local generation");
    });
    const seen = [];
    const engine = new EventEmitter();
    engine.ready = true;
    engine.ensure = async () => {};
    engine.json = async (method, endpoint, body) => {
        if (endpoint === "/sessions") {
            seen.push(body);
            return { catalog, id: "session-" + seen.length };
        }
        if (endpoint.endsWith("/state")) return { cookies: [], origins: [] };
        return {};
    };
    const source = {
        getAuth: index => ({
            _accountSessionVersion: 1,
            cookies: [{ name: "fixture", value: "account-" + index }],
            origins: [],
        }),
        getRotationIndices: () => [0, 1],
    };
    const manager = new LocalSessionManager(
        logger,
        { enableAuthUpdate: false, makerSuiteTimeoutMs: 1000 },
        source,
        engine
    );
    manager.setConnectionRegistry(new ConnectionRegistry(logger, null, () => -1, manager));
    manager.setProxyResolver(index => ({
        proxy: { password: String(index), server: `http://127.0.0.1:${9000 + index}`, username: "fixture" },
        source: "test",
    }));
    t.after(async () => {
        await Promise.all([0, 1].map(i => manager.closeContext(i)));
        manager.connectionRegistry.closeAllConnections?.();
    });
    await Promise.all([0, 1].map(index => manager._getOrStartContextInit(index)));
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0].proxy, seen[1].proxy);
    assert.notEqual(seen[0].state.cookies[0].value, seen[1].state.cookies[0].value);
    for (const index of [0, 1]) {
        assert.equal(manager.isContextReady(index), true);
        assert.equal(manager.contexts.get(index).page, undefined);
        assert.equal(manager.contexts.get(index).context, undefined);
    }
    assert.equal(firefox.launch.mock.callCount(), 0);
    assert.equal(
        proxyURL({ password: "p:q", server: "socks5://127.0.0.1:1080", username: "a@b" }),
        "socks5://a%40b:p%3Aq@127.0.0.1:1080"
    );
});
test("Build read interruption resumes the known task, preserves proof fields, and never resubmits", async () => {
    const calls = [],
        callbacks = [];
    let reads = 0;
    const rpcTransport = {
        cancel: async () => {},
        run: async args => {
            calls.push(args);
            let text = "[]";
            if (args.rpcMethod === "CreateApplet") text = '["00000000-0000-4000-8000-000000000001"]';
            if (args.rpcMethod === "CodeAssistantOffline") text = '["task"]';
            if (args.rpcMethod === "StreamCodeAssistantOfflineGeneration") {
                if (!reads++) throw unavailable(502, "read_interrupted");
                const turn = Array(17).fill(null);
                turn[0] = [[[[null, "done"]], "model"]];
                turn[11] = 1;
                turn[12] = 1;
                turn[13] = "models/gemini-3.8-flash";
                turn[16] = "task";
                text = JSON.stringify([[[null, null, [turn], "app"]]]);
            }
            return { bridgeId: "local-fixture", source: "google_http", status: 200, text };
        },
        session: "local-fixture",
    };
    const runtime = new BuildRuntime({ accountKey: "account", rpcTransport, timeoutMs: 3000 });
    const identity = { thinking: 0, upstream: "gemini-3.8-flash" },
        context = { files: [{ name: "file.txt", text: "attachment" }], prompt: "prompt" };
    const result = await runtime.generate(identity, context, { onCleanup: f => callbacks.push(f) });
    assert.equal(result.text, "done");
    assert.equal(calls.filter(x => x.rpcMethod === "CodeAssistantOffline").length, 1);
    assert.equal(calls.filter(x => x.rpcMethod === "CreateApplet").length, 1);
    assert.equal(calls.filter(x => x.rpcMethod === "StreamCodeAssistantOfflineGeneration").length, 2);
    const submit = calls.find(x => x.rpcMethod === "CodeAssistantOffline");
    assert.equal(submit.proofText, context.prompt);
    assert.equal(submit.ht, encode(identity, context, "app").ht);
    assert.equal(submit.body[1], null);
    assert.equal(runtime.active.size, 0);
    assert.equal(callbacks.length, 1);
});
test("vendored host scripts retain reference syntax and ordering", () => {
    for (const name of ["dom", "smhost"]) {
        const source = fs.readFileSync(path.join(__dirname, `../local-engine/internal/waa/${name}.js`), "utf8");
        assert.doesNotThrow(() => new Function(source));
        const expected = {
            dom: "c0640903525052cf8c5e70aa5cd3d60184c5a496cff95b4d5899d39d774e6859",
            smhost: "271e8a2a1a2dcd3e572ee2e8a1573dca1ac491bf55b0bcdbef0c7f365ea37d45",
        };
        assert.equal(createHash("sha256").update(source).digest("hex"), expected[name]);
    }
});

test("local initialization watchdog aborts the service operation and releases pool ownership", async () => {
    const engine = new EventEmitter();
    engine.ready = true;
    engine.ensure = async () => {};
    let aborted = false;
    engine.json = (_method, _path, _body, { signal }) =>
        new Promise((_, reject) => {
            signal.addEventListener(
                "abort",
                () => {
                    aborted = true;
                    reject(unavailable(499, "cancelled"));
                },
                { once: true }
            );
        });
    const source = { getAuth: () => ({ cookies: [], origins: [] }), getRotationIndices: () => [0] };
    const manager = new LocalSessionManager(
        logger,
        { enableAuthUpdate: false, scheduler: { contextInitTotalTimeoutMs: 30 } },
        source,
        engine
    );
    manager.setProxyResolver(() => ({ proxy: null }));
    await assert.rejects(manager._getOrStartContextInit(0));
    assert.equal(aborted, true);
    assert.equal(manager.initializingContexts.size, 0);
    assert.equal(manager._contextInitTasks.size, 0);
    assert.equal(manager.contexts.size, 0);
});

test("local no-retry faults do not change the browser backend's existing retry policy", () => {
    const RequestHandler = require("../src/core/RequestHandler");
    const choose = backend =>
        RequestHandler.prototype._shouldRetryError.call(
            { config: { callBackend: backend, immediateSwitchStatusCodes: [503] } },
            { backend, retryable: false, status: 503 }
        );
    assert.equal(choose("browser"), true);
    assert.equal(choose("local"), false);
});

test("local Playground preserves explicit verification 403 for shared scheduler classification", async () => {
    const calls = [];
    const message =
        "Your account must be verified before it can continue using the Gemini API. Verify your account at https://aistudio.google.com/verify-account.";
    const local = transport(async function* (_id, args) {
        calls.push(args.rpcMethod);
        yield { result: { status: 403, text: JSON.stringify([7, message, []]) } };
    });
    await assert.rejects(
        local.generate({
            body: '{"contents":[{"parts":[{"text":"test"}]}]}',
            method: "POST",
            path: "/v1beta/models/gemini-3.8-flash:generateContent",
        }),
        error => {
            assert.equal(error.status, 403);
            assert.equal(classifyError(error), "verification_required");
            return true;
        }
    );
    assert.deepEqual(calls, ["GenerateContent"]);
});
