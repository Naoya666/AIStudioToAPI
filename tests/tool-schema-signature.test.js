const test = require("node:test");
const assert = require("node:assert/strict");
const FormatConverter = require("../src/core/FormatConverter");
const { buildBody } = require("../src/core/MakerSuiteCodec");
const { encodeToolSchema } = require("../src/core/ToolSchema");
const { ThoughtSignatureStore } = require("../src/core/ThoughtSignatureStore");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const converter = () => new FormatConverter(logger, {}, () => ({ safetySettingsThreshold: "OFF" }));
const model = "gemini-3-flash-preview";
const reply = parts => ({ candidates: [{ content: { parts, role: "model" }, finishReason: "STOP", index: 0 }] });
const callPart = signature => ({
    functionCall: { args: { a: 0, b: false }, id: "call_1", name: "lookup" },
    ...(signature ? { thoughtSignature: signature } : {}),
});
const wireCalls = request =>
    buildBody(model, request)
        .body[1].flatMap(c => c[0])
        .filter(part => part[10]);
const schema = {
    $defs: { code: { enum: [0, 1], type: "integer" } },
    additionalProperties: false,
    properties: {
        code: { $ref: "#/$defs/code" },
        const: { const: false, type: "boolean" },
        default: { default: { type: "literal-value" }, type: ["string", "integer", "null"] },
        enum: { enum: ["", "x"], type: "string" },
        nullable: { anyOf: [{ type: "null" }, { type: "number" }] },
        tuple: { items: false, prefixItems: [{ type: "string" }], type: "array" },
    },
    required: ["code", "missing"],
    type: "object",
};

test("complex tool schemas retain complete constraints and projected property types across all request adapters", async () => {
    const f = converter();
    const before = structuredClone(schema);
    const requests = [
        (
            await f.translateOpenAIToGoogle({
                messages: [{ content: "hi", role: "user" }],
                model,
                tools: [{ function: { name: "lookup", parameters: schema, strict: true }, type: "function" }],
            })
        ).googleRequest,
        (
            await f.translateOpenAIResponseToGoogle({
                input: "hi",
                model,
                tools: [{ name: "lookup", parameters: schema, strict: true, type: "function" }],
            })
        ).googleRequest,
        (
            await f.translateClaudeToGoogle({
                max_tokens: 20,
                messages: [{ content: "hi", role: "user" }],
                model,
                tools: [{ input_schema: schema, name: "lookup" }],
            })
        ).googleRequest,
        {
            contents: [{ parts: [{ text: "hi" }], role: "user" }],
            tools: [{ function_declarations: [{ name: "lookup", parametersJsonSchema: schema }] }],
        },
    ];
    for (const request of requests) {
        const declaration = buildBody(model, request).body[6][0][1][0];
        assert.deepEqual(JSON.parse(declaration[1].split("Arguments must follow this JSON Schema: ")[1]), schema);
        const properties = Object.fromEntries(declaration[2][6]);
        assert.equal(properties.code[0], 3);
        assert.equal(properties.const[0], 4);
        assert.equal(properties.default[3], true);
        assert.equal(properties.default[17].length, 2);
        assert.equal(properties.nullable[3], true);
        assert.ok(properties.missing[17].length);
        assert.equal(properties.tuple[0], 5);
    }
    assert.deepEqual(schema, before);
});

test("recursive, escaped and external tool references remain bounded and preserve the original contract", () => {
    for (const input of [
        {
            $defs: { node: { properties: { next: { $ref: "#/$defs/node" } }, type: "object" } },
            properties: { node: { $ref: "#/$defs/node" } },
            type: "object",
        },
        { $defs: { "a/b~c": { type: "integer" } }, properties: { value: { $ref: "#/$defs/a~1b~0c" } }, type: "object" },
        { properties: { value: { $ref: "https://example.test/schema" } }, type: "object" },
    ]) {
        const { parameters, description } = encodeToolSchema(input);
        assert.equal(parameters[0], 6);
        assert.ok(description.endsWith(JSON.stringify(input)));
    }
});

test("tool schema projection handles booleans, const values and null-only nodes without affecting response schema rejection", () => {
    for (const value of [
        true,
        false,
        { const: 3 },
        { const: null },
        { const: { type: "literal" } },
        { type: "null" },
        { enum: [] },
    ]) {
        const encoded = encodeToolSchema({ properties: { value }, type: "object" });
        assert.ok(encoded.description.includes(JSON.stringify(value)));
        assert.ok(encoded.parameters[6][0][1][0]);
    }
    assert.throws(() => encodeToolSchema({ type: "invalid" }), /Unsupported schema type/);
    assert.throws(() => encodeToolSchema({ anyOf: [] }), /schema.anyOf/);
    assert.throws(
        () =>
            buildBody(model, { generationConfig: { responseSchema: { additionalProperties: true, type: "object" } } }),
        /additionalProperties/
    );
});

test("Chat restores stripped signatures using canonical arguments and respects explicit client signatures", async () => {
    const f = converter();
    const output = f.convertGoogleToOpenAINonStream(reply([callPart("real-signature")]), model);
    const call = output.choices[0].message.tool_calls[0];
    assert.equal(call.extra_content.google.thought_signature, "real-signature");
    delete call.extra_content;
    call.function.arguments = '{ "b": false, "a": 0 }';
    const translate = async () =>
        (await f.translateOpenAIToGoogle({ messages: [output.choices[0].message], model })).googleRequest;
    assert.equal(wireCalls(await translate())[0][14], "real-signature");
    call.extra_content = { google: { thought_signature: "client-signature" } };
    assert.equal(wireCalls(await translate())[0][14], "client-signature");
    delete call.extra_content;
    call.function.arguments = '{"a":1,"b":false}';
    assert.equal(wireCalls(await translate())[0][14], "skip_thought_signature_validator");
    call.function.name = "other";
    assert.equal(wireCalls(await translate())[0][14], "skip_thought_signature_validator");
});

test("Responses and Anthropic restore signatures and keep their tool call IDs", async () => {
    const f = converter();
    const response = f.convertGoogleToResponseAPINonStream(reply([callPart("responses-sig")]), model);
    const item = response.output.find(item => item.type === "function_call");
    const request = (await f.translateOpenAIResponseToGoogle({ input: [item], model })).googleRequest;
    assert.equal(wireCalls(request)[0][10][2], item.call_id);
    assert.equal(wireCalls(request)[0][14], "responses-sig");
    const claude = f.convertGoogleToClaudeNonStream(reply([callPart("claude-sig")]), model);
    const native = (
        await f.translateClaudeToGoogle({
            max_tokens: 10,
            messages: [{ content: claude.content, role: "assistant" }],
            model,
        })
    ).googleRequest;
    assert.equal(wireCalls(native)[0][10][2], claude.content[0].id);
    assert.equal(wireCalls(native)[0][14], "claude-sig");
});

for (const method of [
    "translateGoogleToOpenAIStream",
    "translateGoogleToResponseAPIStream",
    "translateGoogleToClaudeStream",
]) {
    test(`${method} remembers delayed signatures for the ID returned to the client`, () => {
        const f = converter();
        const state = {};
        const part = callPart();
        delete part.functionCall.id;
        const first = reply([part]);
        delete first.candidates[0].finishReason;
        const serialized = f[method](JSON.stringify(first), model, state);
        const events = serialized
            .split("\n")
            .filter(line => line.startsWith("data: {"))
            .map(line => JSON.parse(line.slice(6)));
        const id = events
            .flatMap(event => [
                event.choices?.[0]?.delta?.tool_calls?.[0]?.id,
                event.item?.call_id,
                event.content_block?.id,
            ])
            .find(Boolean);
        f[method](JSON.stringify(reply([{ text: "", thoughtSignature: "late-signature" }])), model, state);
        const replay = callPart();
        replay.functionCall.id = id;
        assert.ok(replay.functionCall.id);
        const native = { contents: [{ parts: [replay], role: "model" }] };
        f.ensureThoughtSignature(native);
        assert.equal(wireCalls(native)[0][14], "late-signature");
    });
}

test("separate unary signature parts attach to calls without mutating the upstream response", () => {
    const f = converter();
    const input = reply([callPart(), { text: "", thoughtSignature: "tail-signature" }]);
    const before = structuredClone(input);
    const result = f.convertGoogleToOpenAINonStream(input, model);
    assert.equal(result.choices[0].message.tool_calls[0].extra_content.google.thought_signature, "tail-signature");
    assert.deepEqual(input, before);
});

test("signature cache is bounded, excludes placeholders and does not match altered calls", () => {
    const store = new ThoughtSignatureStore(2);
    for (const id of ["one", "two", "three"]) store.remember(id, "f", { a: { b: 2 }, z: 1 }, id);
    assert.equal(store.signatures.size, 2);
    assert.equal(store.restore("one", "f", { a: { b: 2 }, z: 1 }), "skip_thought_signature_validator");
    assert.equal(store.restore("two", "f", '{"a":{"b":2},"z":1}'), "two");
    assert.equal(store.restore("two", "g", { a: { b: 2 }, z: 1 }), "skip_thought_signature_validator");
    store.remember("two", "f", { a: { b: 2 }, z: 1 }, "skip_thought_signature_validator");
    assert.equal(store.restore("two", "f", { a: { b: 2 }, z: 1 }), "two");
    assert.equal(store.restore("two", "f", { a: { b: 2 }, z: 1 }, "explicit"), "explicit");
    assert.equal(store.restore("two", "f", "broken"), "skip_thought_signature_validator");
});

test("parallel calls retain separate signatures and genuine snake-case values beat legacy placeholders", async () => {
    const f = converter();
    const second = callPart("second-signature");
    second.functionCall.id = "call_2";
    const result = f.convertGoogleToOpenAINonStream(reply([callPart("first-signature"), second]), model);
    const message = result.choices[0].message;
    for (const call of message.tool_calls) delete call.extra_content;
    const request = (await f.translateOpenAIToGoogle({ messages: [message], model })).googleRequest;
    assert.deepEqual(
        wireCalls(request).map(part => part[14]),
        ["first-signature", "second-signature"]
    );
    const native = {
        contents: [
            {
                parts: [{ ...callPart("context_engineering_is_the_way_to_go"), thought_signature: "client-signature" }],
                role: "model",
            },
        ],
    };
    f.ensureThoughtSignature(native);
    assert.equal(wireCalls(native)[0][14], "client-signature");
});

test("mixed union tools preserve every branch, array item types and the complete schema", () => {
    const input = {
        properties: {
            choices: {
                anyOf: [
                    { items: { type: "integer" }, type: "array" },
                    { properties: { label: { type: "string" } }, type: "object" },
                    { type: "string" },
                ],
            },
        },
        type: "object",
    };
    const encoded = encodeToolSchema(input);
    const choices = encoded.parameters[6][0][1];
    assert.equal(choices[0], 5);
    assert.equal(choices[5][0], 3);
    assert.deepEqual(
        choices[17].map(branch => branch[0]),
        [5, 6, 1]
    );
    assert.ok(encoded.description.endsWith(JSON.stringify(input)));
});
