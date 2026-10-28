const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildBody, decStruct, encStruct, errorEnvelope, merge, wrapResponse } = require("../src/core/MakerSuiteCodec");
const FormatConverter = require("../src/core/FormatConverter");
const AntiTruncation = require("../src/core/AntiTruncation");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const request = () => ({ contents: [{ parts: [{ text: "hello" }], role: "user" }] });
// Independent positional fixtures, deliberately not produced by the encoder.
const first = [[[[[[null, "thinking"]], "model"]]], null, [4]];
const answerContent = [[[null, "hello"]], "model"];
const answer = [[[answerContent, 1]], null, [4, 2, 6]];

test("exact request positions, system content, safety and zero config", () => {
    const input = {
        ...request(),
        generationConfig: {
            temperature: 0,
            thinkingConfig: { includeThoughts: false, thinkingBudget: 0 },
            topK: 0,
            topP: 0,
        },
        systemInstruction: { parts: [{ text: "system" }] },
    };
    const { body, ht } = buildBody("gemini-2.5-flash", input);
    assert.equal(body[0], "models/gemini-2.5-flash");
    assert.deepEqual(body[1], [[[[null, "hello"]], "user"]]);
    assert.deepEqual(body[2], [
        [null, null, 7, 5],
        [null, null, 8, 5],
        [null, null, 9, 5],
        [null, null, 10, 5],
    ]);
    assert.deepEqual(body[3], [
        null,
        null,
        null,
        65536,
        0,
        0,
        0,
        null,
        null,
        null,
        null,
        null,
        null,
        1,
        null,
        null,
        [0, 0],
    ]);
    assert.equal(body[4], null);
    assert.deepEqual(body[5], [[[null, "system"]], "user"]);
    assert.equal(ht, "hello");
    assert.equal(body[6], null);
    assert.equal(body[10], 1);
    assert.deepEqual(body[13], [[null, null, "UTC"]]);
    assert.equal(buildBody("m", request()).body[3][16], undefined, "do not force HIGH/includeThoughts");
});

test("Struct uses protobuf values for false, zero, null, empty lists and nested objects", () => {
    const expected = [
        [
            ["n", [null, 0]],
            ["b", [null, null, null, false]],
            ["nil", [0]],
            ["arr", [null, null, null, null, null, [[]]]],
            ["obj", [null, null, null, null, [[]]]],
        ],
    ];
    assert.deepEqual(
        encStruct(
            Object.fromEntries([
                ["n", 0],
                ["b", false],
                ["nil", null],
                ["arr", []],
                ["obj", {}],
            ])
        ),
        expected
    );
    assert.deepEqual(decStruct(expected), { arr: [], b: false, n: 0, nil: null, obj: {} });
    assert.deepEqual(decStruct([[["nested", [null, null, null, null, [[["text", [null, null, "x"]]]]]]]]), {
        nested: { text: "x" },
    });
    assert.deepEqual(decStruct([[["__proto__", [null, null, "safe"]]]]), JSON.parse('{"__proto__":"safe"}'));
});

test("Part supports inline media, signed function calls and tool responses", () => {
    const g = {
        contents: [
            {
                parts: [
                    { inlineData: { data: "aGVsbG8=", mimeType: "image/png" } },
                    { functionCall: { args: { ok: false }, id: "call-1", name: "f" }, thoughtSignature: "sig" },
                ],
                role: "model",
            },
            { parts: [{ functionResponse: { id: "call-1", name: "f", response: { value: 0 } } }], role: "user" },
        ],
    };
    const { body, ht } = buildBody("m", g);
    assert.deepEqual(body[1][0][0][0], [null, null, ["image/png", "aGVsbG8="]]);
    assert.deepEqual(body[1][0][0][1][10], ["f", [[["ok", [null, null, null, false]]]], "call-1"]);
    assert.equal(body[1][0][0][1][14], "sig");
    assert.deepEqual(body[1][1][0][0][11], ["f", [[["value", [null, 0]]]], "call-1"]);
    assert.equal(ht, "aGVsbG8=  ");
});

test("unsupported features are visible errors, safety enums never silently fall back", () => {
    for (const extra of [
        { tools: [{ googleSearch: {} }] },
        { generationConfig: { responseSchema: { type: "object" } } },
        { generationConfig: { thinkingConfig: { thinkingLevel: "MEDIUM" } } },
        { toolConfig: { functionCallingConfig: { mode: "NONE" } } },
        { toolConfig: { functionCallingConfig: { mode: "UNKNOWN" } } },
        { safetySettings: [{ category: "UNKNOWN", threshold: "OFF" }] },
        { contents: [{ parts: [{ fileData: { fileUri: "file" } }] }] },
    ])
        assert.throws(
            () => buildBody("m", { ...request(), ...extra }),
            e => e.status === 400
        );
    assert.throws(
        () =>
            buildBody("m", {
                ...request(),
                tools: [{ functionDeclarations: [{ name: "f", parameters: { anyOf: [], type: "object" } }] }],
            }),
        /schema.anyOf/
    );
});

test("native forced/named choices use AUTO wire while preserving declarations and source constraints", () => {
    const input = {
        ...request(),
        tools: [{ functionDeclarations: [{ name: "weather" }, { name: "time" }] }],
    };
    const expected = buildBody("gemini-3.8-flash", input);
    for (const key of ["toolConfig", "tool_config"]) {
        for (const functionCallingConfig of [
            { mode: "ANY" },
            { allowedFunctionNames: ["weather"], mode: "ANY" },
            { allowedFunctionNames: ["weather"], mode: "AUTO" },
        ]) {
            const source = { ...input, [key]: { functionCallingConfig } };
            const before = structuredClone(source);
            assert.deepEqual(buildBody("gemini-3.8-flash", source), expected);
            assert.deepEqual(source, before, "bridge downgrade must not mutate retries or other transports");
        }
    }
    assert.deepEqual(
        expected.body[6][0][1].map(d => d[0]),
        ["weather", "time"]
    );
});

test("Chat, Responses and Anthropic forced/named requests remain encodable through their real converters", async () => {
    const converter = new FormatConverter(logger, {}, () => ({ forceThinking: false, safetySettingsThreshold: "OFF" }));
    const declarations = ["weather", "time"].map(name => ({ name, parameters: { type: "object" } }));
    const base = { max_tokens: 512, model: "gemini-3.8-flash" };
    const messages = [{ content: "hello", role: "user" }];
    for (const choice of ["required", { function: { name: "weather" }, type: "function" }]) {
        const { googleRequest } = await converter.translateOpenAIToGoogle({
            ...base,
            messages,
            tool_choice: choice,
            tools: declarations.map(f => ({ function: f, type: "function" })),
        });
        assert.equal(googleRequest.toolConfig.functionCallingConfig.mode, "ANY");
        assert.deepEqual(
            buildBody(base.model, googleRequest).body[6][0][1].map(d => d[0]),
            ["weather", "time"]
        );
        assert.equal(googleRequest.toolConfig.functionCallingConfig.mode, "ANY");
    }
    for (const choice of ["required", { name: "weather", type: "function" }]) {
        const { googleRequest } = await converter.translateOpenAIResponseToGoogle({
            ...base,
            input: "hello",
            tool_choice: choice,
            tools: declarations.map(f => ({ ...f, type: "function" })),
        });
        assert.equal(googleRequest.toolConfig.functionCallingConfig.mode, "ANY");
        assert.deepEqual(
            buildBody(base.model, googleRequest).body[6][0][1].map(d => d[0]),
            ["weather", "time"]
        );
    }
    for (const choice of [{ type: "any" }, { name: "weather", type: "tool" }]) {
        const { googleRequest } = await converter.translateClaudeToGoogle({
            ...base,
            messages,
            tool_choice: choice,
            tools: declarations.map(f => ({ input_schema: f.parameters, name: f.name })),
        });
        assert.equal(googleRequest.toolConfig.functionCallingConfig.mode, "ANY");
        assert.deepEqual(
            buildBody(base.model, googleRequest).body[6][0][1].map(d => d[0]),
            ["weather", "time"]
        );
    }
});

test("unary and streamed envelopes decode independent fixtures and preserve usage unknowns", () => {
    const result = wrapResponse(JSON.stringify([answer]), false);
    const decoded = JSON.parse(JSON.parse(result)[0]);
    assert.deepEqual(decoded, {
        candidates: [{ content: { parts: [{ text: "hello" }], role: "model" }, finishReason: "STOP", index: 0 }],
        usageMetadata: { candidatesTokenCount: 2, promptTokenCount: 4, totalTokenCount: 6 },
    });
    assert.deepEqual(JSON.parse(JSON.parse(wrapResponse(JSON.stringify([[answer]]), false))[0]), decoded);
    assert.equal(decoded.usageMetadata.thoughtsTokenCount, undefined);
    const tail = ["transport-tail"];
    const stream = JSON.parse(wrapResponse(JSON.stringify([answer, tail]), true));
    assert.deepEqual(JSON.parse(stream[0][0][0]), decoded);
    assert.deepEqual(stream[0][1], tail);
});

test("thinking, signature, functions, multiple candidates and usage-only chunks", () => {
    // Two model candidates, function call followed by usage-only record.
    const toolPart = Array(15).fill(null);
    toolPart[10] = ["f", [[["x", [null, 0]]]], "id"];
    toolPart[14] = "signature";
    const chunk = [
        [
            [[[toolPart], "model"], 1],
            [[[[null, "second"]], "model"], 2],
        ],
    ];
    const usage = [null, null, [7, 3, 10, null, null, null, null, null, null, 0]];
    const out = JSON.parse(JSON.parse(wrapResponse(JSON.stringify([[chunk, usage]]), false))[0]);
    assert.equal(out.candidates.length, 2);
    assert.equal(out.candidates[1].finishReason, "MAX_TOKENS");
    assert.deepEqual(out.candidates[0].content.parts[0], {
        functionCall: { args: { x: 0 }, id: "id", name: "f" },
        thoughtSignature: "signature",
    });
    assert.equal(out.usageMetadata.thoughtsTokenCount, 0);
    const thoughtPart = Array(15).fill(null);
    thoughtPart[1] = "reason";
    thoughtPart[12] = true;
    thoughtPart[14] = "sig";
    const reasoning = [[[[[thoughtPart], "model"]]]];
    const result = JSON.parse(JSON.parse(wrapResponse(JSON.stringify([reasoning, answer]), false))[0]);
    assert.deepEqual(result.candidates[0].content.parts[0], { text: "reason", thought: true, thoughtSignature: "sig" });
});

test("unconfirmed responses and malformed envelopes cannot become empty STOP successes", () => {
    const unfinished = [[[[[[null, "partial"]], "model"]]]];
    for (const input of [[], [unfinished], [null], [[13, "error"]], [first]]) {
        assert.throws(
            () => wrapResponse(JSON.stringify(input), false),
            e => e.status === 502
        );
    }
    assert.throws(() => wrapResponse("invalid JSON", false), /JSON/);
    assert.throws(() => merge([{ candidates: [] }]), /confirmed finish/);
    assert.deepEqual(errorEnvelope('[8,"retry in 30s",[{"retryDelay":"30s"}]]', 200), {
        body: '[8,"retry in 30s",[{"retryDelay":"30s"}]]',
        status: 429,
    });
    assert.equal(errorEnvelope("not json", 403).status, 403);
    assert.equal(errorEnvelope('{"error":{"message":"denied"}}', 403).body, '[7,"denied",[]]');
});

test("OpenAI anti-truncation AUTO declaration remains encodable through the real converter", async () => {
    const converter = new FormatConverter(logger, {}, () => ({ forceThinking: false, safetySettingsThreshold: "OFF" }));
    const injected = AntiTruncation.inject({
        messages: [{ content: "hello", role: "user" }],
        model: "gemini-2.5-flash",
    });
    const translated = await converter.translateOpenAIToGoogle(injected.body);
    const { body } = buildBody("gemini-2.5-flash", translated.googleRequest);
    assert.equal(body[6][0][1][0][0], injected.name);
    assert.deepEqual(body[6][0][1][0][2][6], [["content", [1]]]);
});

test("an error Status after a completed candidate cannot be converted to a success", () => {
    for (const streamed of [true, false]) {
        assert.throws(
            () => wrapResponse(JSON.stringify([answer, [8, "retry in 10s", [{ retryDelay: "10s" }]]]), streamed),
            error => error.status === 429 && error.rpcStatus[2][0].retryDelay === "10s"
        );
    }
});

test("a separate empty-text signature attaches to its function call for continuation", () => {
    const result = merge([
        { candidates: [{ content: { parts: [{ functionCall: { args: {}, name: "f" } }] }, index: 0 }] },
        {
            candidates: [
                { content: { parts: [{ text: "", thoughtSignature: "sig" }] }, finishReason: "STOP", index: 0 },
            ],
        },
    ]);
    assert.deepEqual(result.candidates[0].content.parts, [
        { functionCall: { args: {}, name: "f" }, thoughtSignature: "sig" },
    ]);
});

test("replayed functions receive the new marker without overwriting genuine signatures", () => {
    const parts = [
        { functionCall: { name: "a" } },
        { functionCall: { name: "b" }, thoughtSignature: "context_engineering_is_the_way_to_go" },
        { functionCall: { name: "c" }, thought_signature: "genuine-signature" },
        { functionResponse: { name: "a", response: {} } },
    ];
    const { body } = buildBody("m", { contents: [{ parts, role: "model" }] });
    assert.equal(body[1][0][0][0][14], "skip_thought_signature_validator");
    assert.equal(body[1][0][0][1][14], "skip_thought_signature_validator");
    assert.equal(body[1][0][0][2][14], "genuine-signature");
    assert.equal(body[1][0][0][3][14], undefined);
    assert.equal(parts[0].thoughtSignature, undefined, "do not mutate source parts");
});

test("token hash input preserves empty parts and leading, trailing and adjacent spaces", () => {
    const { ht } = buildBody("m", {
        contents: [
            {
                parts: [
                    { text: "" },
                    { text: "A" },
                    { functionCall: { name: "a" } },
                    { functionResponse: { name: "a", response: {} } },
                    { text: "B" },
                    { inlineData: { data: "base64", mimeType: "image/png" } },
                    { text: "" },
                ],
                role: "user",
            },
        ],
    });
    assert.equal(ht, " A   B base64 ");
});

test("observed daily quota envelopes retain RPC message and opaque details", () => {
    const fixtures = require("./fixtures/makersuite/daily-quota.json");
    for (const { wire, rpc } of fixtures) {
        for (const text of [wire, JSON.stringify([null, rpc]), JSON.stringify(rpc)]) {
            const result = errorEnvelope(text, 429);
            assert.equal(result.status, 429);
            assert.deepEqual(JSON.parse(result.body), rpc);
            const assertRpc = error => {
                assert.deepEqual(error.rpcStatus, rpc);
                return true;
            };
            for (const stream of [false, true])
                assert.throws(
                    () => wrapResponse(text, stream),
                    e => e.status === 429 && assertRpc(e)
                );
        }
    }
});

test("wire parser preserves quoted strings and rejects executable or unknown error structures", () => {
    const message = 'synthetic parser fixture [,,] \\"quoted\\"\nnot a real temporary 429';
    const rpc = [8, message, [["opaque", [null, null, "[,]", { text: "} [,]" }]]]];
    assert.deepEqual(JSON.parse(errorEnvelope(`[,${JSON.stringify(rpc)}]`, 200).body), rpc);
    assert.deepEqual(JSON.parse(errorEnvelope('[,[8,"message",[[, ,1]]]]', 429).body), [
        8,
        "message",
        [[null, null, 1]],
    ]);
    for (const text of [
        '(()=>{throw Error("must not execute")})()',
        '[, [8,"bad",[]]]; process.exit(1)',
        '{"error":{,"message":"bad"}}',
        '{"arbitrary":[8,"unrelated",[]]}',
        '[null,null,[8,"unrelated",[]]]',
        '[null,[0,"OK",[]]]',
        '[null,[8,"bad",{}]]',
        "<html>unavailable</html>",
    ]) {
        const result = errorEnvelope(text, 429);
        assert.equal(result.status, 429);
        assert.deepEqual(JSON.parse(result.body), [8, "MakerSuite upstream request failed (HTTP 429)", []]);
    }
    assert.equal(errorEnvelope("unavailable", 503).status, 503);
    assert.deepEqual(JSON.parse(errorEnvelope('{"error":{"message":"denied","details":[{"reason":"x"}]}}', 403).body), [
        7,
        "denied",
        [{ reason: "x" }],
    ]);
});

test("protocol-derived prompt feedback fixtures precede completion checks and preserve metadata", () => {
    // Constructed from Google's public Studio reader, not a captured moderation response.
    for (const [reason, name] of [
        [1, "SAFETY"],
        [2, "OTHER"],
        [3, "BLOCKLIST"],
        [4, "PROHIBITED_CONTENT"],
        [5, "IMAGE_SAFETY"],
        [99, "99"],
    ]) {
        for (const candidates of [null, [], [[answerContent]], [[answerContent, 1]], [[null]]]) {
            const blocked = [candidates, [reason, [[null, null, 9, 4]], "reason from upstream"]];
            const usage = [null, null, [12, 0, 12], null, null, null, null, "real-response-id"];
            for (const stream of [false, true]) {
                for (const root of [[blocked, usage], [[blocked, usage]]]) {
                    const wire = JSON.parse(wrapResponse(JSON.stringify(root), stream));
                    const result = JSON.parse(stream ? wire[0][0][0] : wire[0]);
                    assert.equal(result.promptFeedback.blockReason, name);
                    assert.equal(result.promptFeedback.blockReasonMessage, "reason from upstream");
                    assert.deepEqual(result.promptFeedback.safetyRatings, [
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", probability: "HIGH" },
                    ]);
                    assert.equal(result.usageMetadata.promptTokenCount, 12);
                    assert.equal(result.responseId, "real-response-id");
                    assert.deepEqual(result.candidates, []);
                }
            }
        }
    }
    const result = merge([
        { promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "explanation" } },
        { promptFeedback: { blockReason: "", safetyRatings: [] } },
        { usageMetadata: { promptTokenCount: 4 } },
    ]);
    assert.equal(result.promptFeedback.blockReason, "SAFETY");
    assert.equal(result.promptFeedback.blockReasonMessage, "explanation");
    assert.equal(result.usageMetadata.promptTokenCount, 4);
    for (const feedback of [[], [0], [null], ["4"], [-1]])
        assert.throws(() => wrapResponse(JSON.stringify([[null, feedback, [4]]]), false), /confirmed finish/);
    assert.throws(() => wrapResponse(JSON.stringify([[null, null, [4]]]), false), /confirmed finish/);
    const filtered = [[[answerContent, 3]]];
    const decoded = JSON.parse(JSON.parse(wrapResponse(JSON.stringify([filtered]), false))[0]);
    assert.equal(decoded.candidates[0].finishReason, "SAFETY");
    assert.equal(decoded.promptFeedback, undefined);
});

test("nested stream envelopes cannot turn a trailing RPC Status into prompt feedback", () => {
    for (const streamed of [false, true]) {
        assert.throws(
            () => wrapResponse(JSON.stringify([[answer, [8, "quota", []]]]), streamed),
            error => error.status === 429 && error.message === "quota"
        );
        const raw = [[answer, [null, [4, null, "blocked"]], [8, "quota", []]]];
        const wrapped = JSON.parse(wrapResponse(JSON.stringify(raw), streamed));
        const decoded = JSON.parse(streamed ? wrapped[0][0][0] : wrapped[0]);
        assert.equal(decoded.promptFeedback.blockReason, "PROHIBITED_CONTENT");
        assert.equal(decoded.usageMetadata.totalTokenCount, 6);
    }
});

test("elided feedback and feedback split across chunks keep the actual reason and explanation", () => {
    for (const streamed of [false, true]) {
        const wrapped = JSON.parse(wrapResponse('[[,[,,"upstream explanation"]],[,[4]],[,[0], [6,0,6]]]', streamed));
        const response = JSON.parse(streamed ? wrapped[0][0][0] : wrapped[0]);
        assert.equal(response.promptFeedback.blockReason, "PROHIBITED_CONTENT");
        assert.equal(response.promptFeedback.blockReasonMessage, "upstream explanation");
        assert.equal(response.usageMetadata.promptTokenCount, 6);
    }
});
