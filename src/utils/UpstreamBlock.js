const BLOCK_CODE = "upstream_prompt_blocked";
const nonempty = value => typeof value === "string" && value.trim().length > 0;

function safeText(value, limit = 1024) {
    if (!nonempty(value)) return undefined;
    return value
        .replace(/Bearer\s+[^\s"']+|AIza[\w-]+|sk-[\w-]+/gi, "[redacted]")
        .replace(/((?:api[_-]?key|authorization|cookie|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
        .slice(0, limit);
}

function usageMetadataOf(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const usage = {};
    for (const key of [
        "promptTokenCount",
        "candidatesTokenCount",
        "totalTokenCount",
        "cachedContentTokenCount",
        "toolUsePromptTokenCount",
        "thoughtsTokenCount",
    ])
        if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[key] = value[key];
    for (const key of [
        "promptTokensDetails",
        "candidatesTokensDetails",
        "cacheTokensDetails",
        "toolUsePromptTokensDetails",
    ])
        if (Array.isArray(value[key]))
            usage[key] = value[key]
                .slice(0, 32)
                .filter(
                    item =>
                        /^[A-Z_0-9]{1,64}$/.test(item?.modality) &&
                        Number.isSafeInteger(item.tokenCount) &&
                        item.tokenCount >= 0
                )
                .map(item => ({ modality: item.modality, tokenCount: item.tokenCount }));
    return Object.keys(usage).length ? usage : undefined;
}

function promptBlocked(response) {
    if (Array.isArray(response)) {
        for (const item of response) {
            const blocked = promptBlocked(item);
            if (blocked) return blocked;
        }
        return null;
    }
    const feedback = response?.promptFeedback;
    if (!nonempty(feedback?.blockReason)) return null;
    const upstream = { blockReason: safeText(feedback.blockReason, 256) };
    const explanation = safeText(feedback.blockReasonMessage);
    if (explanation) upstream.blockReasonMessage = explanation;
    if (Array.isArray(feedback.safetyRatings)) {
        upstream.safetyRatings = feedback.safetyRatings.slice(0, 32).map(rating => {
            const result = {};
            for (const key of ["category", "probability", "severity"])
                if (typeof rating?.[key] === "string" && /^[A-Z_0-9]{1,128}$/.test(rating[key]))
                    result[key] = rating[key];
            if (typeof rating?.blocked === "boolean") result.blocked = rating.blocked;
            for (const key of ["probabilityScore", "severityScore"])
                if (typeof rating?.[key] === "number" && Number.isFinite(rating[key])) result[key] = rating[key];
            return result;
        });
    }
    if (response.error && typeof response.error === "object") {
        const original = {};
        if (nonempty(response.error.code)) original.code = safeText(response.error.code, 256);
        else if (typeof response.error.code === "number" && Number.isFinite(response.error.code))
            original.code = response.error.code;
        for (const key of ["message", "type", "status"])
            if (nonempty(response.error[key])) original[key] = safeText(response.error[key]);
        if (Object.keys(original).length) upstream.error = original;
    }
    const message = `Upstream refused generation, blockReason=${upstream.blockReason}${explanation ? `: ${explanation}` : ""}`;
    return Object.assign(new Error(message), {
        code: BLOCK_CODE,
        errorType: "invalid_request_error",
        retryable: false,
        skipAccountSwitch: true,
        status: 400,
        upstream,
        upstreamCode: BLOCK_CODE,
        // Only usage and an actual response ID are retained, never candidates or prompt text.
        upstreamResponseId: safeText(response.responseId, 256),
        usageMetadata: usageMetadataOf(response.usageMetadata),
    });
}

function isPromptBlocked(error) {
    return error?.code === BLOCK_CODE || error?.upstreamCode === BLOCK_CODE;
}

function assertNotBlocked(response) {
    const error = promptBlocked(response);
    if (error) throw error;
}

module.exports = { assertNotBlocked, BLOCK_CODE, isPromptBlocked, promptBlocked, usageMetadataOf };
