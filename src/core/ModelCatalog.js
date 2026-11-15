const { normalizeModelName } = require("./ModelName");
const FEATURES = Object.freeze([
    "openai",
    "responses",
    "claude",
    "gemini",
    "tools",
    "hostedTools",
    "structuredOutput",
    "multimodal",
    "streaming",
    "thinking",
    "antiTruncation",
    "antiCombinations",
]);
const TIERS = ["free", "pro", "ultra", "ultra20"];
const fail = message => Object.assign(new Error(`模型目录：${message}`), { status: 400 });
function validate(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw fail("需要 1–1000 个模型");
    const names = new Set();
    for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.name !== "string")
            throw fail("模型需要 name");
        const id = row.name.replace(/^models\//, "");
        // Legacy Build aliases remain valid catalog entries; policy uses the canonical ID.
        const canonical = normalizeModelName(id);
        if (!require("./codeAssistant/ModelIdentity").isBuild(id) && canonical !== id)
            throw fail("请使用真实模型 ID，不包含功能后缀");
        if (names.has(id)) throw fail(`重复模型 ${id}`);
        names.add(id);
        for (const key of ["displayName", "description", "version"])
            if (row[key] !== undefined && (typeof row[key] !== "string" || row[key].length > 10000))
                throw fail(`${id} 的 ${key} 无效`);
        for (const key of ["inputTokenLimit", "outputTokenLimit"])
            if (row[key] !== undefined && row[key] !== null && (!Number.isSafeInteger(row[key]) || row[key] < 1))
                throw fail(`${id} 的 ${key} 必须为正整数或空值`);
        if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw fail("启用状态必须为布尔值");
        if (
            row.supportedGenerationMethods !== undefined &&
            (!Array.isArray(row.supportedGenerationMethods) ||
                row.supportedGenerationMethods.some(v => typeof v !== "string" || !v))
        )
            throw fail("方法列表无效");
        if (row.features !== undefined) {
            if (!row.features || Array.isArray(row.features) || typeof row.features !== "object")
                throw fail("功能配置无效");
            for (const [key, value] of Object.entries(row.features))
                if (!FEATURES.includes(key) || typeof value !== "boolean") throw fail(`无效功能 ${key}`);
        }
        if (row.quotas !== undefined) {
            if (!row.quotas || Array.isArray(row.quotas) || typeof row.quotas !== "object") throw fail("额度配置无效");
            for (const [tier, quota] of Object.entries(row.quotas)) {
                if (!TIERS.includes(tier) || !quota || typeof quota !== "object" || Array.isArray(quota))
                    throw fail("额度层级无效");
                for (const [key, value] of Object.entries(quota)) {
                    if (["requests", "tokens"].includes(key)) {
                        if (value !== null && (!Number.isSafeInteger(value) || value < 0))
                            throw fail("额度必须为非负整数或空值");
                    } else if (
                        !["source", "updatedAt", "resetNote"].includes(key) ||
                        typeof value !== "string" ||
                        value.length > 1000
                    )
                        throw fail(`无效额度字段 ${key}`);
                }
            }
        }
    }
    if (Buffer.byteLength(JSON.stringify(rows)) > 512 * 1024) throw fail("目录超过 512 KiB");
    return JSON.parse(JSON.stringify(rows));
}
function entry(rows, model) {
    if (!rows?.length) return undefined;
    const id = normalizeModelName(model);
    return rows.find(row => normalizeModelName(row.name.replace(/^models\//, "")) === id);
}
function features(rows, model) {
    return { ...Object.fromEntries(FEATURES.map(key => [key, true])), ...entry(rows, model)?.features };
}
// Build aliases remain discoverable even though administrators edit one canonical row.
function advertisedModels(rows, anti = true) {
    const identity = require("./codeAssistant/ModelIdentity");
    const result = new Map(rows.map(row => [row.name.replace(/^models\//, ""), row]));
    for (const row of rows) {
        const id = row.name.replace(/^models\//, "");
        if (!identity.isBuild(id) || identity.parse(id).canonical !== id) continue;
        for (const alias of identity.models({
            anti: anti && row.features?.antiTruncation !== false,
            bases: [identity.parse(id).upstream],
        }))
            if (!result.has(alias)) result.set(alias, { ...row, name: `models/${alias}` });
    }
    return [...result.values()];
}
function assertRequest(config, model, protocol, body = {}) {
    const row = entry(config.modelList, model);
    if (!row && config.modelList?.length) throw Object.assign(fail(`未登记模型 ${model}`), { status: 404 });
    if (row?.enabled === false) throw Object.assign(fail(`模型 ${model} 已禁用`), { status: 403 });
    const policy = features(config.modelList, model);
    const tools = require("./FormatConverter").parseModelBuiltInToolSuffixes(model);
    const toolList = Array.isArray(body.tools) ? body.tools : [];
    const contents = JSON.stringify(body.messages || body.contents || body.input || []);
    const tests = {
        hostedTools:
            tools.forceCodeExecution ||
            tools.forceWebSearch ||
            config.forceCodeExecution ||
            config.forceWebSearch ||
            config.forceUrlContext ||
            toolList.some(
                t =>
                    (t?.type && t.type !== "function") ||
                    t?.google_search ||
                    t?.googleSearch ||
                    t?.code_execution ||
                    t?.codeExecution ||
                    t?.url_context ||
                    t?.urlContext
            ),
        multimodal: !!(
            body.generationConfig?.responseModalities?.some(m => m !== "TEXT") ||
            body.generation_config?.response_modalities?.some(m => m !== "TEXT") ||
            body.audio ||
            body.modalities?.some(m => m !== "text") ||
            /"(?:image_url|input_image|input_audio|inlineData|inline_data|fileData|file_data|image|audio|video)"\s*:/.test(
                contents
            ) ||
            /"type"\s*:\s*"(?:image|input_image|image_url|input_audio|audio|video|file|document)"/.test(contents)
        ),
        [protocol]: true,
        streaming: body.stream === true,
        structuredOutput: !!(
            body.response_format ||
            body.text?.format ||
            body.generationConfig?.responseMimeType ||
            body.generationConfig?.responseSchema ||
            body.generation_config?.response_mime_type ||
            body.generation_config?.response_schema
        ),
        thinking: !!(
            config.forceThinking ||
            body.reasoning_effort ||
            body.reasoning ||
            body.thinking ||
            body.generationConfig?.thinkingConfig ||
            body.generation_config?.thinking_config ||
            require("./FormatConverter").parseModelThinkingLevel(
                require("./FormatConverter").parseModelStreamingModeSuffix(tools.cleanModelName).cleanModelName
            ).thinkingLevel
        ),
        tools: !!(
            body.tools?.length ||
            body.functions?.length ||
            body.tool_choice ||
            body.function_call ||
            body.toolConfig ||
            body.tool_config
        ),
    };
    for (const [key, used] of Object.entries(tests))
        if (used && policy[key] === false) throw fail(`管理员已关闭 ${model} 的 ${key} 功能`);
    return policy;
}
module.exports = { advertisedModels, assertRequest, entry, FEATURES, features, TIERS, validate };
