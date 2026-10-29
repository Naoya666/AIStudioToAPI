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
const { PlaygroundTransport } = require("../src/core/PlaygroundTransport");

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
                return res.end(`<!doctype html><title>Local Playground fixture</title><ms-prompt-box><textarea></textarea></ms-prompt-box><script>
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
                res.setHeader("content-type", "application/json+protobuf");
                const candidate = (text, finish) => [[[[null, text]], "model"], finish];
                res.write("[[" + JSON.stringify([[candidate("TLS first", null)]]));
                const reply = () =>
                    res.end("," + JSON.stringify([[candidate("TLS answer", 1)], null, [1, 2, 3]]) + "]]");
                let timer = null;
                res.on("close", () => {
                    clearTimeout(timer);
                    if (!res.writableEnded) state.cancelled = (state.cancelled || 0) + 1;
                });
                if (state.hold) return;
                timer = setTimeout(reply, state.generateDelay || 200);
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
        const bridge = new PlaygroundTransport({
            authIndex: index,
            benefit,
            context,
            logger,
            page,
            timeoutMs: 75000,
        });
        page.makerSuiteBridge = bridge;
        await bridge.install();
        t.after(() => {
            bridge.dispose();
            benefit.dispose();
        });
        page._fixtureBenefit = benefit;
        await context.addCookies([
            { domain: "aistudio.google.com", name: "SAPISID", path: "/", secure: true, value: "fixture-sapisid" },
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
        bridge.ready = true; // This fixture initializes WAA in its own official-shaped UI.
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

function request(id, budget = 5000) {
    return {
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }], role: "user" }] }),
        method: "POST",
        path: "/v1beta/models/gemini-test:streamGenerateContent",
        remaining_budget_ms: budget,
        request_attempt_id: id + "_attempt_1",
        request_id: id,
    };
}
async function until(check) {
    const deadline = performance.now() + 5000;
    while (!check()) {
        assert.ok(performance.now() < deadline, "fixture condition timed out");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
test(
    "real TLS incrementally delivers before EOF, uses fresh WAA/auth, and cancels the network reader",
    { timeout: 30000 },
    async t => {
        const f = await fixture(t);
        const { page, bridge } = await f.open();
        f.generateDelay = 500;
        const seen = [];
        let settled = false;
        const generation = bridge
            .generate(request("tls"), chunk => seen.push(chunk))
            .then(() => {
                settled = true;
            });
        await until(() => seen.length);
        assert.equal(settled, false);
        assert.equal(seen[0].candidates[0].content.parts[0].text, "TLS first");
        assert.equal(seen[0].candidates[0].finishReason, undefined);
        await generation;
        assert.equal(seen.at(-1).candidates[0].finishReason, "STOP");
        assert.equal(seen.at(-1).usageMetadata.totalTokenCount, 3);
        const outbound = f.requests.at(-1);
        assert.equal(outbound.url, RPC + "GenerateContent");
        assert.equal(JSON.parse(outbound.body)[4], "new-proof");
        assert.equal(outbound.headers["x-goog-api-key"], auth["x-goog-api-key"]);
        assert.match(outbound.headers.authorization, /^SAPISIDHASH /);
        assert.match(outbound.headers.cookie, /fixture-session=account-0/);
        assert.equal(outbound.headers["x-aistudio-g1-tier"], "TIER2");
        assert.equal(outbound.headers["x-goog-ext-519733851-bin"], "fixture-opaque");
        assert.ok(f.requests.every(x => !/ProxyUnary|ProxyStreamed/.test(x.url)));
        f.hold = true;
        await assert.rejects(
            bridge.generate(request("timeout", 400), () => {}),
            { status: 504 }
        );
        await until(() => f.cancelled === 1);
        const received = [];
        const pending = bridge.generate(request("cancel"), chunk => received.push(chunk));
        const cancelled = assert.rejects(pending, { status: 499 });
        await until(() => received.length);
        bridge.cancelAttempt("cancel", "cancel_attempt_1");
        await cancelled;
        await until(() => f.cancelled === 2);
        await bridge.settle();
        assert.equal(bridge.active.size, 0);
        assert.equal(bridge.cleanup.size, 0);
        await f.reload(page);
        await waitPageReady(page);
        f.hold = false;
        bridge.ready = true;
        const reply = await bridge.generate(request("reloaded"));
        assert.equal(reply.candidates[0].content.parts[0].text, "TLS firstTLS answer");
    }
);
test(
    "real TLS incremental generation survives 61 seconds without buffering first content",
    {
        skip: process.env.MODEL_TRANSPORT_LONG_FIXTURE !== "1",
        timeout: 90000,
    },
    async t => {
        const f = await fixture(t);
        const { bridge } = await f.open();
        f.generateDelay = 61000;
        const start = performance.now();
        let first;
        await bridge.generate(request("long", 75000), () => {
            first ??= performance.now() - start;
        });
        const elapsed = performance.now() - start;
        assert.ok(first < 5000);
        assert.ok(elapsed >= 61000 && elapsed < 75000);
        t.diagnostic(`TLS first content=${Math.round(first)}ms; EOF=${Math.round(elapsed)}ms`);
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
