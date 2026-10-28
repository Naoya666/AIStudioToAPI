/* global window */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { firefox } = require("playwright");
const { BuildBenefitContext } = require("../src/core/BuildBenefitContext");
const RequestHandler = require("../src/core/RequestHandler");
const { ModelScheduler, getModelDailyQuota } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const ORIGIN = "https://alkalimakersuite-pa.clients6.google.com";
const RPC = "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/";
const auth = {
    authorization: "fixture-authorization",
    "x-goog-api-key": "fixture-service-key",
    "x-goog-authuser": "2",
};
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

// A real TLS peer behind a loopback CONNECT proxy receives route.continue().
// No Google traffic leaves this fixture, including DNS resolution.
async function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "build-benefit-"));
    execFileSync(
        "openssl",
        [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            path.join(directory, "key"),
            "-out",
            path.join(directory, "cert"),
            "-days",
            "1",
            "-subj",
            "/CN=fixture",
        ],
        { stdio: "ignore" }
    );
    const state = { body: "[1]", delay: 0, requests: [], status: 200 };
    const server = https.createServer(
        { cert: fs.readFileSync(path.join(directory, "cert")), key: fs.readFileSync(path.join(directory, "key")) },
        async (req, res) => {
            res.setHeader("access-control-allow-origin", "https://aistudio.google.com");
            res.setHeader("access-control-allow-credentials", "true");
            res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] || "*");
            res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
            if (req.method === "OPTIONS") return res.end();
            if (req.method === "GET") {
                res.setHeader("content-type", "text/html");
                return res.end(
                    "<!doctype html><title>Local Build fixture</title>" +
                        (state.autoAuth
                            ? `<script>fetch(${JSON.stringify(ORIGIN + RPC + "ListModels")}, {method:"POST", headers:${JSON.stringify(auth)}, body:"[]", credentials:"include"})</script>`
                            : "")
                );
            }
            let body = "";
            for await (const chunk of req) body += chunk;
            state.requests.push({ body, headers: req.headers, url: req.url });
            if (req.url.startsWith(RPC + "GetAiStudioBenefitTier")) {
                if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
                res.statusCode = state.status;
                res.end(state.body);
            } else res.end("[]");
        }
    );
    await listen(server);
    const sockets = new Set();
    const proxy = http.createServer();
    proxy.on("connect", (req, socket, head) => {
        if (!["aistudio.google.com:443", "alkalimakersuite-pa.clients6.google.com:443"].includes(req.url))
            return socket.destroy();
        const upstream = net.connect(server.address().port, "127.0.0.1", () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            socket.pipe(upstream).pipe(socket);
        });
        for (const peer of [socket, upstream]) {
            sockets.add(peer);
            peer.on("error", () => peer.destroy());
            peer.on("close", () => sockets.delete(peer));
        }
    });
    await listen(proxy);
    const runtime = { browser: null };
    t.after(async () => {
        await runtime.browser?.close();
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        await Promise.all([
            new Promise(resolve => server.close(resolve)),
            new Promise(resolve => proxy.close(resolve)),
        ]);
        fs.rmSync(directory, { force: true, recursive: true });
    });
    const browser = await firefox.launch({
        executablePath: process.env.BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH || undefined,
        headless: true,
        proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
    });
    runtime.browser = browser;
    state.browser = browser;
    state.open = async (index = 0, timeoutMs = 1000) => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();
        const benefit = new BuildBenefitContext(page, { authIndex: index, canUse: () => true, timeoutMs });
        await benefit.install();
        page._fixtureBenefit = benefit;
        await context.addCookies([
            {
                domain: "alkalimakersuite-pa.clients6.google.com",
                httpOnly: true,
                name: "fixture-session",
                path: "/",
                secure: true,
                value: `account-${index}`,
            },
        ]);
        await page.goto("https://aistudio.google.com/");
        return { benefit, context, page };
    };
    // Camoufox 135's Juggler does not complete Page.reload with this
    // Playwright version. Recreate its document through the production goto path.
    state.reload = page =>
        process.env.BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH
            ? page.goto(`https://aistudio.google.com/?fixture_document=${Date.now()}`, {
                  waitUntil: "domcontentloaded",
              })
            : page.reload({ waitUntil: "domcontentloaded" });
    state.native = (page, headers = auth, method = "ListModels", body = "[]") =>
        page._fixtureBenefit._evaluate(
            async ({ body, headers, url }) =>
                (await fetch(url, { body, credentials: "include", headers, method: "POST" })).status,
            { body, headers, url: ORIGIN + RPC + method }
        );
    return state;
}

test("real Firefox preserves legacy wire and isolates entitlement documents/accounts", { timeout: 60000 }, async t => {
    const f = await fixture(t);
    const { page, benefit, context } = await f.open();
    await f.native(page);
    f.delay = 40;
    const first = benefit.ensure();
    assert.equal(first, benefit.ensure());
    assert.equal(await first, "ready-paid");
    const queries = f.requests.filter(request => request.url.includes("GetAiStudioBenefitTier"));
    assert.equal(queries.length, 1);
    assert.equal(queries[0].body, "[]");
    assert.equal(queries[0].headers.cookie, "fixture-session=account-0");
    assert.equal(queries[0].headers.authorization, auth.authorization);
    assert.equal(queries[0].headers["x-goog-authuser"], "2");
    assert.equal(queries[0].headers["x-goog-api-key"], auth["x-goog-api-key"]);
    await f.native(page, { ...auth, "x-aistudio-g1-tier": "TIER2", "x-goog-ext-519733851-bin": "opaque-native-value" });
    const body = JSON.stringify([
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent",
        '{"contents":[]}',
        "waa-proof",
    ]);
    const headers = { ...auth, "content-type": "application/json+protobuf", "x-native-proof": "keep-proof" };
    assert.equal(await f.native(page, headers, "ProxyUnaryCall?authuser=2", body), 200);
    const outbound = f.requests.at(-1);
    assert.equal(outbound.url, RPC + "ProxyUnaryCall?authuser=2");
    assert.equal(outbound.body, body);
    assert.equal(outbound.headers["x-aistudio-g1-tier"], "TIER2");
    assert.equal(outbound.headers["x-goog-ext-519733851-bin"], "opaque-native-value");
    for (const [name, value] of Object.entries(headers)) assert.equal(outbound.headers[name], value);
    await f.native(
        page,
        { ...headers, "x-aistudio-g1-tier": "TIER1", "x-goog-ext-519733851-bin": "current-request-ext" },
        "ProxyUnaryCall",
        body
    );
    assert.equal(f.requests.at(-1).headers["x-aistudio-g1-tier"], "TIER1");
    assert.equal(f.requests.at(-1).headers["x-goog-ext-519733851-bin"], "current-request-ext");
    const otherBody = JSON.stringify([
        "/v1beta/models/gemini-2.5-flash:generateContent",
        JSON.stringify({ contents: [{ text: "/v1beta/models/gemini-4-argon:generateContent" }] }),
        "proof",
    ]);
    await f.native(page, headers, "ProxyUnaryCall", otherBody);
    assert.equal(f.requests.at(-1).headers["x-aistudio-g1-tier"], undefined);
    await f.native(page, headers, "ProxyStreamedCall", body);
    assert.equal(f.requests.at(-1).headers["x-aistudio-g1-tier"], undefined);
    assert.ok(f.requests.every(request => !request.url.startsWith(RPC + "GenerateContent")));
    const retiredId = await benefit._evaluate(() => window.__buildBenefit.documentId);
    await f.reload(page);
    if (benefit.usesMainWorldBridge) {
        await benefit._evaluate(({ owner, id }) => console.debug(`BuildBenefitChange:${owner}:${id}`), {
            id: retiredId,
            owner: benefit.owner,
        });
        await page.waitForTimeout(20);
    } else await page.evaluate(id => window.__buildBenefitChanged(id), retiredId);
    assert.equal(benefit.state, "unknown");
    await f.native(page);
    f.body = "[0]";
    assert.equal(await benefit.ensure(), "ready-free");
    const second = await f.open(1);
    await f.native(second.page);
    f.body = "[2]";
    assert.equal(await second.benefit.ensure(), "ready-paid");
    await f.native(second.page, headers, "ProxyUnaryCall", body);
    assert.equal(f.requests.at(-1).headers["x-aistudio-g1-tier"], "TIER2");
    assert.equal(f.requests.at(-1).headers["x-goog-ext-519733851-bin"], undefined);
    await f.native(page, { ...auth, "x-aistudio-g1-tier": "TIER1", "x-goog-ext-519733851-bin": "account-zero-ext" });
    for (let attempt = 0; attempt < 100 && benefit.state !== "ready-paid"; attempt++) await page.waitForTimeout(10);
    assert.equal(benefit.state, "ready-paid", "native tier notification must wake the owning Node context");
    const beforeConcurrent = f.requests.length;
    await Promise.all([
        f.native(page, headers, "ProxyUnaryCall", body),
        f.native(second.page, headers, "ProxyUnaryCall", body),
    ]);
    const concurrent = f.requests.slice(beforeConcurrent);
    assert.equal(concurrent.length, 2);
    assert.equal(
        concurrent.find(request => request.headers.cookie === "fixture-session=account-0").headers[
            "x-goog-ext-519733851-bin"
        ],
        "account-zero-ext"
    );
    assert.equal(
        concurrent.find(request => request.headers.cookie === "fixture-session=account-1").headers[
            "x-goog-ext-519733851-bin"
        ],
        undefined
    );
    await context.close();
    assert.equal(benefit.disposed, true);
    assert.equal(second.benefit.disposed, undefined);
});

test(
    "benefit parse/auth/HTTP/deadline failures stay failed and permit explicit refresh",
    { timeout: 60000 },
    async t => {
        const f = await fixture(t);
        for (const [body, status] of [
            ["[3]", 200],
            ["{}", 200],
            ["bad json", 200],
            ["[]", 401],
            ["[]", 403],
            ["[]", 429],
        ]) {
            const { benefit, page, context } = await f.open();
            await f.native(page);
            Object.assign(f, { body, status });
            assert.equal(await benefit.ensure(), "failed");
            Object.assign(f, { body: "[1]", status: 200 });
            assert.equal(await benefit.ensure({ refresh: true }), "ready-paid");
            await context.close();
        }
        const { benefit, page, context } = await f.open(0, 50);
        assert.equal(await benefit.ensure(), "failed");
        await f.native(page);
        f.delay = 200;
        assert.equal(await benefit.ensure({ refresh: true }), "failed");
        f.delay = 0;
        benefit.timeoutMs = 1000;
        assert.equal(await benefit.ensure({ refresh: true }), "ready-paid");
        await f.reload(page);
        await f.native(page);
        f.delay = 100;
        const pending = benefit.ensure();
        await f.reload(page);
        await pending;
        assert.equal(benefit.state, "unknown");
        await context.close();
    }
);

test("Argon policy applies before WAA and native SSE intent remains separate", () => {
    const handler = Object.create(RequestHandler.prototype);
    Object.assign(handler, {
        config: { streamingMode: "real" },
        formatConverter: { ensureServerSideToolInvocations() {} },
        logger,
    });
    for (const model of ["gemini-4-argon", "gemini-4-argon-real", "gemini-4-argon-fake"]) {
        const req = {
            body: {},
            headers: {},
            method: "POST",
            path: `/v1beta/models/${model}:streamGenerateContent`,
            query: { alt: "sse", key: "client-key" },
        };
        const request = handler._buildProxyRequest(req, "test");
        assert.equal(request.path, "/v1beta/models/gemini-4-argon:generateContent");
        assert.equal(request.streaming_mode, "fake");
        assert.deepEqual(request.query_params, { key: "client-key" });
        assert.equal(req.query.alt, "sse");
        assert.ok(req.path.includes(":streamGenerateContent"));
    }
    const untrusted = {
        headers: {
            "content-type": "application/json",
            "X-Aistudio-G1-Tier": "TIER2",
            "x-goog-ext-519733851-bin": "client-ext",
        },
        is_generative: true,
        path: "/v1beta/models/gemini-4-argon:generateContent",
        request_id: "client",
    };
    handler._initializeProxyRequestAttempt(untrusted);
    assert.deepEqual(untrusted.headers, { "content-type": "application/json" });
    assert.equal(handler._effectiveStreamMode("gemini-4-argon", "real"), "fake");
    assert.equal(handler._effectiveStreamMode("gemini-4-argon", "early"), "early");
    assert.equal(handler._effectiveStreamMode("gemini-4-other", "real"), "fake");
    assert.equal(getModelDailyQuota("gemini-4-argon"), 0);
    assert.doesNotThrow(() => loadConfig({ ARGON_VERIFIED_ACCOUNTS: "invalid old config" }));
    assert.equal(loadConfig({ ARGON_VERIFIED_ACCOUNTS: "[0,2,2]" }).argonVerifiedAccounts, undefined);
});

test("scheduler uses account tiers without querying benefits or requiring ready-paid", () => {
    const scheduler = Object.create(ModelScheduler.prototype);
    const metadata = {
        authIndex: 0,
        benefitObservation: { rawTier: null, sessionVersion: 2, state: "ready-free" },
        manualTier: "pro",
        sessionVersion: 2,
    };
    const benefit = {
        ensure() {
            throw new Error("unexpected query");
        },
        state: "ready-free",
    };
    Object.assign(scheduler, {
        authSource: { accountLoginService: { state: { accounts: [metadata] } }, isExpired: () => false },
        browserManager: { contexts: new Map([[0, { page: { buildBenefit: benefit } }]]), isContextReady: () => true },
        config: { argonVerifiedAccounts: [1], readyContextOnly: true },
        hiddenModels: new Set(),
        isAccountQuotaExhausted: () => false,
        now: () => 0,
    });
    const account = { healthy: true, index: 0, inflight: 0, key: "auth-0", models: {} };
    for (const state of ["unknown", "failed", "ready-free", "ready-paid"]) {
        benefit.state = state;
        assert.equal(scheduler.isResourceEligible(account, "gemini-4-argon"), true);
        assert.equal(scheduler.canLease(account, "gemini-4-argon"), true);
    }
    metadata.manualTier = "free";
    assert.equal(scheduler.canLease(account, "gemini-4-argon"), false);
    metadata.manualTier = null;
    metadata.benefitObservation = { rawTier: "TIER2", sessionVersion: 1, state: "ready-paid" };
    assert.equal(scheduler.canLease(account, "gemini-4-argon"), false);
    metadata.benefitObservation.sessionVersion = 2;
    assert.equal(scheduler.canLease(account, "gemini-4-argon"), true);
    benefit.isCurrent = () => false;
    assert.equal(scheduler.canLease(account, "gemini-4-argon"), false);
    assert.equal(scheduler.isResourceEligible({ ...account, index: 1 }, "gemini-4-argon"), false);
    assert.equal(scheduler.isResourceEligible({ ...account, index: 1 }, "gemini-2.5-flash"), true);
});

test("unknown Argon accounts fail without starting a context or a preflight", async t => {
    for (const readyContextOnly of [true, false]) {
        const scheduler = new ModelScheduler(
            { ...loadConfig({ CONTEXT_POOL_MIN_READY: "0" }), readyContextOnly, statePath: null },
            { accountNameMap: new Map(), getRotationIndices: () => [0, 1] },
            logger
        );
        t.after(() => scheduler.close());
        scheduler.browserManager = {
            contexts: new Map(),
            isContextReady: () => false,
            requestContexts() {
                throw new Error("unexpected browser launch");
            },
        };
        await assert.rejects(scheduler.acquire("gemini-4-argon"), { code: "MODEL_TIER_DENIED", status: 403 });
        assert.equal(scheduler.pending.length, 0);
    }
});

test(
    "paid tier checks preserve document validity and never force an entitlement query",
    { timeout: 60000 },
    async t => {
        const f = await fixture(t);
        const { page, benefit } = await f.open();
        await f.native(page);
        const before = f.requests.length;
        await benefit.assertReady();
        assert.equal(f.requests.length, before);
        const body = JSON.stringify(["/v1beta/models/gemini-4-argon:generateContent", '{"contents":[]}', "proof"]);
        assert.equal(await f.native(page, auth, "ProxyUnaryCall", body), 200);
        assert.equal(f.requests.at(-1).headers["x-aistudio-g1-tier"], undefined);
        assert.equal(
            f.requests.some(item => item.url.includes("GetAiStudioBenefitTier")),
            false
        );
        benefit.canUse = () => false;
        await assert.rejects(benefit.assertReady(), /Account tier/);
        benefit.canUse = () => true;
        benefit.isCurrent = () => false;
        await assert.rejects(benefit.assertReady(), /disposed/);
    }
);

test("normal page queries and native headers emit observations without extra queries", { timeout: 60000 }, async t => {
    const f = await fixture(t);
    const { page, benefit } = await f.open();
    const observations = [];
    benefit.onObservation = result => observations.push(result);
    f.body = "[0]";
    await f.native(page, auth, "GetAiStudioBenefitTier");
    for (let i = 0; i < 100 && !observations.length; i++) await page.waitForTimeout(10);
    assert.equal(observations.at(-1).state, "ready-free");
    assert.equal(observations.at(-1).rawTier, null);
    await f.native(page, { ...auth, "x-aistudio-g1-tier": "TIER2" });
    for (let i = 0; i < 100 && observations.at(-1).source !== "native"; i++) await page.waitForTimeout(10);
    assert.equal(observations.at(-1).rawTier, "TIER2");
    assert.equal(f.requests.filter(item => item.url.includes("GetAiStudioBenefitTier")).length, 1);
});

test(
    "real queued checks only query benefits and close each overflow context before the next account",
    { timeout: 60000 },
    async t => {
        const f = await fixture(t);
        const ordinary = await f.open(99);
        f.autoAuth = true;
        const AccountLoginService = require("../src/accounts/AccountLoginService");
        const BenefitCheckQueue = require("../src/accounts/BenefitCheckQueue");
        const BrowserManager = require("../src/core/BrowserManager");
        const service = Object.create(AccountLoginService.prototype);
        const accounts = [0, 1].map(authIndex => ({
            accountId: `account-${authIndex}`,
            authIndex,
            dailyRequests: 12,
            manualTier: null,
            sessionState: "valid",
            sessionVersion: 1,
        }));
        Object.assign(service, {
            chain: Promise.resolve(),
            invalidated: new Set(),
            logger,
            queue: { running: new Map() },
            readAuth: async index => ({
                cookies: [
                    {
                        domain: "alkalimakersuite-pa.clients6.google.com",
                        httpOnly: true,
                        name: "fixture-session",
                        path: "/",
                        secure: true,
                        value: `account-${index}`,
                    },
                ],
                origins: [],
            }),
            resolveProxy: () => null,
            save: async () => {},
            state: { accounts, benefitTasks: [], tasks: [] },
            system: {},
        });
        let maxContexts = 0;
        const manager = {
            _contextCapacityIndices: () => new Set([99]),
            _createBrowserContext: async (options, index) => {
                const context = await BrowserManager.prototype._createBrowserContext.call(
                    manager,
                    { ...options, ignoreHTTPSErrors: true },
                    index
                );
                maxContexts = Math.max(maxContexts, f.browser.contexts().length);
                return context;
            },
            _ensureBrowser: async () => {},
            _isContextIdle: () => true,
            _releaseContextCapacity: index => manager.contextCapacityReservations.delete(index),
            browser: f.browser,
            browserGeneration: 1,
            config: { maxContexts: 1 },
            contextCapacityReservations: new Map(),
            contexts: new Map([[99, ordinary]]),
            initializingContexts: new Set(),
            targetUrl: "https://aistudio.google.com/",
        };
        service.system.browserManager = manager;
        const queue = new BenefitCheckQueue(service, { operationMs: 5000 });
        service.benefitQueue = queue;
        t.after(() => queue.close());
        await service.exclusive(() => queue.submit(accounts.map(account => account.accountId)));
        const deadline = Date.now() + 20000;
        while (service.state.benefitTasks.some(task => !task.finishedAt)) {
            if (Date.now() > deadline) throw new Error("real queue timeout");
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok(service.state.benefitTasks.every(task => task.status === "succeeded"));
        const queries = f.requests.filter(request => request.url.includes("GetAiStudioBenefitTier"));
        assert.equal(queries.length, 2);
        assert.deepEqual(
            queries.map(request => request.headers.cookie),
            ["fixture-session=account-0", "fixture-session=account-1"]
        );
        assert.ok(queries.every(request => request.body === "[]"));
        assert.equal(
            f.requests.some(request => /GenerateContent|ProxyUnaryCall|ProxyStreamedCall/.test(request.url)),
            false
        );
        assert.equal(maxContexts, 2);
        assert.equal(f.browser.contexts().length, 1);
        assert.equal(manager.contexts.size, 1);
        assert.ok(
            accounts.every(account => account.dailyRequests === 12 && account.benefitObservation.rawTier === "TIER1")
        );
    }
);
