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
const { MakerSuiteBridge } = require("../src/core/MakerSuiteBridge");
const TransportPolicy = require("../src/core/ModelTransportPolicy");

const ORIGIN = "https://alkalimakersuite-pa.clients6.google.com";
const RPC = "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/";
const auth = {
    authorization: "fixture-authorization",
    "x-goog-api-key": "AIza" + "A".repeat(35),
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
                return res.end(`<!doctype html><title>Local Build fixture</title><script>
                    window.default_MakerSuite = { Cn: async a => a.proof?.snapshot({content:"fixture"}) || "new-proof", GB: text => { const hash = {update(){}, digest:()=> "new-hash:" + text}; hash.update(new TextEncoder().encode(text)); return hash.digest(); } };
                    setTimeout(async () => {
                        await window.default_MakerSuite.Cn({mb:{}, getMetadata: () => ({ authorization:"fixture-authorization", "x-goog-api-key":"AIza" + "T".repeat(35), "x-goog-authuser":"2" })});
                        await fetch(${JSON.stringify(ORIGIN + RPC + "ListModels")}, {method:"POST", headers:${JSON.stringify({ ...auth, "x-aistudio-g1-tier": "TIER2", "x-goog-ext-519733851-bin": "fixture-opaque" })}, body:"[]"});
                        window.pageReady = true;
                    }, 100);
                </script>`);
            }
            let body = "";
            for await (const chunk of req) body += chunk;
            state.requests.push({ body, headers: req.headers, url: req.url });
            if (req.url.startsWith(RPC + "GetAiStudioBenefitTier")) {
                if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
                res.statusCode = state.status;
                res.end(state.body);
            } else if (req.url.startsWith(RPC + "GenerateContent")) {
                const reply = () =>
                    res.end(JSON.stringify([[[[[[[null, "TLS answer"]], "model"], 1]], null, [1, 2, 3]]]));
                let timer;
                res.on("close", () => {
                    clearTimeout(timer);
                    if (!res.writableEnded) state.cancelled = (state.cancelled || 0) + 1;
                });
                if (state.hold) return;
                if (state.generateDelay) timer = setTimeout(reply, state.generateDelay);
                else reply();
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
    state.open = async (index = 0, timeoutMs = 1000) => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();
        const benefit = new BuildBenefitContext(page, { authIndex: index, canUse: () => true, timeoutMs });
        benefit.dispatcher = true;
        await benefit.install();
        const bridge = new MakerSuiteBridge({
            authIndex: index,
            benefit,
            context,
            logger,
            page,
            requireRegistration: true,
        });
        page.makerSuiteBridge = bridge;
        await bridge.install();
        t.after(() => {
            bridge.dispose();
            benefit.dispose();
        });
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
        await page.goto("https://aistudio.google.com/", { waitUntil: "domcontentloaded" });
        await waitPageReady(page);
        await benefit.ensure();
        await benefit.assertReady();
        return { benefit, bridge, context, page };
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

function prepare(bridge, model = "gemini-4-argon", budget = 300000) {
    const attempt = "req_fixture_attempt_" + require("node:crypto").randomUUID();
    const proxy = {
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }], role: "user" }] }),
        request_attempt_id: attempt,
        transport_policy: TransportPolicy.resolve(model, "real"),
    };
    const wire = bridge.prepare(proxy, performance.now() + budget);
    return JSON.stringify([
        // Studio removes arbitrary query parameters; preserve the actual wire form.
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        wire.body,
        "old-proof",
        "POST",
    ]);
}
async function generation(page, body) {
    return page._fixtureBenefit._evaluate(
        async ({ url, body }) => {
            const response = await fetch(url, {
                body,
                headers: { "content-type": "application/json+protobuf" },
                method: "POST",
            });
            return { body: await response.text(), status: response.status };
        },
        { body, url: ORIGIN + RPC + "ProxyUnaryCall" }
    );
}
async function until(check) {
    const deadline = performance.now() + 5000;
    while (!check()) {
        assert.ok(performance.now() < deadline, "fixture condition timed out");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
test(
    "TLS dispatch preserves 3.7 wire, uses fresh proof and benefits, and cancels real upstream",
    { timeout: 30000 },
    async t => {
        const f = await fixture(t);
        const { page, bridge } = await f.open();
        const original = JSON.stringify([
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:streamGenerateContent?alt=sse",
            '{"contents":[]}',
            "original-waa",
        ]);
        await f.native(
            page,
            { ...auth, "content-type": "application/json+protobuf" },
            "ProxyStreamedCall?authuser=2",
            original
        );
        assert.equal(f.requests.at(-1).url, RPC + "ProxyStreamedCall?authuser=2");
        assert.equal(f.requests.at(-1).body, original);
        assert.equal(f.requests.at(-1).headers.authorization, auth.authorization);
        const encodedRpc = "ProxyStreamedCall?note=a%20b&slash=%2f&symbol=~";
        await f.native(page, auth, encodedRpc, original);
        assert.equal(f.requests.at(-1).url, RPC + encodedRpc);
        const result = await generation(page, prepare(bridge));
        assert.equal(result.status, 200);
        assert.equal(JSON.parse(JSON.parse(result.body)[0]).candidates[0].content.parts[0].text, "TLS answer");
        const outbound = f.requests.at(-1);
        assert.equal(outbound.url, RPC + "GenerateContent");
        assert.equal(JSON.parse(outbound.body)[4], "new-proof");
        assert.equal(outbound.headers["x-goog-api-key"], auth["x-goog-api-key"]);
        assert.equal(outbound.headers.cookie, "fixture-session=account-0");
        assert.equal(outbound.headers["x-aistudio-g1-tier"], "TIER2");
        assert.equal(outbound.headers["x-goog-ext-519733851-bin"], "fixture-opaque");
        assert.equal(outbound.body.includes("__aistudio_"), false);
        f.hold = true;
        const pending = generation(page, prepare(bridge, "gemini-4-argon", 400));
        const timed = await pending;
        assert.equal(timed.status, 504);
        await until(() => f.cancelled === 1);
        assert.equal(bridge.active.size, 0);
        assert.equal(bridge.attempts.size, 0);
        const beforeCancel = f.requests.filter(request => request.url === RPC + "GenerateContent").length;
        const body = prepare(bridge);
        const running = generation(page, body).catch(() => null);
        await until(
            () => f.requests.filter(request => request.url === RPC + "GenerateContent").length === beforeCancel + 1
        );
        bridge.cancelAttempt("req_fixture", JSON.parse(JSON.parse(body)[1]).__aistudio_attempt);
        await running;
        await until(() => f.cancelled === 2);
        await bridge.settle();
        assert.equal(bridge.cleanup.size, 0);
        await f.reload(page);
        await waitPageReady(page);
        f.hold = false;
        assert.equal((await generation(page, prepare(bridge))).status, 200);
    }
);
test(
    "real TLS buffered generation survives 61 seconds",
    { skip: process.env.MODEL_TRANSPORT_LONG_FIXTURE !== "1", timeout: 90000 },
    async t => {
        const f = await fixture(t);
        const { page, bridge } = await f.open();
        f.generateDelay = 61000;
        const start = performance.now();
        const result = await generation(page, prepare(bridge, "gemini-4-argon", 75000));
        const elapsed = performance.now() - start;
        assert.equal(result.status, 200);
        assert.match(result.body, /TLS answer/);
        assert.ok(elapsed >= 61000 && elapsed < 75000);
        t.diagnostic(`actual TLS GenerateContent elapsed=${Math.round(elapsed)}ms`);
        assert.equal(bridge.active.size, 0);
    }
);

async function waitPageReady(page) {
    if (!process.env.BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH) return page.waitForFunction(() => window.pageReady);
    // Camoufox's page state lives in wrappedJSObject, matching production evaluation.
    const deadline = performance.now() + 5000;
    while (!(await page._fixtureBenefit._evaluate(() => Boolean(window.pageReady)))) {
        assert.ok(performance.now() < deadline, "Camoufox main-world pageReady deadline");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
