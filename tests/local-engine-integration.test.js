const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { LocalEngine } = require("../src/core/backends/LocalEngine");
const binary = path.join(__dirname, "../local-engine/bin/local-engine");
// Real local binary, no Google network or real credentials. No proof success claim.
test(
    "native service readiness, private socket, request rejection and clean stop",
    { skip: !fs.existsSync(binary), timeout: 20000 },
    async t => {
        const engine = new LocalEngine({ binary });
        t.after(() => engine.close());
        await engine.ensure();
        const directory = engine.directory;
        assert.equal(engine.health().ready, true);
        assert.equal(fs.statSync(engine.socket).mode & 0o777, 0o600);
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
        await assert.rejects(
            engine.json(
                "POST",
                "/sessions",
                { model: "fixture", state: { cookies: [], origins: [] } },
                { timeoutMs: 3000 }
            ),
            { kind: "transport", status: 503 }
        );
        await assert.rejects(engine.json("POST", "/sessions/absent/rpc", { rpcMethod: "https://example.com" }), {
            status: 410,
        });
        await engine.close();
        assert.equal(fs.existsSync(directory), false);
    }
);
test(
    "unexpected native exit invalidates sessions and restarts only within the process budget",
    { skip: !fs.existsSync(binary), timeout: 20000 },
    async t => {
        const engine = new LocalEngine({ binary });
        t.after(() => engine.close());
        await engine.ensure();
        for (let n = 0; n < 3; n++) {
            const unavailable = once(engine, "unavailable");
            engine.child.kill("SIGKILL");
            await unavailable;
            if (n < 2) {
                const deadline = Date.now() + 6000;
                while (!engine.ready && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
                assert.equal(engine.ready, true);
            }
        }
        await assert.rejects(engine.ensure(), { status: 503 });
        assert.equal(engine.exhausted, true);
    }
);
test("local stream timeout and client cancellation stop a stalled Unix response", { timeout: 5000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-stream-test-"));
    const socket = path.join(dir, "service.sock");
    const closed = [];
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.flushHeaders();
        req.once("close", () => closed.push(true));
    });
    server.listen(socket);
    await once(server, "listening");
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(dir, { force: true, recursive: true });
    });
    const engine = new LocalEngine();
    engine.socket = socket;
    engine.child = {};
    const controller = new AbortController();
    const iterator = engine.stream("fixture", {}, { signal: controller.signal, timeoutMs: 500 });
    const pending = assert.rejects(iterator.next());
    setTimeout(() => controller.abort(), 30);
    await pending;
    await assert.rejects(engine.stream("fixture", {}, { timeoutMs: 30 }).next());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closed.length, 2);
});
