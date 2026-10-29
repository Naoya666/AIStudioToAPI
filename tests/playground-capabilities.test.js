const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { PlaygroundResources, parseMultipart } = require("../src/core/PlaygroundResources");
const { buildBody, buildCountBody, convChunk, merge } = require("../src/core/MakerSuiteCodec");
const RequestHandler = require("../src/core/RequestHandler");
const FormatConverter = require("../src/core/FormatConverter");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const base = { contents: [{ parts: [{ text: "Hello" }], role: "user" }] };

test("Playground encodes built-in tools and schema constraints without dropping unsupported fields", () => {
    const request = {
        ...base,
        generationConfig: {
            responseSchema: {
                $defs: { name: { minLength: 1, type: ["string", "null"] } },
                properties: { name: { $ref: "#/$defs/name" } },
                required: ["name"],
                type: "object",
            },
        },
        tools: [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }],
    };
    const { body } = buildBody("gemini-test", request);
    assert.deepEqual(body[6], [[null, null, null, [null, [[]]]], [null, null, null, null, null, null, null, []], [[]]]);
    assert.equal(body[3][7], "application/json");
    assert.equal(body[3][8][0], 6);
    assert.equal(body[3][8][6][0][1][3], true);
    assert.equal(body[3][8][6][0][1][12], 1);
    assert.throws(
        () =>
            buildBody("m", {
                ...base,
                generationConfig: { responseSchema: { additionalProperties: true, type: "object" } },
            }),
        /additionalProperties/
    );
    assert.equal(
        buildBody("m", { ...base, toolConfig: { functionCallingConfig: { mode: "NONE" } }, tools: request.tools })
            .body[6],
        null
    );
    const count = buildCountBody("m", { systemInstruction: { parts: [{ text: "system only" }] } });
    assert.deepEqual(count[2][1], []);
    assert.ok(count[2][5]);
});

test("execution parts, file references and grounding survive native decode and compatibility output", () => {
    const code = [];
    code[7] = [1, "print(1)"];
    const result = [];
    result[8] = [1, "1"];
    const candidate = [[[code, result], "model"], 1];
    candidate[7] = [
        ["search entry"],
        [[["https://example.test", "Example"]]],
        [[[0, 0, 1, "1"], [0], [1]]],
        null,
        ["query"],
    ];
    const response = merge([convChunk([[candidate]])]);
    assert.equal(response.candidates[0].content.parts[0].executableCode.code, "print(1)");
    assert.equal(response.candidates[0].groundingMetadata.groundingChunks[0].web.uri, "https://example.test");
    const converter = new FormatConverter(logger, {});
    const converted = converter.convertGoogleToOpenAINonStream(response, "m");
    assert.match(converted.choices[0].message.content, /print\(1\)/);
    assert.match(converted.choices[0].message.content, /https:\/\/example.test/);
    const encoded = buildBody("m", {
        contents: [
            {
                parts: [
                    { fileData: { fileUri: "drive://drive-id" } },
                    { fileData: { fileUri: "https://youtube.com/watch?v=test", mimeType: "video/mp4" } },
                ],
            },
        ],
    });
    assert.deepEqual(encoded.body[1][0][0][0][5], ["drive-id"]);
    assert.deepEqual(encoded.body[1][0][0][1][6], ["video/mp4", "https://youtube.com/watch?v=test"]);
});

test("error envelopes retain upstream status, message and details in JSON and SSE", () => {
    const handler = Object.create(RequestHandler.prototype);
    handler.logger = logger;
    handler._markTrackedResponseError = () => {};
    handler._resolveErrorFormat = res => res.format;
    const fields = { code: 429, details: [{ quota: "daily" }], message: "daily quota", status: "RESOURCE_EXHAUSTED" };
    for (const format of ["gemini", "openai", "claude", "response_api"]) {
        let sent;
        const res = {
            format,
            headersSent: false,
            send(s) {
                sent = JSON.parse(s);
            },
            status(n) {
                this.statusCode = n;
                return this;
            },
            type() {
                return this;
            },
        };
        handler._sendErrorResponse(res, 429, fields.message, null, { upstreamError: fields });
        assert.equal(res.statusCode, 429);
        assert.deepEqual(sent.error.details, fields.details);
        if (format === "gemini") assert.equal(sent.error.status, "RESOURCE_EXHAUSTED");
        const events = [];
        const stream = { format, headersSent: true, socket: { writable: true }, write: s => events.push(s) };
        handler._sendErrorChunkToClient(stream, fields.message, 429, null, "error", { upstreamError: fields });
        const event = JSON.parse(events[0].split("data: ")[1].trim());
        assert.deepEqual((event.error || event).details, fields.details);
        if (format === "gemini") assert.equal(event.error.status, "RESOURCE_EXHAUSTED");
    }
});

async function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "playground-resources-test-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const calls = [],
        affinities = new Map();
    const system = {
        authSource: { getRotationIndices: () => [0, 1] },
        browserManager: { contexts: new Map() },
        requestHandler: Object.create(RequestHandler.prototype),
        scheduler: {
            account: i => ({ key: "account-" + i }),
            acquire: async (model, excluded) => {
                const index = [0, 1].find(i => !excluded.has("account-" + i));
                assert.notEqual(index, undefined);
                calls.push({ index, model });
                return { account: { index } };
            },
            failure() {},
            fileAffinities: affinities,
            release() {},
            saveSoon() {},
            startAttempt() {},
        },
    };
    system.requestHandler.logger = logger;
    system.requestHandler._assertModelPermission = () => {};
    system.requestHandler._markTrackedResponseError = () => {};
    for (const index of [0, 1])
        system.browserManager.contexts.set(index, {
            page: {
                playgroundTransport: {
                    generate: async request => {
                        calls.push({ index, request });
                        return { totalTokens: 5 };
                    },
                    ready: true,
                },
            },
        });
    const resources = new PlaygroundResources(system, directory);
    resources.drive = async (_transport, operation) => {
        calls.push(operation);
        return operation.download
            ? { data: Buffer.from("hello").toString("base64"), mimeType: "text/plain" }
            : { status: 200, text: JSON.stringify({ id: "drive-id", mimeType: "text/plain" }) };
    };
    t.after(() => resources.close());
    const app = express();
    app.use(express.raw({ limit: "65mb", type: () => true }));
    app.use((req, _res, next) => {
        req.rawBody = req.body;
        try {
            req.body = JSON.parse(req.rawBody?.toString() || "{}");
        } catch {
            req.body = {};
        }
        next();
    });
    app.use((req, res, next) => resources.handle(req, res, next));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(
        () =>
            new Promise(resolve => {
                server.closeAllConnections();
                server.close(resolve);
            })
    );
    const url = "http://127.0.0.1:" + server.address().port;
    return { calls, directory, resources, system, url };
}

test("Files multipart upload, persistence, affinity, download and deletion", async t => {
    const f = await fixture(t);
    const form = new FormData();
    form.append("file", new Blob(["hello"], { type: "text/plain" }), "hello.txt");
    form.append("purpose", "assistants");
    const uploaded = await fetch(f.url + "/v1/files", { body: form, method: "POST" });
    assert.equal(uploaded.status, 200);
    const file = await uploaded.json();
    assert.equal(file.filename, "hello.txt");
    assert.equal(file.bytes, 5);
    assert.equal(f.system.scheduler.fileAffinities.get("file:" + file.id), "account-0");
    const state = new PlaygroundResources(f.system, f.directory);
    t.after(() => state.close());
    assert.equal(state.files.get(file.id).driveId, "drive-id");
    const resolved = f.resources.resolveFiles(
        { parts: [{ fileData: { fileUri: "https://generativelanguage.googleapis.com/v1beta/files/" + file.id } }] },
        0
    );
    assert.equal(resolved.parts[0].fileData.fileUri, "drive://drive-id");
    assert.throws(() => f.resources.resolveFiles({ fileData: { fileUri: "files/" + file.id } }, 1), { status: 409 });
    assert.equal(await (await fetch(f.url + "/v1/files/" + file.id + "/content")).text(), "hello");
    const list = await (await fetch(f.url + "/v1beta/files")).json();
    assert.equal(list.files[0].name, "files/" + file.id);
    assert.equal((await fetch(f.url + "/v1/files/" + file.id, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(f.url + "/v1/files/" + file.id)).status, 404);
});

test("Gemini resumable uploads enforce offsets, accept query/finalize, and remove temporary files", async t => {
    const f = await fixture(t);
    const start = await fetch(f.url + "/upload/v1beta/files", {
        body: JSON.stringify({ file: { displayName: "hello.txt" } }),
        headers: {
            "content-type": "application/json",
            "x-goog-upload-header-content-length": "5",
            "x-goog-upload-header-content-type": "text/plain",
            "x-goog-upload-protocol": "resumable",
        },
        method: "POST",
    });
    assert.equal(start.status, 200);
    assert.match(start.headers.get("x-goog-upload-url"), /^http:\/\//);
    const url = new URL(start.headers.get("x-goog-upload-url"));
    const send = (command, offset, body) =>
        fetch(url, {
            body,
            headers: { "x-goog-upload-command": command, "x-goog-upload-offset": String(offset) },
            method: "POST",
        });
    assert.equal((await send("upload", 0, "hel")).status, 200);
    assert.equal((await send("upload", 0, "lo")).status, 409);
    assert.equal((await send("query", 0)).headers.get("x-goog-upload-size-received"), "3");
    const result = await send("upload, finalize", 3, "lo");
    assert.equal(result.status, 200);
    assert.equal((await result.json()).file.sizeBytes, "5");
    assert.equal(f.resources.uploads.size, 0);
});

test("local cachedContents CRUD expands prompts once and rejects model mismatch/expiry", async t => {
    const f = await fixture(t);
    const result = await fetch(f.url + "/v1beta/cachedContents", {
        body: JSON.stringify({
            contents: base.contents,
            model: "models/gemini-test",
            systemInstruction: { parts: [{ text: "system" }] },
            tools: [{ googleSearch: {} }],
            ttl: "60s",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });
    assert.equal(result.status, 200);
    const cache = await result.json();
    assert.equal(cache.usageMetadata.totalTokenCount, 5);
    const request = {
        body: JSON.stringify({ ...base, cachedContent: cache.name }),
        path: "/v1beta/models/gemini-test:generateContent",
    };
    f.resources.prepareRequest(request);
    f.resources.prepareRequest(request);
    assert.equal(JSON.parse(request.body).contents.length, 2);
    assert.deepEqual(JSON.parse(request.body).tools, [{ googleSearch: {} }]);
    assert.throws(
        () =>
            f.resources.prepareRequest({
                body: JSON.stringify({ cachedContent: cache.name }),
                path: "/v1beta/models/other:generateContent",
            }),
        /model/
    );
    const patch = await fetch(f.url + "/v1beta/" + cache.name, {
        body: JSON.stringify({ ttl: "120s" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
    });
    assert.equal(patch.status, 200);
    assert.equal((await (await fetch(f.url + "/v1beta/cachedContents")).json()).cachedContents.length, 1);
    assert.equal((await fetch(f.url + "/v1beta/" + cache.name, { method: "DELETE" })).status, 200);
    assert.throws(
        () => f.resources.prepareRequest({ body: JSON.stringify({ cachedContent: cache.name }), path: request.path }),
        { status: 404 }
    );
});

test("multipart parsing preserves arbitrary binary bytes", () => {
    const bytes = Buffer.from([0, 255, 13, 10, 1]);
    const body = Buffer.concat([
        Buffer.from(
            '--x\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'
        ),
        bytes,
        Buffer.from("\r\n--x--\r\n"),
    ]);
    assert.deepEqual(parseMultipart(body, "multipart/form-data; boundary=x")[0].body, bytes);
});

test("uploaded file IDs and base64 documents reach all compatibility input adapters", async () => {
    const converter = new FormatConverter(logger, { config: {} });
    const chat = await converter.translateOpenAIToGoogle({
        messages: [{ content: [{ file: { file_id: "uploaded" }, type: "file" }], role: "user" }],
        model: "gemini-test",
    });
    assert.equal(chat.googleRequest.contents[0].parts[0].fileData.fileUri, "files/uploaded");
    const response = await converter.translateOpenAIResponseToGoogle({
        input: [{ content: [{ file_id: "uploaded", type: "input_file" }], role: "user" }],
        model: "gemini-test",
    });
    assert.equal(response.googleRequest.contents[0].parts[0].fileData.fileUri, "files/uploaded");
    const claude = await converter.translateClaudeToGoogle({
        messages: [
            {
                content: [
                    { source: { data: "aGVsbG8=", media_type: "application/pdf", type: "base64" }, type: "document" },
                ],
                role: "user",
            },
        ],
        model: "gemini-test",
    });
    assert.equal(claude.googleRequest.contents[0].parts[0].inlineData.data, "aGVsbG8=");
});

test("mixed built-in/function tools and referenced response schemas survive the full request adapter", async () => {
    const converter = new FormatConverter(logger, { config: {} });
    const result = await converter.translateOpenAIToGoogle({
        messages: [{ content: "hello", role: "user" }],
        model: "gemini-test-search",
        response_format: {
            json_schema: {
                name: "answer",
                schema: {
                    $defs: { name: { minLength: 1, type: "string" } },
                    properties: { name: { $ref: "#/$defs/name" } },
                    type: "object",
                },
            },
            type: "json_schema",
        },
        tools: [{ function: { name: "weather", parameters: { type: "object" } }, type: "function" }],
    });
    const encoded = buildBody("gemini-test", result.googleRequest);
    assert.equal(encoded.body[13][2], true);
    assert.equal(encoded.body[3][8][6][0][1][12], 1);
});

test("connection loss cannot replay queued upstream output before the client has consumed it", async () => {
    const MessageQueue = require("../src/utils/MessageQueue");
    const { ScheduledRequestHandler } = require("../src/core/ScheduledRequestHandler");
    const queue = new MessageQueue();
    queue.enqueue({ data: "partial", event_type: "chunk", upstreamOutputStarted: true });
    queue.close("connection_lost");
    let error;
    try {
        await queue.dequeue();
    } catch (caught) {
        error = caught;
    }
    assert.equal(error.upstreamOutputStarted, true);
    await assert.rejects(Object.create(ScheduledRequestHandler.prototype)._retryTransportQueue(error, {}), error);
});
