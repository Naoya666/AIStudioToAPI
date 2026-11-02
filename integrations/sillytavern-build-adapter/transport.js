/* eslint-env browser */
// Build Standalone 0.6.0 snapshot (MIT); formatting adapted for this repository.
// Original adapter code. No SillyTavern implementation is bundled here.
export const WIRE_PREFIX = "BUILD_ST_CONTEXT_V1\n";
export const MODEL_PREFIX = "build-st/";
export function isBuildConnection(data) {
    return (
        String(data.model || "").startsWith(MODEL_PREFIX) &&
        (data.chat_completion_source === "custom" ||
            (data.chat_completion_source === "openai" &&
                typeof data.reverse_proxy === "string" &&
                !!data.reverse_proxy.trim()))
    );
}
export const MAX_SEGMENTS = 20000;
const background = new Set([
    "worldInfoBefore",
    "worldInfoAfter",
    "charDescription",
    "charPersonality",
    "scenario",
    "personaDescription",
    "dialogueExamples",
    "summary",
    "authorsNote",
    "vectorsMemory",
    "vectorsDataBank",
    "smartContext",
]);
const controls = new Set([
    "main",
    "nsfw",
    "jailbreak",
    "enhanceDefinitions",
    "groupNudge",
    "continueNudge",
    "impersonate",
    "quietPrompt",
    "bias",
    "newMainChat",
    "newChat",
    "emptyUserMessageReplacement",
]);
const fail = code => {
    throw Object.assign(new Error(code), { code });
};
export function presetSource(id, settings) {
    if (background.has(id)) return false;
    if (controls.has(id)) return true;
    return !!settings?.prompts?.some(p => p.identifier === id && p.marker !== true && !background.has(id));
}
// Temporary boundaries survive ST's in-chat prompt grouping. They are added to
// prepared copies only, never to saved presets or chat messages.
export function createTagger(nonce) {
    if (!/^[a-f0-9]{24}$/.test(nonce)) fail("invalid_nonce");
    let sequence = 0,
        fault = null;
    const entries = new Map(),
        bySource = new Map();
    const prefix = `[[BST:${nonce}:`;
    const expression = new RegExp(`\\[\\[BST:${nonce}:(\\d+):(BEGIN|END)\\]\\]`, "g");
    function split(text, fallback) {
        const output = [];
        let offset = 0,
            active = null,
            found = 0;
        for (const match of text.matchAll(expression)) {
            const meta = entries.get(match[1]);
            if (!meta) fail("unknown_boundary");
            if (match.index > offset)
                output.push({ ...(active?.meta || fallback), text: text.slice(offset, match.index) });
            if (match[2] === "BEGIN") {
                if (active) fail("nested_boundary");
                active = { id: match[1], meta };
            } else {
                if (active?.id !== match[1]) fail("broken_boundary");
                active = null;
            }
            offset = match.index + match[0].length;
            found++;
        }
        if (active) fail("broken_boundary");
        if (offset < text.length) output.push({ ...fallback, text: text.slice(offset) });
        if (!found && text.includes(prefix)) fail("broken_boundary");
        return output.length ? output : [{ ...fallback, text: "" }];
    }
    function strip(text) {
        return typeof text === "string"
            ? split(text, {})
                  .map(x => x.text)
                  .join("")
            : text;
    }
    function mark(text, meta) {
        if (!text) return text;
        const key = JSON.stringify(meta);
        let id = bySource.get(key);
        if (!id) {
            if (entries.size >= MAX_SEGMENTS) {
                fault = "boundary_capacity";
                fail(fault);
            }
            id = String(++sequence);
            entries.set(id, meta);
            bySource.set(key, id);
        }
        return `${prefix}${id}:BEGIN]]${text}${prefix}${id}:END]]`;
    }
    return {
        get fault() {
            return fault;
        },
        mark,
        prefix,
        split,
        strip,
    };
}

export function hookPromptManager(manager, tagger, active) {
    const original = manager.preparePrompt;
    if (typeof original !== "function") fail("prompt_api_missing");
    function prepared(prompt, originalText = null) {
        if (!active()) return original.call(this, prompt, originalText);
        const id = prompt?.identifier || "";
        const history = /^chatHistory-\d+$/.test(id);
        // Re-preparation of a history message must retain its inner source boundaries.
        const source = history ? prompt : { ...prompt, content: tagger.strip(prompt?.content) };
        const result = original.call(this, source, tagger.strip(originalText));
        if (result?.then) fail("prompt_api_async");
        if (history || typeof result?.content !== "string" || !result.content) return result;
        const placement = presetSource(id, this.serviceSettings) ? "inline" : "file";
        return Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
            content: tagger.mark(result.content, { placement, source: id || "context" }),
        });
    }
    manager.preparePrompt = prepared;
    return () => {
        if (manager.preparePrompt === prepared) manager.preparePrompt = original;
    };
}

function textMessage(m) {
    const call = m?.role === "assistant" && (m.tool_calls || m.function_call);
    if (
        !m ||
        !["system", "developer", "user", "assistant", "tool", "function"].includes(m.role) ||
        (typeof m.content !== "string" && !(call && m.content === null)) ||
        m.reasoning ||
        m.signature
    )
        fail("text_only");
    if (m.name !== undefined && (typeof m.name !== "string" || m.name.length > 128)) fail("invalid_name");
    return { content: m.content ?? "", role: m.role, ...(m.name ? { name: m.name } : {}) };
}
export function toolMessageMetadata(chat) {
    return chat.flatMap((m, message) => {
        const fields = {};
        for (const field of ["tool_calls", "tool_call_id", "function_call"])
            if (m[field] !== undefined) fields[field] = m[field];
        if (m.content === null) fields.contentNull = true;
        return Object.keys(fields).length ? [{ message, ...fields }] : [];
    });
}
// Read the enabled presets where ST actually prepares them, then extract their
// final expanded copies at send time. All other final text is background. No
// comparison with Prompt Manager's mutable inspection tree is needed.
export function readPresetSegments(chat, tagger, { latestUserText } = {}) {
    if (tagger.fault) fail(tagger.fault);
    if (!Array.isArray(chat) || !chat.length) fail("text_only");
    const pieces = [];
    let prepared = false,
        current = -1;
    for (let i = 0; i < chat.length; i++) {
        const sent = textMessage(chat[i]);
        if (sent.content.includes(tagger.prefix)) prepared = true;
        const toolHistory = ["tool", "function"].includes(sent.role) || chat[i].tool_calls || chat[i].function_call;
        const split = toolHistory
            ? [{ placement: "file", source: "tool-history", text: sent.content }]
            : tagger.split(sent.content, { placement: "file", source: "conversation-context" });
        // An exact unmarked user message can remain in the composer. A user-role
        // preset or World Info fragment must never be promoted as the current turn.
        if (sent.role === "user" && sent.content === latestUserText && !sent.content.includes(tagger.prefix))
            current = i;
        split.forEach((piece, part) =>
            pieces.push({ message: i, part, role: sent.role, ...(sent.name ? { name: sent.name } : {}), ...piece })
        );
    }
    if (!prepared) fail("preset_not_ready");
    for (const piece of pieces)
        if (piece.message === current) {
            piece.placement = "inline";
            piece.source = "currentUser";
        }
    if (pieces.length > MAX_SEGMENTS) fail("too_many_segments");
    return pieces;
}
export function encodeEnvelope(segments, generationType = "normal", inlineTokens = null, messageMetadata = []) {
    return {
        content:
            WIRE_PREFIX +
            JSON.stringify({
                generationType: generationType || "normal",
                inlineTokens,
                segments,
                version: messageMetadata.length ? 2 : 1,
                ...(messageMetadata.length ? { messageMetadata } : {}),
            }),
        role: "user",
    };
}
export function errorEnvelope(code) {
    return { content: WIRE_PREFIX + JSON.stringify({ error: code, version: 1 }), role: "user" };
}
export const excludedSampling = [
    "temperature",
    "top_p",
    "top_k",
    "top_a",
    "min_p",
    "presence_penalty",
    "frequency_penalty",
    "repetition_penalty",
    "stop",
    "seed",
    "logprobs",
    "top_logprobs",
    "logit_bias",
    "reasoning_effort",
    "user",
    "verbosity",
];
export function prepareOutgoing(data, prepared, { inlineTokens = null, tokenBudget = 45000 } = {}) {
    if (!isBuildConnection(data)) return null;
    if (data.json_schema || data.request_images || data.n > 1) fail("text_only");
    if (
        data.chat_completion_source === "custom" &&
        (String(data.custom_include_body || "").trim() || String(data.custom_exclude_body || "").trim())
    )
        fail("custom_body_conflict");
    if (!prepared) fail("preset_not_ready");
    if (!Number.isFinite(inlineTokens) || inlineTokens < 0) fail("token_count_unavailable");
    if (inlineTokens > tokenBudget) fail("inline_budget_exceeded");
    return encodeEnvelope(
        prepared.segments,
        prepared.generationType || data.type,
        Math.ceil(inlineTokens),
        toolMessageMetadata(data.messages || [])
    );
}
export function applyOutgoing(data, envelope) {
    // Custom-body JSON is also valid YAML, and ST applies it after constructing
    // the OpenAI body. No server plugin or modification of ST core is required.
    data.messages = [envelope];
    if (data.chat_completion_source === "custom") {
        const toolFields = {};
        for (const key of ["tools", "tool_choice", "parallel_tool_calls", "functions", "function_call"])
            if (data[key] !== undefined) toolFields[key] = data[key];
        data.custom_include_body = JSON.stringify({ messages: [envelope], ...toolFields });
        data.custom_exclude_body = JSON.stringify(excludedSampling);
        data.custom_prompt_post_processing = "";
    } else {
        // ST's OpenAI reverse-proxy path forwards messages directly and never
        // applies custom-body overrides. Preserve its route and credentials.
        for (const field of excludedSampling) delete data[field];
    }
}
