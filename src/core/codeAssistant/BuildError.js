// Build diagnostics are allowlisted and bounded before reaching clients or storage.
const RPC_STATUS = { 1: 499, 3: 400, 4: 504, 5: 404, 7: 403, 8: 429, 14: 503, 16: 401 };
const MESSAGE_BYTES = 4096;
const DETAILS_BYTES = 16384;
function clean(value) {
    return String(value)
        .replace(/\b(?:cookie|authorization)\s*:\s*[^\r\n]+/gi, "[redacted-header]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
        .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, "[redacted-resource]")
        .replace(/https?:\/\/[^\s"<>]+/gi, "[redacted-url]")
        .replace(/\b(?:Bearer|SAPISIDHASH|SAPISID1PHASH|SAPISID3PHASH)\s+[^\s,;"']+/gi, "[redacted-auth]")
        .replace(/\b(?:AIza[\w-]+|ya29\.[\w.-]+)/g, "[redacted-key]")
        .replace(
            /\b(authorization|cookie|api[_-]?key|signature|credential|token|password)\b["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
            "$1=[redacted]"
        );
}
function bounded(value, bytes) {
    const text = clean(value);
    const buffer = Buffer.from(text);
    return {
        text: buffer
            .subarray(0, bytes)
            .toString("utf8")
            .replace(/\uFFFD$/, ""),
        truncated: buffer.length > bytes,
    };
}
function safeDetails(value) {
    // Only documented diagnostic fields, never arbitrary protobuf payloads or metadata.
    const allowed = new Set([
        "@type",
        "reason",
        "domain",
        "message",
        "status",
        "code",
        "retryDelay",
        "violations",
        "subject",
        "description",
        "field",
        "fieldViolations",
    ]);
    let nodes = 0,
        truncated = false;
    const visit = (v, depth = 0) => {
        if (++nodes > 256 || depth > 6) {
            truncated = true;
            return null;
        }
        if (typeof v === "string") {
            const b = bounded(v, MESSAGE_BYTES);
            truncated ||= b.truncated;
            return b.text;
        }
        if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
        if (Array.isArray(v)) {
            // Unknown positional protobuf details are not an approved diagnostic schema.
            if (v.some(x => !x || typeof x !== "object" || Array.isArray(x))) {
                truncated = true;
                return null;
            }
            if (v.length > 32) truncated = true;
            return v.slice(0, 32).map(x => visit(x, depth + 1));
        }
        if (v && typeof v === "object")
            return Object.fromEntries(
                Object.entries(v)
                    .filter(([k]) => allowed.has(k))
                    .map(([k, x]) => [k, visit(x, depth + 1)])
            );
        return null;
    };
    const details = value == null ? null : visit(value);
    if (Buffer.byteLength(JSON.stringify(details)) > DETAILS_BYTES) return { details: null, truncated: true };
    return { details, truncated };
}
function rpcRecord(value) {
    const tuple = v =>
        Array.isArray(v) &&
        v.length >= 2 &&
        v.length <= 3 &&
        Number.isInteger(v[0]) &&
        v[0] > 0 &&
        v[0] <= 16 &&
        typeof v[1] === "string";
    // Supported RPC envelopes only: Status, [Status], [[Status]], [null, Status], or REST error.
    // Never search inside task turns, generated parts or usage arrays.
    for (const candidate of [
        value,
        Array.isArray(value) && value.length === 2 && value[0] === null ? value[1] : null,
        value?.length === 1 ? value[0] : null,
        value?.length === 1 && value[0]?.length === 1 ? value[0][0] : null,
    ]) {
        if (tuple(candidate)) return { details: candidate[2] ?? null, message: candidate[1], rpcCode: candidate[0] };
    }
    const e = value?.error;
    if (
        e &&
        !Array.isArray(e) &&
        typeof e.message === "string" &&
        (Number.isInteger(e.code) || typeof e.status === "string")
    )
        return {
            details: e.details,
            message: e.message,
            rpcCode: e.code > 0 && e.code <= 16 ? e.code : null,
            status: typeof e.status === "string" ? e.status : null,
        };
    return null;
}
function buildError({
    message,
    source = "local",
    phase = "decode",
    httpStatus = null,
    rpcCode = null,
    upstreamStatus = null,
    details = null,
    status,
    code,
    taskTerminal = false,
    usage,
    retryAfterMs = null,
}) {
    const upstream = source.startsWith("google_");
    const quota =
        upstream &&
        (httpStatus === 429 ||
            rpcCode === 8 ||
            upstreamStatus === "RESOURCE_EXHAUSTED" ||
            (source === "google_task" && /\bQuota exceeded\b/i.test(message)));
    const symbolicStatus = {
        CANCELLED: 499,
        DEADLINE_EXCEEDED: 504,
        INTERNAL: 502,
        INVALID_ARGUMENT: 400,
        NOT_FOUND: 404,
        PERMISSION_DENIED: 403,
        RESOURCE_EXHAUSTED: 429,
        UNAUTHENTICATED: 401,
        UNAVAILABLE: 503,
    };
    status ||= quota
        ? 429
        : RPC_STATUS[rpcCode] ||
          symbolicStatus[upstreamStatus] ||
          (httpStatus >= 400 ? httpStatus : /\binvalid argument\b/i.test(message) ? 400 : 502);
    const prefix = source === "google_task" ? "Build 上游任务失败：" : upstream ? "Build 上游错误：" : "";
    const m = bounded(prefix + message, MESSAGE_BYTES),
        u = bounded(message, MESSAGE_BYTES),
        d = safeDetails(details),
        symbol = upstreamStatus == null ? null : bounded(upstreamStatus, 256);
    return Object.assign(new Error(m.text), {
        code:
            code ||
            (quota
                ? "BUILD_QUOTA_EXCEEDED"
                : source === "google_task"
                  ? "BUILD_TASK_FAILED"
                  : source === "google_rpc"
                    ? "BUILD_RPC_FAILED"
                    : source === "google_http"
                      ? "BUILD_HTTP_FAILED"
                      : "BUILD_LOCAL_ERROR"),
        kind: upstream ? "upstream" : "transport",
        phase,
        source,
        status,
        taskTerminal,
        truncated: m.truncated || u.truncated || d.truncated || Boolean(symbol?.truncated),
        upstreamError: {
            details: d.details,
            httpStatus: upstream ? httpStatus : null,
            message: upstream ? u.text : null,
            rpcCode: upstream ? rpcCode : null,
            status: upstream ? (symbol?.text ?? null) : null,
        },
        usage,
        ...(quota
            ? {
                  rateLimit: {
                      limit: null,
                      metric: null,
                      resetAt: null,
                      retryAfterMs,
                      scope: "account_model",
                      type: "temporary",
                  },
              }
            : {}),
    });
}
function retryAfter(value, now = Date.now()) {
    if (typeof value !== "string" || value.length > 128) return null;
    const ms = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
    return Number.isFinite(ms) && ms > 0 && ms <= 86400000 ? Math.ceil(ms) : null;
}
function fromResponse(result, phase) {
    let value;
    try {
        value = JSON.parse(result.text);
    } catch {
        /* Non-JSON HTTP errors can still carry useful text. */
    }
    const rpc = rpcRecord(value);
    if (result.status === 200 && !rpc) return null;
    const local = result.source === "local" || result.source === "transport" || result.authState || result.proofBroken;
    const message =
        rpc?.message ||
        (typeof value?.message === "string"
            ? value.message
            : !value && typeof result.text === "string" && !/^\s*</.test(result.text)
              ? result.text
              : `Build RPC failed (HTTP ${result.status})`);
    return buildError({
        details: local ? null : rpc?.details,
        httpStatus: local ? null : result.status,
        message,
        phase,
        retryAfterMs: local ? null : retryAfter(result.retryAfter),
        rpcCode: local ? null : rpc?.rpcCode,
        source: local ? "local" : rpc ? "google_rpc" : "google_http",
        status: local ? result.status : undefined,
        upstreamStatus: local ? null : rpc?.status,
    });
}
function redactResources(error, resources) {
    const ids = resources.filter(value => typeof value === "string" && value.length >= 3);
    const visit = value => {
        if (typeof value === "string")
            return ids.reduce((text, id) => text.split(id).join("[redacted-resource]"), value);
        if (Array.isArray(value)) return value.map(visit);
        if (value && typeof value === "object")
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
        return value;
    };
    error.message = visit(error.message);
    if (error.upstreamError) error.upstreamError = visit(error.upstreamError);
    return error;
}
function errorInfo(error) {
    const m = bounded(error.message || "Build 请求失败", MESSAGE_BYTES);
    const d = safeDetails(error.upstreamError?.details);
    return {
        code: error.code || "BUILD_LOCAL_ERROR",
        ...(error.cleanupMethod ? { cleanupMethod: error.cleanupMethod } : {}),
        message: m.text,
        phase: error.phase || "decode",
        rateLimit: error.rateLimit || null,
        source: error.source || "local",
        status: error.status || 502,
        taskTerminal: error.taskTerminal === true,
        truncated: Boolean(error.truncated || m.truncated || d.truncated),
        upstreamError: error.upstreamError
            ? {
                  details: d.details,
                  httpStatus: error.upstreamError.httpStatus ?? null,
                  message:
                      error.upstreamError.message == null
                          ? null
                          : bounded(error.upstreamError.message, MESSAGE_BYTES).text,
                  rpcCode: error.upstreamError.rpcCode ?? null,
                  status: error.upstreamError.status ?? null,
              }
            : null,
        version: 1,
        ...(error.secondaryErrors ? { secondaryErrors: error.secondaryErrors.slice(0, 4).map(errorInfo) } : {}),
    };
}
function serializeError(error, requestId) {
    const info = errorInfo(error);
    return {
        error: { ...info, code: info.status, request_id: requestId, semantic_code: info.code, type: info.code },
        ...(error.usage ? { usage: error.usage } : {}),
    };
}
module.exports = { buildError, errorInfo, fromResponse, redactResources, retryAfter, rpcRecord, serializeError };
