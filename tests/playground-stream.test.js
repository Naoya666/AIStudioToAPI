const { test } = require("node:test");
const assert = require("node:assert/strict");
const Decoder = require("../src/core/PlaygroundStreamDecoder");
const { decodeResponse } = require("../src/core/MakerSuiteCodec");
const chunk = (text, finish = null) => [[[[[null, text]], "model"], finish]].map(c => c); // candidate list
const message = (text, finish = null) => [chunk(text, finish)];

for (const wrapped of [false, true]) {
    test(`incremental sparse JSON parser delivers complete messages before EOF (wrapped=${wrapped})`, () => {
        const received = [];
        const decoder = new Decoder(x => received.push(x));
        const first = JSON.stringify(message('你\\"\n好'));
        const last = JSON.stringify(message("world", 1));
        const prefix = wrapped ? "[[" : "[";
        for (const ch of prefix + first) decoder.push(ch);
        assert.equal(received.length, 1);
        assert.equal(received[0].candidates[0].content.parts[0].text, '你\\"\n好');
        const suffix = "," + last + (wrapped ? "]]" : "]");
        for (const ch of suffix) decoder.push(ch);
        decoder.finish();
        assert.equal(received.length, 2);
        assert.deepEqual(received, decodeResponse(prefix + first + suffix).chunks);
    });
}

test("truncation, invalid JSON, late RPC status and extra roots fail without inventing a finish", () => {
    const first = JSON.stringify(message("partial"));
    for (const [wire, pattern] of [
        ["[[" + first, /truncated/],
        ["[[" + first + "]]", /finish reason/],
        ["[[" + first + ',[8,"late quota"]]]', /late quota/],
        ["[[" + first + ",?]]", /JSON/],
        [JSON.stringify([[message("done", 1)]]) + "[]", /after/],
    ]) {
        const decoder = new Decoder(() => {});
        assert.throws(() => {
            decoder.push(wire);
            decoder.finish();
        }, pattern);
    }
});

test("sparse slots, usage-only tail, thoughts, signatures and tools preserve unary semantics", () => {
    const thought = message("thinking");
    thought[0][0][0][0][0][12] = 1;
    thought[0][0][0][0][0][14] = "sig";
    const values = [thought, message("answer", 1), [null, null, [10, 20, 30]]];
    const wire = JSON.stringify([values]).replaceAll(",null,", ",,");
    const output = [];
    const decoder = new Decoder(x => output.push(x));
    for (let i = 0; i < wire.length; i += 3) decoder.push(wire.slice(i, i + 3));
    decoder.finish();
    assert.deepEqual(output, decodeResponse(wire).chunks);
    assert.equal(output[0].candidates[0].content.parts[0].thoughtSignature, "sig");
    assert.equal(output.at(-1).usageMetadata.totalTokenCount, 30);
});

test("streaming does not retain the generated response and enforces per-message limits", () => {
    let count = 0;
    const decoder = new Decoder(() => count++);
    decoder.push("[[");
    const wire = JSON.stringify(message("x".repeat(1000)));
    for (let i = 0; i < 10000; i++) {
        decoder.push((i ? "," : "") + wire);
        assert.ok(decoder.stack.every(frame => frame.text.length < 100));
    }
    decoder.push("," + JSON.stringify(message("end", 1)) + "]]");
    decoder.finish();
    assert.equal(count, 10001);
    assert.throws(() => new Decoder(() => {}, 32).push("[[" + wire), /size limit/);
});

test("incremental queues enforce both idle waits and the unchanged generation deadline", async t => {
    const Queue = require("../src/utils/MessageQueue");
    let now = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const q = new Queue();
    q.generationDeadline = 1000;
    q.incremental = true;
    q.enqueue({ event_type: "response_headers" });
    await q.dequeue();
    const idle = assert.rejects(q.dequeue(100), { code: "QUEUE_TIMEOUT" });
    now = 100;
    t.mock.timers.tick(100);
    await idle;
    now = 950;
    const deadline = assert.rejects(q.dequeue(100), { code: "QUEUE_TIMEOUT" });
    now = 1000;
    t.mock.timers.tick(50);
    await deadline;
    q.close();
});

test("confirmed prompt blocks take precedence over later status records", () => {
    const received = [];
    const decoder = new Decoder(chunk => received.push(chunk));
    const block = [null, [1]];
    const wire = JSON.stringify([[block, [8, "late quota"]]]);
    decoder.push(wire);
    decoder.finish();
    assert.equal(received[0].promptFeedback.blockReason, "SAFETY");
    assert.deepEqual(received, decodeResponse(wire).chunks);
});
