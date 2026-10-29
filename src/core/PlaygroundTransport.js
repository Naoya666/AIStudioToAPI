/* global window, document */
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { MakerSuiteBridge, pageEval } = require("./MakerSuiteBridge");
const { buildBody, buildCountBody, decodeCountResponse, merge, errorEnvelope } = require("./MakerSuiteCodec");
const PlaygroundStreamDecoder = require("./PlaygroundStreamDecoder");
const { tagStatus } = require("../utils/MakerSuiteAuth");
const { withHardTimeout } = require("../utils/TimeoutUtils");

const GENERATE =
    "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";
const fail = (message, status = 503) => Object.assign(new Error(message), { status });

// Keep the scheduler's account/connection/attempt epochs and queue protocol, but
// execute locally through Playwright. There is no browser WebSocket or Build app.
class PlaygroundConnection extends EventEmitter {
    constructor(transport) {
        super();
        this.transport = transport;
        this.readyState = 1;
        this.isPlayground = true;
    }

    dispatch(request) {
        if (this.readyState !== 1) throw fail("Playground connection closed");
        const transmit = message => {
            if (this.readyState === 1)
                this.emit(
                    "message",
                    JSON.stringify({
                        ...message,
                        request_attempt_id: request.request_attempt_id,
                        request_id: request.request_id,
                    })
                );
        };
        const streamed = /:streamGenerateContent$/.test(request.path || "");
        let headersSent = false;
        const onChunk = chunk => {
            if (!headersSent) {
                transmit({
                    event_type: "response_headers",
                    headers: { "content-type": "text/event-stream", "x-accel-buffering": "no" },
                    status: 200,
                });
                headersSent = true;
            }
            transmit({ data: `data: ${JSON.stringify(chunk)}\n\n`, event_type: "chunk" });
        };
        this.transport.generate(request, streamed ? onChunk : null).then(
            result => {
                if (!streamed) {
                    transmit({
                        event_type: "response_headers",
                        headers: { "content-type": "application/json" },
                        status: 200,
                    });
                    transmit({ data: JSON.stringify(result), event_type: "chunk" });
                }
                transmit({ event_type: "stream_close" });
            },
            error => {
                const status = error.status || 502;
                const kind =
                    error.kind ||
                    (status === 429 ? "upstream_rate_limited" : status >= 500 ? "upstream_5xx" : "upstream");
                transmit({
                    cooldown: error.cooldown ?? (status === 429 || status >= 500),
                    event_type: "error",
                    kind,
                    message: error.message,
                    reason: error.reason || kind,
                    retryable: error.retryable ?? (status === 429 || status >= 500),
                    status,
                    upstreamError: error.upstreamError,
                    upstreamOutputStarted: error.upstreamOutputStarted === true,
                });
            }
        );
    }

    send(raw) {
        const message = JSON.parse(raw);
        if (message.event_type === "cancel_request")
            this.transport.cancelAttempt(message.request_id, message.request_attempt_id);
        else if (message.event_type === "proxy_request") this.dispatch(message);
        // Browser logging is controlled by the server, so set_log_level is a no-op.
    }

    close() {
        if (this.readyState !== 1) return;
        this.readyState = 3;
        for (const entry of this.transport.active.values()) this.transport.cancelAttempt(null, entry.attemptId);
        this.emit("close");
    }

    terminate() {
        this.close();
    }
}

class PlaygroundTransport extends MakerSuiteBridge {
    constructor(options) {
        super({ ...options, direct: true, registerRoute: false });
        this.ready = false;
        this.page.on("framenavigated", frame => {
            if (frame !== this.page.mainFrame()) return;
            this.ready = false;
            this.connection?.close();
        });
        this.page.once("close", () => this.connection?.close());
    }

    // As in AIStudio2API's Camoufox worker, let the official UI initialize its
    // WAA service, then abort its bootstrap GenerateContent before it leaves the
    // browser. Only initialization uses a network route; business calls do not.
    async bootstrap(timeoutMs = 120000) {
        this.ready = false;
        this.bootstrapping = true;
        const page = this.page;
        let intercepted = false;
        const capture = async route => {
            intercepted = true;
            this.logger.debug(
                `[Playground] account #${this.authIndex}: bootstrap generation intercepted and cancelled`
            );
            await route.abort("aborted").catch(() => {});
        };
        await page.route(GENERATE, capture);
        try {
            await page.waitForFunction(
                () => {
                    const w = window.wrappedJSObject || window;
                    return w.eval(
                        "window.__makerSuiteBridge?.hook() !== 'module_missing' && !!document.querySelector('ms-prompt-box textarea')"
                    );
                },
                null,
                { timeout: timeoutMs }
            );
            const state = await page.evaluate(pageEval, "window.__makerSuiteBridge.hook()");
            if (!["ready", "token_pending"].includes(state)) throw fail("Playground WAA module unsupported");
            await page.evaluate(() => {
                for (const selector of [
                    'ms-g1-welcome-dialog button[aria-label="Close dialog"]',
                    'button[aria-label="Close guided tour"]',
                    "#glue-cookie-notification-bar-1 .glue-cookie-notification-bar__reject",
                ])
                    document.querySelector(selector)?.click();
            });
            const input = page.locator("ms-prompt-box textarea:visible");
            await input.fill("Hello");
            await page.waitForFunction(
                () => {
                    const button = document.querySelector("ms-run-button button");
                    return button && !button.disabled && !button.closest('[aria-disabled="true"]');
                },
                null,
                { timeout: timeoutMs }
            );
            // Use the official DOM submit path after input change detection, as
            // the Camoufox worker in AIStudio2API does.
            await page.evaluate(() => document.querySelector("ms-run-button button").click());
            await page.waitForFunction(
                () => {
                    const w = window.wrappedJSObject || window;
                    return w.eval(
                        "window.__makerSuiteBridge?.hook() === 'ready' && window.__makerSuiteBridge.auth().state === 'ready'"
                    );
                },
                null,
                { timeout: timeoutMs }
            );
            // Hook readiness alone does not prove the page issued its bootstrap.
            const deadline = Date.now() + Math.min(timeoutMs, 10000);
            while (!intercepted) {
                if (Date.now() >= deadline) throw fail("Playground WAA bootstrap request missing");
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            await page.evaluate(() => {
                const button = document.querySelector("ms-run-button button");
                if (button && (button.querySelector(".spin") || /Stop|停止/.test(button.innerText))) button.click();
            });
            await input.fill("");
            if (this.closed || this.benefit?.isCurrent() === false) throw fail("Playground document retired");
            this.ready = true;
            this.logger.info(`[Playground] account #${this.authIndex}: transport ready (Camoufox, no Build App)`);
        } finally {
            this.bootstrapping = false;
            // On failure keep the guard until the owning context is closed: a
            // late official snapshot must never send a bootstrap generation.
            if (this.ready) await page.unroute(GENERATE, capture).catch(() => {});
        }
    }

    connect(registry, owner) {
        if (!this.ready || this.closed) throw fail("Playground transport not ready");
        this.connection = new PlaygroundConnection(this);
        registry.addConnection(this.connection, {
            address: "Playwright",
            attemptId: owner.id || owner.attemptId,
            authIndex: this.authIndex,
            browserGeneration: owner.browserGeneration,
            transportVersion: 2,
        });
        return this.connection;
    }

    async generate(request, onChunk = null) {
        if (!this.ready || this.closed || this.benefit?.disposed || this.benefit?.isCurrent() === false)
            throw fail("Playground transport unavailable");
        const match =
            /^\/v1(?:beta|alpha)?\/models\/([^:/]+):(streamGenerateContent|generateContent|countTokens)$/.exec(
                request.path || ""
            );
        if (!match || request.method?.toUpperCase() !== "POST")
            throw Object.assign(fail("This endpoint is not supported by the Playground transport", 501), {
                cooldown: false,
                kind: "capability",
                reason: "unsupported_endpoint",
                retryable: false,
            });
        if (request.transport_policy?.transport === "legacy")
            throw fail("The Build legacy transport has been removed; select makersuite", 400);
        const rpcMethod = match[2] === "countTokens" ? "CountTokens" : "GenerateContent";
        let input;
        try {
            input = JSON.parse(request.body || "{}");
        } catch {
            throw fail("Invalid request JSON", 400);
        }
        const { body, ht } =
            rpcMethod === "CountTokens"
                ? { body: buildCountBody(match[1], input), ht: "" }
                : buildBody(match[1], input);
        const id = randomUUID();
        const epoch = this.epoch;
        const attemptId = request.request_attempt_id;
        let invalidate,
            cancelled = false,
            outputStarted = false;
        const invalidated = new Promise((_, reject) => {
            invalidate = () => {
                cancelled = true;
                reject(fail("Playground request cancelled or document retired", 499));
            };
        });
        // Install cancellation before any await, including entitlement/document reads.
        this.active.set(id, { attemptId, id, invalidate });
        const excludedKeys = [
            ...Object.entries(request.headers || {})
                .filter(([key]) => ["x-goog-api-key", "x-api-key"].includes(key.toLowerCase()))
                .map(([, value]) => value),
            request.query_params?.key,
        ].filter(value => typeof value === "string");
        const timeoutMs = Math.floor(
            Math.min(
                request.remaining_budget_ms ?? this.timeoutMs,
                (request.__bridgeGenerationDeadline ?? Infinity) - performance.now(),
                (request.__generationDeadline ?? Infinity) - performance.now()
            )
        );
        const execute = async () => {
            if (timeoutMs <= 0) throw fail("Playground generation deadline exceeded", 504);
            if (match[1] === "gemini-4-argon") await this.benefit?.assertReady();
            const expectedDocumentId = await this.benefit?._evaluate(() => window.__buildBenefit?.documentId);
            if (cancelled || this.closed || epoch !== this.epoch || !this.active.has(id))
                throw fail("Playground document retired", 499);
            const chunks = [];
            const terminal = { candidates: [] };
            const finishes = new Map();
            const decoder = new PlaygroundStreamDecoder(chunk => {
                outputStarted ||= chunk.candidates?.some(c => c.content.parts.length > 0) || false;
                if (!onChunk) {
                    chunks.push(chunk);
                    return;
                }
                // Content is delivered immediately. Completion is committed only
                // after EOF validation, so late RPC errors cannot become success.
                const output = structuredClone(chunk);
                for (const candidate of output.candidates || []) {
                    if (candidate.finishReason) {
                        finishes.set(candidate.index, { ...candidate, content: { parts: [], role: "model" } });
                        delete candidate.finishReason;
                    }
                }
                if (chunk.usageMetadata) terminal.usageMetadata = { ...terminal.usageMetadata, ...chunk.usageMetadata };
                if (chunk.responseId) terminal.responseId = chunk.responseId;
                if (chunk.promptFeedback) terminal.promptFeedback = chunk.promptFeedback;
                if (output.candidates?.some(c => c.content.parts.length) || output.promptFeedback) onChunk(output);
            });
            let result;
            try {
                await this.page.evaluate(
                    pageEval,
                    `window.__makerSuiteBridge.start(${JSON.stringify({ body, excludedKeys, expectedDocumentId, ht, id, readyTimeoutMs: this.readyTimeoutMs, rpcMethod, timeoutMs })})`
                );
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    const event = await this.page.evaluate(
                        pageEval,
                        `window.__makerSuiteBridge.next(${JSON.stringify(id)})`
                    );
                    if (cancelled || this.closed || epoch !== this.epoch)
                        throw fail("Playground document retired", 499);
                    if (event?.result) {
                        result = event.result;
                        break;
                    }
                    if (!event || typeof event.text !== "string") throw fail("Invalid Playground stream event", 502);
                    decoder.push(event.text);
                }
                if (result.status === 200 && rpcMethod === "GenerateContent") {
                    decoder.finish();
                    if (onChunk) {
                        terminal.candidates = [...finishes.values()];
                        onChunk(terminal);
                    }
                }
            } catch (error) {
                if (error.rpcStatus) {
                    if (error.status === 401)
                        await this.page
                            .evaluate(pageEval, `window.__makerSuiteBridge.rejectStreamAuth(${JSON.stringify(id)})`)
                            .catch(() => {});
                    throw await this.upstreamError(
                        { status: error.status, text: JSON.stringify(error.rpcStatus) },
                        invalidated
                    );
                }
                throw error;
            }
            if (this.closed || epoch !== this.epoch) throw fail("Playground document retired", 499);
            this.logger.info(
                `[Playground] account=${this.authIndex} attempt=${attemptId} rpc=${rpcMethod} fetch_completed=true status=${result.status}`
            );
            if (result.status !== 200) throw await this.upstreamError(result, invalidated);
            try {
                return rpcMethod === "CountTokens"
                    ? decodeCountResponse(result.text)
                    : onChunk
                      ? undefined
                      : merge(chunks);
            } catch (error) {
                if (error.rpcStatus)
                    throw await this.upstreamError(
                        { status: error.status, text: JSON.stringify(error.rpcStatus) },
                        invalidated
                    );
                throw error;
            }
        };
        try {
            return await withHardTimeout(() => Promise.race([execute(), invalidated]), Math.max(1, timeoutMs), {
                operation: "Playground generation",
                status: 504,
            });
        } catch (error) {
            error.upstreamOutputStarted = outputStarted;
            cancelled = true;
            await this.cancel(id);
            // Evaluation exceptions can contain serialized arguments and credentials.
            if (!error.status) throw fail("Playground browser transport failed", 502);
            throw error;
        } finally {
            await withHardTimeout(
                () => this.page.evaluate(pageEval, `window.__makerSuiteBridge?.release(${JSON.stringify(id)})`),
                2000,
                { operation: "Playground stream cleanup", status: 504 }
            ).catch(() => {});
            this.active.delete(id);
        }
    }

    async upstreamError(result, invalidated) {
        const normalized = errorEnvelope(result.text, result.status);
        if (result.authState) normalized.body = tagStatus(normalized.body, "key_unavailable");
        if (normalized.status === 401)
            normalized.body = tagStatus(normalized.body, await this.diagnoseAuth(invalidated));
        const rpc = JSON.parse(normalized.body);
        const statuses = {
            3: "INVALID_ARGUMENT",
            5: "NOT_FOUND",
            7: "PERMISSION_DENIED",
            8: "RESOURCE_EXHAUSTED",
            16: "UNAUTHENTICATED",
        };
        const error = fail(rpc[1], normalized.status);
        error.upstreamError = {
            code: normalized.status,
            details: rpc[2],
            message: rpc[1],
            status: statuses[rpc[0]] || "INTERNAL",
            type: null,
        };
        return error;
    }

    dispose() {
        this.ready = false;
        super.dispose();
        this.connection?.close();
    }
}

module.exports = { PlaygroundConnection, PlaygroundTransport };
