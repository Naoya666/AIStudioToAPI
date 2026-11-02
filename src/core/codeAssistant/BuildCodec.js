// CodeAssistant wire fields cross-checked with yunx738/ais2api 38f2355
// and Mag1cFall/AIStudio2API 0451f26; see docs/zh/build-dual-channel.md.
const { randomUUID } = require("node:crypto");
const fail = message => Object.assign(new Error(message), { kind: "capability", retryable: false, status: 502 });
function encode(identity, context, app) {
    const parts = context.files.map(f =>
        Buffer.byteLength(f.text) > 200 * 1024
            ? { __upload: ["text/plain", Buffer.from(f.text).toString("base64"), f.name] }
            : [null, null, ["text/plain", Buffer.from(f.text).toString("base64")]]
    );
    parts.push([null, context.prompt]);
    const body = Array(29).fill(null);
    body[0] = [[parts, "user"]];
    body[5] = 2;
    body[7] = "models/" + identity.upstream;
    body[11] = app;
    // Keep the complete framework configuration for a fresh default applet.
    // [2] accepts submission but the generation then fails with Invalid argument.
    body[13] = [2, null, 2];
    body[15] = 1;
    body[18] = [1, null, null, identity.thinking];
    body[22] = true;
    body[28] = randomUUID().toUpperCase();
    // Hash matches the direct-input and inline attachment parts; signing is serialized
    // by the same page proofTail as Playground, fetch/read remains concurrent.
    return { body, ht: parts.map(p => p[1] ?? p[2]?.[1] ?? "").join(" ") };
}
function decode(raw, task) {
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        throw Object.assign(fail("Build 读取中断或 RPC 封装损坏；未重新生成"), { code: "BUILD_READ_INTERRUPTED" });
    }
    const turns = [];
    let rpcError;
    function walk(v, depth = 0) {
        if (depth > 10 || !Array.isArray(v)) return;
        if (Number.isInteger(v[0]) && v[0] > 0 && typeof v[1] === "string") {
            rpcError = Object.assign(fail("Build RPC 返回任务错误"), {
                kind: "upstream",
                status: { 1: 499, 3: 400, 4: 504, 5: 404, 7: 403, 8: 429, 16: 401 }[v[0]] || 502,
            });
            if (v[0] === 16) rpcError.upstreamError = { status: "UNAUTHENTICATED" };
            return;
        }
        if (
            ((Array.isArray(v[0]?.[0]?.[0]) && ["model", "user"].includes(v[0][0][1])) ||
                (v[16] === task && v[12] === 4)) &&
            typeof v[13] === "string" &&
            v[13].startsWith("models/")
        ) {
            turns.push(v);
            return;
        }
        v.forEach(x => walk(x, depth + 1));
    }
    walk(data);
    const model = turns.filter(t => t[16] === task && (t[0]?.[0]?.[1] === "model" || t[12] === 4)).at(-1);
    if (!model) {
        if (rpcError) throw rpcError;
        return { complete: false, empty: true, text: "", usage: null };
    }
    let usage = null;
    const u = model[15];
    if (
        Array.isArray(u) &&
        [2, 3].includes(u.length) &&
        u.every(n => typeof n === "string" && /^\d+$/.test(n) && Number.isSafeInteger(Number(n)))
    ) {
        const [uncached, output, cached = 0] = u.map(Number);
        usage = {
            completion_tokens: output,
            prompt_tokens: uncached + cached,
            prompt_tokens_details: { cached_tokens: cached },
            total_tokens: uncached + cached + output,
        };
    }
    if (rpcError) {
        rpcError.usage = usage;
        throw rpcError;
    }
    if (model[12] === 4 || model[5])
        throw Object.assign(
            fail("Build 上游任务失败" + (typeof model[5]?.[0] === "string" ? `：${model[5][0].slice(0, 300)}` : "")),
            {
                code: "BUILD_TASK_FAILED",
                kind: "upstream",
                taskTerminal: model[12] === 4,
                usage,
            }
        );
    let text = "",
        thought = "";
    for (const p of model[0][0][0]) {
        if (typeof p?.[1] === "string") {
            if (p[12] === 1) thought += p[1];
            else text += p[1];
        }
    }
    // Completion is a task status, independent of availability of usage.
    return { complete: model[12] === 1 && !model[9], empty: !text && !thought, text, thought, usage };
}
module.exports = { decode, encode };
