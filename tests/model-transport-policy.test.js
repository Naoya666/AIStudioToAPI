const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parsePolicy, resolve } = require("../src/core/ModelTransportPolicy");
const ConfigLoader = require("../src/utils/ConfigLoader");
const RequestHandler = require("../src/core/RequestHandler");
const MessageQueue = require("../src/utils/MessageQueue");
const logger = { debug() {}, error() {}, info() {}, warn() {} };

test("exact routing follows existing prefix/suffix parsing, with immutable per-request capabilities", () => {
    for (const name of ["gemini-4-argon", "models/gemini-4-argon-real", "anti-gemini-4-argon(high)-real"]) {
        const policy = resolve(name, "real");
        assert.equal(policy.model, "gemini-4-argon");
        assert.equal(policy.transport, "makersuite");
        assert.equal(policy.effectiveMode, "fake");
        assert.equal(policy.timeoutCategory, "buffered");
        assert.equal(Object.isFrozen(policy), true);
    }
    for (const name of ["gemini-3.7-flash", "gemini-4-other", "gemini-4-argon-preview", "constructor"]) {
        assert.equal(resolve(name, "real").transport, "legacy");
        assert.equal(resolve(name, "real").effectiveMode, "real");
    }
    assert.equal(resolve("gemini-4-argon", "early").effectiveMode, "early");
    assert.equal(resolve("gemini-4-argon", "real", { "gemini-4-argon": "legacy" }).effectiveMode, "real");
    assert.equal(resolve("gemini-3.7-flash", "real", { "gemini-3.7-flash": "makersuite" }).effectiveMode, "fake");
});

test("configuration rejects wildcard, prototype, alias and invalid transport mappings", () => {
    for (const value of [
        "bad",
        "[]",
        "null",
        '{"__proto__":"legacy"}',
        { constructor: "legacy" },
        { "gemini-*": "legacy" },
        { "models/gemini-4-argon": "legacy" },
        { "anti-gemini-4-argon": "legacy" },
        { "gemini-4-argon-real": "legacy" },
        { "gemini-4-argon": "auto" },
    ]) {
        assert.throws(() => parsePolicy(value), /MODEL_TRANSPORT_POLICY/);
        assert.throws(
            () =>
                new ConfigLoader(logger).loadConfiguration({
                    MODEL_TRANSPORT_POLICY: typeof value === "string" ? value : JSON.stringify(value),
                }),
            /MODEL_TRANSPORT_POLICY/
        );
    }
    const mapping = new ConfigLoader(logger).loadConfiguration({
        MODEL_TRANSPORT_POLICY: '{"gemini-4-argon":"legacy"}',
    }).modelTransportPolicy;
    assert.equal(resolve("gemini-4-argon", "real", mapping).transport, "legacy");
    const input = { "gemini-4-argon": "legacy" };
    const policy = resolve("gemini-4-argon", "real", input);
    input["gemini-4-argon"] = "makersuite";
    assert.equal(policy.transport, "legacy");
    assert.equal(resolve("gemini-4-argon", "real", input).transport, "makersuite");
});

test("fixed buffered budget overrides incremental idle waits at 59/61/90 seconds and never renews", async t => {
    let elapsed = 0;
    t.mock.method(performance, "now", () => elapsed);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const queue = new MessageQueue();
    queue.generationDeadline = 100000;
    for (const time of [59000, 61000, 90000]) {
        const pending = queue.dequeue(60000);
        t.mock.timers.tick(time - elapsed);
        elapsed = time;
        queue.enqueue({ time });
        assert.equal((await pending).time, time);
    }
    const pending = assert.rejects(queue.dequeue(60000), { code: "QUEUE_TIMEOUT", status: 504 });
    elapsed = 100000;
    t.mock.timers.tick(10000);
    await pending;
    queue.enqueue({ late: true });
    await assert.rejects(queue.dequeue(), { code: "QUEUE_TIMEOUT" });
    queue.close();
});

test("buffered and bridge configuration accept long budgets and reject timer overflow", () => {
    const { MAX_GENERATION_TIMEOUT_MS } = require("../src/config/TransportConfig");
    for (const key of ["FAKE_STREAM_TIMEOUT_MS", "MAKERSUITE_TIMEOUT_MS"]) {
        for (const value of [300001, 600000, 3600000, MAX_GENERATION_TIMEOUT_MS]) {
            const config = new ConfigLoader(logger).loadConfiguration({ [key]: String(value) });
            assert.equal(
                config[key === "FAKE_STREAM_TIMEOUT_MS" ? "fakeStreamTimeoutMs" : "makerSuiteTimeoutMs"],
                value
            );
        }
        for (const value of [0, -1, 1.5, MAX_GENERATION_TIMEOUT_MS + 1, Infinity, "", "bad"])
            assert.throws(() => new ConfigLoader(logger).loadConfiguration({ [key]: String(value) }), /Invalid/);
    }
});

test("attempt initialization keeps the chosen transport when configuration changes", () => {
    const handler = Object.create(RequestHandler.prototype);
    handler.config = { modelTransportPolicy: { "gemini-4-argon": "makersuite" } };
    const request = {
        is_generative: true,
        path: "/v1beta/models/gemini-4-argon:generateContent",
        request_id: "test",
        streaming_mode: "real",
    };
    handler._initializeProxyRequestAttempt(request);
    const snapshot = request.transport_policy;
    handler.config = { modelTransportPolicy: { "gemini-4-argon": "legacy" } };
    handler._advanceProxyRequestAttempt(request);
    assert.equal(request.transport_policy, snapshot);
    assert.equal(request.transport_policy.transport, "makersuite");
    assert.equal(request.streaming_mode, "fake");
});

test("non-generation requests never register a bridge call or receive its internal marker", () => {
    const sent = [];
    const handler = Object.create(RequestHandler.prototype);
    handler.config = {};
    handler.logger = logger;
    handler.browserManager = { contexts: new Map() };
    handler.authSource = { accountLoginService: { state: { accounts: [{ authIndex: 0, manualTier: "pro" }] } } };
    handler.connectionRegistry = { getConnectionByAuth: () => ({ send: value => sent.push(JSON.parse(value)) }) };
    const request = {
        is_generative: false,
        path: "/v1beta/models/gemini-4-argon:countTokens",
        query_params: { key: "client" },
        request_id: "count",
        transport_policy: resolve("gemini-4-argon"),
    };
    handler._forwardRequest(request, 0);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].query_params, { key: "client" });
    assert.equal(sent[0].remaining_budget_ms, undefined);
});

test("downstream OpenAI and Gemini model catalogues include the accepted Argon model", async t => {
    const ProxyServerSystem = require("../src/core/ProxyServerSystem");
    const system = Object.create(ProxyServerSystem.prototype);
    system.config = new ConfigLoader(logger).loadConfiguration({ API_KEYS: "catalogue-fixture-key" });
    system.logger = logger;
    system.webRoutes = { authRoutes: { getClientIP: () => "fixture" }, setupSession() {} };
    system.requestHandler = { withConfigurationSnapshot: next => next() };
    const app = system._createExpressApp();
    const server = await new Promise(resolve => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const openAI = await fetch(base + "/v1/models", { headers: { authorization: "Bearer catalogue-fixture-key" } });
    assert.equal(openAI.status, 200);
    assert.equal((await openAI.json()).data.filter(model => model.id === "gemini-4-argon").length, 1);
    const native = await fetch(base + "/v1beta/models", { headers: { authorization: "Bearer catalogue-fixture-key" } });
    assert.equal(native.status, 200);
    assert.equal((await native.json()).models.filter(model => model.name === "models/gemini-4-argon").length, 1);
});

test("bridge panel budget owns the fixed generation deadline and preserves settlement time across attempts", t => {
    const { MakerSuiteBridge } = require("../src/core/MakerSuiteBridge");
    let elapsed = 0;
    t.mock.method(performance, "now", () => elapsed);
    const bridge = Object.create(MakerSuiteBridge.prototype);
    Object.assign(bridge, { attempts: new Map(), epoch: 0 });
    const queue = new MessageQueue();
    t.after(() => queue.close());
    const sent = [];
    const handler = new RequestHandler(
        {},
        {
            getConnectionByAuth: () => ({ send: raw => sent.push(JSON.parse(raw)) }),
            messageQueues: new Map([["budget", { queue }]]),
        },
        logger,
        { contexts: new Map([[0, { page: { makerSuiteBridge: bridge } }]]) },
        { fakeStreamTimeoutMs: 300000, makerSuiteTimeoutMs: 600000 },
        {}
    );
    const request = {
        body: "{}",
        is_generative: true,
        path: "/v1beta/models/gemini-3.7-flash:generateContent",
        request_attempt_id: "first",
        request_id: "budget",
        transport_policy: resolve("gemini-3.7-flash", "fake", { "gemini-3.7-flash": "makersuite" }),
    };
    handler._forwardRequest(request, 0);
    assert.equal(request.__generationDeadline, 605000);
    assert.equal(queue.generationDeadline, 605000);
    assert.equal(bridge.attempts.get("first").bridgeDeadline, 600000);
    assert.equal(sent[0].remaining_budget_ms, 605000);
    elapsed = 300001;
    request.request_attempt_id = "second";
    handler._forwardRequest(request, 0);
    assert.equal(request.__generationDeadline, 605000);
    assert.equal(bridge.attempts.get("second").bridgeDeadline, 600000);
    assert.equal(sent[1].remaining_budget_ms, 304999);
    elapsed = 605000;
    assert.throws(() => handler._forwardRequest(request, 0), /deadline/);
});
