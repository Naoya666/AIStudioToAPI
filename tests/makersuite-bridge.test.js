const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const { MakerSuiteBridge } = require("../src/core/MakerSuiteBridge");
const RPC =
    "https://alkali.example/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ProxyUnaryCall";
const content = [[[null, "answer"]], "model"];
const success = JSON.stringify([[[[content, 1]], null, [1, 2, 3]]]);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(r => {
        resolve = r;
    });
    return { promise, resolve };
}
function fixture(t, authIndex = 0, options = {}) {
    const logs = [],
        calls = [],
        timers = new Set();
    const frame = {};
    const sandbox = {
        AbortController,
        addEventListener() {},
        clearInterval(timer) {
            timers.delete(timer);
            clearInterval(timer);
        },
        clearTimeout,
        default_MakerSuite: {
            Cn: async () => "token",
            GB: async text => "hash:" + text,
        },
        DOMException,
        fetch: async (url, init) => {
            calls.push({ init, url });
            return options.fetch ? options.fetch(url, init) : { status: 200, text: async () => success };
        },
        Headers,
        location: { href: "https://aistudio.google.com/" },
        Request,
        setInterval(fn, ms) {
            const timer = setInterval(fn, ms);
            timers.add(timer);
            return timer;
        },
        setTimeout,
        URL,
    };
    sandbox.window = sandbox;
    const realm = vm.createContext(sandbox);
    sandbox.eval = source => vm.runInContext(source, realm);
    const page = new EventEmitter();
    page.closed = false;
    page.isClosed = () => page.closed;
    page.mainFrame = () => frame;
    page.evaluate = async (fn, arg) => vm.runInContext(`(${fn.toString()})(${JSON.stringify(arg)})`, realm);
    page.addInitScript = async ({ content }) => {
        page.init = content;
    };
    const context = new EventEmitter();
    context.route = async (pattern, handler) => {
        context.pattern = pattern;
        context.handler = handler;
    };
    context.unroute = async (pattern, handler) => {
        assert.equal(pattern, context.pattern);
        assert.equal(handler, context.handler);
        context.unrouted = true;
    };
    const logger = Object.fromEntries(["debug", "info", "warn"].map(level => [level, message => logs.push(message)]));
    const bridge = new MakerSuiteBridge({
        authIndex,
        context,
        logger,
        page,
        readyTimeoutMs: 10,
        streamTimeoutMs: 1000,
        timeoutMs: 1000,
        ...options.bridge,
    });
    t.after(() => {
        bridge.dispose();
        for (const timer of timers) clearInterval(timer);
    });
    async function init({ capture = true } = {}) {
        await bridge.install();
        vm.runInContext(page.init, realm);
        if (capture)
            await sandbox.default_MakerSuite.Cn({
                getMetadata: () => ({ Authorization: "private" }),
                mb: { F: "https://upstream.example", jK: "key", Ml: authIndex },
            });
    }
    function route({
        streamed = false,
        path = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        body = { contents: [{ parts: [{ text: "hi" }], role: "user" }] },
        id = "test-id",
    } = {}) {
        const request = {
            headers: () => ({ "x-aistudio-bridge-id": id }),
            postData: () => JSON.stringify([path, JSON.stringify(body)]),
            url: () =>
                (streamed ? RPC.replace("Unary", "Streamed") : RPC) + "?__aistudio_bridge_id=" + encodeURIComponent(id),
        };
        const outcomes = [];
        return {
            abort: async () => {
                outcomes.push({ kind: "abort" });
            },
            continue: async override => {
                outcomes.push({ kind: "continue", override });
            },
            fulfill: async result => {
                outcomes.push({ kind: "fulfill", ...result });
            },
            outcomes,
            request: () => request,
        };
    }
    return { bridge, calls, context, frame, init, logs, page, realm, route, sandbox, timers };
}

test("installs before navigation, bridges the full dotted RPC name and leaves non-generation alone", async t => {
    const f = fixture(t);
    await f.init();
    assert.ok(f.context.pattern.test(RPC));
    assert.equal(f.context.pattern.test(RPC.replace("ProxyUnaryCall", "GenerateContent")), false);
    const route = f.route();
    await f.context.handler(route);
    assert.equal(route.outcomes[0].status, 200);
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].url, /MakerSuiteService\/GenerateContent$/);
    const config = f.calls[0].init;
    assert.equal(config.credentials, "include");
    assert.equal(config.headers.authorization, "private");
    assert.equal(JSON.parse(config.body)[4], "token");
    assert.equal(
        f.logs.some(line => /private|answer|token"/.test(line)),
        false
    );
    const models = f.route({ path: "https://generativelanguage.googleapis.com/v1beta/models" });
    await f.context.handler(models);
    assert.equal(models.outcomes[0].kind, "continue");
    assert.equal(models.outcomes[0].override.url.includes("__aistudio_bridge_id"), false);
    const stream = f.route({ streamed: true });
    await f.bridge.handle(stream);
    assert.equal(stream.outcomes[0].status, 200);
    assert.match(f.logs[0], /buffered/);
});

test("two accounts and concurrent requests keep page authentication isolated", async t => {
    const a = fixture(t, 1),
        b = fixture(t, 2);
    await Promise.all([a.init(), b.init()]);
    await Promise.all([
        a.bridge.handle(a.route({ id: "a1" })),
        a.bridge.handle(a.route({ id: "a2" })),
        b.bridge.handle(b.route({ id: "b" })),
    ]);
    assert.equal(a.calls.length, 2);
    assert.equal(b.calls.length, 1);
    assert.ok(a.calls.every(call => call.init.headers["x-goog-authuser"] === "1"));
    assert.equal(b.calls[0].init.headers["x-goog-authuser"], "2");
    assert.equal(a.bridge.active.size, 0);
});

test("unsupported requests fail before network; missing token is bounded and distinct", async t => {
    const f = fixture(t);
    await f.init({ capture: false });
    const unsupported = f.route({ body: { contents: [{ parts: [{ text: "hi" }] }], tools: [{ googleSearch: {} }] } });
    await f.bridge.handle(unsupported);
    assert.equal(unsupported.outcomes[0].status, 400);
    assert.match(unsupported.outcomes[0].body, /does not support tools.googleSearch/);
    assert.equal(f.calls.length, 0);
    const unready = f.route();
    await f.bridge.handle(unready);
    assert.equal(unready.outcomes[0].status, 503);
    assert.match(unready.outcomes[0].body, /token service not ready/);
});

test("upstream HTTP and application errors preserve Status detail instead of fake success", async t => {
    const detail = '[8,"retry in 42s",[{"retryDelay":"42s"}]]';
    for (const status of [200, 429]) {
        const f = fixture(t, 0, { fetch: async () => ({ status, text: async () => detail }) });
        await f.init();
        const route = f.route();
        await f.bridge.handle(route);
        assert.equal(route.outcomes[0].status, 429);
        assert.equal(route.outcomes[0].body, detail);
    }
    for (const status of [400, 401, 403, 500, 503]) {
        const f = fixture(t, 0, { fetch: async () => ({ status, text: async () => '[13,"upstream message"]' }) });
        await f.init();
        const route = f.route();
        await f.bridge.handle(route);
        assert.equal(route.outcomes[0].status, status);
        assert.match(route.outcomes[0].body, /upstream message/);
    }
    const f = fixture(t, 0, { fetch: async () => ({ status: 200, text: async () => "[]" }) });
    await f.init();
    const route = f.route();
    await f.bridge.handle(route);
    assert.equal(route.outcomes[0].status, 502);
});

test("fetch AbortSignal cancels only its paired GenerateContent request", async t => {
    const original = deferred(),
        started = deferred();
    const f = fixture(t, 0, {
        fetch: (url, init) => {
            if (url.startsWith(RPC)) return original.promise;
            started.resolve(init.signal);
            return new Promise((resolve, reject) =>
                init.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {
                    once: true,
                })
            );
        },
    });
    await f.init();
    const controller = new AbortController();
    const originalFetch = f.sandbox.fetch(RPC, { signal: controller.signal });
    const id = new URL(f.calls[0].url).searchParams.get("__aistudio_bridge_id");
    const route = f.route({ id });
    const pending = f.bridge.handle(route);
    const signal = await started.promise;
    controller.abort();
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(route.outcomes[0].status, 499);
    original.resolve({ status: 499 });
    await originalFetch;
});

test("XHR abort is linked to its new upstream controller", async t => {
    const f = fixture(t);
    // Install a browser-like XHR before the init script wraps its prototype.
    const code = `class FakeXHR { open(method, url) { this.id = new URL(url).searchParams.get("__aistudio_bridge_id"); } send() {} abort() { this.aborted = true; } setRequestHeader(k,v) { this.id = v; } addEventListener() {} }; window.XMLHttpRequest = FakeXHR;`;
    vm.runInContext(code, f.realm);
    await f.init();
    const start = deferred();
    // nativeFetch was captured at installation; use its fixture response body to hold the request.
    // Exercise the wrapped XHR identifier, then run a transport using that same record.
    const xhr = vm.runInContext(
        'var xhr = new XMLHttpRequest(); xhr.open("POST", ' + JSON.stringify(RPC) + "); xhr.send(); xhr",
        f.realm
    );
    // Delay token calculation so abort happens before the native request can begin.
    f.sandbox.default_MakerSuite.GB = () => start.promise;
    const route = f.route({ id: xhr.id });
    const pending = f.bridge.handle(route);
    await tick();
    xhr.abort();
    start.resolve("hash");
    await pending;
    assert.equal(xhr.aborted, true);
    assert.equal(route.outcomes[0].status, 499);
    assert.equal(f.calls.length, 0);
});

test("deadline aborts upstream and clears active bookkeeping", async t => {
    let signal;
    const f = fixture(t, 0, {
        bridge: { timeoutMs: 20 },
        fetch: (url, init) => {
            signal = init.signal;
            return new Promise((resolve, reject) =>
                signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
            );
        },
    });
    await f.init();
    const route = f.route();
    await f.bridge.handle(route);
    assert.equal(signal.aborted, true);
    assert.equal(route.outcomes[0].status, 504);
    assert.equal(f.bridge.active.size, 0);
});

test("navigation, requestfailed and disposal suppress late results and detach resources", async t => {
    for (const event of ["navigation", "requestfailed", "dispose"]) {
        const started = deferred(),
            result = deferred();
        const f = fixture(t, 0, {
            fetch: () => {
                started.resolve();
                return result.promise;
            },
        });
        await f.init();
        const route = f.route();
        const pending = f.bridge.handle(route);
        await started.promise;
        if (event === "navigation") f.page.emit("framenavigated", f.frame);
        else if (event === "requestfailed") f.context.emit("requestfailed", route.request());
        else f.bridge.dispose();
        await pending;
        result.resolve({ status: 200, text: async () => success });
        await tick();
        assert.deepEqual(route.outcomes, [{ kind: "abort" }]);
        f.bridge.dispose();
        await tick();
        assert.equal(f.context.unrouted, true);
        assert.equal(f.context.listenerCount("requestfailed"), 0);
        assert.equal(f.page.listenerCount("framenavigated"), 0);
        assert.equal(f.timers.size, 0);
    }
});

test("init script is idempotent and can capture a fresh page token service after reload", async t => {
    const f = fixture(t);
    await f.init();
    const before = f.sandbox.default_MakerSuite.Cn;
    const originalFetch = f.sandbox.fetch;
    vm.runInContext(f.page.init, f.realm);
    assert.equal(f.sandbox.default_MakerSuite.Cn, before);
    f.sandbox.__makerSuiteBridge.dispose();
    vm.runInContext("window.__makerSuiteBridge = undefined", f.realm);
    // A reload creates a fresh page realm; restore page originals for this simulation.
    f.sandbox.fetch = originalFetch;
    f.sandbox.default_MakerSuite = { Cn: async () => "fresh-token", GB: async () => "hash" };
    vm.runInContext(f.page.init, f.realm);
    await f.sandbox.default_MakerSuite.Cn({
        getMetadata: () => ({ Authorization: "new-auth" }),
        mb: { F: "https://fresh.example", jK: "new-key", Ml: 3 },
    });
    assert.equal(f.sandbox.__makerSuiteBridge.tb.getMetadata().Authorization, "new-auth");
    const route = f.route();
    await f.bridge.handle(route);
    assert.equal(route.outcomes[0].status, 200, JSON.stringify(route.outcomes));
    assert.equal(f.calls.at(-1).init.headers.authorization, "new-auth");
    assert.equal(JSON.parse(f.calls.at(-1).init.body)[4], "fresh-token");
});

test("disposal during asynchronous installation removes a late route registration", async t => {
    const f = fixture(t),
        gate = deferred(),
        entered = deferred();
    const register = f.context.route;
    f.context.route = async (...args) => {
        await register(...args);
        entered.resolve();
        await gate.promise;
    };
    const installing = f.bridge.install();
    await entered.promise;
    f.bridge.dispose();
    gate.resolve();
    await installing;
    assert.equal(f.context.unrouted, true);
    assert.equal(f.context.listenerCount("requestfailed"), 0);
    assert.equal(f.page.listenerCount("close"), 0);
});

test("a hung Playwright evaluation is bounded by the Node deadline", async t => {
    const f = fixture(t, 0, { bridge: { timeoutMs: 5 } });
    await f.init();
    f.page.evaluate = () => new Promise(() => {});
    const route = f.route();
    await f.bridge.handle(route);
    assert.equal(route.outcomes[0].status, 504);
    assert.equal(f.bridge.active.size, 0);
    assert.equal(f.calls.length, 0);
});
