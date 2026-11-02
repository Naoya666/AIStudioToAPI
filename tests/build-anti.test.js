const test = require("node:test");
const assert = require("node:assert/strict");
const Anti = require("../src/core/codeAssistant/AntiTransport");
const Tools = require("../src/core/codeAssistant/ToolContract");
const Policy = require("../src/core/AntiTruncation");
const Handler = require("../src/core/codeAssistant/BuildRequestHandler");
const Identity = require("../src/core/codeAssistant/ModelIdentity");
const base = {
    messages: [{ content: "hello", role: "user" }],
    model: "build/gemini-3.8-flash",
};
const tools = [
    {
        function: {
            name: "sum",
            parameters: {
                additionalProperties: false,
                properties: { n: { type: "integer" } },
                required: ["n"],
                type: "object",
            },
        },
        type: "function",
    },
];
const wire = (name, args, content = null) =>
    `{"content":${JSON.stringify(content)},"tool_calls":[{"name":${JSON.stringify(name)},"arguments":${JSON.stringify(args)}}]}`;
for (const mode of ["strict", "auto_fallback"]) {
    test(`${mode}: answer transport and real tools retain the original contract`, () => {
        const contract = Tools.prepareTools({ ...base, tool_choice: "auto", tools }, { mode });
        const state = Anti.prepare(contract),
            answer = '中文😀\n```js\nconst x="\\\\";\n```'.repeat(1000);
        assert.equal(contract.definitions.length, 1);
        assert.equal(Anti.restore(wire(state.name, { content: answer }), state).message.content, answer);
        assert.equal(Anti.restore(wire("sum", { n: 42 }), state).message.tool_calls[0].function.name, "sum");
        if (mode === "auto_fallback")
            assert.equal(Anti.restore(wire("sum", { n: "relaxed" }), state).message.tool_calls.length, 1);
        else assert.throws(() => Anti.restore(wire("sum", { n: "relaxed" }), state));
        assert.throws(() => Anti.restore(wire("unknown", {}), state));
        assert.throws(() => Anti.restore(wire(state.name, { content: "x" }, "leaked"), state));
        assert.throws(() =>
            Anti.restore(
                JSON.stringify({
                    content: null,
                    tool_calls: [
                        { arguments: { content: "x" }, name: state.name },
                        { arguments: { n: 42 }, name: "sum" },
                    ],
                }),
                state
            )
        );
    });
    test(`${mode}: none suppresses all real tools while answer transport remains available`, () => {
        const state = Anti.prepare(Tools.prepareTools({ ...base, tool_choice: "none", tools }, { mode }));
        assert.equal(Anti.restore(wire(state.name, { content: "ok" }), state).message.content, "ok");
        assert.throws(() => Anti.restore(wire("sum", { n: 42 }), state));
    });
}
test("strict required and forced client calls cannot be satisfied by synthetic answers", () => {
    for (const choice of ["required", { function: { name: "sum" }, type: "function" }]) {
        const state = Anti.prepare(Tools.prepareTools({ ...base, tool_choice: choice, tools }, { mode: "strict" }));
        assert.throws(() => Anti.restore(wire(state.name, { content: "wrong" }), state));
        assert.throws(() => Anti.restore(wire("sum", { n: "wrong" }), state));
        assert.equal(Anti.restore(wire("sum", { n: 42 }), state).message.tool_calls.length, 1);
    }
});
test("auto_fallback retains relaxed client choice without allowing plain-text bypass", () => {
    const state = Anti.prepare(
        Tools.prepareTools({ ...base, tool_choice: "required", tools }, { mode: "auto_fallback" })
    );
    assert.equal(Anti.restore(wire(state.name, { content: "answer" }), state).message.content, "answer");
    assert.throws(() => Anti.restore("plain", state));
});
test("only missing closing delimiters of a synthetic answer can be repaired", () => {
    const state = Anti.prepare(null),
        full = wire(state.name, { content: "abcd" });
    const cutoff = full.slice(0, full.indexOf("abcd") + 4);
    const restored = Anti.restore(cutoff, state);
    assert.deepEqual(restored, {
        message: { content: "abcd", role: "assistant" },
        repaired: true,
    });
    for (const suffix of ["\\", "\\u12", "\\q", "\n"]) assert.throws(() => Anti.restore(cutoff + suffix, state));
    assert.throws(() => Anti.restore(wire(state.name, { content: 12 }), state));
    assert.throws(() => Anti.restore(wire(state.name, { content: "ok", extra: true }), state));
    const realState = Anti.prepare(Tools.prepareTools({ ...base, tools }, { mode: "strict" }));
    assert.throws(() => Anti.restore(wire("sum", { n: 42 }).slice(0, -1), realState), {
        code: "build_anti_incomplete_tool_call",
    });
});
test("legacy client functions are restored to their original output shape", () => {
    const contract = Tools.prepareTools({
        ...base,
        function_call: { name: "sum" },
        functions: [tools[0].function],
    });
    const state = Anti.prepare(contract),
        result = Anti.restore(wire("sum", { n: 42 }), state).message;
    assert.equal(result.function_call.name, "sum");
    assert.equal(result.tool_calls, undefined);
});
test("policy, disabled switch, explicit false, model aliases and context injection", () => {
    const config = {
        antiTruncationDefault: "off",
        antiTruncationEnabled: true,
        buildEnabled: true,
    };
    assert.equal(Policy.resolve({ ...base, anti_truncation: true }, config).enabled, true);
    assert.equal(Policy.resolve({ ...base, model: "anti-" + base.model }, config).enabled, true);
    assert.equal(Policy.resolve(base, { ...config, antiTruncationDefault: "prefer" }).enabled, true);
    assert.equal(
        Policy.resolve({ ...base, anti_truncation: false, model: "anti-" + base.model }, config).enabled,
        false
    );
    assert.throws(() =>
        Policy.resolve({ ...base, anti_truncation: true }, { ...config, antiTruncationEnabled: false })
    );
    assert.throws(() => Policy.resolve({ ...base, anti_truncation: true }, config, "gemini"));
    const p = Handler.prepare({ ...base, anti_truncation: true }, config, {});
    assert.equal(p.contract, null);
    assert.ok(p.context.files[0].text.includes(p.anti.name));
    assert.ok(Identity.models().includes("anti-build/gemini-3.8-flash"));
    assert.ok(!Identity.models({ anti: false }).some(n => n.startsWith("anti-")));
});
test("synthetic names avoid client collisions and do not misclassify similarly named real tools", () => {
    const crypto = require("node:crypto");
    const filename = require.resolve("../src/core/codeAssistant/AntiTransport");
    const cached = require.cache[filename],
        original = crypto.randomBytes;
    let attempts = 0;
    const name = "agw_emit_" + Buffer.alloc(12, 1).toString("hex");
    try {
        crypto.randomBytes = () => Buffer.alloc(12, ++attempts === 1 ? 1 : 2);
        delete require.cache[filename];
        const fresh = require(filename);
        const contract = Tools.prepareTools({
            ...base,
            tools: [{ ...tools[0], function: { ...tools[0].function, name } }],
        });
        const state = fresh.prepare(contract);
        assert.notEqual(state.name, name);
        assert.equal(attempts, 2);
        assert.equal(fresh.restore(wire(name, { n: 42 }), state).message.tool_calls[0].function.name, name);
    } finally {
        crypto.randomBytes = original;
        require.cache[filename] = cached;
    }
});
test("trailing whitespace in a received truncated answer is preserved", () => {
    const state = Anti.prepare(null),
        value = "end  ";
    const full = wire(state.name, { content: value });
    assert.equal(Anti.restore(full.slice(0, full.indexOf(value) + value.length), state).message.content, value);
});
test("complete Markdown JSON envelopes allow trailing whitespace and CRLF without altering the answer", () => {
    const state = Anti.prepare(null),
        content = "正文😀\n末尾  ",
        full = wire(state.name, { content });
    for (const raw of [
        `\u0060\u0060\u0060json\n${full}\n\u0060\u0060\u0060\n`,
        `\u0060\u0060\u0060json\r\n${full}\r\n\u0060\u0060\u0060\r\n  `,
    ])
        assert.equal(Anti.restore(raw, state).message.content, content);
});
