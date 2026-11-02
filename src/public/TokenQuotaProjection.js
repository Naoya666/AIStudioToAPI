const { count } = require("../core/TokenUsage");
function validateTokenQuota(q) {
    if (!q || !["pg/model", "build/account"].includes(q.scope) || typeof q.pool !== "string" || q.pool.length > 256)
        return false;
    if (
        !q.window ||
        !/^\d{4}-\d{2}-\d{2}$/.test(q.window.date) ||
        q.window.timezone !== "America/Los_Angeles" ||
        typeof q.window.reset_verified !== "boolean"
    )
        return false;
    for (const k of [
        "known_limit",
        "known_remaining_upper_bound",
        "unknown_limit_accounts",
        "unknown_usage_requests",
        "known_usage_requests",
    ])
        if (!count(q[k])) return false;
    for (const k of ["limit", "estimated_remaining"]) if (q[k] !== null && !count(q[k])) return false;
    if (
        q.observed_tokens !== null &&
        (!q.observed_tokens ||
            Object.entries(q.observed_tokens).some(
                ([k, v]) => !require("../core/TokenUsage").FIELDS.includes(k) || !count(v)
            ))
    )
        return false;
    return true;
}
function mergeTokenQuotas(rows) {
    const valid = rows.filter(q => validateTokenQuota(q));
    if (!valid.length) return null;
    const first = valid[0];
    const same = valid.every(
        q => q.pool === first.pool && q.scope === first.scope && q.window.date === first.window.date
    );
    if (!same) return null;
    const sum = key => valid.reduce((n, q) => n + (q[key] || 0), 0);
    const complete = valid.length === rows.length;
    const observed = {};
    for (const q of valid)
        for (const [key, v] of Object.entries(q.observed_tokens || {})) observed[key] = (observed[key] || 0) + v;
    const result = {
        coverage: complete ? "complete" : "partial",
        estimated_remaining:
            complete && valid.every(q => q.estimated_remaining !== null) ? sum("estimated_remaining") : null,
        known_limit: sum("known_limit"),
        known_remaining_upper_bound: sum("known_remaining_upper_bound"),
        known_usage_requests: sum("known_usage_requests"),
        limit: complete && valid.every(q => q.limit !== null) ? sum("limit") : null,
        observed_tokens: Object.keys(observed).length ? observed : null,
        pool: first.pool,
        scope: first.scope,
        source: "operator_observation_2026-11-02",
        token_metric: "total_tokens",
        unknown_limit_accounts: sum("unknown_limit_accounts"),
        unknown_usage_requests: sum("unknown_usage_requests"),
        window: {
            date: first.window.date,
            reset_verified: valid.every(q => q.window.reset_verified),
            timezone: first.window.timezone,
        },
    };
    return validateTokenQuota(result) ? result : null;
}
module.exports = { mergeTokenQuotas, validateTokenQuota };
