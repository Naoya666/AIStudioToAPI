/**
 * Browser transport adapted with permission from yunx738/ais2api, commit
 * 79807728179482509cf1f8a4f5e3e175d9dd6702 (CC BY-NC 4.0).
 * The old RPC envelope is kept so existing Build apps need no manual update.
 */
const { randomUUID } = require("node:crypto");
const { buildBody, errorEnvelope, wrapResponse } = require("./MakerSuiteCodec");
const RPC = /MakerSuiteService\/Proxy(Unary|Streamed)Call(?:\?|$)/;
const MARKER = "__aistudio_bridge_id";

// Serialized into the MAIN page realm, including Firefox's wrapped page window.
// No Node closures may be referenced here.
/* eslint-env browser */
function installPageBridge() {
    if (window.__makerSuiteBridge) return;
    const records = new Map();
    const nativeFetch = window.fetch.bind(window);
    const rpc = /MakerSuiteService\/Proxy(Unary|Streamed)Call(?:\?|$)/;
    let sequence = 0;
    const prefix = Math.random().toString(36).slice(2);
    const service = {
        cancel(id) {
            records.get(id)?.controller.abort();
        },
        dispose() {
            service.closed = true;
            clearInterval(service.timer);
            for (const r of records.values()) r.controller.abort();
            records.clear();
        },
        hook() {
            const M = window.default_MakerSuite;
            if (!M?.Cn || !M.GB) return "module_missing";
            if (!M.Cn.__aistudioBridge) {
                const original = M.Cn;
                const wrapped = function (a) {
                    if (a?.mb) service.tb = a;
                    return original.apply(this, arguments);
                };
                wrapped.__aistudioBridge = true;
                M.Cn = wrapped;
            }
            return service.tb ? "ready" : "token_pending";
        },
        async run({ id, body, ht, timeoutMs, readyTimeoutMs }) {
            if (service.closed) return { status: 499, text: '[1,"MakerSuite bridge disposed"]' };
            const record = records.get(id) || { controller: new AbortController() };
            records.set(id, record);
            const signal = record.controller.signal;
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                record.controller.abort();
            }, timeoutMs);
            const check = () => {
                if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            };
            try {
                const readyDeadline = Date.now() + Math.min(readyTimeoutMs, timeoutMs);
                while (service.hook() !== "ready") {
                    check();
                    if (Date.now() >= readyDeadline)
                        return { status: 503, text: '[14,"MakerSuite token service not ready"]' };
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                check();
                const M = window.default_MakerSuite,
                    tb = service.tb;
                body[4] = await M.Cn(tb, await M.GB(ht));
                check();
                const metadata = tb.getMetadata(),
                    mb = tb.mb;
                const response = await nativeFetch(
                    mb.F + "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent",
                    {
                        body: JSON.stringify(body),
                        credentials: "include",
                        headers: {
                            authorization: metadata.Authorization,
                            "content-type": "application/json+protobuf",
                            "x-goog-api-key": mb.jK,
                            "x-goog-authuser": String(mb.Ml),
                            "x-user-agent": "grpc-web-javascript/0.1",
                        },
                        method: "POST",
                        signal,
                    }
                );
                const text = await response.text();
                check();
                return { status: response.status, text };
            } catch (e) {
                // Do not return raw evaluation/transport errors which can include credentials or URLs.
                return {
                    status: timedOut ? 504 : signal.aborted ? 499 : 502,
                    text: JSON.stringify([
                        timedOut ? 4 : signal.aborted ? 1 : 14,
                        timedOut
                            ? "MakerSuite generation deadline exceeded"
                            : signal.aborted
                              ? "MakerSuite generation cancelled"
                              : "MakerSuite browser transport failed",
                    ]),
                };
            } finally {
                clearTimeout(timer);
                if (records.get(id) === record) records.delete(id);
            }
        },
    };
    window.__makerSuiteBridge = service;
    // Link the original Google transport's cancellation to the new upstream fetch.
    // Both fetch and XHR are used by different Studio bundles. Mark only the
    // intercepted URL (never new upstream calls); an extra header would change
    // cross-origin preflight requirements.
    window.fetch = function (input, init) {
        const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
        if (!rpc.test(url)) return nativeFetch(input, init);
        const id = `${prefix}:${++sequence}`,
            controller = new AbortController();
        const signal = init?.signal || input?.signal;
        const cancel = () => controller.abort();
        if (signal?.aborted) cancel();
        signal?.addEventListener("abort", cancel, { once: true });
        records.set(id, { controller });
        const marked = new URL(url, window.location.href);
        marked.searchParams.set("__aistudio_bridge_id", id);
        const target =
            typeof input === "string" || input instanceof URL ? marked.href : new Request(marked.href, input);
        return nativeFetch(target, init).finally(() => {
            signal?.removeEventListener("abort", cancel);
            records.delete(id);
        });
    };
    const proto = window.XMLHttpRequest?.prototype;
    if (proto) {
        const open = proto.open,
            send = proto.send,
            abort = proto.abort;
        const state = new WeakMap();
        proto.open = function (method, url) {
            const previous = state.get(this);
            if (previous?.id) service.cancel(previous.id);
            const matches = rpc.test(String(url));
            const entry = { matches };
            if (matches) {
                entry.id = `${prefix}:${++sequence}`;
                const marked = new URL(String(url), window.location.href);
                marked.searchParams.set("__aistudio_bridge_id", entry.id);
                arguments[1] = marked.href;
            }
            state.set(this, entry);
            return open.apply(this, arguments);
        };
        proto.send = function () {
            const entry = state.get(this);
            if (entry?.matches) {
                const id = entry.id;
                records.set(id, { controller: new AbortController() });
                this.addEventListener(
                    "loadend",
                    () => {
                        service.cancel(id);
                        records.delete(id);
                    },
                    { once: true }
                );
            }
            return send.apply(this, arguments);
        };
        proto.abort = function () {
            const entry = state.get(this);
            if (entry?.id) service.cancel(entry.id);
            return abort.apply(this, arguments);
        };
    }
    service.hook();
    service.timer = setInterval(() => {
        if (service.hook() === "ready") clearInterval(service.timer);
    }, 25);
    window.addEventListener("pagehide", () => service.dispose(), { once: true });
}
/* eslint-env node */

function pageEval(source) {
    // Firefox Playwright may execute in a wrapped realm. Always use the page's own objects.
    const target = window.wrappedJSObject || window;
    return target.eval(source);
}
const INSTALL = `(${installPageBridge.toString()})()`;
const INIT = `(${pageEval.toString()})(${JSON.stringify(INSTALL)})`;

class MakerSuiteBridge {
    constructor({
        context,
        page,
        logger,
        authIndex,
        timeoutMs = 295000,
        streamTimeoutMs = 55000,
        readyTimeoutMs = 10000,
    }) {
        Object.assign(this, { authIndex, context, logger, page, readyTimeoutMs, streamTimeoutMs, timeoutMs });
        this.active = new Map();
        this.closed = false;
        this.epoch = 0;
        this.route = this.handle.bind(this);
        this.onClose = () => {
            this.dispose();
        };
        this.onNavigation = frame => {
            if (frame === page.mainFrame()) {
                this.epoch++;
                for (const entry of this.active.values()) entry.invalidate();
            }
        };
        this.onFailed = request => {
            const entry = this.active.get(request);
            if (entry) {
                entry.invalidate();
                this.cancel(entry.id);
            }
        };
    }
    async install() {
        // Register close hooks before awaited setup so failed initialization is cleaned up too.
        this.page.once("close", this.onClose);
        this.context.once("close", this.onClose);
        this.page.on("framenavigated", this.onNavigation);
        this.context.on("requestfailed", this.onFailed);
        await this.page.addInitScript({ content: INIT });
        if (this.closed) return this;
        await this.context.route(RPC, this.route);
        if (this.closed) {
            await this.context.unroute(RPC, this.route).catch(() => {});
            return this;
        }
        this.logger.info(
            `[MakerSuite] account #${this.authIndex}: GenerateContent bridge installed; streamed RPC responses are buffered`
        );
        return this;
    }
    cancel(id) {
        if (this.closed || this.page.isClosed()) return;
        this.page.evaluate(pageEval, `window.__makerSuiteBridge?.cancel(${JSON.stringify(id)})`).catch(() => {});
    }
    async handle(route) {
        const request = route.request();
        let a;
        try {
            a = JSON.parse(request.postData() || "null");
        } catch {
            /* Validated below if this is a generation request. */
        }
        const path = Array.isArray(a) && typeof a[0] === "string" ? a[0] : "";
        const match = path.match(/(?:^|\/)models\/([^:/?]+):(streamGenerateContent|generateContent)(?:\?|$)/i);
        if (!match) {
            // The transport wrapper also sees model/file RPCs. Never forward its
            // local correlation marker to Google when leaving those calls alone.
            const url = new URL(request.url());
            if (url.searchParams.has(MARKER)) {
                url.searchParams.delete(MARKER);
                return route.continue({ url: url.href });
            }
            return route.continue();
        }
        const epoch = this.epoch;
        if (this.closed) return route.abort("aborted").catch(() => {});
        const streamed = /ProxyStreamedCall/.test(request.url());
        const id = new URL(request.url()).searchParams.get(MARKER) || randomUUID();
        let invalid = false,
            deadline;
        let invalidate;
        const invalidated = new Promise(resolve => {
            invalidate = () => {
                invalid = true;
                resolve(null);
            };
        });
        this.active.set(request, { id, invalidate });
        const fulfill = result => route.fulfill({ ...result, contentType: "application/json+protobuf; charset=UTF-8" });
        try {
            let g;
            try {
                g = JSON.parse(a[1] || "{}");
            } catch {
                throw Object.assign(new Error("Invalid Gemini JSON in MakerSuite generation request"), { status: 400 });
            }
            const { body, ht } = buildBody(match[1], g);
            const timeoutMs = streamed ? this.streamTimeoutMs : this.timeoutMs;
            const arg = { body, ht, id, readyTimeoutMs: this.readyTimeoutMs, timeoutMs };
            const pending = this.page.evaluate(
                pageEval,
                `${INSTALL}; window.__makerSuiteBridge.run(${JSON.stringify(arg)})`
            );
            // Bound hung Playwright calls too; cancel the browser fetch on deadline.
            const expired = new Promise(resolve => {
                deadline = setTimeout(() => {
                    this.cancel(id);
                    resolve({ status: 504, text: '[4,"MakerSuite generation deadline exceeded"]' });
                }, timeoutMs + 250);
            });
            const result = await Promise.race([pending, invalidated, expired]);
            if (invalid || this.closed || epoch !== this.epoch || !result) return;
            let error;
            try {
                const v = JSON.parse(result.text);
                if (Array.isArray(v) && typeof v[0] === "number") error = true;
            } catch {
                /* codec validates JSON */
            }
            if (result.status !== 200 || error) {
                const normalized = errorEnvelope(result.text, result.status);
                this.logger.warn(
                    `[MakerSuite] account #${this.authIndex}: generation failed status=${normalized.status}`
                );
                return await fulfill(normalized);
            }
            const response = wrapResponse(result.text, streamed);
            await fulfill({ body: response, status: 200 });
            this.logger.debug(`[MakerSuite] account #${this.authIndex}: generation completed`);
        } catch (error) {
            this.cancel(id);
            if (!invalid && !this.closed && epoch === this.epoch) {
                const status = error.status || 502;
                const message = error.status ? error.message : "MakerSuite bridge request failed";
                // Keep the protobuf RPC Status shape expected by the Studio client.
                await fulfill({
                    body: JSON.stringify(error.rpcStatus || [status === 400 ? 3 : 13, message]),
                    status,
                }).catch(() => {});
            }
        } finally {
            clearTimeout(deadline);
            this.active.delete(request);
            if (invalid) await route.abort("aborted").catch(() => {});
        }
    }
    dispose() {
        if (this.closed) return;
        // Abort before closing admission; all calls target this instance's own page.
        for (const entry of this.active.values()) {
            this.cancel(entry.id);
            entry.invalidate();
        }
        if (!this.page.isClosed()) this.page.evaluate(pageEval, "window.__makerSuiteBridge?.dispose()").catch(() => {});
        this.closed = true;
        this.page.removeListener("close", this.onClose);
        this.context.removeListener("close", this.onClose);
        this.page.removeListener("framenavigated", this.onNavigation);
        this.context.removeListener("requestfailed", this.onFailed);
        this.context.unroute(RPC, this.route).catch(() => {});
    }
}
module.exports = { installPageBridge, MakerSuiteBridge };
