class PublicDashboardService {
    constructor(scheduler, usageStatsService, options = {}) {
        this.scheduler = scheduler;
        this.usageStatsService = usageStatsService;
        this.cacheTtlMs = options.cacheTtlMs ?? 1000;
        this.cachedAt = 0;
        this.cachedSnapshot = null;
        this.includeAggregation = options.includeAggregation === true;
    }

    _realtimeSnapshot() {
        const realtime = this.scheduler?.publicSummarySnapshot?.() || {
            active: 0,
            limit: 0,
            models: [],
            queued: 0,
            usageWindow: { date: null, timezone: "America/Los_Angeles" },
        };
        return {
            ...realtime,
            models: realtime.models.filter(item => typeof item.model === "string" && item.model.trim()),
        };
    }

    _visibilityKey(realtime) {
        return JSON.stringify([...new Set(realtime.models.map(item => item.model))].sort());
    }

    async getSnapshot() {
        const realtime = this._realtimeSnapshot();
        const key = this._visibilityKey(realtime);
        if (key !== this.visibilityKey) {
            this.visibilityKey = key;
            this.cachedSnapshot = null;
            this.pending = null;
        }
        if (this.cachedSnapshot && Date.now() - this.cachedAt < this.cacheTtlMs) return this.cachedSnapshot;
        if (!this.pending) {
            const pending = this._buildSnapshot(realtime, Date.now())
                .then(snapshot => {
                    if (this.pending === pending && this._visibilityKey(this._realtimeSnapshot()) === key) {
                        this.cachedSnapshot = snapshot;
                        this.cachedAt = Date.now();
                    }
                    return snapshot;
                })
                .finally(() => {
                    if (this.pending === pending) this.pending = null;
                });
            this.pending = pending;
        }
        const snapshot = await this.pending;
        if (this._visibilityKey(this._realtimeSnapshot()) !== key) return this.getSnapshot();
        return snapshot;
    }

    async _buildSnapshot(realtime, now) {
        const visibleModels = realtime.models.map(item => item.model);
        let recent;
        try {
            recent = await this.usageStatsService.getPublicModelWindows(visibleModels, now, this.includeAggregation);
        } catch {
            recent = { models: [], windows: {} };
        }
        const windows = Object.fromEntries(
            ["24h", "1h"].map(range => {
                const status = recent.windows[range]?.status;
                return [
                    range,
                    {
                        from: new Date(now - (range === "24h" ? 86400000 : 3600000)).toISOString(),
                        status: ["available", "disabled", "unavailable"].includes(status) ? status : "unavailable",
                        to: new Date(now).toISOString(),
                    },
                ];
            })
        );
        const recentByModel = new Map(recent.models.map(item => [item.modelKey, item.stats]));
        const history = this.usageStatsService.getPublicSummarySnapshot(visibleModels);
        const historyByModel = new Map(history.models.map(item => [item.modelKey, item]));
        const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
        const nullableCount = value => (value === null ? null : count(value));
        const rate = value => (Number.isFinite(value) && value >= 0 && value <= 100 ? Number(value.toFixed(1)) : null);

        const snapshot = {
            disclaimer: "estimated_quota_may_differ_from_actual",
            generated_at: new Date(now).toISOString(),
            history: {
                average_duration_ms: nullableCount(history.summary.averageDurationMs),
                enabled: history.enabled,
                failed_requests: nullableCount(history.summary.failedRequests),
                success_rate: rate(history.summary.successRate),
                total_requests: nullableCount(history.summary.totalRequests),
            },
            model_stat_windows: windows,
            models: realtime.models.map(item => {
                const modelHistory = historyByModel.get(item.model);
                const quotaIsEstimable = Number.isSafeInteger(item.estimatedRemaining) && item.estimatedRemaining >= 0;
                return {
                    history: {
                        average_duration_ms: nullableCount(modelHistory?.averageDurationMs ?? null),
                        failed_requests: nullableCount(modelHistory?.failedRequests ?? null),
                        success_rate: rate(modelHistory?.successRate),
                        total_requests: nullableCount(modelHistory?.totalRequests ?? null),
                    },
                    model: item.model,
                    quota: {
                        estimable: quotaIsEstimable,
                        estimated_remaining: quotaIsEstimable ? item.estimatedRemaining : null,
                    },
                    realtime: {
                        active: count(item.active),
                        available_accounts: count(item.availableAccounts),
                        queued: count(item.queued),
                        rate_limited_accounts: count(item.rateLimitedAccounts),
                        tier_allowed_accounts: nullableCount(item.tierAllowedAccounts ?? null),
                    },
                    recent_stats: Object.fromEntries(
                        ["24h", "1h"].map(range => {
                            const stats =
                                windows[range].status === "available" ? recentByModel.get(item.model)?.[range] : null;
                            return [
                                range,
                                {
                                    average_duration_ms: nullableCount(stats?.averageDurationMs ?? null),
                                    failed_requests: nullableCount(stats?.failedRequests ?? null),
                                    success_rate: rate(stats?.successRate),
                                    total_requests: nullableCount(stats?.totalRequests ?? null),
                                },
                            ];
                        })
                    ),
                    today: { requests: count(item.todayRequests) },
                };
            }),
            realtime: {
                active: count(realtime.active),
                limit: count(realtime.limit),
                queued: count(realtime.queued),
            },
            schema_version: 1,
            usage_window: { date: realtime.usageWindow.date, timezone: realtime.usageWindow.timezone },
        };
        if (!this.includeAggregation) return snapshot;
        const { counters } = require("./DashboardProtocol");
        const aggregation = this.usageStatsService.getPublicAggregationSnapshot(visibleModels);
        for (const model of aggregation.models) {
            model.recent_stats = Object.fromEntries(
                ["24h", "1h"].map(range => {
                    const stats = recentByModel.get(model.model)?.[range];
                    return [
                        range,
                        counters(
                            windows[range].status,
                            stats?.totalRequests,
                            stats?.successfulRequests,
                            stats?.failedRequests,
                            stats?.totalDurationMs
                        ),
                    ];
                })
            );
        }
        return { aggregation, snapshot };
    }
}

module.exports = PublicDashboardService;
