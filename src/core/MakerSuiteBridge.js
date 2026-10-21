/**
 * Browser transport adapted with permission from yunx738/ais2api, commit
 * 79807728179482509cf1f8a4f5e3e175d9dd6702 and e134063 (CC BY-NC 4.0).
 * The old RPC envelope is retained; budgets over five minutes require the updated Build client.
 */
const { BRIDGE_SETTLEMENT_MS, DEFAULT_MAKERSUITE_TIMEOUT_MS } = require("../config/TransportConfig");
const { randomUUID } = require("node:crypto");
const { tagStatus } = require("../utils/MakerSuiteAuth");
const { buildBody, errorEnvelope, wrapResponse } = require("./MakerSuiteCodec");
const RPC = url =>
    url.origin === "https://alkalimakersuite-pa.clients6.google.com" &&
    /^\/\$rpc\/google\.internal\.alkali\.applications\.makersuite\.v1\.MakerSuiteService\/Proxy(?:Unary|Streamed)Call$/.test(
        url.pathname
    );
const TransportPolicy = require("./ModelTransportPolicy");
const MARKER = "__aistudio_bridge_id";
const ATTEMPT_FIELD = "__aistudio_attempt";

// Serialized into the MAIN page realm, including Firefox's wrapped page window.
// No Node closures may be referenced here.
/* eslint-env browser */
function installPageBridge() {
    if (window.top && window !== window.top) return;
    if (window.__makerSuiteBridge) return;
    const records = new Map();
    const nativeFetch = window.fetch.bind(window);
    const upstreamFetch = (window.__buildBenefit?.nativeFetch || nativeFetch).bind(window);
    const endpoint = "https://alkalimakersuite-pa.clients6.google.com";
    const keyPattern = /^AIza[0-9A-Za-z_-]{30,}$/;
    const observed = new Map(),
        rejected = new Set();
    const tokenServiceKey = "AIzaSyBGb5fGAyC-pRcRU6MUHb__b_vKha71HRE";
    const excluded = new Set([tokenServiceKey]);
    const validUrl = value => {
        try {
            const url = new URL(String(value), window.location.href);
            return (
                url.protocol === "https:" &&
                url.origin === endpoint &&
                /^\/\$rpc\/google\.internal\.alkali\.applications\.makersuite\.v1\.MakerSuiteService\/[^/]+$/.test(
                    url.pathname
                )
            );
        } catch {
            return false;
        }
    };
    const rpc = value =>
        validUrl(value) && /\/Proxy(?:Unary|Streamed)Call$/.test(new URL(String(value), window.location.href).pathname);
    const markUrl = (value, id) => {
        const original = new URL(String(value), window.location.href).href.split("#")[0];
        return original + (original.includes("?") ? "&" : "?") + "__aistudio_bridge_id=" + encodeURIComponent(id);
    };
    let sequence = 0;
    const prefix = Math.random().toString(36).slice(2);
    const service = {
        auth(clientKeys = []) {
            let metadata;
            try {
                metadata = new Headers(service.tb?.getMetadata() || {});
            } catch {
                return { state: "metadata_missing" };
            }
            const exclude = metadata.get("x-goog-api-key");
            if (exclude) excluded.add(exclude);
            const permitted = key =>
                keyPattern.test(key || "") && !excluded.has(key) && !clientKeys.includes(key) && !rejected.has(key);
            // A later metadata exclusion invalidates any earlier preliminary observation.
            const known = [...observed.keys()].filter(permitted);
            let key = known.at(-1),
                source = "observed";
            if (!key) {
                let values = [];
                try {
                    values = Object.values(service.tb?.mb || {});
                } catch {
                    /* No trustworthy fallback. */
                }
                const candidates = [...new Set(values.filter(v => typeof v === "string" && permitted(v)))];
                if (candidates.length !== 1) return { state: candidates.length ? "key_ambiguous" : "key_missing" };
                key = candidates[0];
                source = "scan";
            }
            const authorization = metadata.get("authorization");
            if (!authorization) return { state: "authorization_missing" };
            return { authorization, authuser: metadata.get("x-goog-authuser") ?? "0", key, source, state: "ready" };
        },

        cancel(id) {
            const record = records.get(id);
            record?.controller.abort();
            return record?.done;
        },

        confirmNative(key) {
            return !service.closed && !excluded.has(key) && observed.has(key);
        },

        dispose() {
            service.closed = true;
            clearInterval(service.timer);
            if (service.proofWrapper && service.module?.[service.proofKey] === service.proofWrapper)
                service.module[service.proofKey] = service.proofOriginal;
            for (const r of records.values()) r.controller.abort();
            records.clear();
            observed.clear();
            rejected.clear();
            excluded.clear();
        },

        hook() {
            const M = window.default_MakerSuite;
            if (!M) return "module_missing";
            if (service.module !== M || !service.proofKey || !service.hashKey) {
                const proofs = [],
                    hashes = [];
                // Google renames exports independently for each Studio bundle. Match
                // the native proof/hash operations, never a previously observed name.
                for (const key of Object.keys(M)) {
                    try {
                        const fn = M[key];
                        if (typeof fn !== "function") continue;
                        const source = Function.prototype.toString.call(fn);
                        if (
                            !/^class\b/.test(source) &&
                            /\.snapshot\s*\(\s*\{/.test(source) &&
                            /\bcontent\s*:/.test(source)
                        )
                            proofs.push(key);
                        if (
                            !/^class\b/.test(source) &&
                            source.includes("TextEncoder") &&
                            /\.update\s*\(/.test(source) &&
                            /\.digest\s*\(/.test(source)
                        )
                            hashes.push(key);
                    } catch {
                        /* Ignore unrelated exports with throwing getters. */
                    }
                }
                if (proofs.length !== 1 || hashes.length !== 1) return "module_unsupported";
                if (service.module !== M) service.tb = null;
                service.module = M;
                service.proofKey = proofs[0];
                service.hashKey = hashes[0];
            }
            if (M[service.proofKey] !== service.proofWrapper) {
                const original = M[service.proofKey];
                const wrapped = function (a) {
                    if (typeof a?.getMetadata === "function") service.tb = a;
                    return original.apply(this, arguments);
                };
                service.proofOriginal = original;
                service.proofWrapper = wrapped;
                M[service.proofKey] = wrapped;
            }
            return service.tb ? "ready" : "token_pending";
        },
        // Observations belong to this page realm; they cannot survive navigation.
        observe(url, headers) {
            if (
                !validUrl(url) ||
                /\/(?:GenerateContent|GetAiStudioBenefitTier)(?:\?|$)/.test(String(url)) ||
                service.closed
            )
                return false;
            const key = new Headers(headers || {}).get("x-goog-api-key");
            if (!keyPattern.test(key || "") || excluded.has(key)) return false;
            rejected.delete(key);
            observed.delete(key);
            observed.set(key, true);
            return true;
        },
        async run({ id, body, ht, timeoutMs, readyTimeoutMs, expectedDocumentId, excludedKeys = [] }) {
            if (expectedDocumentId && window.__buildBenefit?.documentId !== expectedDocumentId)
                return { status: 503, text: '[14,"MakerSuite document changed"]' };
            if (service.closed) return { status: 499, text: '[1,"MakerSuite bridge disposed"]' };
            const record = records.get(id) || { controller: new AbortController() };
            records.set(id, record);
            let settled;
            record.done = new Promise(resolve => {
                settled = resolve;
            });
            const signal = record.controller.signal;
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                record.controller.abort();
            }, timeoutMs);
            const check = () => {
                if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            };
            const abortable = promise =>
                new Promise((resolve, reject) => {
                    const abort = () => reject(new DOMException("Aborted", "AbortError"));
                    if (signal.aborted) abort();
                    else signal.addEventListener("abort", abort, { once: true });
                    Promise.resolve(promise).then(
                        value => {
                            signal.removeEventListener("abort", abort);
                            resolve(value);
                        },
                        error => {
                            signal.removeEventListener("abort", abort);
                            reject(error);
                        }
                    );
                });
            try {
                const readyDeadline = Date.now() + Math.min(readyTimeoutMs, timeoutMs);
                let auth, hook;
                while ((hook = service.hook()) !== "ready" || (auth = service.auth(excludedKeys)).state !== "ready") {
                    check();
                    if (Date.now() >= readyDeadline)
                        return {
                            authState: hook !== "ready" ? hook : auth?.state || "token_pending",
                            status: 503,
                            text: '[14,"MakerSuite page authentication not ready"]',
                        };
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                check();
                const M = window.default_MakerSuite,
                    tb = service.tb;
                body[4] = await abortable(M[service.proofKey](tb, await abortable(M[service.hashKey](ht))));
                check();
                // Refresh metadata after token generation; never reuse Authorization across calls.
                auth = service.auth(excludedKeys);
                if (auth.state !== "ready")
                    return {
                        authState: auth.state,
                        status: 503,
                        text: '[14,"MakerSuite page authentication not ready"]',
                    };
                const response = await upstreamFetch(
                    endpoint +
                        "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent",
                    {
                        body: JSON.stringify(body),
                        credentials: "include",
                        headers: {
                            ...(window.__buildBenefit?.tier
                                ? { "x-aistudio-g1-tier": window.__buildBenefit.tier }
                                : {}),
                            ...(window.__buildBenefit?.ext
                                ? { "x-goog-ext-519733851-bin": window.__buildBenefit.ext }
                                : {}),
                            authorization: auth.authorization,
                            "content-type": "application/json+protobuf",
                            "x-goog-api-key": auth.key,
                            "x-goog-authuser": auth.authuser,
                            "x-user-agent": "grpc-web-javascript/0.1",
                        },
                        method: "POST",
                        signal,
                    }
                );
                const text = await response.text();
                check();
                // Do not learn from this nativeFetch: it deliberately bypasses observe().
                let rpcCode;
                try {
                    const value = JSON.parse(text);
                    const records = Array.isArray(value)
                        ? [value, ...value, ...(Array.isArray(value[0]) ? value[0] : [])]
                        : [];
                    if (records.some(v => Array.isArray(v) && v[0] === 16 && typeof v[1] === "string")) rpcCode = 16;
                } catch {
                    /* codec validates */
                }
                if (response.status === 401 || rpcCode === 16) {
                    rejected.add(auth.key);
                    observed.delete(auth.key);
                }
                return { authSource: auth.source, status: response.status, text };
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
                settled();
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
        if (!rpc(url)) {
            service.observe(url, init?.headers || input?.headers);
            return nativeFetch(input, init);
        }
        service.observe(url, init?.headers || input?.headers);
        const id = `${prefix}:${++sequence}`,
            controller = new AbortController();
        const signal = init?.signal || input?.signal;
        const cancel = () => controller.abort();
        if (signal?.aborted) cancel();
        signal?.addEventListener("abort", cancel, { once: true });
        records.set(id, { controller });
        const marked = markUrl(url, id);
        const target = typeof input === "string" || input instanceof URL ? marked : new Request(marked, input);
        return nativeFetch(target, init).finally(() => {
            signal?.removeEventListener("abort", cancel);
            records.delete(id);
        });
    };
    const proto = window.XMLHttpRequest?.prototype;
    if (proto) {
        const open = proto.open,
            send = proto.send,
            abort = proto.abort,
            setRequestHeader = proto.setRequestHeader;
        const state = new WeakMap();
        proto.open = function (method, url) {
            const previous = state.get(this);
            if (previous?.id) service.cancel(previous.id);
            const matches = rpc(String(url));
            const entry = { headers: {}, matches, url: String(url) };
            if (matches) {
                entry.id = `${prefix}:${++sequence}`;
                arguments[1] = markUrl(url, entry.id);
            }
            state.set(this, entry);
            return open.apply(this, arguments);
        };
        proto.setRequestHeader = function (name, value) {
            const entry = state.get(this);
            if (entry) entry.headers[String(name).toLowerCase()] = String(value);
            return setRequestHeader.apply(this, arguments);
        };
        proto.send = function () {
            const entry = state.get(this);
            if (entry) service.observe(entry.url, entry.headers);
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
        timeoutMs = DEFAULT_MAKERSUITE_TIMEOUT_MS,
        streamTimeoutMs = DEFAULT_MAKERSUITE_TIMEOUT_MS,
        policy = {},
        benefit = null,
        registerRoute = true,
        requireRegistration = false,
        readyTimeoutMs = 10000,
        validateSession = async () => "unverified",
        diagnosticTimeoutMs = 2000,
    }) {
        Object.assign(this, {
            authIndex,
            benefit,
            context,
            diagnosticTimeoutMs,
            logger,
            page,
            policy,
            readyTimeoutMs,
            registerRoute,
            requireRegistration,
            streamTimeoutMs,
            timeoutMs,
            validateSession,
        });
        this.active = new Map();
        this.attempts = new Map();
        this.cleanup = new Set();
        this.closed = false;
        this.epoch = 0;
        this.route = this.handle.bind(this);
        this.onClose = () => {
            this.dispose();
        };
        this.onNavigation = frame => {
            if (frame === page.mainFrame()) {
                this.epoch++;
                this.attempts.clear();
                for (const entry of this.active.values()) {
                    this.cancel(entry.id);
                    entry.invalidate();
                }
            }
        };
        this.onRequest = request => {
            // Confirm an observation made in the CURRENT page realm; never inject a
            // key from an old document or our own GenerateContent call into it.
            try {
                const url = new URL(request.url());
                if (
                    this.closed ||
                    request.frame() !== page.mainFrame() ||
                    url.protocol !== "https:" ||
                    url.origin !== "https://alkalimakersuite-pa.clients6.google.com" ||
                    !/^\/\$rpc\/google\.internal\.alkali\.applications\.makersuite\.v1\.MakerSuiteService\//.test(
                        url.pathname
                    ) ||
                    url.pathname.endsWith("/GenerateContent")
                )
                    return;
                const key = request.headers()["x-goog-api-key"];
                if (!/^AIza[0-9A-Za-z_-]{30,}$/.test(key || "")) return;
                const epoch = this.epoch;
                this.page
                    .evaluate(pageEval, `window.__makerSuiteBridge?.confirmNative(${JSON.stringify(key)})`)
                    .then(confirmed => {
                        if (confirmed && !this.closed && this.epoch === epoch)
                            this.logger.debug(`[MakerSuite] account #${this.authIndex}: page API key observed`);
                    })
                    .catch(() => {});
            } catch {
                /* Detached frames and disposed contexts cannot update auth state. */
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
        this.context.on("request", this.onRequest);
        await this.page.addInitScript({ content: INIT });
        if (this.closed) return this;
        if (this.registerRoute) await this.page.route(RPC, this.route);
        if (this.closed) {
            if (this.registerRoute) await this.page.unroute(RPC, this.route).catch(() => {});
            return this;
        }
        this.logger.info(
            `[MakerSuite] account #${this.authIndex}: GenerateContent bridge installed; streamed RPC responses are buffered`
        );
        return this;
    }
    prepare(proxyRequest, deadline, timeoutMs = this.timeoutMs) {
        const id = proxyRequest.request_attempt_id;
        if (this.closed || this.benefit?.disposed || this.benefit?.isCurrent() === false)
            throw Object.assign(new Error("MakerSuite document unavailable"), { status: 503 });
        const startedAt = performance.now();
        const remaining = deadline - startedAt;
        const body = JSON.parse(proxyRequest.body || "{}");
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.hasOwn(body, ATTEMPT_FIELD))
            throw Object.assign(new Error("Invalid or reserved MakerSuite request metadata"), { status: 400 });
        this.attempts.set(id, {
            bridgeDeadline: Math.min(startedAt + timeoutMs, proxyRequest.__bridgeGenerationDeadline ?? Infinity),
            deadline,
            epoch: this.epoch,
            excludedKeys: [
                ...Object.entries(proxyRequest.headers || {})
                    .filter(([name]) => ["x-goog-api-key", "x-api-key"].includes(name.toLowerCase()))
                    .map(([, value]) => value),
                proxyRequest.query_params?.key,
            ].filter(value => typeof value === "string"),
            policy: proxyRequest.transport_policy,
            reserveMs: Math.min(BRIDGE_SETTLEMENT_MS, timeoutMs * 0.05, remaining * 0.05),
        });
        proxyRequest.query_params = { ...proxyRequest.query_params, [ATTEMPT_FIELD]: id };
        // Studio may remove arbitrary URL query parameters from ProxyUnaryCall.
        // The JSON payload survives that boundary; strip this local field before
        // encoding GenerateContent and generating its new proof. Never mutate the
        // original body used by retries and anti-truncation continuation rounds.
        return { ...proxyRequest, body: JSON.stringify({ ...body, [ATTEMPT_FIELD]: id }) };
    }
    cancelAttempt(requestId, attemptId) {
        for (const [id] of this.attempts)
            if (id === attemptId || (!attemptId && id.startsWith(requestId + "_attempt_"))) this.attempts.delete(id);
        for (const entry of this.active.values())
            if (entry.attemptId === attemptId || (!attemptId && entry.attemptId?.startsWith(requestId + "_attempt_"))) {
                const task = this.cancel(entry.id);
                this.cleanup.add(task);
                task.finally(() => this.cleanup.delete(task));
                entry.invalidate();
            }
    }
    async settle() {
        await Promise.all([...this.cleanup]);
    }
    cancel(id) {
        if (this.closed || this.page.isClosed()) return Promise.resolve();
        return require("../utils/TimeoutUtils")
            .withHardTimeout(
                () => this.page.evaluate(pageEval, `window.__makerSuiteBridge?.cancel(${JSON.stringify(id)})`),
                2000
            )
            .catch(() => {
                this.logger.warn(`[MakerSuite] account #${this.authIndex}: cancellation cleanup bounded`);
            });
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
        let upstream;
        try {
            upstream = new URL(path || "/", "https://generativelanguage.googleapis.com");
        } catch {
            upstream = new URL("https://invalid.example/");
        }
        const match = upstream.pathname.match(
            /^\/v1(?:beta|alpha)?\/models\/([^:/]+):(streamGenerateContent|generateContent)$/
        );
        let wireBody;
        try {
            wireBody = JSON.parse(a?.[1] || "{}");
        } catch {
            /* The generation handler returns the existing controlled JSON error. */
        }
        const hasBodyAttempt = wireBody && typeof wireBody === "object" && Object.hasOwn(wireBody, ATTEMPT_FIELD);
        const bodyAttempt = hasBodyAttempt ? wireBody[ATTEMPT_FIELD] : null;
        const queryAttempt = upstream.searchParams.get(ATTEMPT_FIELD);
        const attemptId = typeof bodyAttempt === "string" ? bodyAttempt : queryAttempt;
        const registration = this.attempts.get(attemptId);
        const selected = registration?.policy || TransportPolicy.resolve(match?.[1] || "", "fake", this.policy);
        if (
            !match ||
            request.method() !== "POST" ||
            request.frame() !== this.page.mainFrame() ||
            upstream.origin !== "https://generativelanguage.googleapis.com" ||
            selected.transport !== "makersuite"
        ) {
            // Remove only our appended parameter. URLSearchParams would rewrite
            // unrelated legacy query escaping and invalidate the unchanged wire guarantee.
            const url = request.url().replace(/[?&]__aistudio_bridge_id=[^&#]*$/, "");
            return this.benefit ? this.benefit.route(route, url) : route.continue({ url });
        }
        const epoch = this.epoch;
        if (this.closed) return route.abort("aborted").catch(() => {});
        const streamed = /ProxyStreamedCall/.test(request.url());
        const id = new URL(request.url()).searchParams.get(MARKER) || randomUUID();
        let invalid = false,
            deadline,
            keySource = "unknown";
        let invalidate;
        const invalidated = new Promise(resolve => {
            invalidate = () => {
                invalid = true;
                resolve(null);
            };
        });
        this.active.set(request, { attemptId, id, invalidate });
        const fulfill = result => route.fulfill({ ...result, contentType: "application/json+protobuf; charset=UTF-8" });
        try {
            if (
                hasBodyAttempt &&
                (typeof bodyAttempt !== "string" || !bodyAttempt || (queryAttempt && bodyAttempt !== queryAttempt))
            )
                throw Object.assign(new Error("Invalid MakerSuite request metadata"), { status: 400 });
            if (
                (this.requireRegistration || hasBodyAttempt) &&
                (!registration || registration.epoch !== epoch || registration.policy.model !== match[1])
            )
                throw Object.assign(new Error("Retired MakerSuite request"), { status: 503 });
            if (match[1] === "gemini-4-argon" && this.benefit) await this.benefit.assertReady();
            if (this.benefit && (this.benefit.disposed || !this.benefit.isCurrent()))
                throw Object.assign(new Error("Retired MakerSuite document"), { status: 503 });
            let g;
            try {
                g = JSON.parse(a[1] || "{}");
            } catch {
                throw Object.assign(new Error("Invalid Gemini JSON in MakerSuite generation request"), { status: 400 });
            }
            if (hasBodyAttempt) delete g[ATTEMPT_FIELD];
            const { body, ht } = buildBody(match[1], g);
            const expectedDocumentId = this.benefit
                ? await this.benefit._evaluate(() => window.__buildBenefit?.documentId)
                : null;
            if (invalid || this.closed || epoch !== this.epoch)
                throw Object.assign(new Error("MakerSuite document changed"), { status: 503 });
            const timeoutMs = Math.floor(
                Math.min(
                    registration ? registration.bridgeDeadline - performance.now() : this.timeoutMs,
                    registration ? registration.deadline - performance.now() - registration.reserveMs : this.timeoutMs
                )
            );
            if (timeoutMs <= 0)
                throw Object.assign(new Error("MakerSuite generation deadline exceeded"), { status: 504 });
            const arg = {
                body,
                excludedKeys: registration?.excludedKeys || [],
                expectedDocumentId,
                ht,
                id,
                readyTimeoutMs: this.readyTimeoutMs,
                timeoutMs,
            };
            this.logger.debug(
                `[MakerSuite] account=${this.authIndex} attempt=${attemptId || id} model=${match[1]} transport=makersuite rpc=GenerateContent policy=${selected.version} remaining_ms=${timeoutMs}`
            );
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
            keySource = result.authSource || "unknown";
            let error;
            try {
                const v = JSON.parse(result.text);
                if (Array.isArray(v) && typeof v[0] === "number") error = true;
            } catch {
                /* codec validates JSON */
            }
            if (result.status !== 200 || error) {
                const normalized = errorEnvelope(result.text, result.status);
                if (result.authState) normalized.body = tagStatus(normalized.body, "key_unavailable");
                if (normalized.status === 401) {
                    const state = await this.diagnoseAuth(invalidated);
                    if (invalid || this.closed || epoch !== this.epoch) return;
                    normalized.body = tagStatus(normalized.body, state);
                    this.logger.warn(
                        `[MakerSuite] account #${this.authIndex}: authentication state=${state}, key_source=${result.authSource || "unknown"}, page_epoch=${epoch}`
                    );
                }
                this.logger.warn(
                    `[MakerSuite] account #${this.authIndex}: generation failed status=${normalized.status}${result.authState ? ` readiness=${result.authState}` : ""}`
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
                let body = JSON.stringify(error.rpcStatus || [status === 400 ? 3 : 13, message]);
                if (status === 401) {
                    const state = await this.diagnoseAuth(invalidated);
                    if (invalid || this.closed || epoch !== this.epoch) return;
                    body = tagStatus(body, state);
                    this.logger.warn(
                        `[MakerSuite] account #${this.authIndex}: authentication state=${state}, key_source=${keySource}, page_epoch=${epoch}`
                    );
                }
                await fulfill({ body, status }).catch(() => {});
            }
        } finally {
            clearTimeout(deadline);
            this.active.delete(request);
            if (attemptId) this.attempts.delete(attemptId);
            if (invalid) await route.abort("aborted").catch(() => {});
        }
    }
    async diagnoseAuth(invalidated) {
        let timer;
        try {
            const state = await Promise.race([
                Promise.resolve().then(() => this.validateSession()),
                invalidated,
                new Promise(resolve => {
                    timer = setTimeout(() => resolve("unverified"), this.diagnosticTimeoutMs);
                }),
            ]);
            return state === "expired" ? "session_expired" : "unverified";
        } catch {
            return "unverified";
        } finally {
            clearTimeout(timer);
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
        this.attempts.clear();
        this.page.removeListener("close", this.onClose);
        this.context.removeListener("close", this.onClose);
        this.page.removeListener("framenavigated", this.onNavigation);
        this.context.removeListener("requestfailed", this.onFailed);
        this.context.removeListener("request", this.onRequest);
        if (this.registerRoute) this.page.unroute(RPC, this.route).catch(() => {});
    }
}
module.exports = { installPageBridge, MakerSuiteBridge };
