const { counters, isCount, publicStats, ranges, timezone, usageDate } = require("./DashboardProtocol");

const sum = values => {
    if (!values.length || values.some(value => !isCount(value))) return null;
    const result = values.reduce((total, value) => total + value, 0);
    return isCount(result) ? result : null;
};
function coverage(expected, included, uncertain = false) {
    return {
        expected_nodes: expected,
        included_nodes: included,
        status: !included ? "unavailable" : included === expected && !uncertain ? "complete" : "partial",
    };
}
function mergeStats(sources) {
    const included = sources.filter(source => source.fresh && source.raw?.status === "available");
    const keys = ["total_requests", "successful_requests", "failed_requests", "total_duration_ms"];
    const totals = keys.map(key => sum(included.map(source => source.raw[key])));
    const disabled = sources.length > 0 && sources.every(source => source.fresh && source.raw?.status === "disabled");
    const raw = counters(included.length ? "available" : disabled ? "disabled" : "unavailable", ...totals);
    return {
        coverage: coverage(
            sources.length,
            raw.status === "available" ? included.length : 0,
            sources.some(s => s.failed)
        ),
        raw,
        stats: publicStats(raw),
    };
}
function mergeNumbers(sources, keys, usable) {
    const included = sources.filter(usable);
    const values = Object.fromEntries(keys.map(key => [key, sum(included.map(source => source.value[key]))]));
    return {
        coverage: coverage(
            sources.length,
            Object.values(values).some(value => value === null) ? 0 : included.length,
            sources.some(source => source.failed)
        ),
        values,
    };
}

// Pure projection: no HTTP, database or account access; every outgoing field is explicit.
function aggregate(entries, now = Date.now(), staleAfterMs = 20000) {
    const date = usageDate(now);
    const sources = entries.map(entry => ({
        ...entry,
        fresh: Boolean(
            entry.body &&
            now - Date.parse(entry.body.generated_at) <= staleAfterMs &&
            Date.parse(entry.body.generated_at) <= now + 5000
        ),
    }));
    const fresh = sources.filter(source => source.fresh);
    if (!fresh.length) return null;
    const ready = source => source.fresh && source.body.service_status === "ready";
    const currentDay = source =>
        source.fresh &&
        source.body.snapshot.usage_window.timezone === timezone &&
        source.body.snapshot.usage_window.date === date;
    const history = mergeStats(sources.map(source => ({ ...source, raw: source.body?.aggregation.history })));
    const realtime = mergeNumbers(
        sources.map(source => ({ ...source, value: source.body?.snapshot.realtime })),
        ["active", "limit", "queued"],
        ready
    );
    const byModel = new Map();
    const unknownSources = sources.some(source => !source.body);
    for (const source of sources) {
        if (!source.body) continue;
        const rawByModel = new Map(source.body.aggregation.models.map(row => [row.model, row]));
        for (const model of source.body.snapshot.models) {
            if (!byModel.has(model.model)) byModel.set(model.model, []);
            byModel
                .get(model.model)
                .push({ ...source, failed: source.failed || unknownSources, model, raw: rawByModel.get(model.model) });
        }
    }
    const modelNames = [...byModel.keys()].sort();
    const models = modelNames.map(name => {
        const modelSources = byModel.get(name);
        const modelHistory = mergeStats(modelSources.map(source => ({ ...source, raw: source.raw.history })));
        const recent = Object.fromEntries(
            ranges.map(range => [
                range,
                mergeStats(modelSources.map(source => ({ ...source, raw: source.raw.recent_stats[range] }))),
            ])
        );
        const modelRealtime = mergeNumbers(
            modelSources.map(source => ({ ...source, value: source.model.realtime })),
            ["active", "available_accounts", "queued", "rate_limited_accounts"],
            ready
        );
        const today = mergeNumbers(
            modelSources.map(source => ({ ...source, value: source.model.today })),
            ["requests"],
            currentDay
        );
        const quota = mergeNumbers(
            modelSources.map(source => ({ ...source, value: { remaining: source.model.quota.estimated_remaining } })),
            ["remaining"],
            source => ready(source) && currentDay(source) && source.model.quota.estimable
        );
        return {
            coverage: {
                history: modelHistory.coverage,
                quota: quota.coverage,
                realtime: modelRealtime.coverage,
                recent_stats: Object.fromEntries(ranges.map(range => [range, recent[range].coverage])),
                today: today.coverage,
            },
            history: modelHistory.stats,
            model: name,
            quota: {
                estimable: quota.coverage.status === "complete",
                estimated_remaining: quota.coverage.status === "complete" ? quota.values.remaining : null,
                known_estimated_remaining: quota.values.remaining,
            },
            realtime: {
                ...modelRealtime.values,
                tier_allowed_accounts: sum(
                    modelSources.filter(ready).map(source => source.model.realtime.tier_allowed_accounts)
                ),
            },
            recent_stats: Object.fromEntries(ranges.map(range => [range, recent[range].stats])),
            today: today.values,
        };
    });
    const metricCoverage = metric => {
        const included = sources.filter(source => {
            if (!source.fresh || !source.body.snapshot.models.length) return false;
            return (
                currentDay(source) &&
                (metric === "today" ||
                    (ready(source) && source.body.snapshot.models.every(model => model.quota.estimable)))
            );
        });
        return coverage(
            sources.length,
            included.length,
            sources.some(source => source.failed)
        );
    };
    const windows = Object.fromEntries(
        ranges.map(range => {
            const available = fresh.filter(
                source => source.body.snapshot.model_stat_windows[range].status === "available"
            );
            const times = available.map(source => Date.parse(source.body.snapshot.model_stat_windows[range].to));
            const allDisabled = sources.every(
                source => source.fresh && source.body.snapshot.model_stat_windows[range].status === "disabled"
            );
            return [
                range,
                {
                    alignment: "approximate",
                    source_to_max: times.length ? new Date(Math.max(...times)).toISOString() : null,
                    source_to_min: times.length ? new Date(Math.min(...times)).toISOString() : null,
                    status: available.length ? "available" : allDisabled ? "disabled" : "unavailable",
                },
            ];
        })
    );
    const times = fresh.map(source => Date.parse(source.body.generated_at));
    const overallCoverage = {
        history: history.coverage,
        quota: metricCoverage("quota"),
        realtime: realtime.coverage,
        today: metricCoverage("today"),
    };
    const complete =
        sources.every(source => source.fresh && !source.failed && ready(source)) &&
        Object.values(overallCoverage).every(value => value.status === "complete") &&
        models.every(
            model =>
                ["history", "quota", "realtime", "today"].every(key => model.coverage[key].status === "complete") &&
                ranges.every(range => model.coverage.recent_stats[range].status === "complete")
        );
    return {
        cluster: {
            expected_nodes: sources.length,
            fresh_nodes: fresh.length,
            newest_source_at: new Date(Math.max(...times)).toISOString(),
            oldest_source_at: new Date(Math.min(...times)).toISOString(),
            serving_nodes: sources.filter(ready).length,
            status: complete ? "complete" : "partial",
        },
        coverage: overallCoverage,
        disclaimer: "estimated_quota_may_differ_from_actual",
        generated_at: new Date(now).toISOString(),
        history: {
            enabled: sources.some(source => source.body?.snapshot.history.enabled),
            status: history.raw.status,
            ...history.stats,
        },
        model_stat_windows: windows,
        models,
        realtime: realtime.values,
        schema_version: 1,
        service_status: sources.some(ready) ? "ready" : "unavailable",
        stale: false,
        usage_window: { date, timezone },
    };
}
module.exports = { aggregate, sum };
