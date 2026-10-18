/* global window, location, XMLHttpRequest */
const ORIGIN = "https://alkalimakersuite-pa.clients6.google.com";
const RPC = "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/";
const MODEL = "gemini-4-argon";
const isArgon = model => model?.replace(/^models\//, "") === MODEL;
const benefitError = message => Object.assign(new Error(message), { code: "BUILD_BENEFIT_NOT_READY", status: 503 });

// Runs in each new document. Credentials and opaque entitlement values never leave
// the owning page except for the final, native RPC's headers.
function installObserver({ origin, rpc, binding, owner, messageBridge = false }) {
    if (window !== window.top) return;
    const documentId = crypto.randomUUID();
    const state = {
        auth: null,
        documentId,
        ext: null,
        observation: null,
        outgoing: new Set(),
        owner,
        pending: null,
        source: null,
        tier: null,
    };
    window.__buildBenefit = state;
    const notify = () => {
        if (messageBridge) console.debug(`BuildBenefitChange:${owner}:${documentId}`);
        else if (binding) window[binding](documentId).catch(() => {});
    };
    const observe = (url, headers) => {
        try {
            const parsed = new URL(url, location.href);
            if (parsed.origin !== origin || !parsed.pathname.startsWith(rpc)) return;
            if (!/^[A-Za-z]+$/.test(parsed.pathname.slice(rpc.length))) return;
            if (parsed.pathname === rpc + "GetAiStudioBenefitTier") return;
            const h = new Headers(headers);
            if (h.has("authorization") && (h.has("x-goog-api-key") || parsed.searchParams.has("key"))) {
                state.auth = {
                    authorization: h.get("authorization"),
                    "x-goog-api-key": h.get("x-goog-api-key") || parsed.searchParams.get("key"),
                    "x-goog-authuser": h.get("x-goog-authuser") || parsed.searchParams.get("authuser") || "0",
                };
            }
            const tier = h.get("x-aistudio-g1-tier");
            if (tier === "TIER1" || tier === "TIER2") {
                state.tier = tier;
                state.source = "native";
                state.observation = {
                    rawTier: tier,
                    sequence: crypto.randomUUID(),
                    source: "native",
                    state: "ready-paid",
                };
                notify();
            }
            if (h.has("x-goog-ext-519733851-bin")) state.ext = h.get("x-goog-ext-519733851-bin");
            if (state.auth && !tier) notify();
        } catch {
            // Ignore unrelated requests and malformed header input.
        }
    };
    const rememberBody = (url, body) => {
        try {
            const parsed = new URL(url, location.href);
            if (parsed.origin === origin && parsed.pathname === rpc + "ProxyUnaryCall" && typeof body === "string") {
                const payload = JSON.parse(body);
                if (
                    Array.isArray(payload) &&
                    typeof payload[0] === "string" &&
                    /^(?:https:\/\/generativelanguage\.googleapis\.com)?\/v1beta\/models\/gemini-4-argon:generateContent(?:\?|$)/.test(
                        payload[0]
                    )
                )
                    state.outgoing.add(body);
            }
        } catch {
            /* Unrelated URL. */
        }
    };
    const observeResponse = async (url, response) => {
        const parsed = new URL(url, location.href);
        if (parsed.origin !== origin || parsed.pathname !== rpc + "GetAiStudioBenefitTier") return;
        try {
            if (!response.ok) throw new Error(response.reason || "query_http");
            const data = await response.json();
            if (!Array.isArray(data) || ![0, 1, 2].includes(data[0])) throw new Error("query_response");
            state.tier = data[0] === 1 ? "TIER1" : data[0] === 2 ? "TIER2" : null;
            state.source = "normal-query";
            state.observation = {
                rawTier: state.tier,
                sequence: crypto.randomUUID(),
                source: "normal-query",
                state: state.tier ? "ready-paid" : "ready-free",
            };
        } catch (error) {
            state.observation = {
                reason: error.message,
                sequence: crypto.randomUUID(),
                source: "normal-query",
                state: "failed",
            };
        }
        notify();
    };
    const originalFetch = window.fetch;
    state.nativeFetch = originalFetch.bind(window);
    window.fetch = function (input, init) {
        const url = input instanceof Request ? input.url : input;
        observe(url, init?.headers || input?.headers);
        if (
            input instanceof Request &&
            init?.body === undefined &&
            String(url).startsWith(origin + rpc + "ProxyUnaryCall")
        ) {
            return input
                .clone()
                .text()
                .then(body => {
                    rememberBody(url, body);
                    return originalFetch.call(this, input, init);
                });
        }
        rememberBody(url, init?.body);
        return originalFetch.call(this, input, init).then(
            response => {
                observeResponse(url, response.clone()).catch(() => {});
                return response;
            },
            error => {
                observeResponse(url, { ok: false, reason: "query_network" }).catch(() => {});
                throw error;
            }
        );
    };
    const open = XMLHttpRequest.prototype.open;
    const setHeader = XMLHttpRequest.prototype.setRequestHeader;
    const send = XMLHttpRequest.prototype.send;
    const requests = new WeakMap();
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        requests.set(this, { headers: new Headers(), url });
        return open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        requests.get(this)?.headers.append(name, value);
        return setHeader.call(this, name, value);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        const request = requests.get(this);
        if (request) {
            observe(request.url, request.headers);
            this.addEventListener(
                "loadend",
                () => {
                    observeResponse(request.url, {
                        json: async () =>
                            this.responseType === "json" ? this.response : JSON.parse(this.responseText),
                        ok: this.status >= 200 && this.status < 300,
                    }).catch(() => {});
                },
                { once: true }
            );
            rememberBody(request.url, args[0]);
        }
        return send.apply(this, args);
    };
    state.read = async (timeoutMs, refresh = false) => {
        if (state.tier && !refresh) return { rawTier: state.tier, source: state.source, state: "ready-paid" };
        if (state.pending) return state.pending;
        state.pending = (async () => {
            if (!state.auth)
                throw Object.assign(new Error("authentication context unavailable"), { reason: "auth_unavailable" });
            const controller = new AbortController();
            state.controller = controller;
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await originalFetch(origin + rpc + "GetAiStudioBenefitTier", {
                    body: "[]",
                    credentials: "include",
                    headers: { ...state.auth, "content-type": "application/json+protobuf" },
                    method: "POST",
                    signal: controller.signal,
                });
                if (!response.ok)
                    throw Object.assign(new Error("benefit query HTTP failure"), {
                        reason: "query_http",
                        status: response.status,
                    });
                const data = await response.json();
                if (!Array.isArray(data) || !Number.isInteger(data[0]) || ![0, 1, 2].includes(data[0]))
                    throw Object.assign(new Error("unknown benefit response"), { reason: "query_response" });
                state.tier = data[0] === 1 ? "TIER1" : data[0] === 2 ? "TIER2" : null;
                state.source = "query";
                return { rawTier: state.tier, source: state.source, state: state.tier ? "ready-paid" : "ready-free" };
            } finally {
                clearTimeout(timer);
                state.controller = null;
            }
        })();
        try {
            return await state.pending;
        } finally {
            state.pending = null;
        }
    };
}

class BuildBenefitContext {
    constructor(
        page,
        {
            authIndex,
            onChange = () => {},
            isCurrent = () => true,
            timeoutMs = 5000,
            canUse = () => false,
            onObservation = () => {},
        } = {}
    ) {
        Object.assign(this, { authIndex, canUse, isCurrent, onChange, onObservation, page, timeoutMs });
        this.state = "unknown";
        this.owner = require("node:crypto").randomUUID();
        this.epoch = 0;
        this.onNavigation = frame => {
            if (frame === page.mainFrame()) {
                this.cancelPending?.();
                this.epoch++;
                this.state = "unknown";
                this.source = null;
                this.failureReason = null;
                this.queryStatus = null;
                this.pending = null;
                this.onChange();
            }
        };
        this.onClose = () => this.dispose();
        this.route = this.route.bind(this);
        this.matcher = url => url.origin === ORIGIN && url.pathname === RPC + "ProxyUnaryCall";
    }

    async install() {
        this.page.on("framenavigated", this.onNavigation);
        this.page.on("close", this.onClose);
        const binding = "__buildBenefitChanged";
        this.usesMainWorldBridge = await this.page.evaluate(() => Boolean(window.wrappedJSObject));
        const options = { binding, origin: ORIGIN, owner: this.owner, rpc: RPC };
        if (this.usesMainWorldBridge) {
            // Camoufox's isolated world also cannot call Playwright bindings.
            // Forward only owner/document IDs through a private console marker;
            // the current page's state is read again before accepting the event.
            const prefix = `BuildBenefitChange:${this.owner}:`;
            this.onConsole = message => {
                const text = message.text();
                if (text.startsWith(prefix)) this._observeDocument(text.slice(prefix.length)).catch(() => {});
            };
            this.page.on("console", this.onConsole);
            await this.page.addInitScript(
                ({ source, options }) => {
                    if (window !== window.top) return;
                    window.wrappedJSObject.eval(`(${source})(${JSON.stringify({ ...options, messageBridge: true })})`);
                },
                { options, source: installObserver.toString() }
            );
        } else {
            await this.page.exposeBinding(binding, ({ frame }, documentId) => {
                if (frame === this.page.mainFrame()) return this._observeDocument(documentId);
            });
            await this.page.addInitScript(installObserver, options);
        }
        if (!this.dispatcher) await this.page.route(this.matcher, this.route);
    }

    async _observeDocument(documentId) {
        if (this.disposed) return;
        const epoch = this.epoch;
        const current = await this._evaluate(() => ({
            id: window.__buildBenefit?.documentId,
            observation: window.__buildBenefit?.observation,
            tier: window.__buildBenefit?.tier,
        })).catch(() => null);
        if (this.disposed || !this.isCurrent() || epoch !== this.epoch || current?.id !== documentId) return;
        const result = current?.observation;
        if (!result || result.sequence === this.lastObservationSequence) return;
        this.lastObservationSequence = result.sequence;
        this.state = result.state;
        this.rawTier = result.rawTier || null;
        this.source = result.source;
        this.failureReason = result.reason || null;
        this.queryStatus = null;
        this.onObservation(result);

        this.onChange();
    }

    async _evaluate(fn, arg) {
        if (!this.usesMainWorldBridge) return this.page.evaluate(fn, arg);
        // Resolve promises and serialize in the page world, so no credential
        // objects or cross-realm Promise wrappers enter Playwright's sandbox.
        const expression = `(async () => JSON.stringify(await (${fn.toString()})(${JSON.stringify(arg) ?? "undefined"})))()`;
        const result = await this.page.evaluate(expression => window.wrappedJSObject.eval(expression), expression);
        return result === undefined ? undefined : JSON.parse(result);
    }

    ensure({ refresh = false, signal } = {}) {
        if (this.disposed || !this.isCurrent()) return Promise.reject(benefitError("Build benefit context disposed"));
        if (signal?.aborted) return Promise.reject(benefitError("Build benefit check cancelled"));
        if (this.pending) return this.pending;
        if (
            !refresh &&
            (["ready-paid", "ready-free"].includes(this.state) ||
                (this.state === "failed" && Date.now() < this.retryAt))
        )
            return Promise.resolve(this.state);
        const epoch = this.epoch;
        this.state = "loading";
        const task = (async () => {
            let timer;
            const abort = () => {
                this.cancelPending?.();
                this._evaluate(() => window.__buildBenefit?.controller?.abort()).catch(() => {});
            };
            signal?.addEventListener("abort", abort, { once: true });
            try {
                const result = await Promise.race([
                    this._evaluate(
                        async ({ timeout, refresh }) => {
                            try {
                                return await window.__buildBenefit.read(timeout, refresh);
                            } catch (error) {
                                return {
                                    httpStatus: error.status || null,
                                    reason:
                                        error.name === "AbortError" ? "query_timeout" : error.reason || "query_parse",
                                    state: "failed",
                                };
                            }
                        },
                        { refresh, timeout: this.timeoutMs }
                    ),
                    new Promise((_, reject) => {
                        this.cancelPending = () => reject(benefitError("Build document retired"));
                        timer = setTimeout(
                            () => reject(benefitError("Build benefit query deadline exceeded")),
                            this.timeoutMs + 100
                        );
                    }),
                ]);
                if (this.disposed || !this.isCurrent() || epoch !== this.epoch)
                    throw benefitError("Build document changed");
                this.state = result.state;
                this.rawTier = result.rawTier || null;
                this.source = result.source;
                this.failureReason = result.reason || null;
                this.queryStatus = result.httpStatus || null;
                if (result.state === "failed") this.retryAt = Date.now() + 30000;
            } catch {
                if (!this.disposed && epoch === this.epoch) {
                    this.state = "failed";
                    this.failureReason = "context_or_deadline";
                    this.queryStatus = null;
                    this.retryAt = Date.now() + 30000;
                }
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                if (epoch === this.epoch) {
                    this.pending = null;
                    this.cancelPending = null;
                    if (!signal?.aborted && !this.disposed && this.isCurrent())
                        this.onObservation({
                            rawTier: this.rawTier || null,
                            reason: this.failureReason,
                            source: this.source || "query",
                            state: this.state,
                        });
                    this.onChange();
                }
            }
            return this.state;
        })();
        this.pending = task;
        return task;
    }

    async assertReady() {
        if (this.disposed || !this.isCurrent()) throw benefitError("Build benefit context disposed");
        if (!this.canUse()) throw benefitError(`Account tier does not allow ${MODEL}`);
    }

    async route(route, cleanUrl) {
        if (typeof cleanUrl !== "string") cleanUrl = undefined;
        const request = route.request();
        let body;
        try {
            body = JSON.parse(request.postData() || "null");
        } catch {
            return route.continue(cleanUrl ? { url: cleanUrl } : {});
        }
        try {
            // Legacy Build's first protobuf-JSON field is the upstream path.
            // Do not scan prompt strings or opaque proof fields for model names.
            const target =
                Array.isArray(body) &&
                typeof body[0] === "string" &&
                /^(?:https:\/\/generativelanguage\.googleapis\.com)?\/v1beta\/models\/gemini-4-argon:generateContent(?:\?|$)/.test(
                    body[0]
                );
            if (!target || request.frame() !== this.page.mainFrame())
                return await route.continue(cleanUrl ? { url: cleanUrl } : {});
            const epoch = this.epoch;
            const documentId = await this._evaluate(body => {
                const state = window.__buildBenefit;
                return state?.outgoing.delete(body) ? state.documentId : null;
            }, request.postData());
            if (!documentId || epoch !== this.epoch) throw benefitError("Retired Build request");
            await this.assertReady();
            const native = await this._evaluate(() => {
                const state = window.__buildBenefit;
                return { documentId: state?.documentId, ext: state?.ext, tier: state?.tier };
            });
            if (epoch !== this.epoch || this.disposed || !this.isCurrent() || native.documentId !== documentId)
                throw benefitError("Build document changed");
            const headers = await request.allHeaders();
            if (headers["x-aistudio-g1-tier"] && !["TIER1", "TIER2"].includes(headers["x-aistudio-g1-tier"]))
                throw benefitError("Unknown native Build tier");
            if (!headers["x-aistudio-g1-tier"]) {
                if (native.tier) headers["x-aistudio-g1-tier"] = native.tier;
            }
            if (!headers["x-goog-ext-519733851-bin"] && native.ext) headers["x-goog-ext-519733851-bin"] = native.ext;
            await route.continue({ headers, ...(cleanUrl ? { url: cleanUrl } : {}) });
        } catch {
            await route.abort("blockedbyclient").catch(() => {});
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelPending?.();
        this.epoch++;
        this.state = "unknown";
        this.page.off("framenavigated", this.onNavigation);
        this.page.off("close", this.onClose);
        if (this.onConsole) this.page.off("console", this.onConsole);
        this.page.unroute(this.matcher, this.route).catch(() => {});
        this._evaluate(owner => {
            if (window.__buildBenefit?.owner === owner) window.__buildBenefit.controller?.abort();
        }, this.owner).catch(() => {});
        this.onChange();
    }
}
module.exports = { benefitError, BuildBenefitContext, installObserver, isArgon, MODEL };
