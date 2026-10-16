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
const response = JSON.stringify([[[[content, 1]], null, [1, 2, 3]]]);

test(
    "Firefox performs the new RPC, preserves old envelopes and cancels fetch/XHR upstream",
    { timeout: 30000 },
    async t => {
        let oldCalls = 0,
            newCalls = 0,
            cancelled = 0;
        let hold = false;
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
                res.setHeader("content-type", "text/html");
                res.end(`<script>
                window.default_MakerSuite = { Cn: async () => 'token', GB: async () => 'hash' };
                setTimeout(() => window.default_MakerSuite.Cn({
                    mb: { F: ${JSON.stringify(base)}, Ml: 0, jK: 'test-key' },
                    getMetadata: () => ({ Authorization: 'fixture-auth' })
                }), 100);
                </script>`);
                return;
            }
            if (req.url.includes("/GenerateContent")) {
                newCalls++;
                assert.equal(req.headers.authorization, "fixture-auth");
                let raw = "";
                req.on("data", data => {
                    raw += data;
                });
                req.on("end", () => {
                    assert.equal(JSON.parse(raw)[4], "token");
                    assert.equal(req.url.includes("__aistudio_bridge_id"), false);
                    if (hold) {
                        res.on("close", () => {
                            cancelled++;
                        });
                        return;
                    }
                    res.setHeader("content-type", "application/json+protobuf");
                    res.end(response);
                });
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
        const context = await browser.newContext();
        const page = await context.newPage();
        const bridge = new MakerSuiteBridge({
            authIndex: 0,
            context,
            logger,
            page,
            readyTimeoutMs: 2000,
            timeoutMs: 5000,
        });
        await bridge.install();
        t.after(() => bridge.dispose());
        await page.goto(base);
        await page.waitForFunction(() => window.__makerSuiteBridge?.hook() === "ready");
        const rpc =
            base.replace("127.0.0.1", "localhost") +
            "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ProxyUnaryCall";
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
        await page.waitForFunction(() => window.__makerSuiteBridge?.hook() === "ready");
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
    }
);
async function waitFor(check) {
    const deadline = Date.now() + 3000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("Fixture condition timed out");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
