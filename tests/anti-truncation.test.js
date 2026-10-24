const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Attempt, decode, identity, inject, resolve, MAX_BYTES, TEXT_MODELS } = require("../src/core/AntiTruncation");
const FormatConverter = require("../src/core/FormatConverter");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const converter = new FormatConverter(logger, { config: {} });
const model = "gemini-2.5-flash";
const response = (parts, finishReason = "STOP", index = 0) => ({
    candidates: [{ content: { parts }, finishReason, index }],
});
const synthetic = content => ({ functionCall: { args: { content }, name: "synthetic" } });
const events = output =>
    output
        .split("\n")
        .filter(line => line.startsWith("data: {"))
        .map(line => JSON.parse(line.slice(6)));

test("policy precedence, canonical identity, disabled switch and protocol admission", () => {
    assert.equal(resolve({ model }, {}).enabled, false);
    assert.equal(resolve({ model: `anti-${model}` }, {}).enabled, true);
    assert.equal(resolve({ anti_truncation: false, model: `anti-${model}` }, {}).enabled, false);
    assert.equal(resolve({ model }, { antiTruncationDefault: "prefer" }).enabled, true);
    assert.equal(resolve({ anti_truncation: false, model }, { antiTruncationDefault: "prefer" }).enabled, false);
    assert.equal(resolve({ model }, { antiTruncationDefault: "prefer", antiTruncationEnabled: false }).enabled, false);
    for (const name of ["anti-", `anti-anti-${model}`]) assert.throws(() => identity(name), { status: 400 });
    for (const value of [null, "true", 1, {}])
        assert.throws(() => resolve({ anti_truncation: value, model }, {}), { status: 400 });
    assert.throws(() => resolve({ model: `anti-${model}` }, { antiTruncationEnabled: false }), {
        code: "anti_truncation_disabled",
    });
    for (const protocol of ["gemini", "claude", "response_api", "embedding"]) {
        assert.throws(() => resolve({ model: `anti-${model}` }, {}, protocol), { status: 400 });
        assert.equal(resolve({ model }, { antiTruncationDefault: "prefer" }, protocol).enabled, false);
    }
    const parsed = identity(`models/AnTi-${model}(minimal)-EARLY-search-code`);
    assert.equal(parsed.realModel, model);
    assert.equal(parsed.streamingMode, "early");
    assert.equal(parsed.forceCodeExecution, true);
    assert.equal(identity("anti-Gemini-2.5-Flash-real").realModel, "Gemini-2.5-Flash");
});

test("capability matrix excludes multimodal, hosted tools and unknown models", () => {
    for (const body of [
        { model: "anti-gemini-2.5-flash-preview-tts" },
        { model: `anti-${model}-search` },
        { model: `anti-${model}`, tools: [{ type: "google_search" }] },
        { modalities: ["audio"], model: `anti-${model}` },
        { messages: [{ content: [{ type: "image_url" }] }], model: `anti-${model}` },
        { model: `anti-${model}`, response_format: { type: "json_object" } },
    ])
        assert.throws(() => resolve(body, {}), { status: 400 });
    assert.equal(
        resolve({ model: `anti-${model}`, tool_choice: { function: { name: "weather" }, type: "function" } }, {})
            .reason,
        "forced_real_tool"
    );
});

test("injection is immutable, unique per attempt, closes assistant turn and respects none/required", async () => {
    const tool = { function: { name: "weather", parameters: { type: "object" } }, type: "function" };
    const baseline = {
        anti_truncation: true,
        messages: [{ content: "prefill", role: "assistant" }],
        model,
        tools: [tool],
    };
    const before = structuredClone(baseline);
    const first = inject(baseline),
        second = inject(baseline);
    assert.deepEqual(baseline, before);
    assert.match(first.name, /^agw_emit_[a-f0-9]{24}$/);
    assert.notEqual(first.name, second.name);
    assert.equal(first.body.tools.length, 2);
    assert.deepEqual(first.body.tools[0], tool);
    assert.equal(first.body.messages.at(-1).role, "user");
    assert.equal(first.body.anti_truncation, undefined);
    const none = inject({ ...baseline, tool_choice: "none" });
    const translated = await converter.translateOpenAIToGoogle(none.body);
    assert.equal(translated.googleRequest.tools[0].functionDeclarations.length, 1);
    assert.deepEqual(translated.googleRequest.toolConfig.functionCallingConfig, {
        allowedFunctionNames: [none.name],
        mode: "ANY",
    });
    assert.equal(inject({ ...baseline, tool_choice: "required" }).body.tool_choice, "required");
});

test("bounded deterministic repairs preserve received Unicode and reject invalid schemas/escapes", () => {
    assert.deepEqual(decode({ content: "中文😀\n\\" }), { content: "中文😀\n\\", repaired: false });
    assert.equal(decode('```json\n{"content":"ok"}\n```').content, "ok");
    assert.equal(decode('{"content":"\\uD83D\\uDE00').content, "😀");
    assert.equal(decode('{"content":"partial"').content, "partial");
    for (const args of [null, {}, { content: 1 }, '{"content":"bad\\u12', '{"content":"bad\\', '{"text":"answer"}'])
        assert.throws(() => decode(args), { status: 502 });
    assert.throws(() => decode({ content: "x".repeat(MAX_BYTES) }), { code: "anti_truncation_limit" });
});

test("buffered and real restoration preserve text, reasoning, tools, token usage and finish reasons", () => {
    const input = response([
        { text: "discard" },
        { text: "reason", thought: true },
        synthetic("中文😀"),
        { functionCall: { args: { city: "上海" }, id: "call_preserved", name: "weather" } },
    ]);
    input.usageMetadata = { candidatesTokenCount: 30, promptTokenCount: 20, totalTokenCount: 50 };
    const non = new Attempt("synthetic").nonStream(input, converter, model);
    const stream = new Attempt("synthetic");
    const shared = {};
    const chunks = events(stream.stream(input, converter, model, shared, true) + stream.usageEvent(shared));
    assert.equal(non.choices[0].message.content, "中文😀");
    assert.equal(chunks.map(chunk => chunk.choices[0]?.delta.content || "").join(""), non.choices[0].message.content);
    assert.equal(non.choices[0].message.reasoning_content, "reason");
    assert.equal(non.choices[0].message.tool_calls[0].function.name, "weather");
    assert.equal(non.choices[0].message.tool_calls[0].index, 0);
    assert.equal(non.choices[0].message.tool_calls[0].id, "call_preserved");
    assert.equal(chunks.find(chunk => chunk.choices[0]?.delta.tool_calls)?.choices[0].delta.tool_calls[0].index, 0);
    assert.equal(non.choices[0].finish_reason, "tool_calls");
    assert.equal(chunks.filter(chunk => chunk.usage).length, 1);
    assert.deepEqual(chunks.at(-1).usage, non.usage);
    assert.equal(stream.usageEvent(shared), "");
    for (const reason of ["STOP", "MAX_TOKENS", "SAFETY"]) {
        const result = new Attempt("synthetic").nonStream(response([synthetic("partial")], reason), converter, model);
        assert.equal(result.choices[0].finish_reason, converter._mapFinishReason(reason));
    }
});

test("each choice isolates source conflicts, real-tool indices and role; side buffers have explicit latency", () => {
    for (const limit of [0, 100]) {
        const attempt = new Attempt("synthetic", () => {}, limit);
        const first = attempt.restore(response([{ text: "prior" }], undefined));
        // response helper defaults STOP for undefined, use an explicit missing field instead.
        assert.equal(first.candidates[0].content.parts.map(part => part.text).join(""), "prior");
        const stream = new Attempt("synthetic", () => {}, limit);
        const state = {};
        const initial = response([{ text: "prior" }]);
        delete initial.candidates[0].finishReason;
        const before = events(stream.stream(initial, converter, model, state));
        const later = events(
            stream.stream(response([synthetic("answer"), { text: "after" }]), converter, model, state)
        );
        assert.equal(before.map(e => e.choices[0].delta.content || "").join(""), limit ? "" : "prior");
        assert.equal(later.map(e => e.choices[0].delta.content || "").join(""), "answer");
    }
    const stream = new Attempt("synthetic");
    const input = {
        candidates: [
            response([synthetic("one")], "STOP", 0).candidates[0],
            response([{ text: "two" }], "STOP", 1).candidates[0],
        ],
    };
    const chunks = events(stream.stream(input, converter, model, {}));
    assert.deepEqual(
        chunks.filter(e => e.choices[0].delta.role).map(e => e.choices[0].index),
        [0, 1]
    );
    stream.assertComplete();
});

test("transport assembler handles every JSON/Unicode/escape boundary, mixed usage, comments and EOF errors", () => {
    const input = response([synthetic('中😀\n"\\')]);
    const raw = `: ping\r\n\r\ndata: ${JSON.stringify(input)}\r\n\r\ndata: ${JSON.stringify({ usageMetadata: { totalTokenCount: 10 } })}\n\n`;
    for (let split = 1; split < raw.length; split++) {
        const attempt = new Attempt("synthetic");
        const parsed = [...attempt.read(raw.slice(0, split)), ...attempt.read(raw.slice(split))];
        assert.deepEqual(parsed, [input, { usageMetadata: { totalTokenCount: 10 } }]);
    }
    const attempt = new Attempt("synthetic");
    assert.deepEqual(attempt.read('data: {"candidates":'), []);
    assert.throws(() => attempt.read("", true), { status: 502 });
    assert.throws(() => new Attempt("synthetic").read("x".repeat(MAX_BYTES + 1)), { status: 502 });
    assert.throws(() => new Attempt("synthetic").nonStream(response([synthetic("answer")], null), converter, model), {
        code: "anti_truncation_incomplete_stream",
    });
    assert.throws(() => new Attempt("synthetic").restore({ error: { code: 429, message: "private" } }), {
        code: "upstream_error",
        message: "private",
        status: 429,
        upstreamError: { code: 429, message: "private", type: null },
    });
});

test("catalog text allowlist supports modifier parsing and Gemini injection in isolated conversion", async () => {
    for (const name of TEXT_MODELS) {
        const policy = resolve({ model: `anti-${name}-minimal-real` }, {});
        assert.equal(policy.enabled, true);
        assert.equal(policy.realModel, name);
        const injected = inject({ messages: [{ content: "test", role: "user" }], model: policy.model });
        const translated = await converter.translateOpenAIToGoogle(injected.body, { privateTransport: true });
        assert.equal(translated.cleanModelName, name);
        assert.equal(translated.modelStreamingMode, "real");
        assert.equal(translated.googleRequest.tools[0].functionDeclarations[0].name, injected.name);
        assert.equal(translated.googleRequest.contents.at(-1).role, "user");
    }
});

test("upstream safety block is a terminal business error and batch DONE does not duplicate output", () => {
    assert.throws(
        () => new Attempt("synthetic").nonStream({ promptFeedback: { blockReason: "SAFETY" } }, converter, model),
        {
            code: "upstream_prompt_blocked",
            retryable: false,
            status: 400,
        }
    );
    const attempt = new Attempt("synthetic");
    const responses = attempt.read(`data: ${JSON.stringify(response([synthetic("answer")]))}\n\ndata: [DONE]\n\n`);
    assert.equal(responses.length, 1);
    attempt.stream(responses[0], converter, model, {});
    attempt.assertComplete();
});

test("upstream error normalization preserves business codes and uses bounded HTTP statuses", () => {
    const { normalizeError, upstreamError } = require("../src/utils/UpstreamError");
    for (const code of [429, "429", "RESOURCE_EXHAUSTED"]) {
        const fields = { code, message: '错误 "文本"\n下一行', type: "quota_error" };
        const error = upstreamError(fields, 403);
        assert.equal(error.code, "upstream_error");
        assert.deepEqual(normalizeError(error), { code, message: fields.message, status: 403, type: fields.type });
    }
    assert.deepEqual(normalizeError(upstreamError({ code: "QUOTA" })), {
        code: "QUOTA",
        message: "Upstream generation failed",
        status: 502,
        type: null,
    });
    for (const code of [null, {}, [], NaN, Infinity]) {
        assert.deepEqual(normalizeError(upstreamError({ code, message: {}, type: 5 }, 200)), {
            code: 502,
            message: "Upstream generation failed",
            status: 502,
            type: null,
        });
    }
    assert.equal(normalizeError(upstreamError({ code: 429 })).status, 429);
    assert.equal(
        normalizeError({
            code: "anti_truncation_incomplete_stream",
            message: "Upstream ended before a finish event",
            status: 502,
        }).code,
        "anti_truncation_incomplete_stream"
    );
});

test("browser HTTP failures retain structured upstream fields without proxy prefixes", async () => {
    const fs = require("node:fs");
    const vm = require("node:vm");
    const source = fs.readFileSync(require.resolve("../scripts/client/build.js"), "utf8");
    let body;
    const context = vm.createContext({
        AbortController,
        clearTimeout,
        EventTarget,
        fetch: async () => ({ ok: false, status: 429, statusText: "Too Many Requests", text: async () => body }),
        performance,
        setTimeout,
    });
    vm.runInContext(
        source.replace(/initializeProxySystem\(\);\s*$/, "") +
            "\nLogger.enabled = false; globalThis.processor = new RequestProcessor(); globalThis.ProxySystemClass = ProxySystem;",
        context
    );
    context.processor._constructUrl = () => "https://example.invalid";
    context.processor._buildRequestConfig = () => ({});
    const message = '配额不足 "model"\n稍后重试';
    for (const fields of [
        { code: "RESOURCE_EXHAUSTED", message, status: "RESOURCE_EXHAUSTED", type: "quota_error" },
        { code: 429, message },
        { code: {}, message: {}, type: [] },
        null,
    ]) {
        body = fields ? JSON.stringify({ error: fields }) : "<html>private error page</html>";
        const execution = context.processor.execute({ request_attempt_id: "attempt" }, "test");
        let captured;
        await assert.rejects(execution.responsePromise, error => {
            context.ProxySystemClass.prototype._sendErrorResponse.call(
                {
                    connectionManager: {
                        transmit(value) {
                            captured = JSON.parse(JSON.stringify(value));
                        },
                    },
                },
                error,
                "test",
                "attempt"
            );
            return true;
        });
        execution.cancelTimeout();
        assert.equal(captured.status, 429);
        assert.equal(
            captured.message,
            fields && typeof fields.message === "string" ? message : "Upstream request failed (HTTP 429)"
        );
        assert.equal(captured.upstreamError.code, fields && typeof fields.code !== "object" ? fields.code : 429);
        assert.equal(captured.retryable, true);
        assert.equal(captured.cooldown, true);
        assert.equal(captured.message.includes("private error page"), false);
    }
});

test("block diagnostics are validated, bounded and take precedence over candidates and top-level errors", () => {
    const { promptBlocked } = require("../src/utils/UpstreamBlock");
    for (const blockReason of [undefined, null, "", "  ", {}, 4])
        assert.equal(promptBlocked({ promptFeedback: { blockReason } }), null);
    const blocked = promptBlocked({
        candidates: [{ content: { parts: [{ text: "must not escape" }] }, finishReason: "STOP" }],
        error: { code: 503, message: "network RESOURCE_EXHAUSTED PERMISSION_DENIED" },
        promptFeedback: {
            blockReason: "FUTURE_REASON",
            blockReasonMessage: "Bearer secret-credential " + "x".repeat(2000),
            safetyRatings: [{ blocked: true, category: "HARM_CATEGORY_TEST", extra: "private", probability: "HIGH" }],
            untrusted: "private",
        },
        usageMetadata: { private: "do not expose", promptTokenCount: 123 },
    });
    assert.equal(blocked.retryable, false);
    assert.equal(blocked.status, 400);
    assert.equal(blocked.upstream.blockReason, "FUTURE_REASON");
    assert.equal(blocked.upstream.error.code, 503);
    assert.ok(blocked.upstream.blockReasonMessage.length <= 1024);
    assert.equal(JSON.stringify(blocked).includes("secret-credential"), false);
    assert.equal(JSON.stringify(blocked).includes("must not escape"), false);
    assert.equal(JSON.stringify(blocked).includes("private"), false);
    assert.deepEqual(blocked.usageMetadata, { promptTokenCount: 123 });
    for (const convert of [
        input => converter.convertGoogleToOpenAINonStream(input),
        input => converter.convertGoogleToClaudeNonStream(input),
        input => converter.convertGoogleToResponseAPINonStream(input),
        input => converter.translateGoogleToOpenAIStream(JSON.stringify(input), model, {}),
        input => converter.translateGoogleToClaudeStream(JSON.stringify(input), model, {}),
        input => converter.translateGoogleToResponseAPIStream(JSON.stringify(input), model, {}),
    ])
        assert.throws(() => convert({ promptFeedback: { blockReason: "FUTURE_REASON" } }), {
            code: "upstream_prompt_blocked",
        });
});

test("generation guard assembles every JSON/SSE boundary before inspecting a block", () => {
    const Guard = require("../src/utils/GenerationResponseGuard");
    const blocked = JSON.stringify({
        candidates: [{ content: { parts: [{ text: '中😀 " } \\ hidden' }] } }],
        promptFeedback: { blockReason: "UNKNOWN_REASON" },
        usageMetadata: { promptTokenCount: 10 },
    });
    for (const wire of [blocked, `[${blocked}]`, `: heartbeat\r\n\r\ndata: ${blocked}\r\n\r\n`, `data: ${blocked}`]) {
        for (let split = 1; split < wire.length; split++) {
            const guard = new Guard({ requestId: "req_test" });
            const messages = [
                ...guard.push({ data: wire.slice(0, split), event_type: "chunk" }),
                ...guard.push({ data: wire.slice(split), event_type: "chunk" }),
                ...guard.push({ type: "STREAM_END" }),
            ];
            const error = messages.find(message => message.code === "upstream_prompt_blocked");
            assert.ok(error, `split=${split}: ${wire}`);
            assert.equal(error.requestId, "req_test");
            assert.equal(error.upstream.blockReason, "UNKNOWN_REASON");
            assert.deepEqual(error.usageMetadata, { promptTokenCount: 10 });
            assert.equal(
                messages.some(message => message.data?.includes("hidden")),
                false
            );
            assert.deepEqual(guard.push({ event_type: "error", status: 503 }), []);
        }
    }
    const guard = new Guard();
    const prior = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "prior" }] } }], usageMetadata: { candidatesTokenCount: 2 } })}\n\n`;
    const messages = guard.push({
        data: prior + 'data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n',
        event_type: "chunk",
    });
    assert.equal(messages[0].data, prior);
    assert.equal(messages[1].code, "upstream_prompt_blocked");
    assert.deepEqual(messages[1].usageMetadata, { candidatesTokenCount: 2 });
    const limited = new Guard({}, 4);
    assert.equal(limited.push({ data: '{"abc', event_type: "chunk" })[0].code, "anti_truncation_limit");
});

test("a detected block survives queue closure and deadline races without becoming a transport retry", async () => {
    const MessageQueue = require("../src/utils/MessageQueue");
    const Guard = require("../src/utils/GenerationResponseGuard");
    for (const close of [false, true]) {
        const queue = new MessageQueue();
        queue.responseGuard = new Guard();
        queue.enqueue({ data: '{"promptFeedback":{"blockReason":"SAFETY"}}', event_type: "chunk" });
        if (close) queue.close("connection_lost");
        else queue.generationDeadline = performance.now() - 1;
        await assert.rejects(queue.dequeue(), { code: "upstream_prompt_blocked", retryable: false });
    }
    const guard = new Guard();
    const frames = guard.push({
        data: 'data: {"promptFeedback":\r\ndata: {"blockReason":"SAFETY"}}\r\n\r\n',
        event_type: "chunk",
    });
    assert.equal(frames[0].code, "upstream_prompt_blocked");
});
