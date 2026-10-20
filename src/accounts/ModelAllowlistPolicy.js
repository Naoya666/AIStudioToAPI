const { normalizeModelName } = require("../core/ModelName");
const LEVELS = Object.freeze(["free", "pro", "ultra", "ultra20"]);
const PAID_MODELS = Object.freeze(["gemini-3-flash-preview", "gemini-3.6-flash", "gemini-4-argon"]);
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
                .filter(model => normalizeModelName(model) === model.replace(/^models\//, ""))
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
                tier === "free"
                    ? names.filter(model => !PAID_MODELS.includes(model))
                    : [...new Set([...names, ...PAID_MODELS])],
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
    return policy
        ? policy.tiers[tier || "free"].includes(model)
        : !PAID_MODELS.includes(model) || (tier && tier !== "free");
}
module.exports = { allows, catalogModels, initialPolicy, LEVELS, PAID_MODELS, parsePolicy };
