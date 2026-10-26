/**
 * MakerSuite position-array bridge, adapted with permission from yunx738/ais2api
 * commits 79807728179482509cf1f8a4f5e3e175d9dd6702 and e134063 (CC BY-NC 4.0).
 * See docs/zh/makersuite-generate-content-protocol-repair-plan-20261016.md.
 * Positions below are observed protocol fields, not a public Google API contract.
 */
const CAT = {
    HARM_CATEGORY_CIVIC_INTEGRITY: 11,
    HARM_CATEGORY_DANGEROUS_CONTENT: 10,
    HARM_CATEGORY_HARASSMENT: 7,
    HARM_CATEGORY_HATE_SPEECH: 8,
    HARM_CATEGORY_SEXUALLY_EXPLICIT: 9,
};
const THR = { BLOCK_LOW_AND_ABOVE: 1, BLOCK_MEDIUM_AND_ABOVE: 2, BLOCK_NONE: 4, BLOCK_ONLY_HIGH: 3, OFF: 5 };
const FIN = { 1: "STOP", 2: "MAX_TOKENS", 3: "SAFETY", 4: "RECITATION", 5: "OTHER" };
const TYP = { array: 5, boolean: 4, integer: 3, number: 2, object: 6, string: 1 };
const fail = (message, status = 400) => {
    throw Object.assign(new Error(message), { status });
};
const fill = a => Array.from(a, v => (v === undefined ? null : v));
function fields(value, allowed, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Invalid ${path}`);
    for (const key of Object.keys(value)) {
        if (value[key] !== undefined && !allowed.includes(key))
            fail(`MakerSuite bridge does not support ${path}.${key}`);
    }
}
function encVal(v) {
    if (v == null) return [0];
    if (typeof v === "number" && Number.isFinite(v)) return [null, v];
    if (typeof v === "string") return [null, null, v];
    if (typeof v === "boolean") return [null, null, null, v];
    if (Array.isArray(v)) return [null, null, null, null, null, [v.map(encVal)]];
    if (typeof v === "object") return [null, null, null, null, encStruct(v)];
    return fail("Invalid function argument value");
}
function encStruct(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) fail("Function arguments must be an object");
    return [
        Object.entries(o)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, encVal(v)]),
    ];
}
function decVal(v) {
    if (!Array.isArray(v)) return fail("Invalid MakerSuite Value", 502);
    if (v[1] != null) return v[1];
    if (v[2] != null) return v[2];
    if (v[3] != null) return !!v[3];
    if (v[4] != null) return decStruct(v[4]);
    if (v[5] != null) return (v[5][0] || []).map(decVal);
    return null;
}
function decStruct(st) {
    if (!Array.isArray(st) || !Array.isArray(st[0])) return fail("Invalid MakerSuite Struct", 502);
    return Object.fromEntries(st[0].map(([k, v]) => [k, decVal(v)]));
}
function encSchema(sc) {
    fields(sc, ["type", "format", "description", "nullable", "enum", "items", "properties", "required"], "schema");
    const type = TYP[String(sc.type || "object").toLowerCase()];
    if (!Number.isInteger(type)) fail("Unsupported MakerSuite schema type");
    const a = [type];
    if (sc.format) a[1] = sc.format;
    if (sc.description) a[2] = sc.description;
    if (sc.nullable != null) a[3] = !!sc.nullable;
    if (sc.enum) a[4] = sc.enum.map(String);
    if (sc.items) a[5] = encSchema(sc.items);
    if (sc.properties) a[6] = Object.entries(sc.properties).map(([k, v]) => [k, encSchema(v)]);
    if (sc.required) a[7] = sc.required;
    return fill(a);
}
function encTools(tools = []) {
    const decls = [];
    for (const t of tools) {
        fields(t, ["functionDeclarations", "function_declarations"], "tools");
        for (const d of t.functionDeclarations || t.function_declarations || []) {
            fields(d, ["name", "description", "parameters", "parametersJsonSchema"], "functionDeclaration");
            if (!d.name) fail("Function declaration requires a name");
            const x = [d.name, d.description || null];
            const ps = d.parameters || d.parametersJsonSchema;
            if (ps) x[2] = encSchema(ps);
            decls.push(x);
        }
    }
    return decls.length ? [[null, decls]] : null;
}
function toPart(p) {
    fields(
        p,
        [
            "text",
            "inlineData",
            "inline_data",
            "functionCall",
            "function_call",
            "functionResponse",
            "function_response",
            "thought",
            "thoughtSignature",
            "thought_signature",
        ],
        "part"
    );
    const a = [],
        d = p.inlineData || p.inline_data,
        fc = p.functionCall || p.function_call,
        fr = p.functionResponse || p.function_response;
    if (typeof p.text === "string") a[1] = p.text;
    else if (d) {
        fields(d, ["mimeType", "mime_type", "data"], "inlineData");
        a[2] = [d.mimeType || d.mime_type, d.data];
    } else if (fc) {
        fields(fc, ["name", "args", "id"], "functionCall");
        a[10] = [fc.name, encStruct(fc.args || {}), fc.id || null];
    } else if (fr) {
        fields(fr, ["name", "response", "id"], "functionResponse");
        a[11] = [fr.name, encStruct(fr.response || {}), fr.id || null];
    } else if (!(p.thoughtSignature || p.thought_signature)) return fail("Unsupported or empty MakerSuite part");
    if (p.thought != null) a[12] = !!p.thought;
    const signature = p.thoughtSignature || p.thought_signature;
    if (fc && (!signature || signature === "context_engineering_is_the_way_to_go"))
        a[14] = "skip_thought_signature_validator";
    else if (signature) a[14] = signature;
    return fill(a);
}
function toContent(c) {
    fields(c, ["role", "parts"], "content");
    if (!Array.isArray(c.parts) || !c.parts.length) fail("Content requires parts");
    if (c.role && !["user", "model", "system"].includes(c.role)) fail("Unsupported content role");
    return [c.parts.map(toPart), c.role === "model" ? "model" : "user"];
}
function buildBody(model, g) {
    fields(
        g,
        [
            "contents",
            "generationConfig",
            "generation_config",
            "systemInstruction",
            "system_instruction",
            "safetySettings",
            "safety_settings",
            "tools",
            "toolConfig",
            "tool_config",
            "model",
        ],
        "request"
    );
    const gc = g.generationConfig || g.generation_config || {},
        tc = gc.thinkingConfig || gc.thinking_config;
    fields(
        gc,
        [
            "stopSequences",
            "maxOutputTokens",
            "temperature",
            "topP",
            "topK",
            "responseMimeType",
            "thinkingConfig",
            "thinking_config",
        ],
        "generationConfig"
    );
    const cfg = [];
    if (gc.stopSequences) cfg[1] = gc.stopSequences;
    cfg[3] = gc.maxOutputTokens ?? 65536;
    cfg[4] = gc.temperature ?? 1;
    cfg[5] = gc.topP ?? 0.95;
    cfg[6] = gc.topK ?? 64;
    if (gc.responseMimeType) cfg[7] = gc.responseMimeType;
    cfg[13] = 1;
    if (tc) {
        fields(tc, ["includeThoughts", "thinkingBudget", "thinkingLevel"], "thinkingConfig");
        const th = [];
        if (tc.includeThoughts != null) th[0] = tc.includeThoughts ? 1 : 0;
        if (tc.thinkingBudget != null) th[1] = tc.thinkingBudget;
        if (tc.thinkingLevel != null) {
            const level = { high: 2, low: 1 }[String(tc.thinkingLevel).toLowerCase()];
            if (!Number.isInteger(level))
                fail("MakerSuite bridge supports only LOW/HIGH thinkingLevel; use thinkingBudget for other settings");
            th[3] = level;
        }
        cfg[16] = fill(th);
    }
    // AUTO is the native default; other tool-choice modes have no verified mapping yet.
    const toolConfig = g.toolConfig || g.tool_config;
    if (toolConfig) {
        fields(toolConfig, ["functionCallingConfig"], "toolConfig");
        const fc = toolConfig.functionCallingConfig;
        if (fc) {
            fields(fc, ["mode"], "functionCallingConfig");
            if (fc.mode && String(fc.mode).toUpperCase() !== "AUTO")
                fail("MakerSuite bridge currently supports only AUTO tool choice");
        }
    }
    let safety = [7, 8, 9, 10].map(c => [null, null, c, 5]);
    const settings = g.safetySettings || g.safety_settings;
    if (settings)
        safety = settings.map(s => {
            fields(s, ["category", "threshold"], "safetySettings");
            if (!Number.isInteger(CAT[s.category]) || !Number.isInteger(THR[s.threshold]))
                fail("Unknown MakerSuite safety category or threshold");
            return [null, null, CAT[s.category], THR[s.threshold]];
        });
    if (!Array.isArray(g.contents) || !g.contents.length) fail("Generation requires contents");
    const contents = g.contents.map(toContent),
        si = g.systemInstruction || g.system_instruction;
    const sys = si ? toContent(si) : null;
    if (sys) sys[1] = "user";
    const body = [
        "models/" + model,
        contents,
        safety,
        fill(cfg),
        null,
        sys,
        encTools(g.tools),
        null,
        null,
        null,
        1,
        null,
        null,
        [[null, null, "UTC"]],
    ];
    const ht = contents
        .flatMap(c => c[0])
        .map(p => (p[1] != null ? p[1] : p[2] ? p[2][1] : ""))
        .join(" ");
    return { body, ht };
}
function convChunk(m) {
    const out = {};
    if (Array.isArray(m[0]))
        out.candidates = m[0].map((c, i) => {
            if (!Array.isArray(c?.[0]?.[0])) fail("Invalid MakerSuite candidate", 502);
            const parts = c[0][0].map(p => {
                const o = {};
                if (typeof p[1] === "string") o.text = p[1];
                if (Array.isArray(p[2])) o.inlineData = { data: p[2][1], mimeType: p[2][0] };
                if (Array.isArray(p[10])) {
                    o.functionCall = { args: decStruct(p[10][1]), name: p[10][0] };
                    if (p[10][2]) o.functionCall.id = p[10][2];
                }
                if (p[12] === 1 || p[12] === true) o.thought = true;
                if (p[14]) o.thoughtSignature = p[14];
                if (!Object.keys(o).length) fail("Unknown MakerSuite response part", 502);
                return o;
            });
            const cand = { content: { parts, role: "model" }, index: i };
            if (c[1]) cand.finishReason = Object.hasOwn(FIN, c[1]) ? FIN[c[1]] : "OTHER";
            return cand;
        });
    if (Array.isArray(m[2])) {
        out.usageMetadata = {};
        for (const [key, idx] of Object.entries({
            candidatesTokenCount: 1,
            promptTokenCount: 0,
            thoughtsTokenCount: 9,
            totalTokenCount: 2,
        })) {
            if (typeof m[2][idx] === "number") out.usageMetadata[key] = m[2][idx];
        }
    }
    if (typeof m[7] === "string") out.responseId = m[7];
    return out;
}
function merge(chunks) {
    const candidates = new Map();
    const out = { candidates: [] };
    for (const ch of chunks) {
        for (const c of ch.candidates || []) {
            let dest = candidates.get(c.index);
            if (!dest) {
                dest = { content: { parts: [], role: "model" }, index: c.index };
                candidates.set(c.index, dest);
            }
            if (c.finishReason) dest.finishReason = c.finishReason;
            for (const p of c.content.parts) {
                const last = dest.content.parts.at(-1);
                if (p.text != null && last?.text != null && !!last.thought === !!p.thought && !last.thoughtSignature) {
                    last.text += p.text;
                    if (p.thoughtSignature) last.thoughtSignature = p.thoughtSignature;
                } else if (
                    (p.text === undefined || p.text === "") &&
                    p.thoughtSignature &&
                    Object.keys(p).every(key => ["text", "thought", "thoughtSignature"].includes(key)) &&
                    last
                )
                    last.thoughtSignature = p.thoughtSignature;
                else dest.content.parts.push({ ...p });
            }
        }
        if (ch.usageMetadata) out.usageMetadata = { ...out.usageMetadata, ...ch.usageMetadata };
        if (ch.responseId) out.responseId = ch.responseId;
    }
    out.candidates = [...candidates.values()];
    if (!out.candidates.length || out.candidates.some(c => !c.finishReason))
        fail("MakerSuite response ended without a confirmed finish reason", 502);
    return out;
}
function wrapResponse(text, streamed) {
    let root;
    try {
        root = JSON.parse(text);
    } catch {
        return fail("Invalid MakerSuite response JSON", 502);
    }
    // Observed envelopes: [chunk, ...] or [[chunk, ...]]. A chunk may contain usage only.
    const isChunk = x =>
        Array.isArray(x) &&
        ((Array.isArray(x[0]) &&
            x[0].length > 0 &&
            x[0].every(c => Array.isArray(c?.[0]?.[0]) && c[0][1] === "model")) ||
            ((x[0] == null || (Array.isArray(x[0]) && x[0].length === 0)) && Array.isArray(x[2])));
    const arr = Array.isArray(root) && root.some(isChunk) ? root : root?.[0];
    if (!Array.isArray(arr)) fail("Unrecognized MakerSuite response envelope", 502);
    for (const record of arr) {
        if (Array.isArray(record) && Number.isInteger(record[0]) && record[0] !== 0 && typeof record[1] === "string") {
            throw Object.assign(new Error(record[1]), { rpcStatus: record, status: RPC_STATUS[record[0]] || 502 });
        }
    }
    const chunks = arr.filter(isChunk).map(convChunk);
    const merged = merge(chunks); // Validate completion even when returning the old streamed envelope.
    if (!streamed) return JSON.stringify([JSON.stringify(merged)]);
    const tail = arr.length && !isChunk(arr.at(-1)) ? arr.at(-1) : null;
    return JSON.stringify([[...chunks.map(c => [JSON.stringify(c)]), ...(tail ? [tail] : [])]]);
}
const RPC_STATUS = { 3: 400, 5: 404, 7: 403, 8: 429, 9: 400, 13: 500, 14: 503, 16: 401 };
function errorEnvelope(text, status) {
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        value = null;
    }
    if (Array.isArray(value) && typeof value[0] === "number") {
        return { body: JSON.stringify(value), status: status >= 400 ? status : RPC_STATUS[value[0]] || 502 };
    }
    const error = value?.error;
    const message =
        typeof error?.message === "string" ? error.message : `MakerSuite upstream request failed (HTTP ${status})`;
    const code = Object.keys(RPC_STATUS).find(k => RPC_STATUS[k] === status) || 13;
    return {
        body: JSON.stringify([Number(code), message, error?.details || []]),
        status: status >= 400 ? status : 502,
    };
}
module.exports = { buildBody, decStruct, encStruct, errorEnvelope, merge, wrapResponse };
