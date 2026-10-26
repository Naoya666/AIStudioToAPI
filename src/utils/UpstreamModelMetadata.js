// Only retain explicit Google model identifiers, never arbitrary response strings.
const modelVersionOf = value =>
    typeof value === "string" && /^(?:models\/)?gemini-[a-zA-Z0-9._-]{1,128}$/.test(value) ? value : null;

function normalizeObservation(value = {}) {
    if (!value || typeof value !== "object") value = {};
    return {
        modelIdentifiers: (Array.isArray(value.modelIdentifiers) ? value.modelIdentifiers : [])
            .filter(item => modelVersionOf(item?.value) && /^\$[\w.[\]]{0,128}$/.test(item?.path))
            .slice(0, 16)
            .map(item => ({ path: item.path, value: item.value })),
        modelVersion: modelVersionOf(value.modelVersion),
        requestAttemptId:
            typeof value.requestAttemptId === "string" && /^[\w-]{1,256}$/.test(value.requestAttemptId)
                ? value.requestAttemptId
                : null,
        transport: ["legacy", "makersuite"].includes(value.transport) ? value.transport : "unknown",
    };
}

module.exports = { modelVersionOf, normalizeObservation };
