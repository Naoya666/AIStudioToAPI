// Administrator declarations, upstream observations and model call state are independent.
const TIERS = Object.freeze([null, "free", "pro", "ultra", "ultra20"]);
const PAID = new Set(["pro", "ultra", "ultra20"]);
function resolveTier(account = {}) {
    const observation = account.benefitObservation;
    const current = !!observation && observation.sessionVersion === account.sessionVersion;
    const detected = current
        ? observation.state === "ready-free"
            ? "free"
            : observation.state === "ready-paid" && ["TIER1", "TIER2"].includes(observation.rawTier)
              ? "pro"
              : null
        : null;
    const manual = TIERS.includes(account.manualTier) ? account.manualTier : null;
    const tier = manual || detected;
    return {
        argonEligible: PAID.has(tier),
        conflict: PAID.has(manual) && detected === "free",
        detectedTier: detected,
        effectiveTier: tier,
        observationCurrent: current,
        source: manual ? "manual" : detected ? "detected" : null,
        stale: !!observation && !current,
    };
}
function modelQuota(model, account = {}) {
    const normalized = String(model || "")
        .replace(/^models\//, "")
        .toLowerCase();
    const { effectiveTier, argonEligible } = resolveTier(account);
    if (normalized === "gemini-4-argon")
        return argonEligible ? { pro: 50, ultra: 100, ultra20: 200 }[effectiveTier] : 0;
    if (normalized.startsWith("__") || /embedding|imagen/.test(normalized)) return null;
    const parts = normalized.split("-");
    if (parts.includes("flash")) return ["ultra", "ultra20"].includes(effectiveTier) ? 500 : 100;
    if (parts.includes("pro")) return { pro: 50, ultra: 100, ultra20: 200 }[effectiveTier] || 10;
    return null;
}
function accountForIndex(authSource, index) {
    return authSource?.accountLoginService?.state?.accounts.find(account => account.authIndex === index) || {};
}
function canUseModel(account, model, policy) {
    return !!require("./ModelAllowlistPolicy").allows(resolveTier(account).effectiveTier, model, policy);
}
module.exports = { accountForIndex, canUseModel, modelQuota, resolveTier, TIERS };
