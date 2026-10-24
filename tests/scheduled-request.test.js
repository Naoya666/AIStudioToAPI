const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const RequestHandler = require("../src/core/RequestHandler");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const StatusRoutes = require("../src/routes/StatusRoutes");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
class Response extends EventEmitter {
    constructor() {
        super();
        this.statusCode = 200;
        this.body = "";
        this.headersSent = false;
        this.writableEnded = false;
        this.writableFinished = false;
        this.destroyed = false;
        this.socket = { destroyed: false, writable: true };
    }
    status(status) {
        this.statusCode = status;
        return this;
    }
    set() {
        return this;
    }
    get() {
        return "application/json";
    }
    getHeader() {
        return "application/json";
    }
    setHeader() {
        return this;
    }
    type() {
        return this;
    }
    write(value) {
        this.headersSent = true;
        this.body += value;
        return true;
    }
    end(value = "") {
        this.body += value;
        this.headersSent = true;
        this.writableEnded = true;
        this.writableFinished = true;
        this.emit("finish");
    }
    send(value) {
        this.end(value);
        return this;
    }
    json(value) {
        return this.send(JSON.stringify(value));
    }
}
function setup(reply, overrides = {}) {
    const config = {
        fakeStreamTimeoutMs: 100,
        immediateSwitchStatusCodes: [429, 503],
        makerSuiteTimeoutMs: 100,
        maxRetries: 3,
        retryDelay: 1,
        streamingMode: "real",
        streamTimeoutMs: 100,
        ...overrides,
    };
    const auth = {
        accountLoginService: {
            state: { accounts: (overrides.paidAccounts || []).map(authIndex => ({ authIndex, manualTier: "pro" })) },
        },
        accountNameMap: new Map(),
        availableIndices: [0, 1, 2, 3],
        getRotationIndices() {
            return this.availableIndices;
        },
    };
    const scheduler = new ModelScheduler(
        { ...loadConfig({ MAX_BROWSER_WORKERS: "4" }), statePath: null, ...overrides.scheduler },
        auth,
        logger
    );
    const registry = new ConnectionRegistry(logger);
    const sent = [];
    const browser = { authSource: auth, currentAuthIndex: 99, async ensureWorkerContext() {}, notifyUserActivity() {} };
    for (const index of auth.availableIndices)
        registry.connectionsByAuth.set(index, {
            readyState: 1,
            send(raw) {
                const request = JSON.parse(raw);
                if (request.event_type !== "proxy_request") return;
                sent.push({ index, request });
                const messages = reply(index, request);
                setImmediate(() => {
                    for (const message of messages)
                        registry._handleIncomingMessage(
                            JSON.stringify({
                                ...message,
                                request_attempt_id: request.request_attempt_id,
                                request_id: request.request_id,
                            }),
                            index
                        );
                });
            },
        });
    const system = { config, scheduler, webRoutes: { authRoutes: { getClientIP: () => "test" } } };
    const handler = new RequestHandler(system, registry, logger, browser, config, auth);
    return { browser, handler, registry, scheduler, sent };
}
const success = [
    { event_type: "response_headers", headers: { "content-type": "application/json" }, status: 200 },
    {
        data: JSON.stringify({
            candidates: [{ content: { parts: [{ text: "hello" }], role: "model" }, finishReason: "STOP" }],
            usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 1, totalTokenCount: 2 },
        }),
        event_type: "chunk",
    },
    { event_type: "stream_close" },
];
function request(model = "flash", stream = false, path = "/v1/chat/completions") {
    const body = { max_tokens: 20, messages: [{ content: "hi", role: "user" }], model, stream };
    return {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
        path,
        query: {},
        rawBody: Buffer.from(JSON.stringify(body)),
    };
}

function setupSchedulerResetRoute(scheduler) {
    const routes = new Map();
    const app = {};
    for (const method of ["delete", "get", "post", "put", "use"])
        app[method] = (route, ...handlers) => {
            if (method === "post") routes.set(route, handlers);
        };
    const serverSystem = { config: {}, distIndexPath: "", logger, scheduler };
    const isAuthenticated = (req, res, next) =>
        req.authenticated ? next() : res.status(401).json({ error: "Unauthorized" });
    new StatusRoutes(serverSystem).setupRoutes(app, isAuthenticated);
    return async authenticated => {
        const handlers = routes.get("/api/scheduler/reset-all");
        const response = {
            body: null,
            json(body) {
                this.body = body;
                return this;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            statusCode: 200,
        };
        let index = 0;
        const next = () => handlers[++index]({ authenticated }, response, next);
        await handlers[0]({ authenticated }, response, next);
        return response;
    };
}

test("reset-all scheduler route enforces authentication and reports legacy and change counts", async () => {
    const reset = setupSchedulerResetRoute({
        resetAllAccounts: () => ({ reset_account_count: 2, reset_model_count: 3 }),
    });
    let response = await reset(false);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { error: "Unauthorized" });
    response = await reset(true);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
        reset_account_count: 2,
        reset_model_count: 3,
        success: true,
    });

    response = await setupSchedulerResetRoute(null)(true);
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, { error: "Scheduler is in legacy mode" });

    response = await setupSchedulerResetRoute({
        resetAllAccounts: () => ({ reset_account_count: 0, reset_model_count: 0 }),
    })(true);
    assert.deepEqual(response.body, {
        reset_account_count: 0,
        reset_model_count: 0,
        success: true,
    });
});

test("disable scheduler route authenticates, validates IDs, and is idempotent", async () => {
    const routes = new Map();
    const app = {};
    for (const method of ["delete", "get", "post", "put", "use"])
        app[method] = (route, ...handlers) => {
            if (method === "post") routes.set(route, handlers);
        };
    let disabled = false;
    const scheduler = {
        disable(index) {
            const changed = !disabled;
            disabled = true;
            return { account_id: index, changed, disabled: true };
        },
    };
    const serverSystem = {
        authSource: { availableIndices: [0] },
        config: {},
        distIndexPath: "",
        logger,
        scheduler,
    };
    const isAuthenticated = (req, res, next) =>
        req.authenticated ? next() : res.status(401).json({ error: "Unauthorized" });
    new StatusRoutes(serverSystem).setupRoutes(app, isAuthenticated);
    const invoke = async (authenticated, body) => {
        const handlers = routes.get("/api/scheduler/disable");
        const response = new Response();
        response.body = null;
        response.json = value => {
            response.body = value;
            return response;
        };
        let index = 0;
        const next = () => handlers[++index]({ authenticated, body }, response, next);
        await handlers[0]({ authenticated, body }, response, next);
        return response;
    };
    assert.equal((await invoke(false, { account_id: 0 })).statusCode, 401);
    assert.equal((await invoke(true, {})).statusCode, 400);
    assert.equal((await invoke(true, { account_id: 9 })).statusCode, 400);
    assert.deepEqual((await invoke(true, { account_id: 0 })).body, {
        account_id: 0,
        changed: true,
        disabled: true,
        success: true,
    });
    assert.equal((await invoke(true, { account_id: 0 })).body.changed, false);
});

for (const stream of [false, true]) {
    test(`OpenAI ${stream ? "real stream" : "buffered"} retries quota on another account and keeps global account unchanged`, async () => {
        const fixture = setup(index =>
            index === 0 ? [{ event_type: "error", message: "quota", status: 429 }] : success
        );
        const res = new Response();
        await fixture.handler.processOpenAIRequest(request("flash-high-real-search", stream), res);
        assert.equal(res.statusCode, 200, res.body);
        assert.match(res.body, /hello/);
        assert.deepEqual(
            fixture.sent.map(entry => entry.index),
            [0, 1]
        );
        assert.ok(fixture.sent.every(entry => entry.request.path.includes("/flash:")));
        assert.equal(fixture.scheduler.account(0).models.flash.rate_limited, true);
        assert.equal(fixture.scheduler.account(1).models.flash.success_count, 1);
        assert.equal(fixture.scheduler.snapshot().models.find(model => model.model === "flash").daily_requests, 2);
        assert.equal(fixture.browser.currentAuthIndex, 99);
        assert.equal(fixture.scheduler.snapshot().active_workers, 0);
        fixture.scheduler.close();
    });
}

test("retry budget is enforced for real streaming, with no repeated account", async () => {
    const fixture = setup(() => [{ event_type: "error", message: "quota", status: 429 }], {
        scheduler: { maxRetries: 1 },
    });
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("a", true), res);
    assert.deepEqual(
        fixture.sent.map(entry => entry.index),
        [0, 1]
    );
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /^: accepted/);
    assert.match(res.body, /"error"/);
    assert.equal(fixture.scheduler.snapshot().active_workers, 0);
    fixture.scheduler.close();
});

test("late streaming errors mark the actual model status without replaying output", async () => {
    const fixture = setup(() => [success[0], success[1], { event_type: "error", message: "late quota", status: 429 }]);
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("a", true), res);
    assert.equal(fixture.sent.length, 1);
    assert.match(res.body, /hello/);
    assert.equal(fixture.scheduler.account(0).models.a.rate_limited, true);
    assert.equal(fixture.scheduler.account(0).models.a.success_count, 0);
    fixture.scheduler.close();
});

test("pre-output connection loss migrates a stream after early headers", async () => {
    const fixture = setup(index => (index === 0 ? [success[0]] : success));
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("a", true), res);
    await new Promise(resolve => setImmediate(resolve));
    fixture.registry.closeMessageQueuesForEpoch(0, 1, "connection_lost");
    await running;
    assert.deepEqual(
        fixture.sent.map(entry => entry.index),
        [0, 1]
    );
    assert.match(res.body, /^: accepted/);
    assert.match(res.body, /hello/);
    assert.equal(fixture.scheduler.account(0).models.a.cooldown_until, 0);
    fixture.scheduler.close();
});

test("connection loss after model output sends an error without replaying", async () => {
    const fixture = setup(() => [success[0], success[1]]);
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("a", true), res);
    for (let i = 0; i < 5 && !res.body.includes("hello"); i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    fixture.registry.closeMessageQueuesForEpoch(0, 1, "connection_lost");
    await running;
    assert.equal(fixture.sent.length, 1);
    assert.match(res.body, /hello/);
    assert.match(res.body, /Stream interrupted/);
    assert.equal(fixture.scheduler.account(0).models.a.cooldown_until, 0);
    fixture.scheduler.close();
});

test("concurrent HTTP handlers never share request-local account state", async () => {
    const fixture = setup(() => success);
    const responses = Array.from({ length: 4 }, () => new Response());
    await Promise.all(responses.map((res, i) => fixture.handler.processOpenAIRequest(request(i % 2 ? "a" : "b"), res)));
    assert.equal(new Set(fixture.sent.map(entry => entry.index)).size, 4);
    assert.ok(responses.every(res => res.statusCode === 200 && res.body.includes("hello")));
    assert.equal(fixture.registry.messageQueues.size, 0);
    fixture.scheduler.close();
});

test("Claude and Gemini preserve streaming and non-streaming conversion", async () => {
    for (const stream of [false, true]) {
        for (const method of ["processClaudeRequest", "processRequest", "processOpenAIResponseRequest"]) {
            const fixture = setup(() => success);
            const req = request("a", stream);
            if (method === "processRequest") {
                req.path = `/v1beta/models/a:${stream ? "streamGenerateContent" : "generateContent"}`;
                req.body = { contents: [{ parts: [{ text: "hi" }], role: "user" }] };
                req.rawBody = Buffer.from(JSON.stringify(req.body));
            }
            if (method === "processOpenAIResponseRequest") req.body.input = "hi";
            const res = new Response();
            await fixture.handler[method](req, res);
            assert.equal(res.statusCode, 200, `${method}: ${res.body}`);
            assert.match(res.body, /hello/);
            assert.equal(fixture.scheduler.snapshot().active_workers, 0);
            fixture.scheduler.close();
        }
    }
});

test("client disconnect while queued is removed without upstream work", async () => {
    const fixture = setup(() => success, { scheduler: { globalConcurrency: 1 } });
    const blocker = await fixture.scheduler.acquire("a");
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("a"), res);
    await new Promise(resolve => setImmediate(resolve));
    res.destroyed = true;
    res.emit("close");
    await running;
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.scheduler.pending.length, 0);
    fixture.scheduler.release(blocker);
    fixture.scheduler.close();
});

test("early streaming headers keep the connection alive while dispatch waits and clean up on disconnect", async () => {
    const fixture = setup(() => success, {
        scheduler: { globalConcurrency: 1, streamKeepaliveIntervalMs: 5 },
    });
    const blocker = await fixture.scheduler.acquire("a");
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("a", true), res);
    await new Promise(resolve => setTimeout(resolve, 16));
    assert.match(res.body, /^: accepted\n\n/);
    assert.match(res.body, /: keep-alive/);
    res.destroyed = true;
    res.emit("close");
    await running;
    assert.equal(fixture.scheduler.pending.length, 0);
    fixture.scheduler.release(blocker);
    fixture.scheduler.close();
});

test("count-token endpoints use bounded model-aware retries", async () => {
    for (const method of ["processClaudeCountTokens", "processOpenAIResponseInputTokens"]) {
        const fixture = setup(index =>
            index === 0
                ? [{ event_type: "error", message: "quota", status: 429 }]
                : [success[0], { data: '{"totalTokens":7}', event_type: "chunk" }, success[2]]
        );
        const req = request("a");
        req.body.input = "hi";
        const res = new Response();
        await fixture.handler[method](req, res);
        assert.equal(res.statusCode, 200, res.body);
        assert.match(res.body, /7/);
        assert.deepEqual(
            fixture.sent.map(entry => entry.index),
            [0, 1]
        );
        fixture.scheduler.close();
    }
});

test("file references keep their issuing account even when another account is less used", async () => {
    const fixture = setup(() => success);
    fixture.scheduler.fileAffinities.set("file:abc", "auth-2");
    const req = request("a");
    req.path = "/v1beta/models/a:generateContent";
    req.body = {
        contents: [
            {
                parts: [
                    {
                        fileData: {
                            fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
                            mimeType: "text/plain",
                        },
                    },
                ],
            },
        ],
    };
    req.rawBody = Buffer.from(JSON.stringify(req.body));
    const res = new Response();
    await fixture.handler.processRequest(req, res);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
        fixture.sent.map(entry => entry.index),
        [2]
    );
    fixture.scheduler.close();
});

test("503 and model permissions retry but malformed client requests do not", async () => {
    for (const [status, message, expected] of [
        [503, "upstream", 2],
        [403, "PERMISSION_DENIED", 2],
        [400, "bad input", 1],
    ]) {
        const fixture = setup(index => (index === 0 ? [{ event_type: "error", message, status }] : success));
        const res = new Response();
        await fixture.handler.processOpenAIRequest(request("a", true), res);
        assert.equal(fixture.sent.length, expected);
        assert.equal(fixture.scheduler.account(0).healthy, true);
        if (status === 403) {
            assert.equal(fixture.scheduler.account(0).models.a.unsupported, false);
            assert.ok(fixture.scheduler.account(0).models.a.cooldown_until > Date.now());
        }
        fixture.scheduler.close();
    }
});

test("concurrent streams on one account keep request IDs and response queues isolated", async () => {
    const fixture = setup(
        (index, req) => [
            success[0],
            { ...success[1], data: success[1].data.replace("hello", req.request_id) },
            success[2],
        ],
        { scheduler: { globalConcurrency: 8, maxWorkers: 1 } }
    );
    const responses = Array.from({ length: 8 }, () => new Response());
    await Promise.all(responses.map(res => fixture.handler.processOpenAIRequest(request("a", true), res)));
    assert.equal(new Set(fixture.sent.map(entry => entry.index)).size, 1);
    assert.equal(new Set(fixture.sent.map(entry => entry.request.request_id)).size, 8);
    for (const { request: req } of fixture.sent) {
        assert.equal(responses.filter(res => res.body.includes(req.request_id)).length, 1);
    }
    assert.equal(fixture.registry.messageQueues.size, 0);
    assert.equal(fixture.scheduler.account(0).inflight, 0);
    assert.equal(fixture.scheduler.account(0).models.a.success_count, 8);
    fixture.scheduler.close();
});

test("hidden models reject every protocol before early stream headers or model discovery", async t => {
    const cases = [
        {
            body: { messages: [{ content: "hi", role: "user" }], model: "flash-high-real-search", stream: true },
            method: "processOpenAIRequest",
            path: "/v1/chat/completions",
        },
        {
            body: { input: "hi", model: "flash-high-real-code", stream: true },
            method: "processOpenAIResponseRequest",
            path: "/v1/responses",
        },
        {
            body: {
                max_tokens: 20,
                messages: [{ content: "hi", role: "user" }],
                model: "flash-high-real-search",
                stream: true,
            },
            method: "processClaudeRequest",
            path: "/v1/messages",
        },
        {
            body: { contents: [{ parts: [{ text: "hi" }], role: "user" }] },
            method: "processRequest",
            path: "/v1beta/models/flash-high-real-search:streamGenerateContent",
        },
        { body: { input: "hi", model: "flash" }, method: "processOpenAIEmbeddingsRequest", path: "/v1/embeddings" },
    ];
    for (const entry of cases)
        await t.test(entry.method, async () => {
            const fixture = setup(() => success, {
                scheduler: { allocation: { flash: { min: 0, preferred: 1 } }, streamEarlyHeaders: true },
            });
            fixture.scheduler.hideModel("flash");
            const res = new Response();
            const writes = [];
            const write = res.write.bind(res);
            res.write = value => {
                writes.push(value);
                return write(value);
            };
            const req = {
                ...request(),
                body: entry.body,
                path: entry.path,
                rawBody: Buffer.from(JSON.stringify(entry.body)),
            };
            await fixture.handler[entry.method](req, res);
            assert.equal(res.statusCode, 403, res.body);
            assert.deepEqual(writes, []);
            assert.deepEqual(fixture.sent, []);
            assert.equal(fixture.scheduler.pending.length, 0);
            assert.equal(
                [...fixture.scheduler.accounts.values()].some(account => Object.keys(account.models).length),
                false
            );
            fixture.scheduler.close();
        });
});

function completionChunks(res) {
    return res.body
        .split("\n")
        .filter(line => line.startsWith("data: {"))
        .map(line => JSON.parse(line.slice(6)));
}
function deliver(fixture, entry, messages) {
    for (const message of messages) {
        fixture.registry._handleIncomingMessage(
            JSON.stringify({
                ...message,
                request_attempt_id: entry.request.request_attempt_id,
                request_id: entry.request.request_id,
            }),
            entry.index
        );
    }
}
async function waitFor(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.ok(predicate(), "condition was not reached");
}
function useLegacy(fixture) {
    delete fixture.handler.serverSystem.scheduler;
    fixture.handler.authSwitcher.currentAuthIndex = 0;
}

test("early sends one empty start before readiness/upstream completion in legacy and model modes", async t => {
    for (const legacy of [false, true])
        await t.test(legacy ? "legacy" : "model", async () => {
            const fixture = setup(() => [success[0]], {
                scheduler: { streamEarlyHeaders: false, streamKeepaliveIntervalMs: 5 },
                streamingMode: "early",
            });
            if (legacy) useLegacy(fixture);
            let releaseReady;
            const ready = new Promise(resolve => {
                releaseReady = resolve;
            });
            if (legacy) fixture.handler._ensureBrowserBackedRequestReady = () => ready;
            const res = new Response();
            const req = request("flash-high-early-search", true);
            req.body.stream_options = { include_usage: true };
            const running = fixture.handler.processOpenAIRequest(req, res);
            await waitFor(() => res.__streamStartSent);
            const start = completionChunks(res)[0];
            assert.deepEqual(start.choices, [
                { delta: { content: "", role: "assistant" }, finish_reason: null, index: 0 },
            ]);
            assert.equal(start.model, "flash");
            assert.equal(start.usage, undefined);
            assert.equal(res.__modelOutputStarted, false);
            assert.equal(res.body.includes("[DONE]"), false);
            if (legacy) {
                assert.equal(fixture.sent.length, 0);
                releaseReady(true);
            }
            await waitFor(() => fixture.sent.length === 1);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(fixture.sent[0].request.streaming_mode, "fake");
            assert.equal(fixture.sent[0].request.path, "/v1beta/models/flash:generateContent");
            // Headers alone do not stop waiting heartbeats or count as model output.
            assert.equal(completionChunks(res).length, 2);
            assert.deepEqual(completionChunks(res)[1].choices, [
                { delta: { content: "" }, finish_reason: null, index: 0 },
            ]);
            deliver(fixture, fixture.sent[0], success.slice(1));
            await running;
            const chunks = completionChunks(res);
            assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.delta?.role === "assistant").length, 1);
            assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.delta?.content === "hello").length, 1);
            assert.ok(
                chunks.every(
                    chunk => chunk.id === start.id && chunk.created === start.created && chunk.model === start.model
                )
            );
            assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.finish_reason === "stop").length, 1);
            assert.equal(chunks.at(-1).usage.total_tokens, 2);
            assert.equal(res.body.split("data: [DONE]").length - 1, 1);
            const finalBody = res.body;
            await new Promise(resolve => setTimeout(resolve, 15));
            assert.equal(res.body, finalBody);
            assert.equal(fixture.registry.messageQueues.size, 0);
            assert.equal(fixture.scheduler.snapshot().active_workers, 0);
            fixture.scheduler.close();
        });
});

test("early start precedes account queue and uses one heartbeat timer that stops on disconnect", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = setup(() => success, {
        scheduler: { globalConcurrency: 1, streamEarlyHeaders: false, streamKeepaliveIntervalMs: 5 },
        streamingMode: "early",
    });
    t.after(() => fixture.scheduler.close());
    const blocker = await fixture.scheduler.acquire("flash");
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("flash", true), res);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.scheduler.pending.length, 1);
    assert.equal(completionChunks(res).length, 2);
    t.mock.timers.tick(1000);
    assert.equal(completionChunks(res).length, 3);
    assert.equal(fixture.sent.length, 0);
    assert.equal(res.__modelOutputStarted, false);
    assert.equal(fixture.scheduler.pending.length, 1);
    res.destroyed = true;
    res.emit("close");
    await running;
    assert.equal(fixture.scheduler.pending.length, 0);
    const body = res.body;
    t.mock.timers.tick(5000);
    assert.equal(res.body, body);
    fixture.scheduler.release(blocker);
});

test("early retries quota after start and preserves stream identity without duplicate starts", async t => {
    const fixture = setup(index => (index === 0 ? [{ event_type: "error", message: "quota", status: 429 }] : success), {
        scheduler: { streamEarlyHeaders: false },
        streamingMode: "early",
    });
    t.after(() => fixture.scheduler.close());
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("flash", true), res);
    assert.deepEqual(
        fixture.sent.map(entry => entry.index),
        [0, 1]
    );
    const chunks = completionChunks(res);
    assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.delta?.content === "").length, 2);
    assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.delta?.content === "hello").length, 1);
    assert.ok(chunks.every(chunk => chunk.id === chunks[0].id));
    assert.equal(chunks.at(-1).usage, undefined);
    assert.equal(res.__modelOutputStarted, true);
});

test("early resets buffered body when transport retry moves to another account", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = setup(
        index => (index === 0 ? [success[0], { data: '{"partial":', event_type: "chunk" }] : success),
        {
            fakeStreamTimeoutMs: 180000,
            scheduler: { streamEarlyHeaders: false },
            streamingMode: "early",
        }
    );
    t.after(() => fixture.scheduler.close());
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("flash", true), res);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.sent.length, 1);
    t.mock.timers.tick(1000);
    assert.equal(res.__modelOutputStarted, false);
    assert.equal(fixture.scheduler.metrics.samples.model_first_output_ms.length, 0);
    fixture.registry.closeMessageQueuesForEpoch(0, 1, "connection_lost");
    await running;
    assert.deepEqual(
        fixture.sent.map(entry => entry.index),
        [0, 1]
    );
    assert.match(res.body, /hello/);
    assert.equal(completionChunks(res).filter(chunk => chunk.choices?.[0]?.delta?.content === "").length, 3);
    assert.equal(fixture.registry.messageQueues.size, 0);
});

test("early final failure is a stream error with original status and no success completion", async t => {
    const fixture = setup(() => [{ event_type: "error", message: "quota", status: 429 }], {
        scheduler: { maxRetries: 1, streamEarlyHeaders: false },
        streamingMode: "early",
    });
    t.after(() => fixture.scheduler.close());
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("flash", true), res);
    const chunks = completionChunks(res);
    assert.equal(res.statusCode, 200);
    assert.equal(chunks[0].choices[0].delta.content, "");
    assert.equal(chunks.at(-1).error.code, 429);
    assert.equal(res.__modelOutputStarted, false);
    assert.equal(res.body.includes("[DONE]"), false);
    assert.equal(res.writableEnded, true);
    assert.equal(fixture.scheduler.snapshot().active_workers, 0);
});

test("early preserves HTTP admission errors before starting a stream", async t => {
    const fixture = setup(() => success, { streamingMode: "early" });
    t.after(() => fixture.scheduler.close());
    fixture.scheduler.config.allocation.flash = { min: 0, preferred: 1 };
    fixture.scheduler.hideModel("flash");
    for (const req of [
        request("flash-early-search", true),
        { ...request("other", true), body: { model: "other", stream: true } },
    ]) {
        const res = new Response();
        await fixture.handler.processOpenAIRequest(req, res);
        assert.ok([400, 403].includes(res.statusCode));
        assert.equal(res.__streamStartSent, undefined);
        assert.equal(res.body.includes("chat.completion.chunk"), false);
    }
    assert.equal(fixture.sent.length, 0);
});

test("early non-stream requests remain JSON and suffix overrides global mode", async () => {
    for (const [globalMode, model, stream, expected] of [
        ["early", "flash", false, null],
        ["early", "flash-fake", true, "fake"],
        ["early", "flash-real", true, "real"],
        ["real", "flash-EARLY", true, "early"],
    ]) {
        const fixture = setup(() => success, { scheduler: { streamEarlyHeaders: false }, streamingMode: globalMode });
        const res = new Response();
        await fixture.handler.processOpenAIRequest(request(model, stream), res);
        assert.equal(Boolean(res.__streamStartSent), expected === "early");
        assert.equal(res.__proxyResponseStreamMode, expected);
        if (!stream) assert.equal(JSON.parse(res.body).choices[0].message.content, "hello");
        fixture.scheduler.close();
    }
});

test("other protocols fall back to fake for global early and early suffix", async () => {
    for (const method of ["processOpenAIResponseRequest", "processClaudeRequest", "processRequest"]) {
        for (const suffix of ["", "-early-search"]) {
            const fixture = setup(() => success, { scheduler: { streamEarlyHeaders: false }, streamingMode: "early" });
            const req = request(`flash${suffix}`, true);
            if (method === "processOpenAIResponseRequest") req.body.input = "hi";
            if (method === "processRequest") {
                req.path = `/v1beta/models/flash${suffix}:streamGenerateContent`;
                req.body = { contents: [{ parts: [{ text: "hi" }], role: "user" }] };
                req.rawBody = Buffer.from(JSON.stringify(req.body));
            }
            const res = new Response();
            await fixture.handler[method](req, res);
            assert.equal(res.__proxyResponseStreamMode, "fake", method);
            assert.equal(fixture.sent[0].request.streaming_mode, "fake", method);
            assert.equal(res.__streamStartSent, undefined, method);
            assert.equal(res.body.includes("chat.completion.chunk"), false, method);
            assert.match(res.body, /hello/);
            fixture.scheduler.close();
        }
    }
});

test("legacy cancellation stops readiness wait and never forwards upstream", async t => {
    const fixture = setup(() => success, { streamingMode: "early" });
    t.after(() => fixture.scheduler.close());
    useLegacy(fixture);
    let release;
    fixture.handler._ensureBrowserBackedRequestReady = () =>
        new Promise(resolve => {
            release = resolve;
        });
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("flash", true), res);
    await waitFor(() => release);
    res.destroyed = true;
    res.emit("close");
    await running;
    release(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.sent.length, 0);
    assert.equal(res.__usageTrackingClientAborted, true);
});

test("early has exactly one heartbeat source throughout buffered waiting and none after finish", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const legacy of [true, false]) {
        const fixture = setup(() => [success[0]], {
            fakeStreamTimeoutMs: 180000,
            scheduler: { streamEarlyHeaders: true, streamKeepaliveIntervalMs: 15000 },
            streamingMode: "early",
        });
        if (legacy) useLegacy(fixture);
        const res = new Response();
        const forwarded = [];
        let buffered;
        const write = res.write.bind(res);
        res.write = value => {
            for (const event of String(value).split("\n\n").filter(Boolean)) {
                if (buffered !== undefined) forwarded.push(buffered);
                buffered = event;
            }
            return write(value);
        };
        const running = fixture.handler.processOpenAIRequest(request("flash", true), res);
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
        assert.equal(fixture.sent.length, 1);
        assert.equal(res.body.includes(": accepted"), false);
        const start = completionChunks(res)[0];
        assert.equal(completionChunks(res).length, 2);
        assert.equal(forwarded.length, 1);
        assert.deepEqual(JSON.parse(forwarded[0].slice(6)), start);
        assert.equal(res.__keepaliveSent, true);
        t.mock.timers.tick(999);
        assert.equal(completionChunks(res).length, 2);
        t.mock.timers.tick(1);
        assert.equal(completionChunks(res).length, 3);
        // Hold the isolated upstream for two minutes of simulated time.
        for (let second = 1; second < 120; second++) {
            t.mock.timers.tick(1000);
            assert.equal(completionChunks(res).length, second + 3);
        }
        const emptyChunks = completionChunks(res);
        assert.equal(emptyChunks.length, 122);
        assert.equal(forwarded.length, 121);
        assert.equal(res.__modelOutputStarted, false);
        assert.equal(res.__modelFirstOutputAt, undefined);
        assert.equal(fixture.scheduler.metrics.samples.model_first_output_ms.length, 0);
        assert.equal(res.body.includes(": keep-alive"), false);
        for (const chunk of emptyChunks.slice(1)) {
            assert.deepEqual(chunk, {
                choices: [{ delta: { content: "" }, finish_reason: null, index: 0 }],
                created: start.created,
                id: start.id,
                model: start.model,
                object: "chat.completion.chunk",
            });
        }
        deliver(fixture, fixture.sent[0], success.slice(1));
        await running;
        const body = res.body;
        t.mock.timers.tick(30000);
        assert.equal(res.body, body);
        fixture.scheduler.close();
    }
});

test("early delivers reasoning and complete tool inputs with usage and tool finish reason", async t => {
    const payload = {
        candidates: [
            {
                content: {
                    parts: [
                        { text: "thinking", thought: true },
                        { functionCall: { args: { city: "上海" }, name: "weather" } },
                    ],
                },
                finishReason: "STOP",
            },
        ],
        usageMetadata: { candidatesTokenCount: 3, promptTokenCount: 2, totalTokenCount: 5 },
    };
    const fixture = setup(() => [success[0], { data: JSON.stringify(payload), event_type: "chunk" }, success[2]], {
        streamingMode: "early",
    });
    t.after(() => fixture.scheduler.close());
    const req = request("flash", true);
    req.body.stream_options = { include_usage: true };
    const res = new Response();
    await fixture.handler.processOpenAIRequest(req, res);
    const chunks = completionChunks(res);
    assert.equal(chunks[0].choices[0].delta.tool_calls, undefined);
    assert.equal(chunks[2].choices[0].delta.reasoning_content, "thinking");
    const tool = chunks[3].choices[0].delta.tool_calls[0];
    assert.deepEqual(JSON.parse(tool.function.arguments), { city: "上海" });
    assert.equal(tool.function.name, "weather");
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
    assert.equal(chunks.at(-1).usage.total_tokens, 5);
    assert.equal(fixture.scheduler.metrics.samples.stream_start_ms.length, 1);
    assert.equal(fixture.scheduler.metrics.samples.model_first_output_ms.length, 1);
    assert.equal(fixture.scheduler.metrics.samples.request_complete_ms.length, 1);
});

test("early reports late upstream errors and malformed buffered JSON without success DONE", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const messages of [
        [success[0], { error: { type: "upstream_error" }, event_type: "error", message: "late error", status: 418 }],
        [success[0], { data: "invalid JSON", event_type: "chunk" }, success[2]],
    ]) {
        const fixture = setup(() => messages, { streamingMode: "early" });
        const res = new Response();
        await fixture.handler.processOpenAIRequest(request("flash", true), res);
        const error = completionChunks(res).at(-1).error;
        assert.ok(error);
        if (messages[1].status) {
            assert.equal(error.code, 418);
            assert.equal(error.type, "upstream_error");
        }
        assert.equal(res.body.includes("[DONE]"), false);
        assert.equal(res.__modelOutputStarted, false);
        assert.equal(fixture.scheduler.metrics.samples.model_first_output_ms.length, 0);
        assert.equal(fixture.registry.messageQueues.size, 0);
        const body = res.body;
        t.mock.timers.tick(5000);
        assert.equal(res.body, body);
        fixture.scheduler.close();
    }
});

test("early disconnect cancels active upstream and stops heartbeats in both runtime modes", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const legacy of [true, false]) {
        const fixture = setup(() => [success[0]], {
            scheduler: { streamKeepaliveIntervalMs: 5 },
            streamingMode: "early",
        });
        if (legacy) useLegacy(fixture);
        const cancelled = [];
        for (const connection of fixture.registry.connectionsByAuth.values()) {
            const send = connection.send;
            connection.send = raw => {
                const message = JSON.parse(raw);
                if (message.event_type === "cancel_request") cancelled.push(message);
                send(raw);
            };
        }
        const res = new Response();
        const running = fixture.handler.processOpenAIRequest(request("flash", true), res);
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
        assert.equal(fixture.sent.length, 1);
        t.mock.timers.tick(1000);
        assert.equal(completionChunks(res).length, 3);
        res.destroyed = true;
        res.emit("close");
        await running;
        const body = res.body;
        t.mock.timers.tick(5000);
        assert.equal(res.body, body);
        assert.equal(fixture.registry.messageQueues.size, 0);
        assert.equal(fixture.scheduler.snapshot().active_workers, 0);
        assert.equal(cancelled.length, 1);
        assert.equal(res.body.includes("[DONE]"), false);
        fixture.scheduler.close();
    }
});

test("early queued timeout preserves stream error status and cleans up the queue", async t => {
    const fixture = setup(() => success, {
        scheduler: {
            globalConcurrency: 1,
            queueTimeoutMs: 10,
            streamEarlyHeaders: false,
            streamKeepaliveIntervalMs: 5,
        },
        streamingMode: "early",
    });
    t.after(() => fixture.scheduler.close());
    const blocker = await fixture.scheduler.acquire("flash");
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("flash", true), res);
    assert.equal(res.statusCode, 200);
    assert.equal(completionChunks(res).at(-1).error.code, 504);
    assert.equal(res.body.includes("[DONE]"), false);
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.scheduler.pending.length, 0);
    fixture.scheduler.release(blocker);
});

test("configuration changes apply to new requests while accepted early requests keep their snapshot", async t => {
    const fixture = setup(() => success, { streamingMode: "early" });
    t.after(() => fixture.scheduler.close());
    useLegacy(fixture);
    let release;
    let waiting = true;
    fixture.handler._ensureBrowserBackedRequestReady = () =>
        waiting
            ? new Promise(resolve => {
                  release = resolve;
              })
            : Promise.resolve(true);
    const first = new Response();
    const running = fixture.handler.withConfigurationSnapshot(() =>
        fixture.handler.processOpenAIRequest(request("flash", true), first)
    );
    await waitFor(() => release);
    fixture.handler.config = { ...fixture.handler.config, streamingMode: "real" };
    waiting = false;
    release(true);
    await running;
    assert.equal(first.__proxyResponseStreamMode, "early");
    const second = new Response();
    await fixture.handler.withConfigurationSnapshot(() =>
        fixture.handler.processOpenAIRequest(request("flash", true), second)
    );
    assert.equal(second.__proxyResponseStreamMode, "real");
    assert.equal(second.__streamStartSent, undefined);
    assert.deepEqual(
        fixture.sent.map(entry => entry.request.streaming_mode),
        ["fake", "real"]
    );
});

// Integrated anti transport tests use the same account/queue fixture as ordinary requests.
function antiReply(index, request) {
    const body = JSON.parse(request.body);
    const synthetic = body.tools?.[0]?.functionDeclarations.find(tool => tool.name.startsWith("agw_emit_"));
    assert.ok(synthetic);
    assert.equal(body.anti_truncation, undefined);
    assert.equal(
        body.tools.flatMap(tool => tool.functionDeclarations || []).filter(tool => tool.name.startsWith("agw_emit_"))
            .length,
        1
    );
    return [
        { event_type: "response_headers", headers: { "content-type": "application/json" }, status: 200 },
        {
            data: JSON.stringify({
                candidates: [
                    {
                        content: {
                            parts: [
                                { text: "discard" },
                                { text: "reason", thought: true },
                                { functionCall: { args: { content: "最终😀回答" }, name: synthetic.name } },
                            ],
                        },
                        finishReason: "STOP",
                    },
                ],
                usageMetadata: { candidatesTokenCount: 7, promptTokenCount: 5, totalTokenCount: 12 },
            }),
            event_type: "chunk",
        },
        { event_type: "stream_close" },
    ];
}

test("anti transport uses canonical scheduling and consistent replies for nonstream/fake/early/real", async t => {
    for (const mode of [null, "fake", "early", "real"]) {
        const fixture = setup(antiReply);
        t.after(() => fixture.scheduler.close());
        const req = request(`models/anti-gemini-2.5-flash${mode ? `-${mode}` : ""}`, Boolean(mode));
        req.body.stream_options = { include_usage: true };
        const res = new Response();
        await fixture.handler.processOpenAIRequest(req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(fixture.sent[0].request.path.includes("/gemini-2.5-flash:"), true);
        assert.equal(res.body.includes("agw_emit_"), false);
        assert.equal(res.body.includes("discard"), false);
        assert.equal(res.body.includes("最终😀回答"), true);
        if (mode) {
            const output = res.body
                .split("\n")
                .filter(line => line.startsWith("data: {"))
                .map(line => JSON.parse(line.slice(6)));
            assert.equal(output.filter(event => event.choices?.[0]?.delta.role).length, 1);
            assert.equal(output.filter(event => event.usage).length, 1);
            assert.equal(new Set(output.map(event => event.id)).size, 1);
            assert.equal(output.find(event => event.choices?.[0]?.finish_reason).choices[0].finish_reason, "stop");
            assert.equal(res.body.match(/\[DONE\]/g).length, 1);
        } else assert.equal(JSON.parse(res.body).choices[0].message.content, "最终😀回答");
    }
});

test("anti admission failures occur before early start or forwarding", async t => {
    for (const [model, fields, config] of [
        ["anti-", {}, {}],
        ["anti-anti-gemini-2.5-flash", {}, {}],
        ["anti-gemini-2.5-flash", {}, { antiTruncationEnabled: false }],
        ["anti-gemini-2.5-flash-search", {}, {}],
        ["anti-gemini-2.5-flash-preview-tts", {}, {}],
        ["gemini-2.5-flash", { anti_truncation: "true" }, {}],
    ]) {
        const fixture = setup(antiReply, { streamingMode: "early", ...config });
        t.after(() => fixture.scheduler.close());
        const req = request(model, true);
        Object.assign(req.body, fields);
        const res = new Response();
        await fixture.handler.processOpenAIRequest(req, res);
        assert.equal(res.statusCode, 400);
        assert.equal(Boolean(res.__streamStartSent), false);
        assert.equal(fixture.sent.length, 0);
    }
});

test("anti early account retry creates a new transport and preserves one stream identity", async t => {
    const names = [];
    const fixture = setup((index, req) => {
        names.push(JSON.parse(req.body).tools[0].functionDeclarations.at(-1).name);
        return names.length === 1 ? [{ event_type: "error", message: "quota", status: 429 }] : antiReply(index, req);
    });
    t.after(() => fixture.scheduler.close());
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("anti-gemini-2.5-flash-early", true), res);
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1]);
    assert.equal(res.body.includes("最终😀回答"), true);
    assert.equal(res.body.match(/\[DONE\]/g).length, 1);
    assert.equal(res.body.includes(names[0]), false);
    assert.equal(res.body.includes('"error"'), false);
});

test("anti real handles fragmented SSE and errors after parameters without replay or DONE", async t => {
    for (const fail of [false, true]) {
        const fixture = setup((index, req) => {
            const messages = antiReply(index, req);
            const raw = `data: ${messages[1].data}\n\n`;
            return [
                messages[0],
                ...Array.from(raw, char => ({ data: char, event_type: "chunk" })),
                ...(fail ? [{ event_type: "error", message: "upstream private", status: 429 }] : [messages[2]]),
            ];
        });
        t.after(() => fixture.scheduler.close());
        const res = new Response();
        await fixture.handler.processOpenAIRequest(request("anti-gemini-2.5-flash-real", true), res);
        assert.equal(fixture.sent.length, 1);
        assert.equal(res.body.includes("最终😀回答"), true);
        assert.equal(res.body.includes("[DONE]"), !fail);
        assert.equal(res.body.includes('"error"'), fail);
        assert.equal(res.body.includes("upstream private"), fail);
    }
});

test("anti decoder and incomplete EOF failures are explicit with no success DONE", async t => {
    for (const mode of ["early", "real"]) {
        for (const malformed of ["args", "finish", "json"]) {
            const fixture = setup((index, req) => {
                const messages = antiReply(index, req);
                const body = JSON.parse(messages[1].data);
                if (malformed === "args") body.candidates[0].content.parts.at(-1).functionCall.args = { content: 1 };
                if (malformed === "finish") delete body.candidates[0].finishReason;
                messages[1].data = malformed === "json" ? '{"invalid":' : JSON.stringify(body);
                return messages;
            });
            t.after(() => fixture.scheduler.close());
            const res = new Response();
            await fixture.handler.processOpenAIRequest(request(`anti-gemini-2.5-flash-${mode}`, true), res);
            assert.equal(res.body.includes('"error"'), true);
            assert.equal(res.body.includes("[DONE]"), false);
            assert.equal(fixture.sent.length, 1);
            const returnedError = errorPayload(res);
            assert.equal(
                returnedError.code,
                malformed === "finish" ? "anti_truncation_incomplete_stream" : "anti_truncation_decode_failed"
            );
            assert.equal(res.body.includes("agw_emit_"), false);
        }
    }
});

test("anti early HTTP client receives live empty events throughout delayed upstream waiting", async t => {
    const express = require("express");
    const delay = Number(process.env.ANTI_TEST_DELAY_MS || 1100);
    const fixture = setup(
        (index, req) => {
            const timer = setTimeout(() => {
                for (const message of antiReply(index, req))
                    fixture.registry._handleIncomingMessage(
                        JSON.stringify({
                            ...message,
                            request_attempt_id: req.request_attempt_id,
                            request_id: req.request_id,
                        }),
                        index
                    );
            }, delay);
            t.after(() => clearTimeout(timer));
            return [];
        },
        { fakeStreamTimeoutMs: delay + 5000 }
    );
    t.after(() => fixture.scheduler.close());
    const app = express();
    app.use(express.json());
    app.post("/v1/chat/completions", (req, res) => fixture.handler.processOpenAIRequest(req, res));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const accepted = Date.now();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
        body: JSON.stringify({
            messages: [{ content: "test", role: "user" }],
            model: "anti-gemini-2.5-flash-early",
            stream: true,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
    });
    const received = [];
    let raw = "";
    for await (const bytes of res.body) {
        const text = Buffer.from(bytes).toString("utf8");
        raw += text;
        received.push({ at: Date.now() - accepted, text });
    }
    assert.equal(res.status, 200);
    assert.equal(received[0].at < Math.min(delay, 1000), true);
    assert.equal(received.filter(item => item.at < delay && item.text.includes('"content":""')).length >= 2, true);
    assert.equal(raw.includes("最终😀回答"), true);
    assert.equal(raw.includes("discard"), false);
    assert.equal(raw.match(/\[DONE\]/g).length, 1);
    assert.equal(fixture.registry.messageQueues.size, 0);
    const waiting = received.filter(item => item.text.includes('"content":""'));
    assert.equal(waiting.length >= Math.max(2, Math.floor(delay / 1000)), true);
    for (let i = 1; i < waiting.length; i++) assert.equal(waiting[i].at - waiting[i - 1].at < 2000, true);
    console.log(`anti HTTP arrival: first=${received[0].at}ms, wait=${delay}ms, reads=${received.length}`);
});

test("anti unsupported entries reject explicit activation and false overrides remove aliases", async t => {
    for (const method of [
        "processOpenAIResponseRequest",
        "processClaudeRequest",
        "processOpenAIEmbeddingsRequest",
        "processRequest",
    ]) {
        const fixture = setup(() => success, { streamingMode: "early" });
        t.after(() => fixture.scheduler.close());
        const req = request("anti-gemini-2.5-flash", true);
        const res = new Response();
        await fixture.handler[method](req, res);
        assert.equal(res.statusCode, 400);
        assert.equal(fixture.sent.length, 0);
        assert.equal(Boolean(res.__streamStartSent), false);
    }
    const fixture = setup(() => success);
    t.after(() => fixture.scheduler.close());
    const req = request("anti-gemini-2.5-flash-real", true);
    req.body.anti_truncation = false;
    const res = new Response();
    await fixture.handler.processOpenAIRequest(req, res);
    assert.equal(res.body.includes("hello"), true);
    assert.equal(fixture.sent[0].request.body.includes("agw_emit_"), false);
    assert.equal(fixture.sent[0].request.path, "/v1beta/models/gemini-2.5-flash:streamGenerateContent");
});

test("anti cancellation clears live queues and waiting heartbeats in legacy and model modes", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const legacy of [false, true]) {
        const fixture = setup(() => [success[0]], { streamingMode: "early" });
        if (legacy) useLegacy(fixture);
        t.after(() => fixture.scheduler.close());
        const res = new Response();
        const running = fixture.handler.processOpenAIRequest(request("anti-gemini-2.5-flash-early", true), res);
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
        assert.equal(fixture.sent.length, 1);
        res.destroyed = true;
        res.emit("close");
        await running;
        const body = res.body;
        t.mock.timers.tick(5000);
        assert.equal(res.body, body);
        assert.equal(fixture.registry.messageQueues.size, 0);
        assert.equal(res.body.includes("[DONE]"), false);
    }
});

test("concurrent anti requests keep private transports isolated and release scheduler resources", async t => {
    const fixture = setup(antiReply);
    t.after(() => fixture.scheduler.close());
    const results = await Promise.all(
        Array.from({ length: 12 }, async () => {
            const res = new Response();
            await fixture.handler.processOpenAIRequest(request("anti-gemini-2.5-flash-early", true), res);
            return res;
        })
    );
    assert.equal(
        results.every(res => res.body.includes("最终😀回答") && !res.body.includes('"error"')),
        true
    );
    const names = fixture.sent.map(
        ({ request: req }) => JSON.parse(req.body).tools[0].functionDeclarations.at(-1).name
    );
    assert.equal(new Set(names).size, 12);
    assert.equal(fixture.registry.messageQueues.size, 0);
    assert.equal(fixture.scheduler.snapshot().active_workers, 0);
});

test("anti real delivery waits for drain and cleans up temporary backpressure listeners", async t => {
    const fixture = setup(antiReply);
    t.after(() => fixture.scheduler.close());
    const res = new Response();
    const write = res.write.bind(res);
    let drains = 0;
    res.write = value => {
        write(value);
        setImmediate(() => {
            drains++;
            res.emit("drain");
        });
        return false;
    };
    await fixture.handler.processOpenAIRequest(request("anti-gemini-2.5-flash-real", true), res);
    assert.equal(drains > 0, true);
    assert.equal(res.body.includes("最终😀回答"), true);
    assert.equal(res.listenerCount("drain"), 0);
    assert.equal(res.listenerCount("error"), 0);
});

function errorPayload(res) {
    if (res.body.trimStart().startsWith("{")) return JSON.parse(res.body).error;
    return res.body
        .split("\n")
        .filter(line => line.startsWith("data: {"))
        .map(line => JSON.parse(line.slice(6)))
        .find(event => event.error)?.error;
}

test("anti preserves upstream error fields across stream modes and runtimes", async t => {
    const message = '配额不足 "model"\n请稍后重试';
    for (const legacy of [false, true]) {
        for (const mode of [null, "early", "fake", "real"]) {
            for (const embedded of [false, true]) {
                const fields = { code: "RESOURCE_EXHAUSTED", message, type: "quota_error" };
                const fixture = setup(
                    () =>
                        embedded
                            ? [
                                  success[0],
                                  {
                                      data:
                                          mode === "real"
                                              ? `data: ${JSON.stringify({ error: fields })}\n\n`
                                              : JSON.stringify({ error: fields }),
                                      event_type: "chunk",
                                  },
                                  success[2],
                              ]
                            : [{ event_type: "error", message, status: 429, upstreamError: fields }],
                    {
                        maxRetries: 1,
                        scheduler: { maxRetries: 0, streamEarlyHeaders: false },
                    }
                );
                t.after(() => fixture.scheduler.close());
                if (legacy) {
                    useLegacy(fixture);
                    fixture.handler._ensureBrowserBackedRequestReady = async () => true;
                    fixture.handler.authSwitcher.handleRequestFailureAndSwitch = async () => {};
                }
                const res = new Response();
                let flushed = 0;
                res.flush = () => flushed++;
                await fixture.handler.processOpenAIRequest(
                    request(`anti-gemini-2.5-flash${mode ? `-${mode}` : ""}`, Boolean(mode)),
                    res
                );
                assert.deepEqual(errorPayload(res), fields, `${legacy}/${mode}/${embedded}: ${res.body}`);
                if (!legacy && !embedded) {
                    assert.equal(
                        fixture.scheduler.account(fixture.sent[0].index).models["gemini-2.5-flash"].last_http_status,
                        429
                    );
                }
                assert.equal(res.statusCode, mode === "early" ? 200 : embedded ? 502 : 429);
                assert.equal(res.body.includes("[DONE]"), false);
                assert.equal(res.writableEnded, true);
                if (res.statusCode === 200) assert.ok(flushed > 0);
                assert.equal(fixture.registry.messageQueues.size, 0);
            }
        }
    }
});

test("anti early reports numeric upstream codes and keeps statistics status independent", async t => {
    for (const status of [403, 429, 500]) {
        const fixture = setup(
            () => [{ event_type: "error", status, upstreamError: { code: status, message: `upstream ${status}` } }],
            { scheduler: { maxRetries: 0 } }
        );
        t.after(() => fixture.scheduler.close());
        const res = new Response();
        await fixture.handler.processOpenAIRequest(request("anti-gemini-2.5-flash-early", true), res);
        assert.equal(res.statusCode, 200);
        assert.equal(errorPayload(res).code, status);
        assert.equal(errorPayload(res).message, `upstream ${status}`);
        assert.equal(res.body.includes("[DONE]"), false);
    }
});

test("retry acquisition failure returns the terminal local error rather than upstream quota", async t => {
    const fixture = setup(() => [
        { event_type: "error", message: "quota", status: 429, upstreamError: { code: "QUOTA", message: "quota" } },
    ]);
    t.after(() => fixture.scheduler.close());
    const acquire = fixture.scheduler.acquire.bind(fixture.scheduler);
    let count = 0;
    fixture.scheduler.acquire = (...args) =>
        ++count === 1
            ? acquire(...args)
            : Promise.reject(Object.assign(new Error("Account queue deadline exceeded"), { status: 504 }));
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("anti-gemini-2.5-flash-early", true), res);
    assert.equal(errorPayload(res).code, 504);
    assert.equal(errorPayload(res).message, "Account queue deadline exceeded");
    assert.equal(res.body.includes("[DONE]"), false);
});

test("anti early fills missing or invalid upstream fields without overriding valid messages", async t => {
    for (const [input, expected] of [
        [
            { error: {}, event_type: "error", status: 200 },
            { code: 502, message: "Upstream generation failed" },
        ],
        [
            { event_type: "error", status: 429, upstreamError: { code: {}, message: [], type: 1 } },
            { code: 429, message: "Upstream generation failed" },
        ],
        [
            { event_type: "error", upstreamError: { code: 429, message: "quota" } },
            { code: 429, message: "quota" },
        ],
    ]) {
        const fixture = setup(() => [input], { scheduler: { maxRetries: 0 } });
        t.after(() => fixture.scheduler.close());
        const res = new Response();
        await fixture.handler.processOpenAIRequest(request("anti-gemini-2.5-flash-early", true), res);
        assert.equal(errorPayload(res).code, expected.code);
        assert.equal(errorPayload(res).message, expected.message);
        assert.equal(errorPayload(res).type, "api_error");
        assert.equal(res.body.includes("[DONE]"), false);
    }
});

test("Argon uses unary across all adapters while preserving client JSON and SSE", async t => {
    for (const method of [
        "processOpenAIRequest",
        "processOpenAIResponseRequest",
        "processClaudeRequest",
        "processRequest",
    ]) {
        for (const stream of [false, true]) {
            await t.test(`${method} stream=${stream}`, async t => {
                const fixture = setup(() => success, { paidAccounts: [0] });
                t.after(() => fixture.scheduler.close());
                const benefit = { state: "ready-paid", verified: true };
                fixture.browser.contexts = new Map([
                    [
                        0,
                        {
                            page: { buildBenefit: benefit, makerSuiteBridge: { cancelAttempt() {}, prepare() {} } },
                            state: "READY",
                        },
                    ],
                ]);
                fixture.browser.isContextReady = index => index === 0;
                fixture.scheduler.browserManager = fixture.browser;
                const req = request("gemini-4-argon-real", stream);
                if (method === "processOpenAIResponseRequest") req.body.input = "hi";
                if (method === "processRequest") {
                    req.path = `/v1beta/models/gemini-4-argon-real:${stream ? "streamGenerateContent" : "generateContent"}`;
                    req.body = { contents: [{ parts: [{ text: "hi" }], role: "user" }] };
                    req.query = stream ? { alt: "sse" } : {};
                }
                const res = new Response();
                await fixture.handler[method](req, res);
                assert.equal(res.statusCode, 200, res.body);
                assert.equal(fixture.sent.length, 1);
                assert.equal(fixture.sent[0].index, 0);
                assert.equal(fixture.sent[0].request.path, "/v1beta/models/gemini-4-argon:generateContent");
                assert.equal(fixture.sent[0].request.query_params.alt, undefined);
                assert.equal(fixture.sent[0].request.streaming_mode, "fake");
                if (stream) {
                    assert.match(res.body, /data: /);
                    assert.equal(res.__proxyResponseStreamMode, "fake");
                } else assert.doesNotThrow(() => JSON.parse(res.body));
                assert.match(res.body, /hello/);
            });
        }
    }
});

test("Argon permission errors affect only the model and do not replay generation", async t => {
    const fixture = setup(() => [{ event_type: "error", message: "PERMISSION_DENIED", status: 403 }], {
        paidAccounts: [0, 1],
    });
    t.after(() => fixture.scheduler.close());
    fixture.browser.contexts = new Map(
        [0, 1].map(index => [
            index,
            {
                page: {
                    buildBenefit: { state: "ready-paid", verified: true },
                    makerSuiteBridge: { cancelAttempt() {}, prepare() {} },
                },
                state: "READY",
            },
        ])
    );
    fixture.browser.isContextReady = index => index < 2;
    fixture.scheduler.browserManager = fixture.browser;
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("gemini-4-argon"), res);
    assert.equal(fixture.sent.length, 1);
    assert.match(res.body, /PERMISSION_DENIED/);
    const account = fixture.scheduler.account(fixture.sent[0].index);
    assert.equal(account.healthy, true);
    assert.equal(account.models["gemini-4-argon"].unsupported, true);
    assert.equal(account.models["gemini-4-argon"].risk_control_failures || 0, 0);
});

test("Argon does not replay a unary generation after its connection is lost", async t => {
    const fixture = setup(() => [], { paidAccounts: [0, 1] });
    t.after(() => fixture.scheduler.close());
    fixture.browser.contexts = new Map(
        [0, 1].map(index => [
            index,
            {
                page: {
                    buildBenefit: { state: "ready-paid", verified: true },
                    makerSuiteBridge: { cancelAttempt() {}, prepare() {} },
                },
                state: "READY",
            },
        ])
    );
    fixture.browser.isContextReady = index => index < 2;
    fixture.scheduler.browserManager = fixture.browser;
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("gemini-4-argon", true), res);
    await new Promise(resolve => setImmediate(resolve));
    fixture.registry.closeMessageQueuesForEpoch(0, 1, "connection_lost");
    await running;
    assert.equal(fixture.sent.length, 1);
    assert.match(res.body, /not replayed/);
    assert.equal(fixture.scheduler.account(0).healthy, true);
    assert.equal(fixture.scheduler.account(0).inflight, 0);
});

test("Argon upstream 429 retains quota cooldown without expiring the account", async t => {
    const fixture = setup(() => [{ event_type: "error", message: "RESOURCE_EXHAUSTED", status: 429 }], {
        maxRetries: 1,
        paidAccounts: [0],
        scheduler: { maxRetries: 0 },
    });
    t.after(() => fixture.scheduler.close());
    fixture.browser.contexts = new Map([
        [
            0,
            {
                page: {
                    buildBenefit: { state: "ready-paid", verified: true },
                    makerSuiteBridge: { cancelAttempt() {}, prepare() {} },
                },
                state: "READY",
            },
        ],
    ]);
    fixture.browser.isContextReady = index => index === 0;
    fixture.scheduler.browserManager = fixture.browser;
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("gemini-4-argon"), res);
    assert.equal(fixture.sent.length, 1);
    const account = fixture.scheduler.account(0);
    assert.equal(account.healthy, true);
    assert.equal(account.models["gemini-4-argon"].rate_limited, true);
    assert.ok(account.models["gemini-4-argon"].cooldown_until > Date.now());
    assert.equal(account.models["gemini-4-argon"].unsupported || false, false);
    assert.equal(res.statusCode, 429);
});

test("legacy document validity failures return controlled responses in every generation adapter", async t => {
    for (const method of [
        "processOpenAIRequest",
        "processOpenAIResponseRequest",
        "processClaudeRequest",
        "processRequest",
    ]) {
        for (const stream of [false, true]) {
            await t.test(`${method} stream=${stream}`, async t => {
                const fixture = setup(() => success, { paidAccounts: [0] });
                t.after(() => fixture.scheduler.close());
                fixture.handler.serverSystem.scheduler = null;
                fixture.handler.authSwitcher.currentAuthIndex = 0;
                fixture.handler._ensureBrowserBackedRequestReady = async () => true;
                fixture.browser.contexts = new Map([
                    [
                        0,
                        {
                            page: {
                                buildBenefit: {
                                    async assertReady() {
                                        throw Object.assign(
                                            new Error("Build benefit failed for gemini-4-argon (auth_unavailable)"),
                                            { code: "BUILD_BENEFIT_NOT_READY", status: 503 }
                                        );
                                    },
                                },
                            },
                        },
                    ],
                ]);
                const req = request("gemini-4-argon", stream);
                if (method === "processOpenAIResponseRequest") req.body.input = "hi";
                if (method === "processRequest") {
                    req.path = `/v1beta/models/gemini-4-argon:${stream ? "streamGenerateContent" : "generateContent"}`;
                    req.body = { contents: [{ parts: [{ text: "hi" }], role: "user" }] };
                }
                const res = new Response();
                await assert.doesNotReject(fixture.handler[method](req, res));
                assert.equal(res.statusCode, 503);
                assert.match(res.body, /auth_unavailable/);
                assert.equal(res.writableEnded, true);
                assert.equal(fixture.sent.length, 0);
                assert.equal(fixture.registry.messageQueues.size, 0);
            });
        }
    }
});

test("OpenAI tool results normalize parsed JSON scalars without changing object results", async t => {
    const fixture = setup(() => success);
    t.after(() => fixture.scheduler.close());
    for (const [content, expected] of [
        ["7", { result: 7 }],
        ['"7"', { result: "7" }],
        ["true", { result: true }],
        ["null", { result: null }],
        ["plain text", { result: "plain text" }],
        ['{"number":7}', { number: 7 }],
    ]) {
        const translated = await fixture.handler.formatConverter.translateOpenAIToGoogle({
            messages: [
                { content: "get number", role: "user" },
                {
                    content: null,
                    role: "assistant",
                    tool_calls: [{ function: { arguments: "{}", name: "get_number" }, id: "call1", type: "function" }],
                },
                { content, name: "get_number", role: "tool", tool_call_id: "call1" },
            ],
            model: "gemini-3.8-flash",
        });
        const part = translated.googleRequest.contents.flatMap(item => item.parts).find(part => part.functionResponse);
        assert.deepEqual(part.functionResponse.response, expected);
    }
});

test("all adapters honor bridge panel budgets beyond five minutes independently of the buffered setting", async t => {
    for (const method of [
        "processOpenAIRequest",
        "processOpenAIResponseRequest",
        "processClaudeRequest",
        "processRequest",
    ]) {
        for (const stream of [false, true]) {
            await t.test(`${method} stream=${stream}`, async t => {
                let elapsed = 0;
                t.mock.method(performance, "now", () => elapsed);
                t.mock.timers.enable({ apis: ["setTimeout"] });
                const fixture = setup(() => [], {
                    fakeStreamTimeoutMs: 300000,
                    makerSuiteTimeoutMs: 600000,
                    paidAccounts: [0],
                    streamTimeoutMs: 60000,
                });
                t.after(() => fixture.scheduler.close());
                const benefit = { state: "ready-paid", verified: true };
                fixture.browser.contexts = new Map([
                    [
                        0,
                        {
                            page: { buildBenefit: benefit, makerSuiteBridge: { cancelAttempt() {}, prepare() {} } },
                            state: "READY",
                        },
                    ],
                ]);
                fixture.browser.isContextReady = index => index === 0;
                fixture.scheduler.browserManager = fixture.browser;
                const req = request("gemini-4-argon-real", stream);
                if (method === "processOpenAIResponseRequest") req.body.input = "hi";
                if (method === "processRequest") {
                    req.path = `/v1beta/models/gemini-4-argon-real:${stream ? "streamGenerateContent" : "generateContent"}`;
                    req.query = stream ? { alt: "sse" } : {};
                    req.body = { contents: [{ parts: [{ text: "hi" }], role: "user" }] };
                }
                const res = new Response();
                const running = fixture.handler[method](req, res);
                for (let n = 0; n < 15; n++) await new Promise(resolve => setImmediate(resolve));
                assert.equal(fixture.sent.length, 1);
                const entry = fixture.sent[0];
                assert.equal(entry.request.transport_policy.transport, "makersuite");
                assert.equal(entry.request.transport_policy.requestedMode, "real");
                assert.equal(entry.request.transport_policy.effectiveMode, "fake");
                for (const time of [59000, 61000, 300001, 590000]) {
                    t.mock.timers.tick(time - elapsed);
                    elapsed = time;
                    for (let n = 0; n < 3; n++) await new Promise(resolve => setImmediate(resolve));
                    assert.equal(res.writableEnded, false);
                }
                deliver(fixture, entry, success);
                await running;
                assert.equal(res.statusCode, 200, res.body);
                assert.match(res.body, /hello/);
                assert.equal(fixture.sent.length, 1);
                assert.equal(fixture.registry.messageQueues.size, 0);
                assert.equal(fixture.scheduler.snapshot().active_workers, 0);
            });
        }
    }
});

test("blockReason never replays generation or penalizes accounts across modes, anti and runtimes", async t => {
    for (const legacy of [false, true])
        for (const anti of [false, true])
            for (const mode of [null, "real", "fake", "early"])
                await t.test(`${legacy ? "legacy" : "model"}/${anti ? "anti" : "plain"}/${mode}`, async t => {
                    const fixture = setup(
                        () => {
                            const data = JSON.stringify({
                                candidates: [{ content: { parts: [{ text: "blocked candidate must not escape" }] } }],
                                error: { code: 503, message: "RESOURCE_EXHAUSTED PERMISSION_DENIED network" },
                                promptFeedback: {
                                    blockReason: "FUTURE_BLOCK",
                                    blockReasonMessage: "network RESOURCE_EXHAUSTED",
                                },
                                usageMetadata: { candidatesTokenCount: 0, promptTokenCount: 123, totalTokenCount: 123 },
                            });
                            const wire = mode === "real" ? `data: ${data}\n\n` : data;
                            return [
                                success[0],
                                ...[wire.slice(0, 17), wire.slice(17)].map(data => ({ data, event_type: "chunk" })),
                                success[2],
                            ];
                        },
                        { immediateSwitchStatusCodes: [400, 429, 503], scheduler: { streamEarlyHeaders: false } }
                    );
                    t.after(() => fixture.scheduler.close());
                    if (legacy) {
                        useLegacy(fixture);
                        fixture.handler._ensureBrowserBackedRequestReady = async () => true;
                    }
                    let switches = 0;
                    fixture.handler.authSwitcher.handleRequestFailureAndSwitch = async () => switches++;
                    const res = new Response();
                    await fixture.handler.processOpenAIRequest(
                        request(`${anti ? "anti-" : ""}gemini-2.5-flash${mode ? `-${mode}` : ""}`, Boolean(mode)),
                        res
                    );
                    const error = errorPayload(res);
                    assert.equal(error?.code, "upstream_prompt_blocked", res.body);
                    assert.equal(error.upstream.blockReason, "FUTURE_BLOCK");
                    assert.equal(error.upstream.error.code, 503);
                    assert.equal(error.usage.prompt_tokens, 123);
                    assert.equal(error.request_id, fixture.sent[0].request.request_id);
                    assert.equal(res.body.includes("blocked candidate must not escape"), false);
                    assert.equal(res.body.includes("[DONE]"), false);
                    assert.equal(res.__usageTrackingOutcome, "error");
                    assert.equal(res.__usageTrackingErrorStatus, 400);
                    assert.equal(res.statusCode, mode === "early" ? 200 : 400, res.body);
                    assert.equal(fixture.sent.length, 1);
                    assert.equal(switches, 0);
                    assert.equal(res.writableEnded, true);
                    assert.equal(fixture.registry.messageQueues.size, 0);
                    if (!legacy) {
                        const account = fixture.scheduler.account(fixture.sent[0].index);
                        const slot = account.models["gemini-2.5-flash"];
                        assert.equal(account.healthy, true);
                        assert.equal(account.inflight, 0);
                        assert.equal(slot.failure_count, 0);
                        assert.equal(slot.consecutive_failures, 0);
                        assert.equal(slot.cooldown_until, 0);
                        assert.equal(slot.unsupported, false);
                        assert.equal(fixture.scheduler.metrics.upstream_error, 0);
                    }
                });
});

test("all protocols preserve blockReason with an error terminal and no account switch", async t => {
    for (const method of ["processOpenAIResponseRequest", "processClaudeRequest", "processRequest"])
        for (const legacy of [false, true])
            for (const mode of [null, "real", "fake"])
                await t.test(`${method}/${legacy}/${mode}`, async t => {
                    const blocked = JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } });
                    const fixture = setup(
                        () => [
                            success[0],
                            { data: mode === "real" ? `data: ${blocked}\n\n` : blocked, event_type: "chunk" },
                            success[2],
                        ],
                        {
                            immediateSwitchStatusCodes: [400, 429, 503],
                            scheduler: { streamEarlyHeaders: false },
                        }
                    );
                    t.after(() => fixture.scheduler.close());
                    if (legacy) {
                        useLegacy(fixture);
                        fixture.handler._ensureBrowserBackedRequestReady = async () => true;
                    }
                    const req = request(`gemini-2.5-flash${mode ? `-${mode}` : ""}`, Boolean(mode));
                    if (method === "processOpenAIResponseRequest") req.body.input = "hi";
                    if (method === "processRequest") {
                        req.path = `/v1beta/models/gemini-2.5-flash${mode ? `-${mode}` : ""}:${mode ? "streamGenerateContent" : "generateContent"}`;
                        req.body = { contents: [{ parts: [{ text: "hi" }], role: "user" }] };
                        req.query = mode ? { alt: "sse" } : {};
                    }
                    const res = new Response();
                    await fixture.handler[method](req, res);
                    assert.match(res.body, /blockReason=SAFETY/);
                    assert.match(res.body, /"blockReason":"SAFETY"/);
                    assert.equal(fixture.sent.length, 1);
                    assert.equal(fixture.handler.authSwitcher.failureCount, 0);
                    assert.equal(res.__usageTrackingOutcome, "error");
                    assert.equal(res.__usageTrackingErrorStatus, 400);
                    assert.equal(res.body.includes("[DONE]"), false);
                    assert.equal(res.body.includes("response.completed"), false);
                    assert.equal(res.body.includes("message_stop"), false);
                    assert.equal(res.writableEnded, true);
                    assert.equal(fixture.registry.messageQueues.size, 0);
                });
});

test("partial output before block is preserved and a preceding retry stops at the block", async t => {
    for (const legacy of [false, true])
        for (const precedingFailure of [false, true]) {
            let calls = 0;
            const fixture = setup(
                () => {
                    if (precedingFailure && calls++ === 0)
                        return [{ event_type: "error", message: "rate limited", status: 429 }];
                    return [
                        success[0],
                        {
                            data: 'data: {"candidates":[{"content":{"parts":[{"text":"prior output"}]} }],"usageMetadata":{"candidatesTokenCount":2}}\n\n',
                            event_type: "chunk",
                        },
                        { data: 'data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n', event_type: "chunk" },
                        success[2],
                    ];
                },
                { scheduler: { streamEarlyHeaders: false } }
            );
            t.after(() => fixture.scheduler.close());
            if (legacy) {
                useLegacy(fixture);
                fixture.handler._ensureBrowserBackedRequestReady = async () => true;
                fixture.handler.authSwitcher.handleRequestFailureAndSwitch = async () => {};
                fixture.handler._prepareImmediateStatusRetry = async error => error.code !== "upstream_prompt_blocked";
            }
            const res = new Response();
            await fixture.handler.processOpenAIRequest(request("gemini-2.5-flash-real", true), res);
            assert.match(res.body, /prior output/);
            assert.equal(errorPayload(res)?.code, "upstream_prompt_blocked", res.body);
            assert.equal(errorPayload(res)?.usage.completion_tokens, 2);
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.includes("[DONE]"), false);
            assert.equal(fixture.sent.length, precedingFailure ? 2 : 1);
            assert.equal(res.__usageTrackingOutcome, "error");
            assert.equal(fixture.registry.messageQueues.size, 0);
        }
});

test("real HTTP clients receive a correlated block error before headers or inside an early SSE stream", async t => {
    const express = require("express");
    const fixture = setup(
        () => [
            success[0],
            {
                data: JSON.stringify({
                    promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "Bearer private-secret" },
                }),
                event_type: "chunk",
            },
            success[2],
        ],
        { scheduler: { streamEarlyHeaders: false } }
    );
    t.after(() => fixture.scheduler.close());
    const diagnostics = [];
    fixture.handler.logger = { ...logger, warn: message => diagnostics.push(message) };
    const app = express();
    app.use(express.json());
    app.post("/v1/chat/completions", (req, res) => fixture.handler.processOpenAIRequest(req, res));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    for (const early of [false, true]) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
            body: JSON.stringify({
                messages: [{ content: "private input must not be logged", role: "user" }],
                model: `anti-gemini-2.5-flash${early ? "-early" : ""}`,
                stream: early,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        const body = await response.text();
        const payload = early
            ? body
                  .split("\n")
                  .filter(line => line.startsWith("data: {"))
                  .map(line => JSON.parse(line.slice(6)))
                  .find(event => event.error)
            : JSON.parse(body);
        assert.equal(response.status, early ? 200 : 400);
        assert.equal(payload.error.code, "upstream_prompt_blocked");
        assert.equal(payload.error.request_id, response.headers.get("x-request-id"));
        assert.equal(body.includes("private-secret"), false);
        assert.equal(body.includes("[DONE]"), false);
        assert.equal(
            early
                ? response.headers.get("content-type").includes("text/event-stream")
                : response.headers.get("content-type").includes("application/json"),
            true
        );
    }
    const events = diagnostics
        .filter(line => line.includes('"event":"upstream_blocked"'))
        .map(line => JSON.parse(line.slice("[Request] ".length)));
    assert.equal(events.length, 2);
    for (const event of events) {
        assert.equal(event.blockReason, "SAFETY");
        assert.equal(event.attemptCount, 1);
        assert.equal(event.outputStarted, false);
        assert.equal(event.retryable, false);
        assert.equal(event.upstreamHttpStatus, 200);
        assert.ok(event.requestAttemptId);
        assert.ok(event.requestId);
    }
    assert.equal(diagnostics.join("\n").includes("private-secret"), false);
    assert.equal(diagnostics.join("\n").includes("private input must not be logged"), false);
    assert.equal(fixture.sent.length, 2);
});

test("anti guards retain conservative no-replay behavior for incomplete frames on disconnect", async t => {
    const fixture = setup(() => [success[0], { data: 'data: {"candidates":', event_type: "chunk" }], {
        scheduler: { streamEarlyHeaders: false },
    });
    t.after(() => fixture.scheduler.close());
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("anti-gemini-2.5-flash-real", true), res);
    await waitFor(() => fixture.sent.length === 1 && fixture.registry.messageQueues.size === 1);
    await new Promise(resolve => setImmediate(resolve));
    const [entry] = fixture.registry.messageQueues.values();
    fixture.registry.closeMessageQueuesForEpoch(entry.authIndex, entry.connectionEpoch, "connection_lost");
    await running;
    assert.equal(fixture.sent.length, 1);
    assert.equal(res.body.includes("[DONE]"), false);
    assert.equal(res.writableEnded, true);
    assert.equal(fixture.registry.messageQueues.size, 0);
});

test("different proxy retries use a new exit before a same-exit account", async () => {
    const fixture = setup(index => (index === 0 ? [{ event_type: "error", message: "quota", status: 429 }] : success), {
        scheduler: { strategy: "different_proxy_first" },
    });
    Object.assign(fixture.browser, {
        getAccountEgressKey: index => ["P1", "P1", "P2", "P3"][index],
        isContextReady: () => true,
    });
    fixture.scheduler.browserManager = fixture.browser;
    const res = new Response();
    try {
        await fixture.handler.processOpenAIRequest(request(), res);
        assert.equal(res.statusCode, 200, res.body);
        assert.deepEqual(
            fixture.sent.map(entry => entry.index),
            [0, 2]
        );
        assert.ok([...fixture.scheduler.egress.values()].every(group => group.inflight === 0));
    } finally {
        fixture.scheduler.close();
    }
});
