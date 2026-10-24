/**
 * Synthetic transport semantics based on Antigravity Gateway (MIT, Xeltra233).
 * See docs/licenses/antigravity-gateway-MIT.txt. Gemini arguments are structured,
 * so this adapter deliberately does not treat them as OpenAI JSON token fragments.
 */
const { randomBytes } = require("node:crypto");
const FormatConverter = require("./FormatConverter");
const { upstreamError } = require("../utils/UpstreamError");
const { promptBlocked } = require("../utils/UpstreamBlock");
const MAX_BYTES = 10 * 1024 * 1024;
const TEXT_MODELS = Object.freeze([
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-4-argon",
]);
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

function identity(value) {
    const { cleanModelName: model, antiTruncation: prefixed } = FormatConverter.parseModelAntiPrefix(value);
    const tools = FormatConverter.parseModelBuiltInToolSuffixes(model);
    const stream = FormatConverter.parseModelStreamingModeSuffix(tools.cleanModelName);
    const thinking = FormatConverter.parseModelThinkingLevel(stream.cleanModelName);
    return { model, prefixed, realModel: thinking.cleanModelName, ...tools, streamingMode: stream.streamingMode };
}

function resolve(body, config, protocol = "openai", modelName = body.model || "gemini-2.5-flash-lite") {
    const id = identity(modelName);
    if (body.anti_truncation !== undefined && typeof body.anti_truncation !== "boolean")
        throw error("invalid_anti_truncation", "anti_truncation must be a boolean");
    const source = body.anti_truncation !== undefined ? "request" : id.prefixed ? "prefix" : "default";
    const enabled = body.anti_truncation ?? (id.prefixed || config.antiTruncationDefault === "prefer");
    const explicit = enabled && source !== "default";
    const skip = reason => {
        if (explicit) throw error(reason, "Anti-truncation is unavailable for this request");
        return { ...id, enabled: false, reason, source };
    };
    if (!enabled) return { ...id, enabled: false, source };
    if (config.antiTruncationEnabled === false) return skip("anti_truncation_disabled");
    if (protocol !== "openai") return skip("anti_truncation_unsupported_protocol");
    const choice = body.tool_choice ?? body.function_call;
    if (choice && typeof choice === "object" && (choice.function?.name || choice.name))
        return { ...id, enabled: false, reason: "forced_real_tool", source };
    // Only allow the text/function protocol verified by isolated tests. New models
    // and hosted-tool combinations need a separate capability verification.
    if (!TEXT_MODELS.includes(id.realModel)) return skip("anti_truncation_unsupported_model");
    if (
        id.forceCodeExecution ||
        id.forceWebSearch ||
        config.forceCodeExecution ||
        config.forceWebSearch ||
        config.forceUrlContext ||
        body.response_format ||
        body.audio ||
        body.modalities?.some(mode => mode !== "text") ||
        body.messages?.some(
            message => Array.isArray(message.content) && message.content.some(part => part.type !== "text")
        ) ||
        body.tools?.some(tool => tool.type !== "function") ||
        body.functions ||
        (choice !== undefined && !["auto", "none", "required"].includes(choice))
    )
        return skip("anti_truncation_unsupported_combination");
    return { ...id, enabled: true, source };
}

function inject(baseline) {
    const body = structuredClone(baseline);
    delete body.anti_truncation;
    const names = new Set((body.tools || []).map(tool => tool.function?.name));
    let name;
    do {
        name = `agw_emit_${randomBytes(12).toString("hex")}`;
    } while (names.has(name));
    const synthetic = {
        function: {
            description:
                "Use this transport exactly once for the complete final user-visible answer in content. Never wrap genuine tool calls.",
            name,
            parameters: { properties: { content: { type: "string" } }, required: ["content"], type: "object" },
        },
        type: "function",
    };
    if ((body.tool_choice ?? body.function_call) === "none") {
        body.tools = [synthetic];
        body.tool_choice = { function: { name }, type: "function" };
    } else {
        body.tools = [...(body.tools || []), synthetic];
        body.tool_choice ||= body.function_call || "auto";
    }
    body.messages = [
        ...(body.messages || []),
        {
            content: `Always use tool ${name} exactly once to deliver your complete final reply in its content argument. Do not output final-answer text outside this tool. Preserve genuine tool calls and never wrap them in this transport.`,
            role: "user",
        },
    ];
    return { body, name };
}

function decode(args) {
    let value = args;
    let repaired = false;
    if (typeof args === "string") {
        if (Buffer.byteLength(args) > MAX_BYTES)
            throw error("anti_truncation_limit", "Synthetic response exceeds size limit", 502);
        let raw = args.trim();
        if (raw.startsWith("```")) {
            raw = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\s*```$/, "");
            repaired = true;
        }
        try {
            value = JSON.parse(raw);
        } catch {
            // Only close missing delimiters, never guess incomplete escapes/text.
            if (/^\{\s*"content"\s*:\s*"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*$/.test(raw)) raw += '"}';
            else if (/^\{\s*"content"\s*:\s*"(?:[^"\\]|\\.)*"\s*,?\s*$/.test(raw)) raw = raw.replace(/,\s*$/, "") + "}";
            try {
                value = JSON.parse(raw);
                repaired = true;
            } catch {
                throw error("anti_truncation_decode_failed", "Invalid synthetic response arguments", 502);
            }
        }
    }
    if (!value || Array.isArray(value) || typeof value !== "object" || typeof value.content !== "string")
        throw error("anti_truncation_decode_failed", "Synthetic response requires string content", 502);
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES)
        throw error("anti_truncation_limit", "Synthetic response exceeds size limit", 502);
    return { content: value.content, repaired };
}

function parseResponse(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        throw error("anti_truncation_decode_failed", "Invalid upstream JSON response", 502);
    }
}

class Attempt {
    constructor(name, log = () => {}, sideBufferBytes = 0) {
        this.name = name;
        this.log = log;
        this.sideBufferBytes = sideBufferBytes;
        this.choices = new Map();
        this.converterStates = new Map();
        this.bytes = 0;
        this.responseBytes = 0;
        this.input = "";
        this.upstreamDone = false;
    }
    read(data, eof = false) {
        this.input += data;
        if (Buffer.byteLength(this.input) > MAX_BYTES)
            throw error("anti_truncation_limit", "Upstream event exceeds size limit", 502);
        const responses = [];
        const parse = raw => {
            if (!raw.trim()) return;
            if (raw.trim() === "[DONE]") {
                this.upstreamDone = true;
                return;
            }
            if (this.upstreamDone) throw error("anti_truncation_protocol_error", "Output after upstream DONE", 502);
            try {
                responses.push(JSON.parse(raw));
            } catch {
                throw error("anti_truncation_decode_failed", "Invalid upstream JSON event", 502);
            }
        };
        if (this.input.trimStart().startsWith("{")) {
            try {
                JSON.parse(this.input);
            } catch {
                if (eof) throw error("anti_truncation_decode_failed", "Incomplete upstream JSON event", 502);
                return responses;
            }
            parse(this.input);
            this.input = "";
            return responses;
        }
        let match;
        while ((match = /\r?\n\r?\n/.exec(this.input))) {
            const event = this.input.slice(0, match.index);
            this.input = this.input.slice(match.index + match[0].length);
            const raw = event
                .split(/\r?\n/)
                .filter(line => line.startsWith("data:"))
                .map(line => line.slice(5).trimStart())
                .join("\n");
            parse(raw);
        }
        if (eof && this.input.trim()) {
            const tail = this.input.trim();
            if (!tail.startsWith(":")) parse(tail.replace(/^data:\s*/, ""));
            this.input = "";
        }
        return responses;
    }
    restore(response, buffered = false) {
        const blocked = promptBlocked(response);
        if (blocked) {
            this.usageMetadata = blocked.usageMetadata;
            this.log("upstream_blocked", blocked.upstream);
            throw blocked;
        }
        if (response?.error) throw upstreamError(response.error);
        if (!response || typeof response !== "object")
            throw error("anti_truncation_decode_failed", "Invalid upstream response", 502);
        this.responseBytes += Buffer.byteLength(JSON.stringify(response));
        if (this.responseBytes > MAX_BYTES)
            throw error("anti_truncation_limit", "Anti-truncation response exceeds size limit", 502);
        const result = structuredClone(response);
        if (result.candidates !== undefined && !Array.isArray(result.candidates))
            throw error("anti_truncation_protocol_error", "Invalid upstream candidates", 502);
        for (const [position, candidate] of (result.candidates || []).entries()) {
            if (!candidate || typeof candidate !== "object")
                throw error("anti_truncation_protocol_error", "Invalid upstream candidate", 502);
            const index = candidate.index ?? position;
            if (!Number.isSafeInteger(index) || index < 0 || index > 127)
                throw error("anti_truncation_protocol_error", "Invalid upstream choice index", 502);
            let state = this.choices.get(index);
            if (!state) {
                state = { active: false, ended: false, pending: [], pendingBytes: 0 };
                this.choices.set(index, state);
            }
            if (state.ended) throw error("anti_truncation_protocol_error", "Output after choice finished", 502);
            const parts = candidate.content?.parts || [];
            const found = parts.some(part => part.functionCall?.name === this.name);
            if (found) {
                if (state.pending.length || state.plainDelivered) this.log("content_conflict");
                state.pending = [];
                state.pendingBytes = 0;
                state.active = true;
            }
            const output = [];
            for (const part of parts) {
                if (part.functionCall?.name === this.name) {
                    const decoded = decode(part.functionCall.args);
                    this.bytes += Buffer.byteLength(decoded.content);
                    if (this.bytes > MAX_BYTES)
                        throw error("anti_truncation_limit", "Synthetic response exceeds size limit", 502);
                    this.log(decoded.repaired ? "synthetic_repaired" : "synthetic_hit");
                    output.push({ text: decoded.content });
                } else if (!part.thought && part.text) {
                    if (state.active) {
                        this.log("content_conflict");
                        continue;
                    }
                    if (buffered || this.sideBufferBytes > 0) {
                        state.pending.push(part);
                        state.pendingBytes += Buffer.byteLength(part.text);
                        if (!buffered && state.pendingBytes >= this.sideBufferBytes) {
                            output.push(...state.pending);
                            state.plainDelivered = true;
                            state.pending = [];
                            state.pendingBytes = 0;
                        }
                    } else {
                        output.push(part);
                        state.plainDelivered = true;
                    }
                } else output.push(part);
            }
            if (candidate.finishReason || buffered) {
                output.push(...state.pending);
                state.pending = [];
                state.pendingBytes = 0;
                state.ended = Boolean(candidate.finishReason);
            }
            if (candidate.content) candidate.content.parts = output;
            else if (output.length) candidate.content = { parts: output };
        }
        return result;
    }
    assertComplete() {
        if (!this.choices.size || [...this.choices.values()].some(choice => !choice.ended))
            throw error("anti_truncation_incomplete_stream", "Upstream ended before a finish event", 502);
    }
    nonStream(response, converter, model) {
        const restored = this.restore(response, true);
        this.assertComplete();
        const converted = converter.convertGoogleToOpenAINonStream(restored, model, { privateTransport: true });
        converted.choices = restored.candidates.map((candidate, position) => {
            const single = converter.convertGoogleToOpenAINonStream({ ...restored, candidates: [candidate] }, model, {
                privateTransport: true,
            }).choices[0];
            single.index = candidate.index ?? position;
            if (candidate.finishReason && candidate.finishReason !== "STOP")
                single.finish_reason = converter._mapFinishReason(candidate.finishReason);
            return single;
        });
        return converted;
    }
    stream(response, converter, model, shared, buffered = false) {
        const restored = this.restore(response, buffered);
        shared.id ||= `chatcmpl-${randomBytes(12).toString("hex")}`;
        shared.created ||= Math.floor(Date.now() / 1000);
        shared.model ||= model;
        if (restored.usageMetadata) this.usage = converter._parseUsage(restored);
        let output = "";
        for (const [position, candidate] of (restored.candidates || []).entries()) {
            const index = candidate.index ?? position;
            let state = this.converterStates.get(index);
            if (!state) {
                state = {
                    created: shared.created,
                    id: shared.id,
                    includeUsage: false,
                    model: shared.model,
                    roleSent: index === 0 && shared.roleSent,
                };
                this.converterStates.set(index, state);
            }
            const chunks =
                converter.translateGoogleToOpenAIStream(JSON.stringify({ candidates: [candidate] }), model, state, {
                    privateTransport: true,
                }) || "";
            for (const line of chunks.split("\n")) {
                if (!line.startsWith("data: {")) continue;
                const event = JSON.parse(line.slice(6));
                for (const choice of event.choices) {
                    choice.index = index;
                    if (choice.finish_reason && candidate.finishReason !== "STOP")
                        choice.finish_reason = converter._mapFinishReason(candidate.finishReason);
                }
                output += `data: ${JSON.stringify(event)}\n\n`;
            }
        }
        return output;
    }
    usageEvent(shared) {
        if (!this.usage || shared.includeUsage === false || this.usageSent) return "";
        this.usageSent = true;
        return `data: ${JSON.stringify({ choices: [], created: shared.created, id: shared.id, model: shared.model, object: "chat.completion.chunk", usage: this.usage })}\n\n`;
    }
}
module.exports = { Attempt, decode, identity, inject, MAX_BYTES, parseResponse, resolve, TEXT_MODELS };
