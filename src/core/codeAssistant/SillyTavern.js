// Adapted from qiwu622/build-standalone (MIT); see THIRD_PARTY_NOTICES.md.
const WIRE_PREFIX = "BUILD_ST_CONTEXT_V1\n",
    MAX_SEGMENTS = 20000;
const error = (message, status = 400, code = "invalid_request") => Object.assign(new Error(message), { code, status });
const fail = message => {
    throw error(message, 400, "sillytavern_context_invalid");
};
function parseSillyTavern(messages) {
    if (
        !Array.isArray(messages) ||
        messages.length !== 1 ||
        messages[0]?.role !== "user" ||
        typeof messages[0]?.content !== "string" ||
        !messages[0].content.startsWith(WIRE_PREFIX)
    )
        fail("build-st/ 需要安装兼容的酒馆分段扩展并刷新酒馆；普通客户端请改用 build/");
    let value;
    try {
        value = JSON.parse(messages[0].content.slice(WIRE_PREFIX.length));
    } catch {
        fail("酒馆上下文封装损坏");
    }
    if (!value || ![1, 2, 3].includes(value.version)) fail("不支持的酒馆适配版本");
    if (value.error) fail("酒馆适配器已阻止请求，请查看酒馆中的 Build 分流提示；未调用 Google");
    if (!["normal", "regenerate", "swipe", "continue", "quiet", "impersonate"].includes(value.generationType))
        fail("不支持的酒馆生成类型");
    if (!Array.isArray(value.segments) || !value.segments.length || value.segments.length > MAX_SEGMENTS)
        fail("酒馆分段数量无效");
    let lastMessage = -1,
        lastPart = -1,
        lastRole,
        lastName,
        inlineBytes = 0;
    const segments = value.segments.map(s => {
        if (
            !s ||
            !Number.isSafeInteger(s.message) ||
            !Number.isSafeInteger(s.part) ||
            s.message < 0 ||
            s.part < 0 ||
            !["system", "developer", "user", "assistant", "tool", "function"].includes(s.role) ||
            !["inline", "file"].includes(s.placement) ||
            typeof s.text !== "string" ||
            (s.media !== undefined &&
                (value.version !== 3 ||
                    s.text !== "" ||
                    s.placement !== "file" ||
                    !s.media ||
                    typeof s.media !== "object" ||
                    Array.isArray(s.media))) ||
            typeof s.source !== "string" ||
            s.source.length > 128
        )
            fail("酒馆分段结构无效");
        if (["tool", "function"].includes(s.role) && s.placement !== "file") fail("工具结果必须放在附件中");
        if (s.message === lastMessage) {
            if (s.part !== lastPart + 1) fail("酒馆分段顺序不连续");
            if (s.role !== lastRole || (s.name || "") !== lastName) fail("同一条酒馆消息的角色不一致");
        } else if (s.message !== lastMessage + 1 || s.part !== 0) fail("酒馆消息顺序不连续");
        if (s.name !== undefined && (typeof s.name !== "string" || s.name.length > 128)) fail("酒馆角色名称无效");
        lastMessage = s.message;
        lastPart = s.part;
        lastRole = s.role;
        lastName = s.name || "";
        if (s.placement === "inline") inlineBytes += Buffer.byteLength(s.text);
        return {
            message: s.message,
            part: s.part,
            placement: s.placement,
            role: s.role,
            source: s.source,
            text: s.text,
            ...(s.name ? { name: s.name } : {}),
            ...(s.media ? { media: s.media } : {}),
        };
    });
    if (inlineBytes > 1024 * 1024)
        throw error("输入框原文超过 1 MiB 安全大小限制；未移入文件或截断", 413, "inline_too_large");
    if (
        value.inlineTokens !== null &&
        value.inlineTokens !== undefined &&
        (!Number.isSafeInteger(value.inlineTokens) || value.inlineTokens < 0 || value.inlineTokens > 45000)
    )
        throw error("酒馆估算的输入框内容超过 45000 token；未截断预设", 413, "inline_too_large");
    const messageMetadata = value.messageMetadata ?? [],
        seen = new Set();
    const grouped = new Map();
    for (const s of segments) {
        if (!grouped.has(s.message)) grouped.set(s.message, []);
        grouped.get(s.message).push(s);
    }
    if (!Array.isArray(messageMetadata) || messageMetadata.length > lastMessage + 1) fail("工具历史元数据无效");
    for (const m of messageMetadata) {
        if (
            !m ||
            typeof m !== "object" ||
            Array.isArray(m) ||
            Object.keys(m).some(
                k => !["message", "contentNull", "tool_calls", "tool_call_id", "function_call"].includes(k)
            ) ||
            !Number.isSafeInteger(m.message) ||
            m.message < 0 ||
            m.message > lastMessage ||
            seen.has(m.message)
        )
            fail("工具历史元数据无效");
        if (m.contentNull !== undefined && m.contentNull !== true) fail("工具历史空正文标记无效");
        const parts = grouped.get(m.message);
        if (parts.some(s => s.placement !== "file")) fail("工具调用历史必须放在附件中");
        if (m.contentNull && (parts[0].role !== "assistant" || parts.some(s => s.text !== "" || s.media)))
            fail("工具历史空正文标记与内容不一致");
        seen.add(m.message);
    }
    return {
        generationType: value.generationType,
        inlineTokens: value.inlineTokens ?? null,
        segments,
        ...(messageMetadata.length ? { messageMetadata } : {}),
    };
}

function sillyTavernMessages(context) {
    const messages = [];
    for (const s of context.segments) {
        if (s.part === 0) messages.push({ content: s.text, role: s.role, ...(s.name ? { name: s.name } : {}) });
        else messages.at(-1).content += s.text;
    }
    for (const { message, contentNull, ...fields } of context.messageMetadata || []) {
        Object.assign(messages[message], fields);
        if (contentNull) messages[message].content = null;
    }
    return messages;
}

module.exports = { parseSillyTavern, sillyTavernMessages, WIRE_PREFIX };
