// Operator-provided observations, 2026-11-02. Estimates, not Google guarantees.
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
        scope: build ? "build/account" : "pg/model",
        source: "operator_observation_2026-11-02",
        token_metric: "total_tokens",
        tokens: null,
    };
    if (build)
        return {
            ...base,
            tokens: tier === "pro" ? 20000000 : tier === "free" && freeBuildEstimate > 0 ? freeBuildEstimate : null,
        };
    if (["ultra", "ultra20"].includes(tier)) return base;
    if (model === "gemini-4-argon")
        return { ...base, requests: tier === "pro" ? 50 : 0, tokens: tier === "pro" ? 15000000 : null };
    if (model === "gemini-3.1-pro-preview")
        return { ...base, requests: tier === "pro" ? 50 : 10, tokens: tier === "pro" ? 13000000 : 5000000 };
    if (FLASH.has(model))
        return { ...base, requests: tier === "pro" ? 150 : 100, tokens: tier === "pro" ? 25000000 : 11000000 };
    return { ...base, source: "legacy_request_estimate" };
}
module.exports = { dailyBudgets };
