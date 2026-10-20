const MAX_AGENT_BYTES = 1024 * 1024;
const MAX_PUBLIC_BYTES = 1024 * 1024;
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const ranges = ["24h", "1h"];
const statuses = ["available", "disabled", "unavailable"];
const timezone = "America/Los_Angeles";
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
});
function usageDate(now) {
    const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(now)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}
function counters(status, total, success, failed, duration) {
    const valid = [total, success, failed, duration].every(isCount) && success + failed === total;
    if (status === "available" && !valid) status = "unavailable";
    if (!statuses.includes(status)) status = "unavailable";
    return {
        failed_requests: status === "available" ? failed : null,
        status,
        successful_requests: status === "available" ? success : null,
        total_duration_ms: status === "available" ? duration : null,
        total_requests: status === "available" ? total : null,
    };
}
function publicStats(raw) {
    const available = raw.status === "available",
        total = raw.total_requests;
    return {
        average_duration_ms: available && total ? Math.round(raw.total_duration_ms / total) : null,
        failed_requests: available ? raw.failed_requests : null,
        success_rate: available && total ? Number(((raw.successful_requests / total) * 100).toFixed(1)) : null,
        total_requests: available ? total : null,
    };
}
function validateEnvelope(body, expectedId, now = Date.now()) {
    const invalid = () => {
        throw new Error("Invalid agent snapshot");
    };
    const timestamp = value =>
        typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    if (
        !body ||
        body.agent_schema_version !== 1 ||
        body.node_id !== expectedId ||
        !timestamp(body.generated_at) ||
        Date.parse(body.generated_at) > now + 5000 ||
        !isCount(body.snapshot_sequence) ||
        !["ready", "unavailable"].includes(body.service_status)
    )
        invalid();
    const snapshot = body.snapshot;
    if (
        !snapshot ||
        snapshot.schema_version !== 1 ||
        snapshot.generated_at !== body.generated_at ||
        typeof snapshot.history?.enabled !== "boolean" ||
        !Array.isArray(snapshot.models) ||
        snapshot.usage_window?.timezone !== timezone ||
        !(snapshot.usage_window.date === null || /^\d{4}-\d{2}-\d{2}$/.test(snapshot.usage_window.date))
    )
        invalid();
    const checkCounts = (object, keys) => {
        if (!object || keys.some(key => !isCount(object[key]))) invalid();
    };
    checkCounts(snapshot.realtime, ["active", "limit", "queued"]);
    const checkRaw = raw => {
        if (!raw || !statuses.includes(raw.status)) invalid();
        const projected = counters(
            raw.status,
            raw.total_requests,
            raw.successful_requests,
            raw.failed_requests,
            raw.total_duration_ms
        );
        if (raw.status !== projected.status || Object.keys(projected).some(key => raw[key] !== projected[key]))
            invalid();
    };
    if (!body.aggregation || !Array.isArray(body.aggregation.models)) invalid();
    checkRaw(body.aggregation.history);
    for (const range of ranges) {
        const window = snapshot.model_stat_windows?.[range];
        if (
            !window ||
            !statuses.includes(window.status) ||
            !timestamp(window.from) ||
            window.to !== body.generated_at ||
            Date.parse(window.to) - Date.parse(window.from) !== (range === "24h" ? 86400000 : 3600000)
        )
            invalid();
    }
    const rawByModel = new Map();
    for (const raw of body.aggregation.models) {
        if (rawByModel.has(raw.model)) invalid();
        checkRaw(raw.history);
        for (const range of ranges) {
            checkRaw(raw.recent_stats?.[range]);
            // A failed aggregate may degrade an otherwise available window (e.g. integer overflow).
            if (
                snapshot.model_stat_windows[range].status !== "available" &&
                raw.recent_stats[range].status !== snapshot.model_stat_windows[range].status
            )
                invalid();
        }
        rawByModel.set(raw.model, raw);
    }
    const seen = new Set();
    for (const model of snapshot.models) {
        if (
            typeof model.model !== "string" ||
            !model.model.trim() ||
            model.model.length > 256 ||
            seen.has(model.model) ||
            !rawByModel.has(model.model)
        )
            invalid();
        seen.add(model.model);
        checkCounts(model.today, ["requests"]);
        checkCounts(model.realtime, ["active", "available_accounts", "queued", "rate_limited_accounts"]);
        if (model.realtime.tier_allowed_accounts != null && !isCount(model.realtime.tier_allowed_accounts)) invalid();
        if (
            !model.quota ||
            typeof model.quota.estimable !== "boolean" ||
            (model.quota.estimable
                ? !isCount(model.quota.estimated_remaining)
                : model.quota.estimated_remaining !== null)
        )
            invalid();
    }
    if (seen.size !== rawByModel.size) invalid();
    return body;
}
module.exports = {
    counters,
    isCount,
    MAX_AGENT_BYTES,
    MAX_PUBLIC_BYTES,
    publicStats,
    ranges,
    timezone,
    usageDate,
    validateEnvelope,
};
