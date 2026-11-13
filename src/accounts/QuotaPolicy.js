// Operator-provided observations, PG 2026-11-13 / Build 2026-11-04. Estimates, not Google guarantees.
const FLASH = new Set([
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3-flash-preview",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
]);
function dailyBudgets(model, tier = "free", { freeBuildEstimate = 0 } = {}) {
    const build = model.startsWith("build/");
    const base = {
        requests: null,
        reset_verified: false,
        scope: build ? "build/model" : "pg/model",
        source: build ? "operator_observation_2026-11-04" : "operator_observation_2026-11-13",
        token_metric: "total_tokens",
        tokens: null,
    };
    if (build)
        return {
            ...base,
            tokens:
                model === "build/gemini-4-argon" && tier === "pro"
                    ? 20000000
                    : model === "build/gemini-3.8-flash" && tier === "free"
                      ? freeBuildEstimate > 0
                          ? freeBuildEstimate
                          : 8000000
                      : null,
        };
    if (["ultra", "ultra20"].includes(tier)) {
        if (model === "gemini-3.1-pro-preview") return { ...base, requests: 100 };
        if (FLASH.has(model) || ["gemini-4-argon", "gemini-4-carbon"].includes(model))
            return { ...base, requests: 200 };
        return base;
    }
    if (model === "gemini-4-carbon") return { ...base, requests: 0 };
    if (model === "gemini-4-hydrogen")
        return { ...base, requests: tier === "pro" ? 100 : 50, tokens: tier === "pro" ? 25000000 : 10000000 };
    if (model === "gemini-4-argon")
        return { ...base, requests: tier === "pro" ? 50 : 0, tokens: tier === "pro" ? 15000000 : null };
    if (model === "gemini-3.1-pro-preview")
        return { ...base, requests: tier === "pro" ? 50 : 0, tokens: tier === "pro" ? 13000000 : null };
    if (FLASH.has(model))
        return { ...base, requests: tier === "pro" ? 150 : 50, tokens: tier === "pro" ? 25000000 : 5000000 };
    return { ...base, source: "legacy_request_estimate" };
}
module.exports = { dailyBudgets };
