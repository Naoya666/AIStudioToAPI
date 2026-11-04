const { EventEmitter } = require("node:events");
const RequestHandler = require("../../src/core/RequestHandler");
const ConnectionRegistry = require("../../src/core/ConnectionRegistry");
const { ModelScheduler } = require("../../src/core/ModelScheduler");
const loadConfig = require("../../src/core/SchedulerConfig");
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
        makerSuiteTimeoutMs: 300000,
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
    const browser = {
        authSource: auth,
        contexts: new Map(
            auth.availableIndices.map(index => [index, { page: { makerSuiteBridge: { cancelAttempt() {} } } }])
        ),
        currentAuthIndex: 99,
        async ensureWorkerContext() {},
        notifyUserActivity() {},
    };
    for (const index of auth.availableIndices)
        registry.connectionsByAuth.set(index, {
            dispatch(request) {
                this.send(JSON.stringify({ ...request, event_type: "proxy_request" }));
            },
            readyState: 1,
            send(raw) {
                const request = JSON.parse(raw);
                if (request.event_type !== "proxy_request") return;
                sent.push({ index, request });
                const messages = reply(index, request);
                setImmediate(() => {
                    for (const source of messages) {
                        const message =
                            /:streamGenerateContent$/.test(request.path) &&
                            source.data &&
                            source.data.length > 1 &&
                            /^[{[]/.test(source.data)
                                ? { ...source, data: `data: ${source.data}\n\n` }
                                : source;
                        registry._handleIncomingMessage(
                            JSON.stringify({
                                ...message,
                                request_attempt_id: request.request_attempt_id,
                                request_id: request.request_id,
                            }),
                            index
                        );
                    }
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

module.exports = { request, Response, setup, success };
