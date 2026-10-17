// The RPC Status message survives Studio's RPC -> REST error conversion and the
// deployed Build client's error.message forwarding. Do not rely on custom fields
// which older Build clients discard.
const states = new Set(["key_unavailable", "unverified", "session_expired"]);
function authState(error = {}) {
    for (const message of [error.upstreamError?.message, error.error?.message, error.message]) {
        const state = /\[MakerSuiteAuth:(key_unavailable|unverified|session_expired)\]/.exec(
            String(message || "")
        )?.[1];
        if (state) return state;
    }
    return null;
}
function isBridgeAuthFailure(error) {
    const state = authState(error);
    return state === "key_unavailable" || state === "unverified";
}
function tagStatus(text, state) {
    if (!states.has(state)) throw new Error("Invalid MakerSuite auth state");
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        value = null;
    }
    if (!Array.isArray(value) || typeof value[0] !== "number") value = [16, "MakerSuite authentication failed"];
    value[1] = `[MakerSuiteAuth:${state}] ${String(value[1] || "MakerSuite authentication failed")}`;
    return JSON.stringify(value);
}
module.exports = { authState, isBridgeAuthFailure, tagStatus };
