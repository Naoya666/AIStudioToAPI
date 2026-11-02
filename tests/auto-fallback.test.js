const { test } = require("node:test");
const assert = require("node:assert/strict");
const Tools = require("../src/core/codeAssistant/ToolContract");
const Auto = require("../src/core/codeAssistant/AutoToolFallback");
const Anti = require("../src/core/codeAssistant/AntiTransport");
const PG = require("../src/core/AntiTruncation");
const FormatConverter = require("../src/core/FormatConverter");
const { buildBody } = require("../src/core/MakerSuiteCodec");
const RequestHandler = require("../src/core/RequestHandler");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const base = { messages: [{ content: "answer", role: "user" }], model: "gemini-3.8-flash" };
const tools = [
    {
        function: {
            name: "lookup",
            parameters: { properties: { q: { type: "string" } }, required: ["q"], type: "object" },
        },
        type: "function",
    },
];
const auto = body =>
    Tools.prepareTools({ ...base, ...body }, { allowAssistantContinuation: false, mode: "auto_fallback" });

test("automatic preparation never compiles schemas or rejects client tool definitions, choices or histories", async () => {
    const definitions = [
        {
            tools: [
                {
                    function: { ...tools[0].function, parameters: { type: "not-a-json-schema-type" } },
                    type: "function",
                },
            ],
        },
        { tools: [{ function: { ...tools[0].function, description: "x".repeat(300000) }, type: "function" }] },
        { tools: Array(129).fill(tools[0]) },
        { tools: [null, tools[0], tools[0], { function: { name: 1, parameters: false } }] },
        { tool_choice: { custom: true }, tools: "unsupported-dialect" },
        { functions: [tools[0].function], parallel_tool_calls: "invalid", tools },
        { messages: [{ content: "unpaired", role: "tool" }], tools },
        { messages: [{ content: "continue", role: "assistant", tool_calls: "broken" }], tools },
        { messages: [{ content: null, function_call: { arguments: "bad", name: "old" }, role: "assistant" }], tools },
        {
            messages: [
                { content: null, role: "assistant", tool_calls: [{ id: "duplicate" }, { id: "duplicate" }] },
                { content: "next", role: "user" },
            ],
            tools,
        },
    ];
    const converter = new FormatConverter(logger, { config: {} });
    for (const fields of definitions) {
        const body = { ...base, ...fields };
        const context = auto(fields);
        assert.equal(context.mode, "auto_fallback");
        assert.equal(context.validators.size, 0);
        const text = Auto.textRequest(body, context);
        assert.equal(text.tools, undefined);
        const translated = await converter.translateOpenAIToGoogle(text);
        assert.equal(translated.googleRequest.tools, undefined);
        assert.doesNotThrow(() => buildBody(base.model, translated.googleRequest));
        assert.throws(() => Tools.prepareTools(body, { allowAssistantContinuation: false, mode: "strict" }));
    }
});

test("text context retains legacy, mixed tool metadata, nontext PG content and input immutability", () => {
    const body = {
        ...base,
        functions: [{ name: "old" }],
        messages: [
            { content: null, function_call: { arguments: "unfinished", name: "old" }, role: "assistant" },
            {
                content: [
                    { text: "result", type: "text" },
                    { image_url: { url: "https://example.test/image.png" }, type: "image_url" },
                ],
                name: "old",
                role: "function",
            },
            { content: "tail", role: "system" },
        ],
        tools,
    };
    const copy = structuredClone(body),
        context = auto(body),
        text = Auto.textRequest(body, context);
    assert.deepEqual(body, copy);
    assert.match(text.messages[0].content, /"old"/);
    assert.match(text.messages[1].content, /unfinished/);
    assert.deepEqual(text.messages[2].content[1], body.messages[1].content[1]);
    assert.equal(text.messages.at(-1).content, "tail");
});

test("malformed and unavailable calls degrade to original prose without invoking a contract validator", () => {
    const context = auto({ tools });
    for (const raw of [
        'example "tool_calls": [',
        "```function_calls\nunfinished",
        '{"arguments":',
        '{"tool_calls":[',
        '{"function_call":',
    ]) {
        assert.equal(Tools.parseToolReply(raw, context).content, raw);
    }
    for (const call of [
        null,
        { arguments: {}, name: "unknown" },
        { arguments: "bad", name: "lookup" },
        { arguments: [], name: "lookup" },
    ]) {
        const raw = JSON.stringify({ content: "keep this answer", tool_calls: [call] });
        assert.deepEqual(Tools.parseToolReply(raw, context), { content: "keep this answer", role: "assistant" });
    }
    const invalidSchemaArgs = JSON.stringify({
        content: "text",
        tool_calls: [{ arguments: { q: 123 }, name: "lookup" }],
    });
    assert.equal(Tools.parseToolReply(invalidSchemaArgs, context).tool_calls.length, 1);
    const fencedExample = "```json\n" + invalidSchemaArgs + "\n```";
    assert.equal(Tools.parseToolReply(fencedExample, context).content, fencedExample);
    assert.equal(Tools.parseToolReply(fencedExample, context).tool_calls, undefined);
    assert.equal(Tools.parseToolReply(invalidSchemaArgs, auto({ tool_choice: "none", tools })).content, "text");
    const duplicate = {
        content: "keep",
        tool_calls: [1, 2].map(() => ({ function: { arguments: "{}", name: "lookup" }, id: "same" })),
    };
    assert.equal(Tools.validateReply(duplicate, context).content, "keep");
    assert.equal(Tools.validateReply(duplicate, context).tool_calls, undefined);
});

test("native PG unknown calls retain prose, complete calls preserve arguments, and text envelopes convert without schema checks", () => {
    const context = auto({ tools });
    const response = parts => ({
        candidates: [{ content: { parts }, finishReason: "STOP" }],
        usageMetadata: { totalTokenCount: 17 },
    });
    const bad = Auto.googleResponse(
        response([{ text: "visible" }, { functionCall: { args: {}, name: "unknown" } }]),
        context
    );
    assert.deepEqual(bad.candidates[0].content.parts, [{ text: "visible" }]);
    assert.equal(bad.usageMetadata.totalTokenCount, 17);
    const valid = Auto.googleResponse(
        response([
            { text: JSON.stringify({ content: null, tool_calls: [{ arguments: { q: 123 }, name: "lookup" }] }) },
        ]),
        context
    );
    assert.deepEqual(valid.candidates[0].content.parts[0].functionCall.args, { q: 123 });
    const native = Auto.googleResponse(response([{ functionCall: { args: "unfinished", name: "lookup" } }]), context);
    assert.equal(native.candidates[0].content.parts[0].functionCall, undefined);
    assert.match(native.candidates[0].content.parts[0].text, /unfinished/);
});

test("Build anti recovers text from mixed and broken envelopes without exposing synthetic transport or repairing client actions", () => {
    const state = Anti.prepare(auto({ tools }));
    const full = JSON.stringify({
        content: null,
        tool_calls: [{ arguments: { content: "中文😀  " }, name: state.name }],
    });
    const cut = full.slice(0, full.indexOf("中文") + "中文😀  ".length);
    for (const suffix of ["", "\\", "\\u12", "\\q"]) {
        const restored = Anti.restore(cut + suffix, state);
        assert.equal(restored.message.content, "中文😀  ");
        assert.equal(restored.repaired, true);
        assert.equal(restored.message.tool_calls, undefined);
        assert.doesNotMatch(JSON.stringify(restored), /agw_emit_/);
    }
    assert.equal(
        Anti.restore('Explain "tool_calls": examples', state).message.content,
        'Explain "tool_calls": examples'
    );
    const incompleteCall = '{"content":"preserved","tool_calls":[{"name":"lookup","arguments":{"q":"partial';
    const fallback = Anti.restore(incompleteCall, state).message;
    assert.equal(fallback.tool_calls, undefined);
    assert.equal(fallback.content, "preserved");
    assert.throws(() => Anti.restore(`{"tool_calls":[{"name":"${state.name}","arguments":{`, state), { status: 502 });
    assert.equal(Auto.recoverContent('{"content":"escaped \\u4e2d\\nbody'), "escaped 中\nbody");
    assert.equal(Auto.recoverContent(JSON.stringify({ example: '"content":"not text"' })), "");
});

test("PG anti preserves ordinary text beside undecodable internal arguments and never leaks the internal call", () => {
    const converter = new FormatConverter(logger, { config: {} });
    const response = {
        candidates: [
            {
                content: {
                    parts: [
                        { text: "ordinary answer" },
                        { functionCall: { args: '{"content":"partial\\u12', name: "internal" } },
                    ],
                },
                finishReason: "STOP",
            },
        ],
        usageMetadata: { totalTokenCount: 20 },
    };
    const restored = new PG.Attempt("internal", () => {}, 0, "auto_fallback").nonStream(
        response,
        converter,
        base.model
    );
    assert.equal(restored.choices[0].message.content, "ordinary answerpartial");
    assert.equal(restored.choices[0].message.tool_calls, undefined);
    assert.equal(restored.usage.total_tokens, 20);
    assert.throws(() => new PG.Attempt("internal").nonStream(response, converter, base.model));
});

test("PG attempt replacement preserves fallback mode and updates the internal name used by tool decoding", () => {
    const res = {},
        request = { client_tool_contract: { syntheticName: "original" }, request_id: "test" };
    Object.defineProperty(request, "__antiContext", {
        value: { baseline: "original", log() {}, originalName: "original", res, toolMode: "auto_fallback" },
    });
    RequestHandler.prototype._advanceProxyRequestAttempt.call({ _generateRequestAttemptId: () => "attempt" }, request);
    assert.equal(res.__antiAttempt.mode, "auto_fallback");
    assert.equal(request.client_tool_contract.syntheticName, res.__antiAttempt.name);
    assert.equal(request.body, res.__antiAttempt.name);
});

test("PG auto anti does not report an empty success when an undecodable internal call precedes a separate finish event", () => {
    const attempt = new PG.Attempt("internal", () => {}, 0, "auto_fallback");
    attempt.restore({
        candidates: [{ content: { parts: [{ functionCall: { args: { content: 1 }, name: "internal" } }] } }],
    });
    assert.throws(() => attempt.restore({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }), {
        code: "anti_truncation_decode_failed",
    });
});

test("Build anti retains malformed supplied tool context and tolerates legacy internal envelopes", () => {
    const state = Anti.prepare(auto({ tools: { unexpected: "keep this definition" } }));
    assert.match(state.instructions, /keep this definition/);
    const result = Anti.restore(
        JSON.stringify({
            content: null,
            function_call: { arguments: JSON.stringify({ content: "legacy answer" }), name: state.name },
        }),
        state
    );
    assert.equal(result.message.content, "legacy answer");
    assert.equal(result.message.function_call, undefined);
});
