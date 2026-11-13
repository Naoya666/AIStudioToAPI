const { normalizeModelName } = require("../core/ModelName");
const LEVELS = Object.freeze(["free", "pro", "ultra", "ultra20"]);
const PAID_MODELS = Object.freeze(["gemini-3.1-pro-preview", "gemini-4-argon"]);
const ULTRA_MODELS = Object.freeze(["gemini-4-carbon"]);
const PLAYGROUND_MODELS = Object.freeze([
    ...PAID_MODELS,
    ...ULTRA_MODELS,
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3-flash-preview",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
]);
function defaultAllows(tier, model) {
    if (ULTRA_MODELS.includes(model)) return ["ultra", "ultra20"].includes(tier);
    return (!PAID_MODELS.includes(model) && model !== "build/gemini-4-argon") || !!(tier && tier !== "free");
}
const fail = message => Object.assign(new Error(`MODEL_TIER_ALLOWLIST: ${message}`), { status: 400 });
function parsePolicy(value) {
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch {
            throw fail("无效 JSON");
        }
    }
    if (
        !value ||
        value.version !== 1 ||
        !value.tiers ||
        Array.isArray(value.tiers) ||
        Object.keys(value).some(key => !["version", "tiers"].includes(key)) ||
        Object.keys(value.tiers).length !== LEVELS.length ||
        Object.keys(value.tiers).some(tier => !LEVELS.includes(tier))
    )
        throw fail("需要 version: 1 和完整的四个层级");
    const tiers = {};
    for (const tier of LEVELS) {
        if (!Array.isArray(value.tiers[tier])) throw fail(`${tier} 必须为数组`);
        tiers[tier] = [...new Set(value.tiers[tier].map(model => normalizeModelName(model)))].sort();
    }
    return { tiers, version: 1 };
}
function catalogModels(models) {
    return [
        ...new Set(
            models
                .map(model => (typeof model === "string" ? model : model.name))
                .filter(model => typeof model === "string" && !model.replace(/^models\//, "").startsWith("__"))
                .filter(
                    model =>
                        require("../core/codeAssistant/ModelIdentity").isBuild(model) ||
                        normalizeModelName(model) === model.replace(/^models\//, "")
                )
                .map(model => normalizeModelName(model))
        ),
    ];
}
function initialPolicy(models) {
    const names = catalogModels(models);
    return parsePolicy({
        tiers: Object.fromEntries(
            LEVELS.map(tier => [
                tier,
                [...new Set([...names, ...(tier === "free" ? [] : PAID_MODELS)])].filter(model =>
                    defaultAllows(tier, model)
                ),
            ])
        ),
        version: 1,
    });
}
// Missing policy is supported only by isolated/legacy callers without a configured model catalog.
// Production configuration always supplies a persisted, explicit policy.
function allows(tier, model, policy) {
    if (model === "__files__") return true;
    model = normalizeModelName(model);
    return policy ? policy.tiers[tier || "free"].includes(model) : defaultAllows(tier, model);
}
module.exports = {
    allows,
    catalogModels,
    defaultAllows,
    initialPolicy,
    LEVELS,
    PAID_MODELS,
    parsePolicy,
    PLAYGROUND_MODELS,
};
