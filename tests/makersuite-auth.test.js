const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { tagStatus, authState } = require("../src/utils/MakerSuiteAuth");
const { normalizeError } = require("../src/utils/UpstreamError");
const { ModelScheduler, classifyError } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const AuthSwitcher = require("../src/auth/AuthSwitcher");
const RequestHandler = require("../src/core/RequestHandler");
const { ScheduledRequestHandler } = require("../src/core/ScheduledRequestHandler");
const BrowserManager = require("../src/core/BrowserManager");
const FormatConverter = require("../src/core/FormatConverter");
const { buildBody } = require("../src/core/MakerSuiteCodec");
const logger = { debug() {}, error() {}, info() {}, warn() {} };

async function buildError(state) {
    const status = state === "key_unavailable" ? 503 : 401;
    const rpc = JSON.parse(
        tagStatus(JSON.stringify([status === 401 ? 16 : 14, "UNAUTHENTICATED", [{ reason: "test" }]]), state)
    );
    // Representative RPC -> REST mapping. Studio owns this adapter; test the
    // actual deployed Build code below, including its WebSocket serialization.
    const body = JSON.stringify({
        error: {
            code: status,
            message: `Google API returned error: ${status} UNAUTHENTICATED ${rpc[1]}`,
            status: "UNAUTHENTICATED",
        },
    });
    const source = fs.readFileSync(require.resolve("../scripts/client/build.js"), "utf8");
    const realm = vm.createContext({
        AbortController,
        clearTimeout,
        EventTarget,
        fetch: async () => ({ ok: false, status, text: async () => body }),
        performance,
        setTimeout,
    });
    vm.runInContext(
        source.replace(/initializeProxySystem\(\);\s*$/, "") +
            "\nLogger.enabled = false; globalThis.processor = new RequestProcessor(); globalThis.ProxySystemClass = ProxySystem;",
        realm
    );
    realm.processor._constructUrl = () => "https://fixture.invalid";
    realm.processor._buildRequestConfig = () => ({});
    const execution = realm.processor.execute({ request_attempt_id: "attempt" }, "request");
    let captured;
    await assert.rejects(execution.responsePromise, error => {
        realm.ProxySystemClass.prototype._sendErrorResponse.call(
            {
                connectionManager: {
                    transmit: value => {
                        captured = JSON.parse(JSON.stringify(value));
                    },
                },
            },
            error,
            "request",
            "attempt"
        );
        return true;
    });
    return captured;
}
function scheduler(t) {
    const session = { authIndex: 0, sessionVersion: 7 };
    const expired = [];
    const auth = {
        accountLoginService: { state: { accounts: [session] } },
        accountNameMap: new Map(),
        getRotationIndices: () => [0],
        markAsExpired: async (...args) => expired.push(args),
    };
    const instance = new ModelScheduler({ ...loadConfig({}), statePath: null }, auth, logger);
    t.after(() => instance.close());
    return { expired, instance, session };
}

test("Build errors keep auth classification and HTTP status through JSON/WebSocket normalization", async t => {
    for (const state of ["key_unavailable", "unverified", "session_expired"]) {
        const message = await buildError(state);
        assert.equal(message.status, state === "key_unavailable" ? 503 : 401);
        assert.equal(authState(message), state);
        assert.equal(authState(normalizeError(message)), state);
        const { instance, expired } = scheduler(t);
        const lease = await instance.acquire("flash");
        instance.startAttempt(lease);
        await instance.failure(lease, message);
        assert.equal(lease.account.healthy, state !== "session_expired");
        assert.deepEqual(expired, state === "session_expired" ? [[0, 7]] : []);
        assert.equal(classifyError(message), state === "session_expired" ? "account" : "bridge_auth");
        instance.release(lease);
    }
});

test("uncertain bridge auth failures do not switch accounts or replay in scheduled and legacy modes", async () => {
    const message = await buildError("unverified");
    const config = { failureThreshold: 1, immediateSwitchStatusCodes: [401, 503] };
    assert.equal(RequestHandler.prototype._shouldRetryError.call({ config }, message), false);
    assert.equal(ScheduledRequestHandler.prototype._shouldRetryError.call({}, message), false);
    const switcher = new AuthSwitcher(logger, config, {}, {});
    switcher.switchToNextAuth = () => assert.fail("bridge auth must not rotate accounts");
    await switcher.handleRequestFailureAndSwitch(message);
    assert.equal(switcher.failureCount, 0);
});

test("confirmed expired auth retains the session-version guard", async t => {
    const { instance, expired, session } = scheduler(t);
    const lease = await instance.acquire("flash");
    instance.startAttempt(lease);
    session.sessionVersion++;
    await instance.failure(lease, await buildError("session_expired"));
    assert.equal(lease.account.healthy, true);
    assert.equal(lease.slot.failure_count, 0);
    assert.deepEqual(expired, []);
    instance.release(lease);
});

test("bounded page diagnosis uses login-page evidence without changing credentials", async () => {
    const diagnose = BrowserManager.prototype._diagnoseMakerSuiteSession;
    assert.equal(
        await diagnose({ title: async () => "Google AI Studio", url: () => "https://aistudio.google.com/apps/one" }),
        "unverified"
    );
    assert.equal(
        await diagnose({ title: async () => "Sign in", url: () => "https://accounts.google.com/ServiceLogin" }),
        "expired"
    );
    assert.equal(
        await diagnose({ title: async () => "Google AI Studio", url: () => "https://not-accounts.google.com/apps" }),
        "unverified"
    );
});

test("Chat tool round-trip keeps multiple names, ids, signatures and stream/non-stream output", async () => {
    const converter = new FormatConverter(logger, {}, () => ({ safetySettingsThreshold: "OFF" }));
    const response = {
        candidates: [
            {
                content: {
                    parts: [
                        { functionCall: { args: { x: 0 }, id: "a-id", name: "a" } },
                        { functionCall: { args: { y: false }, id: "b-id", name: "b" } },
                    ],
                    role: "model",
                },
                finishReason: "STOP",
                index: 0,
            },
        ],
    };
    const converted = converter.convertGoogleToOpenAINonStream(response, "gemini-3-flash-preview");
    assert.equal(converted.choices[0].finish_reason, "tool_calls");
    assert.equal(converted.choices[0].message.tool_calls.length, 2);
    assert.equal(JSON.stringify(converted).includes("undefined"), false);
    const streamed = converter.translateGoogleToOpenAIStream(JSON.stringify(response), "gemini-3-flash-preview", {});
    assert.match(streamed, /"finish_reason":"tool_calls"/);
    assert.match(streamed, /a-id/);
    assert.match(streamed, /b-id/);
    const input = {
        messages: [
            { content: "call", role: "user" },
            converted.choices[0].message,
            { content: '{"ok":true}', role: "tool", tool_call_id: "a-id" },
            { content: "done", role: "tool", tool_call_id: "b-id" },
        ],
        model: "gemini-3-flash-preview",
        tools: [
            { function: { name: "a", parameters: { type: "object" } }, type: "function" },
            { function: { name: "b", parameters: { type: "object" } }, type: "function" },
        ],
    };
    const { googleRequest } = await converter.translateOpenAIToGoogle(input);
    const { body } = buildBody("gemini-3-flash-preview", googleRequest);
    const calls = body[1].flatMap(c => c[0]).filter(p => p[10]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(p => p[14] === "skip_thought_signature_validator"));
    const results = body[1].flatMap(c => c[0]).filter(p => p[11]);
    assert.deepEqual(
        results.map(p => p[11][0]),
        ["a", "b"]
    );
});

test("Anthropic, Responses and native function histories share MakerSuite replay normalization", async () => {
    const converter = new FormatConverter(logger, {}, () => ({ safetySettingsThreshold: "OFF" }));
    const claude = await converter.translateClaudeToGoogle({
        max_tokens: 10,
        messages: [
            { content: "call", role: "user" },
            { content: [{ id: "a-id", input: {}, name: "a", type: "tool_use" }], role: "assistant" },
            { content: [{ content: "done", tool_use_id: "a-id", type: "tool_result" }], role: "user" },
        ],
        model: "gemini-3-flash-preview",
    });
    const responses = await converter.translateOpenAIResponseToGoogle({
        input: [
            { content: "call", role: "user" },
            { arguments: "{}", call_id: "a-id", name: "a", type: "function_call" },
            { call_id: "a-id", output: "done", type: "function_call_output" },
        ],
        model: "gemini-3-flash-preview",
    });
    const native = { contents: [{ parts: [{ functionCall: { args: {}, name: "a" } }], role: "model" }] };
    converter.ensureThoughtSignature(native);
    for (const request of [claude.googleRequest, responses.googleRequest, native]) {
        const { body } = buildBody("gemini-3-flash-preview", request);
        const calls = body[1].flatMap(c => c[0]).filter(p => p[10]);
        assert.equal(calls.length, 1);
        assert.equal(calls[0][14], "skip_thought_signature_validator");
    }
});

test("native snake-case real signatures survive ensureThoughtSignature and primitive tool results encode", async () => {
    const converter = new FormatConverter(logger, {}, () => ({ safetySettingsThreshold: "OFF" }));
    const native = {
        contents: [{ parts: [{ functionCall: { args: {}, name: "f" }, thought_signature: "real" }], role: "model" }],
    };
    converter.ensureThoughtSignature(native);
    assert.equal(buildBody("m", native).body[1][0][0][0][14], "real");
    for (const content of ["0", "false", "null"]) {
        const converted = await converter.translateOpenAIToGoogle({
            messages: [{ content, name: "f", role: "function" }],
            model: "m",
        });
        const part = buildBody("m", converted.googleRequest).body[1][0][0][0];
        assert.equal(part[11][0], "f");
        assert.equal(part[14], undefined);
    }
});
