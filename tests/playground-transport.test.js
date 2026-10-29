/* eslint-env browser */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { firefox } = require("playwright");
const { PlaygroundTransport } = require("../src/core/PlaygroundTransport");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const { BuildBenefitContext } = require("../src/core/BuildBenefitContext");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const RPC =
    "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/";
const key = "AIza" + "A".repeat(35);
const reply = JSON.stringify([[[[[[[null, "direct answer"]], "model"], 1]], null, [1, 2, 3]]]);
const request = (id, extra = {}) => ({
    body: JSON.stringify({ contents: [{ parts: [{ text: "Hello" }], role: "user" }] }),
    method: "POST",
    path: "/v1beta/models/gemini-test:generateContent",
    remaining_budget_ms: 2000,
    request_attempt_id: id + "_attempt_1",
    request_id: id,
    transport_policy: { transport: "makersuite" },
    ...extra,
});

async function fixture(t, streaming = false) {
    const browser = await firefox.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
        { domain: ".google.com", name: "SAPISID", path: "/", secure: true, value: "fixture-cookie" },
    ]);
    const traffic = [];
    let hold = false,
        status = 200,
        body = reply;
    await context.route("**/*", async route => {
        const req = route.request();
        traffic.push({ body: req.postData(), url: req.url() });
        if (req.url().startsWith(RPC)) {
            if (req.url().endsWith("GenerateAccessToken")) return route.fulfill({ body: '["fixture-bearer"]' });
            if (req.url().endsWith("CountTokens")) return route.fulfill({ body: "[12]" });
            if (!req.url().endsWith("GenerateContent")) return route.fulfill({ body: "[]" });
            assert.match(req.headers().authorization, /^SAPISIDHASH \d+_[a-f0-9]{40}$/);
            assert.equal(req.headers()["x-goog-api-key"], key);
            const wire = JSON.parse(req.postData());
            assert.equal(
                wire[4],
                "proof:" +
                    wire[1]
                        .flatMap(c => c[0])
                        .map(p => p[1] || "")
                        .join(" ")
            );
            if (hold) return;
            return route.fulfill({ body, contentType: "application/json+protobuf", status });
        }
        if (req.url().startsWith("https://www.googleapis.com/")) {
            assert.equal(req.headers().authorization, "Bearer fixture-bearer");
            if (req.method() === "POST") {
                assert.match(req.headers()["content-type"], /multipart\/related/);
                return route.fulfill({
                    body: JSON.stringify({ id: "drive-fixture", mimeType: "text/plain", name: "hello.txt" }),
                });
            }
            if (req.method() === "DELETE") return route.fulfill({ status: 204 });
            return route.fulfill({ body: "hello", contentType: "text/plain" });
        }
        await route.fulfill({
            body: `<!doctype html><title>AI Studio</title>
            <ms-prompt-box><textarea></textarea></ms-prompt-box>
            <ms-run-button><button onclick="run()">Run</button></ms-run-button><script>
            const tb = {}; // Playground services need not expose getMetadata().
            window.default_MakerSuite = {
                proof: async (a, digest) => a.snapshot({content:digest}),
                hash: text => { const h={update(){},digest(){return text}}; h.update(new TextEncoder().encode(text)); return h.digest(); }
            };
            tb.snapshot = async ({content}) => {
                await new Promise(resolve => setTimeout(resolve, 10));
                if(document.querySelector('textarea').value !== content) throw Error('prompt mismatch');
                return 'proof:'+content;
            };
            async function run() {
                try {
                    const proof = await default_MakerSuite.proof(tb, document.querySelector('textarea').value);
                    await fetch(${JSON.stringify(RPC + "GenerateContent")}, {method:'POST', headers:{authorization:'fixture-auth','x-goog-api-key':${JSON.stringify(key)}},body:JSON.stringify(['bootstrap',null,null,null,proof])});
                } catch (_) {}
            }
            fetch(${JSON.stringify(RPC + "ListModels")}, {method:'POST',headers:{authorization:'fixture-auth','x-goog-api-key':${JSON.stringify(key)}},body:'[]'});
            </script>`,
            contentType: "text/html",
        });
    });
    if (streaming)
        await context.addInitScript(() => {
            const native = window.fetch.bind(window);
            window.fetch = (url, options) => {
                if (String(url).endsWith("/GenerateContent") && JSON.parse(options.body)[0] !== "bootstrap") {
                    return Promise.resolve(
                        new Response(
                            new ReadableStream({
                                cancel() {
                                    window.streamCancelled = true;
                                },
                                start(controller) {
                                    window.streamController = controller;
                                    window.streamControllers ||= {};
                                    window.streamControllers[JSON.parse(options.body)[1][0][0][0][1]] = controller;
                                    const candidate = [[[[null, "first你"]], "model"], null];
                                    const bytes = new TextEncoder().encode("[[" + JSON.stringify([[candidate]]));
                                    // Split a UTF-8 character across read boundaries.
                                    const split = bytes.indexOf(0xe4) + 1;
                                    controller.enqueue(bytes.slice(0, split));
                                    controller.enqueue(bytes.slice(split));
                                },
                            }),
                            { status: 200 }
                        )
                    );
                }
                return native(url, options);
            };
        });
    const page = await context.newPage();
    const benefit = new BuildBenefitContext(page, { authIndex: 0 });
    benefit.dispatcher = true;
    await benefit.install();
    const transport = new PlaygroundTransport({ authIndex: 0, benefit, context, logger, page, timeoutMs: 2000 });
    await transport.install();
    t.after(() => transport.dispose());
    await page.goto("https://aistudio.google.com/prompts/new_chat");
    await transport.bootstrap(3000);
    const registry = new ConnectionRegistry(logger);
    t.after(() => {
        registry.closeAllMessageQueues();
        transport.connection?.removeAllListeners();
    });
    const connection = transport.connect(registry, {});
    return {
        connection,
        page,
        registry,
        set: changes => {
            if (changes.hold !== undefined) hold = changes.hold;
            if (changes.status !== undefined) status = changes.status;
            if (changes.body !== undefined) body = changes.body;
        },
        traffic,
        transport,
    };
}

test("Playground initializes without Build or WebSocket, aborts bootstrap, and returns Gemini JSON through the queue", async t => {
    const f = await fixture(t);
    const r = request("direct");
    const q = f.registry.createMessageQueue(r.request_id, 0, r.request_attempt_id);
    f.connection.dispatch(r);
    assert.equal((await q.dequeue()).event_type, "response_headers");
    const result = JSON.parse((await q.dequeue()).data);
    assert.equal(result.candidates[0].content.parts[0].text, "direct answer");
    assert.equal(result.usageMetadata.totalTokenCount, 3);
    assert.equal((await q.dequeue()).type, "STREAM_END");
    assert.equal(f.traffic.filter(x => x.url.endsWith("GenerateContent")).length, 1);
    assert.ok(f.traffic.every(x => !/ProxyUnary|ProxyStreamed|usercontent|\/apps\//.test(x.url)));
    assert.equal(await f.page.locator("textarea").inputValue(), "");
    const count = await f.transport.generate(
        request("count", { is_generative: false, path: "/v1beta/models/gemini-test:countTokens" })
    );
    assert.equal(count.totalTokens, 12);
});

test("direct transport preserves quota/auth errors, cancels the matching attempt, and has a fixed deadline", async t => {
    const f = await fixture(t);
    f.set({ body: '[8,"quota exhausted",[[null,"observed detail"]]]', status: 200 });
    await assert.rejects(
        f.transport.generate(request("quota")),
        e => e.status === 429 && /quota exhausted/.test(e.message)
    );
    f.set({ body: '[16,"expired"]', status: 401 });
    await assert.rejects(
        f.transport.generate(request("auth")),
        e => e.status === 401 && /MakerSuiteAuth:unverified/.test(e.message)
    );
    f.set({ hold: true, status: 200 });
    const a = f.transport.generate(request("cancel"));
    const cancelled = assert.rejects(a, { status: 499 });
    await f.page.waitForTimeout(30);
    f.transport.cancelAttempt("cancel", "stale_attempt");
    assert.equal(f.transport.active.size, 1);
    f.transport.cancelAttempt("cancel", "cancel_attempt_1");
    await cancelled;
    await assert.rejects(f.transport.generate(request("timeout", { remaining_budget_ms: 40 })), { status: 504 });
    assert.equal(f.transport.active.size, 0);
});

test("navigation retires the connection and pending queues; rebootstrap gets a fresh epoch", async t => {
    const f = await fixture(t);
    const firstEpoch = f.registry.getConnectionEpoch(0);
    const q = f.registry.createMessageQueue("pending", 0, "pending_attempt_1");
    f.set({ hold: true });
    f.connection.dispatch(request("pending"));
    await f.page.waitForTimeout(30);
    await f.page.reload();
    assert.equal(f.connection.readyState, 3);
    await assert.rejects(q.dequeue(), { code: "QUEUE_CLOSED" });
    f.set({ hold: false });
    await f.transport.bootstrap(3000);
    f.transport.connect(f.registry, {});
    assert.ok(f.registry.getConnectionEpoch(0) > firstEpoch);
    const result = await f.transport.generate(request("recovered"));
    assert.equal(result.candidates[0].content.parts[0].text, "direct answer");
    for (const timer of f.registry.reconnectGraceTimers.values()) clearTimeout(timer);
});

test("cancellation while reading document context cannot start a late Google fetch", async t => {
    const f = await fixture(t);
    let release;
    t.mock.method(
        f.transport.benefit,
        "_evaluate",
        () =>
            new Promise(resolve => {
                release = resolve;
            })
    );
    const before = f.traffic.length;
    const running = f.transport.generate(request("before-fetch"));
    const cancelled = assert.rejects(running, { status: 499 });
    await f.page.waitForTimeout(20);
    f.transport.cancelAttempt("before-fetch", "before-fetch_attempt_1");
    await cancelled;
    release("retired-document");
    await f.page.waitForTimeout(30);
    assert.equal(f.traffic.length, before);
    assert.equal(f.transport.active.size, 0);
});

test("embeddings stay unsupported without network, cooldown or cross-account retries", async t => {
    const f = await fixture(t);
    const r = request("unsupported", { path: "/v1beta/models/embedding-test:embedContent" });
    const q = f.registry.createMessageQueue(r.request_id, 0, r.request_attempt_id);
    const before = f.traffic.length;
    f.connection.dispatch(r);
    const error = await q.dequeue();
    assert.equal(error.status, 501);
    assert.equal(error.retryable, false);
    assert.equal(error.cooldown, false);
    const { ModelScheduler, classifyError } = require("../src/core/ModelScheduler");
    assert.equal(classifyError(error), "capability");
    const lease = { recorded: false };
    Object.create(ModelScheduler.prototype).failure(lease, error);
    assert.equal(lease.recorded, false, "local unsupported endpoints must not be recorded as an upstream failure");
    assert.equal(f.traffic.length, before);
});

test("concurrent calls serialize WAA prompt synchronization and keep separate proofs", async t => {
    const f = await fixture(t);
    const results = await Promise.all([
        f.transport.generate(request("proof-hello")),
        f.transport.generate(
            request("proof-world", {
                body: JSON.stringify({ contents: [{ parts: [{ text: "World" }], role: "user" }] }),
            })
        ),
    ]);
    assert.ok(results.every(result => result.candidates[0].content.parts[0].text === "direct answer"));
    assert.equal(await f.page.locator("textarea").inputValue(), "");
    assert.equal(f.transport.active.size, 0);
});

test("browser reader delivers text before upstream EOF and commits completion only after EOF", async t => {
    const f = await fixture(t, true);
    const r = request("incremental", { path: "/v1beta/models/gemini-test:streamGenerateContent" });
    const q = f.registry.createMessageQueue(r.request_id, 0, r.request_attempt_id);
    f.connection.dispatch(r);
    assert.equal((await q.dequeue(1000)).event_type, "response_headers");
    const first = JSON.parse((await q.dequeue(1000)).data.slice(6));
    assert.equal(first.candidates[0].content.parts[0].text, "first你");
    assert.equal(first.candidates[0].finishReason, undefined);
    assert.equal(f.transport.active.size, 1, "upstream must still be running at first content");
    await f.page.evaluate(() =>
        (window.wrappedJSObject || window).eval(`
        const candidate = [[[[null, "second"]], "model"], 1];
        window.streamController.enqueue(new TextEncoder().encode("," + JSON.stringify([[candidate],null,[1,2,3]]) + "]]")); 
        window.streamController.close();`)
    );
    const second = JSON.parse((await q.dequeue()).data.slice(6));
    assert.equal(second.candidates[0].content.parts[0].text, "second");
    const terminal = JSON.parse((await q.dequeue()).data.slice(6));
    assert.equal(terminal.candidates[0].finishReason, "STOP");
    assert.equal(terminal.usageMetadata.totalTokenCount, 3);
    assert.equal((await q.dequeue()).type, "STREAM_END");
});

test("stream cancellation releases the browser reader and cannot deliver late completion", async t => {
    const f = await fixture(t, true);
    const seen = [];
    const generation = f.transport.generate(request("cancelstream"), chunk => seen.push(chunk));
    const cancelled = assert.rejects(generation, { status: 499 });
    while (!seen.length) await f.page.waitForTimeout(10);
    f.transport.cancelAttempt("cancelstream", "cancelstream_attempt_1");
    await cancelled;
    assert.equal(f.transport.active.size, 0);
    assert.ok(seen.every(x => !x.candidates?.some(c => c.finishReason)));
});

test("a late RPC error after delivered content never emits a successful finish or stream close", async t => {
    const f = await fixture(t, true);
    const r = request("late-error", { path: "/v1beta/models/gemini-test:streamGenerateContent" });
    const q = f.registry.createMessageQueue(r.request_id, 0, r.request_attempt_id);
    f.connection.dispatch(r);
    await q.dequeue();
    assert.match((await q.dequeue()).data, /first你/);
    await f.page.evaluate(() =>
        (window.wrappedJSObject || window).eval(`
        window.streamController.enqueue(new TextEncoder().encode(',[8,"late quota"]]]'));
        window.streamController.close();`)
    );
    const error = await q.dequeue();
    assert.equal(error.event_type, "error");
    assert.equal(error.status, 429);
    assert.equal(error.upstreamOutputStarted, true);
    assert.equal(q.messages.length, 0);
    assert.equal(f.transport.active.size, 0);
});

test("a stuck proof retires the document and navigation restores the request lane", async t => {
    const f = await fixture(t);
    await f.page.evaluate(() =>
        (window.wrappedJSObject || window).eval("window.__makerSuiteBridge.tb.snapshot = () => new Promise(() => {})")
    );
    await assert.rejects(f.transport.generate(request("stalled-proof", { remaining_budget_ms: 150 })), { status: 504 });
    assert.equal(f.transport.ready, false);
    await assert.rejects(f.transport.generate(request("after-stall")), { status: 503 });
    assert.equal(f.traffic.filter(x => x.url.endsWith("GenerateContent")).length, 0);
    await f.page.goto("https://aistudio.google.com/prompts/new_chat");
    await f.transport.bootstrap(3000);
    const result = await f.transport.generate(request("after-recovery"));
    assert.equal(result.candidates[0].content.parts[0].text, "direct answer");
});

test("cancelling a queued proof does not cancel the active proof or a sibling fetch", async t => {
    const f = await fixture(t);
    await f.page.evaluate(() =>
        (window.wrappedJSObject || window).eval(`
        window.__makerSuiteBridge.tb.snapshot = async ({content}) => {
            await new Promise(resolve => setTimeout(resolve, 150));
            return 'proof:'+content;
        };
    `)
    );
    const active = f.transport.generate(request("active-proof"));
    const queued = f.transport.generate(request("queued-proof"));
    const rejected = assert.rejects(queued, { status: 499 });
    await f.page.waitForTimeout(40);
    f.transport.cancelAttempt("queued-proof", "queued-proof_attempt_1");
    await rejected;
    assert.equal((await active).candidates[0].content.parts[0].text, "direct answer");
    assert.equal(f.transport.ready, true);
    assert.equal((await f.transport.generate(request("next-proof"))).candidates[0].finishReason, "STOP");
});

test("file operations get a fresh token and use authenticated browser Drive requests", async t => {
    const { PlaygroundResources } = require("../src/core/PlaygroundResources");
    const f = await fixture(t);
    const resources = Object.create(PlaygroundResources.prototype);
    const uploaded = await resources.drive(f.transport, {
        data: Buffer.from("hello").toString("base64"),
        method: "POST",
        mimeType: "text/plain",
        name: "hello.txt",
    });
    assert.equal(JSON.parse(uploaded.text).id, "drive-fixture");
    const downloaded = await resources.drive(f.transport, { download: true, fileId: "drive-fixture", method: "GET" });
    assert.equal(Buffer.from(downloaded.data, "base64").toString(), "hello");
    assert.equal((await resources.drive(f.transport, { fileId: "drive-fixture", method: "DELETE" })).status, 204);
    assert.equal(f.traffic.filter(x => x.url.endsWith("GenerateAccessToken")).length, 3);
    assert.ok(!f.traffic.some(x => /ProxyUnary|ProxyStreamed/.test(x.url)));
});

test("two generations overlap on one page and cancelling one leaves the other stream intact", async t => {
    const f = await fixture(t, true),
        firstChunks = [],
        secondChunks = [];
    const first = f.transport.generate(
        request("parallel-first", {
            body: JSON.stringify({ contents: [{ parts: [{ text: "First" }], role: "user" }] }),
        }),
        chunk => firstChunks.push(chunk)
    );
    const cancelled = assert.rejects(first, { status: 499 });
    const second = f.transport.generate(
        request("parallel-second", {
            body: JSON.stringify({ contents: [{ parts: [{ text: "Second" }], role: "user" }] }),
        }),
        chunk => secondChunks.push(chunk)
    );
    while (!firstChunks.length || !secondChunks.length) await f.page.waitForTimeout(10);
    assert.equal(f.transport.active.size, 2);
    f.transport.cancelAttempt("parallel-first", "parallel-first_attempt_1");
    await cancelled;
    assert.equal(f.transport.active.size, 1);
    await f.page.evaluate(() =>
        (window.wrappedJSObject || window).eval(`
        window.streamControllers.Second.enqueue(new TextEncoder().encode(',' + JSON.stringify([[[[[[null,'second done']], 'model'], 1]], null, [1,2,3]]) + ']]'));
        window.streamControllers.Second.close();
    `)
    );
    await second;
    assert.ok(secondChunks.some(chunk => chunk.candidates?.some(candidate => candidate.finishReason === "STOP")));
    assert.equal(f.transport.active.size, 0);
    assert.equal(f.transport.ready, true);
});

test("HTTP 200 embedded auth errors reject the observed key even after browser run cleanup", async t => {
    const f = await fixture(t);
    f.set({ body: '[16,"expired"]', status: 200 });
    await assert.rejects(f.transport.generate(request("embedded-auth")), { status: 401 });
    const state = await f.page.evaluate(() =>
        (window.wrappedJSObject || window).eval("window.__makerSuiteBridge.auth().state")
    );
    assert.equal(state, "key_missing");
});
