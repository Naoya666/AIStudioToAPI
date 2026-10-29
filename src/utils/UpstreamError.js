const STATUS_NAMES = {
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
    409: "ALREADY_EXISTS",
    413: "RESOURCE_EXHAUSTED",
    429: "RESOURCE_EXHAUSTED",
    499: "CANCELLED",
    500: "INTERNAL",
    501: "UNIMPLEMENTED",
    502: "INTERNAL",
    503: "UNAVAILABLE",
    504: "DEADLINE_EXCEEDED",
};
const nonemptyString = value => typeof value === "string" && value.trim().length > 0;
const validCode = value => nonemptyString(value) || (typeof value === "number" && Number.isFinite(value));
const httpStatus = value => {
    const number = typeof value === "number" || nonemptyString(value) ? Number(value) : NaN;
    return Number.isInteger(number) && number >= 400 && number <= 599 ? number : null;
};

// Keep business codes separate from error.code, which drives local retry classification.
function normalizeError(error = {}, fallbackStatus = 500) {
    if (require("./UpstreamBlock").isPromptBlocked(error))
        return { code: "upstream_prompt_blocked", message: error.message, status: 400, type: "invalid_request_error" };
    const upstream = error.upstreamError || error.error;
    const isUpstream =
        Boolean(upstream) ||
        (error.event_type === "error" && error.kind !== "transport" && !error.reason?.startsWith("connection_"));
    const status =
        httpStatus(error.status) ||
        httpStatus(upstream?.code) ||
        (isUpstream ? 502 : httpStatus(fallbackStatus) || 500);
    const code = [upstream?.code, error.upstreamCode, error.code].find(validCode) ?? status;
    const message =
        [upstream?.message, error.message].find(nonemptyString) ||
        (isUpstream ? "Upstream generation failed" : "Request processing failed");
    const type = [upstream?.type, error.errorType].find(nonemptyString) || null;
    return { code, message, status, type, ...(upstream?.details !== undefined ? { details: upstream.details } : {}) };
}

function upstreamError(fields, status) {
    const normalized = normalizeError({ status, upstreamError: fields || {} }, 502);
    return Object.assign(new Error(normalized.message), {
        code: "upstream_error",
        status: normalized.status,
        upstreamError: {
            code: normalized.code,
            message: normalized.message,
            type: normalized.type,
            ...(normalized.details !== undefined ? { details: normalized.details } : {}),
            ...(fields?.status ? { status: fields.status } : {}),
        },
    });
}

function geminiStatus(error, status) {
    return error?.upstreamError?.status || error?.error?.status || STATUS_NAMES[status] || "INTERNAL";
}
module.exports = { geminiStatus, normalizeError, upstreamError };
