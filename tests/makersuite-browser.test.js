/* eslint-env browser, node */
// Optional real-browser transport check. All HTTP traffic is loopback; no Google credentials.
// Run: npx playwright install firefox && npm run test:protocol:browser
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { firefox } = require("playwright");
const { MakerSuiteBridge } = require("../src/core/MakerSuiteBridge");
const logger = { debug() {}, info() {}, warn() {} };
const content = [[[null, "browser answer"]], "model"];
const PAGE_KEY = "AIza" + "A".repeat(35);
const TOKEN_KEY = "AIza" + "T".repeat(35);
const SERVICE =
    "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/";
const response = JSON.stringify([[[[content, 1]], null, [1, 2, 3]]]);

test(
    "Firefox performs the new RPC, preserves old envelopes and cancels fetch/XHR upstream",
    { timeout: 30000 },
    async t => {
        let pageVersion = 0;
        let oldCalls = 0,
            newCalls = 0,
            cancelled = 0;
        let hold = false,
            deny = false;
        const blocked = new Map();
        const server = http.createServer((req, res) => {
            if (req.method === "OPTIONS") {
                res.writeHead(204, {
                    "access-control-allow-credentials": "true",
                    "access-control-allow-headers": req.headers["access-control-request-headers"] || "content-type",
                    "access-control-allow-methods": "POST, OPTIONS",
                    "access-control-allow-origin": req.headers.origin,
                });
                res.end();
                return;
            }
            if (req.url === "/") {
                const proofKey = JSON.stringify("proof" + ++pageVersion);
                const hashKey = JSON.stringify("hash" + pageVersion);
                res.setHeader("content-type", "text/html");
                res.end(`<script>
                window.default_MakerSuite = { Cn: class {}, GB: class {}, [${proofKey}]: async a => a.proof?.snapshot({content:'fixture'}) || 'token', [${hashKey}]: text => { const hash = {update(){}, digest:()=> 'hash'}; hash.update(new TextEncoder().encode(text)); return hash.digest(); } };
                setTimeout(() => window.default_MakerSuite[${proofKey}]({
                    getMetadata: () => ({ Authorization: 'fixture-auth', 'X-Goog-AuthUser': '7', 'X-Goog-Api-Key': ${JSON.stringify(TOKEN_KEY)} })
                }).then(async () => {
                    await fetch(${JSON.stringify(SERVICE + "ListModels")}, { method: 'POST', headers: { 'x-goog-api-key': ${JSON.stringify(PAGE_KEY)} } });
                    window.pageReady = true;
                }), 100);
                </script>`);
                return;
            }
            oldCalls++;
            res.writeHead(400);
            res.end("old endpoint must not be called");
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        t.after(() => {
            server.closeAllConnections();
            server.close();
        });
        const browser = await firefox.launch({ headless: true });
        t.after(() => browser.close());
        const createContext = async () => {
            const context = await browser.newContext();
            context.on("requestfailed", request => {
                const route = blocked.get(request);
                if (route) {
                    blocked.delete(request);
                    cancelled++;
                    route.abort().catch(() => {});
                }
            });
            await context.route(SERVICE + "**", async route => {
                const request = route.request();
                if (!request.url().endsWith("/GenerateContent")) return route.fulfill({ body: "{}", status: 200 });
                newCalls++;
                const headers = request.headers();
                assert.equal(headers.authorization, "fixture-auth");
                assert.equal(headers["x-goog-api-key"], PAGE_KEY);
                assert.equal(headers["x-goog-authuser"], "7");
                assert.equal(JSON.parse(request.postData())[4], "token");
                assert.equal(request.url().includes("__aistudio_bridge_id"), false);
                if (hold) {
                    blocked.set(request, route);
                    return;
                }
                return route.fulfill({
                    body: deny ? '[16,"UNAUTHENTICATED"]' : response,
                    contentType: "application/json+protobuf",
                    status: deny ? 401 : 200,
                });
            });
            return context;
        };
        const context = await createContext();
        const page = await context.newPage();
        const bridge = new MakerSuiteBridge({
            authIndex: 0,
            context,
            logger,
            page,
            policy: { test: "makersuite" },
            readyTimeoutMs: 100,
            timeoutMs: 5000,
        });
        await bridge.install();
        t.after(() => bridge.dispose());
        await page.goto(base);
        await page.waitForFunction(() => window.pageReady && window.__makerSuiteBridge?.auth().state === "ready");
        const rpc = SERVICE + "ProxyUnaryCall";
        const body = JSON.stringify([
            "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent",
            JSON.stringify({ contents: [{ parts: [{ text: "hi" }], role: "user" }] }),
        ]);
        const answer = await page.evaluate(
            async ({ rpc, body }) => {
                const r = await fetch(rpc, {
                    body,
                    credentials: "include",
                    headers: { "content-type": "application/json+protobuf" },
                    method: "POST",
                });
                return { status: r.status, value: JSON.parse(await r.text()) };
            },
            { body, rpc }
        );
        assert.equal(answer.status, 200);
        assert.equal(JSON.parse(answer.value[0]).candidates[0].content.parts[0].text, "browser answer");
        assert.equal(newCalls, 1);
        assert.equal(oldCalls, 0);
        // Reload re-runs the installer in a fresh page realm and captures fresh service metadata.
        await page.reload();
        await page.waitForFunction(() => window.pageReady && window.__makerSuiteBridge?.auth().state === "ready");
        const xhrResult = await page.evaluate(
            ({ rpc, body }) =>
                new Promise(resolve => {
                    const xhr = new XMLHttpRequest();
                    xhr.open("POST", rpc);
                    xhr.onload = () => resolve({ body: xhr.responseText, status: xhr.status });
                    xhr.send(body);
                }),
            { body, rpc }
        );
        assert.equal(xhrResult.status, 200);
        assert.equal(oldCalls, 0);
        hold = true;
        // Test actual browser cancellation, not just a mocked AbortSignal.
        for (const transport of ["fetch", "xhr"]) {
            const before = newCalls;
            await page.evaluate(
                ({ rpc, body, transport }) => {
                    if (transport === "fetch") {
                        window.controller = new AbortController();
                        window.original = fetch(rpc, { body, method: "POST", signal: window.controller.signal }).catch(
                            e => e.name
                        );
                    } else {
                        window.xhr = new XMLHttpRequest();
                        window.xhr.open("POST", rpc);
                        window.xhr.send(body);
                    }
                },
                { body, rpc, transport }
            );
            await waitFor(() => newCalls > before);
            await page.evaluate(
                transport => (transport === "fetch" ? window.controller.abort() : window.xhr.abort()),
                transport
            );
            await waitFor(() => cancelled >= (transport === "fetch" ? 1 : 2));
            await waitFor(() => bridge.active.size === 0);
        }
        assert.equal(oldCalls, 0);
        hold = false;
        deny = true;
        const before = newCalls;
        const rejected = await page.evaluate(
            async ({ rpc, body }) => {
                const r = await fetch(rpc, { body, method: "POST" });
                return { body: await r.text(), status: r.status };
            },
            { body, rpc }
        );
        assert.equal(rejected.status, 401);
        assert.match(rejected.body, /MakerSuiteAuth:unverified/);
        assert.equal(newCalls, before + 1, "no implicit generation retry");
        const notReady = await page.evaluate(
            async ({ rpc, body }) => (await fetch(rpc, { body, method: "POST" })).status,
            { body, rpc }
        );
        assert.equal(notReady, 503);
        assert.equal(newCalls, before + 1);
        deny = false;
        // A new context has no process-wide key cache; its first native request must teach it again.
        const freshContext = await createContext();
        const freshPage = await freshContext.newPage();
        const freshBridge = new MakerSuiteBridge({
            authIndex: 1,
            context: freshContext,
            logger,
            page: freshPage,
            policy: { test: "makersuite" },
            readyTimeoutMs: 2000,
        });
        await freshBridge.install();
        t.after(() => freshBridge.dispose());
        await freshPage.goto(base);
        await freshPage.waitForFunction(() => window.pageReady && window.__makerSuiteBridge?.auth().state === "ready");
        const freshStatus = await freshPage.evaluate(
            async ({ rpc, body }) => (await fetch(rpc, { body, method: "POST" })).status,
            { body, rpc }
        );
        assert.equal(freshStatus, 200);
    }
);
async function waitFor(check) {
    const deadline = Date.now() + 3000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("Fixture condition timed out");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
