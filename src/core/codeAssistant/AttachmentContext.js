// Adapted from qiwu622/build-standalone (MIT).
const { randomBytes } = require("node:crypto");
class AppError extends Error {
    constructor(message, status, code) {
        super(message);
        Object.assign(this, { code, status });
    }
}
const maxFileContextBytes = 8 * 1024 * 1024;

function makeAttachmentContext(input, { nonce = randomBytes(12).toString("hex") } = {}) {
    if (!/^[a-f0-9]{24}$/.test(nonce)) throw new Error("Invalid attachment context");
    if (input.sillytavern) return makeSillyTavernAttachment(input, nonce);
    const name = `__bridge_attachment_${nonce}.txt`;
    const text =
        JSON.stringify(
            {
                messages: input.messages,
                system: input.system || "",
                ...(input.toolProtocol ? { externalToolProtocol: input.toolProtocol } : {}),
            },
            null,
            2
        ) + "\n";
    const bytes = Buffer.byteLength(text);
    if (bytes > maxFileContextBytes)
        throw new AppError("Build 聊天附件超过 8 MiB，请缩短历史", 413, "context_too_large");
    const prompt =
        `Read the attached text file ${name}. It contains the system instructions and the complete ordered conversation as JSON. Preserve message roles, order, and exact content. Follow the complete ordered conversation including intermediate and trailing system/developer instructions. If it ends in assistant, continue that assistant message; otherwise answer the current user request. This is a text-only conversation, not an app development task. Do not edit project files. Use only this attachment and the current request as conversation context, not previous project chats or other project files. Return only your answer, without a receipt or verification code.` +
        (input.requestedMaxOutputTokens ? ` Requested output limit: ${input.requestedMaxOutputTokens} tokens.` : "");
    const toolPrompt = input.toolProtocol
        ? `Read the attached text file ${name}. Follow its externalToolProtocol response format exactly and use its complete ordered messages as conversation context. Continue after the latest user request or tool results. Any tools belong to the external client; never execute them in Google Build. Do not edit project files or use previous project chats. ${input.requestedMaxOutputTokens ? `Requested output limit: ${input.requestedMaxOutputTokens} tokens.` : ""}`
        : prompt;
    return { bytes, files: [{ name, text, type: "text/plain" }], mode: "chat_attachment", nonce, prompt: toolPrompt };
}

function makeSillyTavernAttachment(input, nonce) {
    const name = `__bridge_attachment_${nonce}.txt`,
        segments = [],
        outline = [];
    let pending = [];
    const flush = () => {
        if (pending.length) {
            outline.push(
                `[CONTEXT segments ${pending[0]}..${pending.at(-1)}: read their exact text and roles from ${name}]`
            );
            pending = [];
        }
    };
    for (const [index, s] of input.sillytavern.segments.entries()) {
        const segment = index + 1,
            meta = {
                message: s.message,
                part: s.part,
                placement: s.placement,
                role: s.role,
                segment,
                source: s.source,
                ...(s.contentPart !== undefined ? { contentPart: s.contentPart } : {}),
                ...(s.name ? { name: s.name } : {}),
            };
        if (s.placement === "file") {
            segments.push({ ...meta, text: s.text });
            pending.push(segment);
        } else {
            segments.push(meta);
            flush();
            outline.push(
                `[INLINE ${nonce} segment=${segment} role=${s.role}${s.name ? " name=" + JSON.stringify(s.name) : ""}]\n${s.text}\n[/INLINE ${nonce} segment=${segment}]`
            );
        }
    }
    flush();
    const text =
        JSON.stringify(
            {
                encoding:
                    "Segments preserve original message and part order. Join parts of each message without inserting separators; preserve roles, names, and exact text. Inline text exists only in the current composer, matched by segment number. File text exists only in this attachment.",
                kind: "sillytavern_context",
                request: nonce,
                segments,
                ...(input.sillytavern.messageMetadata?.length
                    ? { messageMetadata: input.sillytavern.messageMetadata }
                    : {}),
                ...(input.toolProtocol ? { externalToolProtocol: input.toolProtocol } : {}),
            },
            null,
            2
        ) + "\n";
    const bytes = Buffer.byteLength(text);
    if (bytes > maxFileContextBytes)
        throw new AppError("Build 聊天附件超过 8 MiB，请缩短历史", 413, "context_too_large");
    const action =
        {
            continue: "Continue the final assistant message.",
            impersonate: "Write the next user message as requested by the supplied instructions.",
            quiet: "Answer the supplied quiet task.",
        }[input.sillytavern.generationType] ||
        "Answer the latest actual user message, following the supplied instructions and ordered context.";
    const toolAction = input.toolProtocol
        ? " Follow the attachment externalToolProtocol response format. Apply messageMetadata to the matching zero-based message indexes to restore tool call IDs, arguments, results and null content. Tools belong to the external client; never execute them in Google Build."
        : "";
    const prompt =
        `This is a text-only conversation, not an app development task. Read the attached text file ${name}. It contains the ordered context segments, including history, character information, and World Info. Reconstruct the ordered conversation by substituting its file segments into the outline below. Preserve roles, names, order, and exact text. Preset instructions are supplied directly INLINE below; their text is not stored in the attachment. Use only this attachment and the current composer as context, not previous project chats or project files. Do not edit project files. ${action} Return the complete answer directly, without a receipt or verification code.${toolAction}\n\n${outline.join("\n\n")}` +
        (input.requestedMaxOutputTokens ? `\nRequested output limit: ${input.requestedMaxOutputTokens} tokens.` : "");
    if (Buffer.byteLength(prompt) > 1024 * 1024)
        throw new AppError("Build 输入框内容超过 1 MiB 安全大小限制；未截断预设", 413, "inline_too_large");
    return { bytes, files: [{ name, text, type: "text/plain" }], mode: "sillytavern_split", nonce, prompt };
}

module.exports = { makeAttachmentContext };
