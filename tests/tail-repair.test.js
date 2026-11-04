const { test } = require("node:test");
const assert = require("node:assert/strict");
const { repairGoogleTail, TAIL_REPAIR_TEXT } = require("../src/core/TailRepair");
const FormatConverter = require("../src/core/FormatConverter");
const { buildBody } = require("../src/core/MakerSuiteCodec");
const { inject } = require("../src/core/AntiTruncation");
const { Response, setup, success, request } = require("./helpers/tail-repair-fixture");
const model = "gemini-3.8-flash";
const content = (role = "model") => ({ parts: [{ text: "unfinished" }], role });
const logger = { debug() {}, error() {}, info() {}, warn() {} };

test("repair is opt-in, immutable, idempotent and preserves request metadata and tool parts", () => {
    for (const parts of [[{ text: "unfinished" }], [{ functionCall: { args: {}, name: "lookup" } }]]) {
        const body = {
            contents: [{ parts, role: "model" }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
            systemInstruction: { parts: [{ text: "system" }] },
            tools: [{ functionDeclarations: [{ name: "lookup" }] }],
        };
        const before = structuredClone(body);
        for (const enabled of [undefined, false, "false", "true", 1])
            assert.equal(repairGoogleTail(body, enabled).body, body);
        const result = repairGoogleTail(body, true);
        assert.equal(result.repaired, true);
        assert.deepEqual(body, before);
        assert.deepEqual(result.body, {
            ...body,
            contents: [...body.contents, { parts: [{ text: TAIL_REPAIR_TEXT }], role: "user" }],
        });
        assert.ok(TAIL_REPAIR_TEXT.trim());
        assert.equal(repairGoogleTail(result.body, true).body, result.body);
        assert.doesNotThrow(() => buildBody(model, result.body));
    }
    for (const last of [
        content("user"),
        { parts: [{ text: "native default role" }] },
        { parts: [{ functionResponse: { name: "lookup", response: { result: 1 } } }], role: "user" },
    ]) {
        const body = { contents: [last] };
        assert.equal(repairGoogleTail(body, true).body, body);
    }
});

test("invalid inputs remain untouched and encoding errors are preserved", () => {
    for (const body of [
        undefined,
        {},
        { contents: [] },
        { contents: "bad" },
        { contents: [null] },
        { contents: [{ role: "model" }] },
        { contents: [{ parts: [], role: "model" }] },
        { contents: [content("unknown"), content()] },
        { contents: [content("unknown")] },
    ]) {
        assert.equal(repairGoogleTail(body, true).body, body);
        if (body) assert.throws(() => buildBody(model, body));
    }
});

test("conversion precedes repair, including system extraction, empty user filtering and anti injection", async () => {
    const converter = new FormatConverter(logger, { config: {} });
    for (const tail of [
        { content: "instructions", role: "system" },
        { content: "", role: "user" },
    ]) {
        const body = { messages: [{ content: "prefill", role: "assistant" }, tail], model };
        const before = structuredClone(body);
        const translated = await converter.translateOpenAIToGoogle(body);
        const result = repairGoogleTail(translated.googleRequest, true);
        assert.equal(result.repaired, true);
        assert.equal(result.body.contents.at(-2).role, "model");
        assert.deepEqual(body, before);
    }
    const injected = inject({ messages: [{ content: "prefill", role: "assistant" }], model });
    const { googleRequest } = await converter.translateOpenAIToGoogle(injected.body, { privateTransport: true });
    assert.equal(repairGoogleTail(googleRequest, true).body, googleRequest);
});

const protocols = [
    {
        fields: { messages: [{ content: "unfinished", role: "assistant" }] },
        method: "processOpenAIRequest",
        path: "/v1/chat/completions",
    },
    {
        fields: { input: [{ content: "unfinished", role: "assistant" }] },
        method: "processOpenAIResponseRequest",
        path: "/v1/responses",
    },
    {
        fields: { messages: [{ content: "unfinished", role: "assistant" }] },
        method: "processClaudeRequest",
        path: "/v1/messages",
    },
    {
        fields: { contents: [content()] },
        method: "processRequest",
        path: `/proxy/v1beta/models/${model}:generateContent`,
    },
];
for (const protocol of protocols) {
    for (const mode of ["nonstream", "real", "fake", "early"]) {
        test(`${protocol.method} ${mode} sends repaired body and preserves client history and usage`, async t => {
            const fixture = setup(() => success, {
                streamingMode: mode === "nonstream" ? "real" : mode,
                tailRepairEnabled: true,
            });
            t.after(() => fixture.scheduler.close());
            const req = { ...request(model, mode !== "nonstream", protocol.path) };
            req.body =
                protocol.method === "processRequest"
                    ? structuredClone(protocol.fields)
                    : { ...req.body, ...protocol.fields };
            req.rawBody = Buffer.from(JSON.stringify(req.body));
            if (protocol.method === "processRequest" && mode === "real")
                req.path = req.path.replace(":generateContent", ":streamGenerateContent");
            const before = structuredClone(req.body);
            const res = new Response();
            const logs = [];
            fixture.handler.logger = { ...logger, info: message => logs.push(message) };
            await fixture.handler[protocol.method](req, res);
            assert.equal(res.statusCode, 200, res.body);
            assert.match(res.body, /hello/);
            assert.equal(fixture.sent.length, 1, res.body);
            const sent = JSON.parse(fixture.sent[0].request.body);
            assert.doesNotThrow(() => buildBody(model, sent));
            assert.deepEqual(sent.contents.at(-1), { parts: [{ text: TAIL_REPAIR_TEXT }], role: "user" });
            assert.equal(sent.contents.at(-2).role, "model");
            assert.equal(sent.contents.filter(c => c.parts.some(p => p.text === TAIL_REPAIR_TEXT)).length, 1);
            assert.deepEqual(req.body, before);
            assert.equal(logs.filter(message => message.startsWith("[TailRepair]")).length, 1);
            assert.ok(!logs.find(message => message.startsWith("[TailRepair]")).includes("unfinished"));
            if (protocol.method === "processOpenAIRequest" && mode === "nonstream")
                assert.equal(JSON.parse(res.body).usage.total_tokens, 2);
        });
    }
}

for (const stream of [false, true]) {
    test(`retry reuses repaired body after hot disable (stream=${stream})`, async t => {
        const fixture = setup(
            index => {
                if (index === 0) {
                    fixture.handler.config.tailRepairEnabled = false;
                    return [{ event_type: "error", message: "quota", status: 429 }];
                }
                return success;
            },
            { tailRepairEnabled: true }
        );
        t.after(() => fixture.scheduler.close());
        const req = request(model, stream);
        req.body.messages = [{ content: "unfinished", role: "assistant" }];
        const res = new Response();
        await fixture.handler.processOpenAIRequest(req, res);
        assert.match(res.body, /hello/);
        assert.deepEqual(
            fixture.sent.map(entry => entry.index),
            [0, 1]
        );
        assert.equal(fixture.sent[0].request.body, fixture.sent[1].request.body);
        assert.equal(JSON.parse(fixture.sent[1].request.body).contents.at(-1).parts[0].text, TAIL_REPAIR_TEXT);
        await fixture.handler.processOpenAIRequest(req, new Response());
        assert.equal(JSON.parse(fixture.sent.at(-1).request.body).contents.at(-1).role, "model");
    });
}

test("disabled and user-tail generation requests preserve existing output bodies", async t => {
    for (const tailRepairEnabled of [false, true]) {
        const fixture = setup(() => success, { tailRepairEnabled });
        t.after(() => fixture.scheduler.close());
        const req = request(model);
        req.body.messages = [{ content: "original", role: tailRepairEnabled ? "user" : "assistant" }];
        await fixture.handler.processOpenAIRequest(req, new Response());
        const body = JSON.parse(fixture.sent[0].request.body);
        assert.equal(body.contents.length, 1);
        assert.equal(body.contents[0].parts[0].text, "original");
    }
});

test("counting routes and native nongeneration requests do not repair", async t => {
    for (const method of ["processClaudeCountTokens", "processOpenAIResponseInputTokens"]) {
        const fixture = setup(() => [success[0], { data: '{"totalTokens":7}', event_type: "chunk" }, success[2]], {
            tailRepairEnabled: true,
        });
        t.after(() => fixture.scheduler.close());
        const req = request(model);
        req.body.messages = [{ content: "unfinished", role: "assistant" }];
        req.body.input = [{ content: "unfinished", role: "assistant" }];
        const res = new Response();
        await fixture.handler[method](req, res);
        assert.equal(res.statusCode, 200, res.body);
        const body = JSON.parse(fixture.sent[0].request.body);
        assert.equal(body.generateContentRequest.contents.at(-1).role, "model");
        assert.ok(!fixture.sent[0].request.body.includes(TAIL_REPAIR_TEXT));
    }
    const fixture = setup(() => success, { tailRepairEnabled: true });
    t.after(() => fixture.scheduler.close());
    for (const path of [":countTokens", ":batchEmbedContents", ":generateContentInvalid", "/upload"]) {
        const req = {
            ...request(model),
            body: { contents: [content()] },
            path: `/proxy/v1beta/models/${model}${path}`,
        };
        const sent = fixture.handler._buildProxyRequest(req, "native");
        assert.ok(!sent.body.includes(TAIL_REPAIR_TEXT));
    }
    const req = {
        ...request(model),
        body: { contents: [content()] },
        method: "PUT",
        path: `/proxy/v1beta/models/${model}:generateContent`,
    };
    assert.ok(!fixture.handler._buildProxyRequest(req, "native").body.includes(TAIL_REPAIR_TEXT));
});

test("native repair leaves unknown-role and malformed histories for the encoder", t => {
    const fixture = setup(() => success, { tailRepairEnabled: true });
    t.after(() => fixture.scheduler.close());
    for (const contents of [
        [],
        [content("unknown")],
        [{ parts: [], role: "model" }],
        [content("unknown"), content()],
    ]) {
        const req = { ...request(model), body: { contents }, path: `/proxy/v1beta/models/${model}:generateContent` };
        const sent = fixture.handler._buildProxyRequest(req, "invalid");
        assert.deepEqual(JSON.parse(sent.body).contents, contents);
        assert.throws(() => buildBody(model, JSON.parse(sent.body)));
    }
});

test("native tool tails preserve calls and results without inventing tool responses", t => {
    const fixture = setup(() => success, { tailRepairEnabled: true });
    t.after(() => fixture.scheduler.close());
    for (const role of ["user", "model"]) {
        const part =
            role === "user"
                ? { functionResponse: { name: "lookup", response: { result: 1 } } }
                : { functionCall: { args: {}, name: "lookup" } };
        const req = {
            ...request(model),
            body: {
                contents: [{ parts: [part], role }],
                generationConfig: { responseMimeType: "application/json" },
                systemInstruction: { parts: [{ text: "instructions" }] },
                tools: [{ functionDeclarations: [{ name: "lookup", parameters: { type: "OBJECT" } }] }],
            },
            path: `/proxy/v1beta/models/${model}:generateContent`,
        };
        const before = structuredClone(req.body);
        const sent = JSON.parse(fixture.handler._buildProxyRequest(req, "tools").body);
        assert.deepEqual(req.body, before);
        assert.equal(sent.contents.length, role === "model" ? 2 : 1);
        assert.deepEqual(
            sent.contents[0].parts[0][role === "model" ? "functionCall" : "functionResponse"],
            part[role === "model" ? "functionCall" : "functionResponse"]
        );
        assert.deepEqual(sent.generationConfig, before.generationConfig);
        assert.deepEqual(sent.systemInstruction, before.systemInstruction);
        assert.deepEqual(sent.tools, before.tools);
        assert.doesNotThrow(() => buildBody(model, sent));
    }
});

test("strict invalid tool histories remain rejected before dispatch", async t => {
    const fixture = setup(() => success, { pgToolCallingMode: "strict", tailRepairEnabled: true });
    t.after(() => fixture.scheduler.close());
    const req = request(model);
    req.body.tools = [{ function: { name: "lookup", parameters: { type: "object" } }, type: "function" }];
    req.body.messages = [{ content: "unpaired result", role: "tool", tool_call_id: "missing" }];
    const res = new Response();
    await fixture.handler.processOpenAIRequest(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(fixture.sent.length, 0);
});

test("anti-truncation generation adds no tail repair on initial dispatch or retry", async t => {
    const fixture = setup(
        (index, request) => {
            if (index === 0) return [{ event_type: "error", message: "quota", status: 429 }];
            const body = JSON.parse(request.body);
            const name = body.tools
                .flatMap(tool => tool.functionDeclarations || [])
                .find(tool => tool.name.startsWith("agw_emit_")).name;
            return [
                success[0],
                {
                    data: JSON.stringify({
                        candidates: [
                            {
                                content: {
                                    parts: [{ functionCall: { args: { content: "hello" }, name } }],
                                    role: "model",
                                },
                                finishReason: "STOP",
                            },
                        ],
                        usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 1, totalTokenCount: 2 },
                    }),
                    event_type: "chunk",
                },
                success[2],
            ];
        },
        { tailRepairEnabled: true }
    );
    t.after(() => fixture.scheduler.close());
    const req = request(model);
    req.body.anti_truncation = true;
    req.body.messages = [{ content: "unfinished", role: "assistant" }];
    const before = structuredClone(req.body);
    const res = new Response();
    await fixture.handler.processOpenAIRequest(req, res);
    assert.match(res.body, /hello/);
    assert.equal(fixture.sent.length, 2);
    for (const { request } of fixture.sent) {
        assert.equal(JSON.parse(request.body).contents.at(-1).role, "user");
        assert.ok(!request.body.includes(TAIL_REPAIR_TEXT));
    }
    assert.deepEqual(req.body, before);
});
