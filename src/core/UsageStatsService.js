/**
 * File: src/core/UsageStatsService.js
 * Description: SQLite-backed usage statistics and bounded active/recent request state
 *
 * Author: OpenAI Codex
 */

const fs = require("fs");
const path = require("path");
const UsageStatsStorage = require("./UsageStatsStorage");

const DAY_MS = 24 * 60 * 60 * 1000;

class UsageStatsService {
    constructor(authSource, logger, dataDir, enabled = true, storageOptions = {}) {
        this.authSource = authSource;
        this.logger = logger;
        this.dataDir = dataDir || path.join(process.cwd(), "data");
        this.statsFilePath = path.join(this.dataDir, "usage-stats.jsonl");
        this.enabled = enabled !== false;
        this.appendPromise = Promise.resolve();
        this.isImportingStats = false;
        this.datasetRevision = 1;
        this.retentionDays = storageOptions.retentionDays ?? 30;
        this.cleanupIntervalMinutes = storageOptions.cleanupIntervalMinutes ?? 60;
        this.cleanupBatchSize = storageOptions.cleanupBatchSize ?? 1000;
        this.dbPath = storageOptions.dbPath || path.join(this.dataDir, "usage-stats.sqlite");
        this.cleanupState = {
            error: null,
            lastAttemptAt: null,
            lastDeletedRecords: 0,
            lastSuccessAt: null,
            nextCleanupAt: null,
            status: this.enabled && this.retentionDays > 0 ? "idle" : "disabled",
        };
        this.storageStatus = "healthy";

        if (this.enabled) {
            // Ensure data directory exists
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
            }

            this.storage = new UsageStatsStorage({
                cleanupBatchSize: this.cleanupBatchSize,
                dbPath: this.dbPath,
                legacyPath: this.statsFilePath,
                retentionDays: this.retentionDays,
            });
            this.ready = this._initializeStorage();
        } else {
            this.ready = Promise.resolve();
        }

        if (!this.startedAt) {
            this.startedAtMs = Date.now();
            this.startedAt = new Date(this.startedAtMs).toISOString();
        }
        if (!this.summary) {
            this.summary = {
                abortedCount: 0,
                errorCount: 0,
                successCount: 0,
                totalDurationMs: 0,
                totalRequests: 0,
            };
        }
        if (!this.activeRequests) {
            this.activeRequests = new Map();
        }
        if (!this.records) {
            this.records = [];
        }
        if (!this.accountStats) {
            this.accountStats = new Map();
        }
        if (!this.formatStats) {
            this.formatStats = new Map();
        }
        if (!this.categoryStats) {
            this.categoryStats = new Map();
        }
        if (!this.streamModeStats) {
            this.streamModeStats = new Map();
        }
        if (!this.modelStats) {
            this.modelStats = new Map();
        }
        if (this.sequence === undefined) {
            this.sequence = 0;
        }
    }

    async _initializeStorage() {
        try {
            await this.storage.ready;
            await this._refreshPersistedSummary();
            if (this.retentionDays > 0) {
                await this.runCleanup();
                this._scheduleCleanup();
            }
        } catch (error) {
            this.storageStatus = "error";
            this.cleanupState.error = error.message;
            if (this.logger) this.logger.error(`[UsageStats] SQLite initialization failed: ${error.message}`);
            throw error;
        }
    }

    async _refreshPersistedSummary() {
        const snapshot = await this.storage.call("summary");
        this.datasetRevision = snapshot.dataset_revision;
        this.startedAt = snapshot.startedAt;
        this.startedAtMs = Date.parse(snapshot.startedAt) || Date.now();
        this.summary = { ...snapshot.summary };
        delete this.summary.avgDurationMs;
        delete this.summary.successRate;
        delete this.summary.formatBreakdown;
        delete this.summary.requestCategoryBreakdown;
        delete this.summary.streamModeBreakdown;
        delete this.summary.uniqueAccountPairs;
        this.accountStats = new Map(
            snapshot.accounts.map(item => [
                item.accountKey,
                {
                    ...item,
                    modelCounts: Object.fromEntries((item.modelCounts || []).map(model => [model.key, model.count])),
                },
            ])
        );
        this.modelStats = new Map(
            snapshot.models.map(item => [
                item.modelKey,
                {
                    ...item,
                    accountCounts: Object.fromEntries(
                        (item.accountCounts || []).map(account => [account.key, account])
                    ),
                },
            ])
        );
        this.formatStats = new Map(snapshot.summary.formatBreakdown.map(item => [item.key, item]));
        this.categoryStats = new Map(snapshot.summary.requestCategoryBreakdown.map(item => [item.key, item]));
        this.streamModeStats = new Map(snapshot.summary.streamModeBreakdown.map(item => [item.key, item]));
    }

    startRequest(requestId, meta = {}) {
        if (!this.enabled) return null;
        if (!requestId) return null;

        const tracker = {
            apiFormat: meta.apiFormat || "unknown",
            attemptCount: 0,
            attempts: [],
            clientIp: meta.clientIp || null,
            initialAccountName: this._normalizeAccountName(meta.initialAccountName),
            initialAuthIndex: this._normalizeAuthIndex(meta.initialAuthIndex),
            isStreaming: Boolean(meta.isStreaming),
            method: meta.method || "GET",
            model: meta.model || null,
            path: meta.path || "/",
            requestCategory: meta.requestCategory || "request",
            requestId,
            startedAt: new Date().toISOString(),
            startedAtMs: Date.now(),
            streamMode: meta.streamMode || null,
        };

        this.activeRequests.set(requestId, tracker);
        return tracker;
    }

    updateRequest(requestId, patch = {}) {
        if (!this.enabled) return;
        const tracker = this.activeRequests.get(requestId);
        if (!tracker) return;

        if (patch.apiFormat !== undefined) tracker.apiFormat = patch.apiFormat || tracker.apiFormat;
        if (patch.clientIp !== undefined) tracker.clientIp = patch.clientIp || null;
        if (patch.isStreaming !== undefined) tracker.isStreaming = Boolean(patch.isStreaming);
        if (patch.method !== undefined) tracker.method = patch.method || tracker.method;
        if (patch.model !== undefined) tracker.model = patch.model || null;
        if (patch.path !== undefined) tracker.path = patch.path || tracker.path;
        if (patch.requestCategory !== undefined)
            tracker.requestCategory = patch.requestCategory || tracker.requestCategory;
        if (patch.streamMode !== undefined) tracker.streamMode = patch.streamMode || null;

        if (patch.initialAuthIndex !== undefined) {
            tracker.initialAuthIndex = this._normalizeAuthIndex(patch.initialAuthIndex);
        }
        if (patch.initialAccountName !== undefined) {
            tracker.initialAccountName = this._normalizeAccountName(patch.initialAccountName);
        }
    }

    recordAttempt(requestId, authIndex, accountName = undefined) {
        if (!this.enabled) return;
        const tracker = this.activeRequests.get(requestId);
        if (!tracker) return;

        const normalizedAuthIndex = this._normalizeAuthIndex(authIndex);
        if (normalizedAuthIndex === null) return;

        const resolvedAccountName =
            accountName !== undefined
                ? this._normalizeAccountName(accountName)
                : this._resolveAccountName(normalizedAuthIndex);

        this._pushAttempt(tracker, normalizedAuthIndex, resolvedAccountName);
    }

    finishRequest(requestId, result = {}) {
        if (!this.enabled) return null;
        const tracker = this.activeRequests.get(requestId);
        if (!tracker) return null;

        this.activeRequests.delete(requestId);
        if (this.isImportingStats) {
            if (this.logger) {
                this.logger.info(`[UsageStats] Dropped request ${requestId} because stats import is in progress.`);
            }
            return null;
        }

        const finishedAtMs = Date.now();
        const lastAttempt = tracker.attempts[tracker.attempts.length - 1] || null;
        const lastParsed = lastAttempt?.accountKey ? this._parseAccountKey(lastAttempt.accountKey) : {};
        const finalAuthIndex =
            this._normalizeAuthIndex(result.finalAuthIndex) ?? lastParsed.authIndex ?? tracker.initialAuthIndex ?? null;
        const finalAccountName =
            this._normalizeAccountName(result.finalAccountName) ??
            lastParsed.accountName ??
            tracker.initialAccountName ??
            null;
        const outcome = this._normalizeOutcome(result.outcome);
        const statusCode = Number.isFinite(result.statusCode) ? Number(result.statusCode) : null;
        const durationMs = Math.max(0, finishedAtMs - tracker.startedAtMs);
        const accountKey = this._buildAccountKey(finalAuthIndex, finalAccountName);

        const record = {
            accountKey,
            apiFormat: tracker.apiFormat,
            attemptCount: tracker.attemptCount,
            attempts: tracker.attempts.map(item => ({ accountKey: item.accountKey })),
            clientIp: tracker.clientIp,
            durationMs,
            errorMessage: result.errorMessage || null,
            finalAccountName,
            finalAuthIndex,
            finishedAt: new Date(finishedAtMs).toISOString(),
            initialAccountName: tracker.initialAccountName,
            initialAuthIndex: tracker.initialAuthIndex,
            isStreaming: tracker.isStreaming,
            method: tracker.method,
            model: tracker.model,
            outcome,
            path: tracker.path,
            requestCategory: tracker.requestCategory,
            requestId: tracker.requestId,
            sequence: ++this.sequence,
            startedAt: tracker.startedAt,
            statusCode,
            streamMode: tracker.requestCategory === "generation" ? tracker.streamMode || "non" : null,
        };

        this.records.push(record);
        if (this.records.length > 1000) this.records.shift();
        this._updateSummary(record);
        this._updateBreakdown(this.formatStats, record.apiFormat);
        this._updateBreakdown(this.categoryStats, record.requestCategory);
        this._updateBreakdown(this.streamModeStats, record.streamMode);
        this._updateAccountStats(record);
        this._updateModelStats(record);

        this.appendPromise = this.appendPromise
            .catch(() => {})
            .then(() => this._persistRecord(record))
            .then(result => {
                if (result.inserted && Number.isSafeInteger(result.id)) {
                    record.sequence = result.id;
                    this.sequence = Math.max(this.sequence, result.id);
                }
                if (!result.inserted && this.logger)
                    this.logger.warn(`[UsageStats] Duplicate request ID ignored: ${record.requestId}`);
            })
            .catch(error => {
                this.storageStatus = "error";
                if (this.logger) this.logger.error(`[UsageStats] Failed to persist request: ${error.message}`);
            });

        return record;
    }

    async _persistRecord(record) {
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const result = await this.storage.call("insert", record);
                this.storageStatus = "healthy";
                return result;
            } catch (error) {
                lastError = error;
                if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 50));
            }
        }
        throw lastError;
    }

    getSnapshot() {
        return { ...this.getSummarySnapshot(), records: this.enabled ? this.records.slice().reverse() : [] };
    }

    async getSummarySnapshotAsync() {
        if (!this.enabled) return UsageStatsService.createEmptySummarySnapshot();
        await this.ready;
        await this.appendPromise.catch(() => {});
        await this._refreshPersistedSummary();
        return this.getSummarySnapshot();
    }

    async queryRecordsAsync(options = {}) {
        if (!this.enabled)
            return {
                dataset_revision: this.datasetRevision,
                has_more: false,
                next_cursor: null,
                records: [],
                reset: false,
            };
        await this.ready;
        await this.appendPromise.catch(() => {});
        return this.storage.call("query", options);
    }

    getSummarySnapshot() {
        if (!this.enabled) {
            const empty = UsageStatsService.createEmptySnapshot();
            delete empty.records;
            return { ...empty, dataset_revision: this.datasetRevision };
        }

        const totalRequests = this.summary.totalRequests;
        const avgDurationMs = totalRequests > 0 ? Math.round(this.summary.totalDurationMs / totalRequests) : 0;
        const successRate =
            totalRequests > 0 ? Number(((this.summary.successCount / totalRequests) * 100).toFixed(1)) : 0;

        const accounts = Array.from(this.accountStats.values())
            .map(item => ({
                abortedCount: item.abortedCount,
                accountKey: item.accountKey,
                accountName: item.accountName,
                authIndex: item.authIndex,
                avgDurationMs: item.totalRequests > 0 ? Math.round(item.totalDurationMs / item.totalRequests) : 0,
                errorCount: item.errorCount,
                lastPath: item.lastPath,
                lastUsedAt: item.lastUsedAt,
                modelCounts: Object.entries(item.modelCounts || {})
                    .map(([key, count]) => ({ count, key }))
                    .sort((a, b) => b.count - a.count),
                successCount: item.successCount,
                successRate:
                    item.totalRequests > 0 ? Number(((item.successCount / item.totalRequests) * 100).toFixed(1)) : 0,
                totalDurationMs: item.totalDurationMs,
                totalRequests: item.totalRequests,
            }))
            .sort((a, b) => {
                if (b.totalRequests !== a.totalRequests) return b.totalRequests - a.totalRequests;
                return (b.lastUsedAt || "").localeCompare(a.lastUsedAt || "");
            });

        return {
            accounts,
            dataset_revision: this.datasetRevision,
            models: this._serializeModelStats(),
            startedAt: this.startedAt,
            summary: {
                abortedCount: this.summary.abortedCount,
                activeRequests: this.activeRequests.size,
                avgDurationMs,
                errorCount: this.summary.errorCount,
                formatBreakdown: this._serializeBreakdown(this.formatStats),
                requestCategoryBreakdown: this._serializeBreakdown(this.categoryStats),
                streamModeBreakdown: this._serializeBreakdown(this.streamModeStats),
                successCount: this.summary.successCount,
                successRate,
                totalRequests,
                uniqueAccountPairs: this.accountStats.size,
                uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1000)),
            },
        };
    }

    /**
     * Return a deliberately small public projection. Never build this from
     * getSummarySnapshot(): that object contains account and request metadata.
     */
    getPublicSummarySnapshot(visibleModels = []) {
        const modelKeys = [...new Set(visibleModels.map(value => String(value)))].sort((a, b) => a.localeCompare(b));
        if (!this.enabled) {
            return {
                enabled: false,
                models: modelKeys.map(modelKey => ({
                    averageDurationMs: null,
                    failedRequests: null,
                    modelKey,
                    successRate: null,
                    totalRequests: null,
                })),
                summary: {
                    averageDurationMs: null,
                    failedRequests: null,
                    successRate: null,
                    totalRequests: null,
                },
            };
        }

        const project = (stats = {}) => {
            const totalRequests = Number.isSafeInteger(stats.totalRequests) ? Math.max(0, stats.totalRequests) : 0;
            const successCount = Number.isSafeInteger(stats.successCount) ? Math.max(0, stats.successCount) : 0;
            const errorCount = Number.isSafeInteger(stats.errorCount) ? Math.max(0, stats.errorCount) : 0;
            const abortedCount = Number.isSafeInteger(stats.abortedCount) ? Math.max(0, stats.abortedCount) : 0;
            const totalDurationMs = Number.isFinite(stats.totalDurationMs) ? Math.max(0, stats.totalDurationMs) : 0;
            return {
                averageDurationMs: totalRequests
                    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(totalDurationMs / totalRequests))
                    : null,
                failedRequests: Math.min(Number.MAX_SAFE_INTEGER, errorCount + abortedCount),
                successRate: totalRequests
                    ? Number((Math.min(1, successCount / totalRequests) * 100).toFixed(1))
                    : null,
                totalRequests,
            };
        };

        return {
            enabled: true,
            models: modelKeys.map(modelKey => ({ modelKey, ...project(this.modelStats.get(modelKey)) })),
            summary: project(this.summary),
        };
    }

    getPublicAggregationSnapshot(visibleModels = []) {
        const { counters } = require("../public/DashboardProtocol");
        const status = this.enabled ? "available" : "disabled";
        const project = stats =>
            counters(
                status,
                stats?.totalRequests ?? 0,
                stats?.successCount ?? 0,
                (stats?.errorCount ?? 0) + (stats?.abortedCount ?? 0),
                Math.round(stats?.totalDurationMs ?? 0)
            );
        return {
            history: project(this.summary),
            models: [...new Set(visibleModels)].map(model => ({ history: project(this.modelStats.get(model)), model })),
        };
    }

    async getPublicModelWindows(visibleModels = [], asOfMs = Date.now(), includeAggregation = false) {
        const modelKeys = [...new Set(visibleModels.filter(value => typeof value === "string" && value.trim()))];
        let rows = [];
        let status = this.enabled ? "available" : "disabled";
        if (this.enabled) {
            try {
                await this.ready;
                await this.appendPromise;
                rows = await this.storage.call("public_model_windows", { asOfMs, visibleModels: modelKeys });
            } catch {
                status = "unavailable";
            }
        }
        const byModel = new Map(rows.map(row => [row.model, row]));
        const windows = {};
        for (const [range, milliseconds] of [
            ["24h", DAY_MS],
            ["1h", 3600000],
        ]) {
            windows[range] = {
                from: new Date(asOfMs - milliseconds).toISOString(),
                status,
                to: new Date(asOfMs).toISOString(),
            };
        }
        const models = modelKeys.map(modelKey => {
            const row = byModel.get(modelKey);
            const stats = {};
            for (const range of ["24h", "1h"]) {
                const total = row?.[`total_${range}`] ?? 0;
                stats[range] = {
                    averageDurationMs:
                        status === "available" && total ? Math.round(row[`duration_${range}`] / total) : null,
                    failedRequests: status === "available" ? (row?.[`failed_${range}`] ?? 0) : null,
                    successRate:
                        status === "available" && total
                            ? Number(((row[`success_${range}`] / total) * 100).toFixed(1))
                            : null,
                    totalRequests: status === "available" ? total : null,
                    ...(includeAggregation
                        ? {
                              successfulRequests: status === "available" ? (row?.[`success_${range}`] ?? 0) : null,
                              totalDurationMs:
                                  status === "available" ? Math.round(row?.[`duration_${range}`] ?? 0) : null,
                          }
                        : {}),
                };
            }
            return { modelKey, stats };
        });
        return { models, windows };
    }

    queryRecords(options = {}) {
        if (!this.enabled) {
            return { dataset_revision: this.datasetRevision, has_more: false, next_cursor: null, records: [] };
        }
        const allowedLimits = new Set([10, 20, 50, 100]);
        const limit = Number(options.limit || 20);
        if (!allowedLimits.has(limit)) throw Object.assign(new Error("Invalid records limit"), { status: 400 });

        if (options.after_sequence !== undefined) {
            const afterSequence = Number(options.after_sequence);
            if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
                throw Object.assign(new Error("Invalid records sequence"), { status: 400 });
            if (Number(options.dataset_revision) !== this.datasetRevision) {
                return {
                    dataset_revision: this.datasetRevision,
                    has_more: this.records.length > limit,
                    latest_sequence: this.sequence,
                    next_cursor: null,
                    records: this.records.slice(-limit).reverse(),
                    reset: true,
                };
            }
            const matching = this.records.filter(record => record.sequence > afterSequence);
            const selected = matching.slice(0, limit);
            const records = selected.slice().reverse();
            return {
                dataset_revision: this.datasetRevision,
                has_more: matching.length > limit,
                latest_sequence: selected.at(-1)?.sequence ?? afterSequence,
                next_cursor: null,
                records,
                reset: false,
            };
        }

        let beforeSequence = Infinity;
        if (options.cursor) {
            try {
                const cursor = JSON.parse(Buffer.from(String(options.cursor), "base64url").toString("utf8"));
                if (cursor.revision !== this.datasetRevision || !Number.isInteger(cursor.before)) {
                    return {
                        dataset_revision: this.datasetRevision,
                        has_more: this.records.length > 0,
                        next_cursor: null,
                        records: [],
                        reset: true,
                    };
                }
                beforeSequence = cursor.before;
            } catch {
                throw Object.assign(new Error("Invalid records cursor"), { status: 400 });
            }
        }

        const values = value => {
            if (value === undefined || value === null || value === "") return null;
            return new Set((Array.isArray(value) ? value : String(value).split(",")).map(item => String(item)));
        };
        const model = values(options.model);
        const outcome = values(options.outcome);
        const statusCode = values(options.status_code);
        const authIndex = values(options.auth_index);
        const apiFormat = values(options.api_format);
        const requestCategory = values(options.request_category);
        const streamMode = values(options.stream_mode);
        const clientIp = values(options.client_ip);
        const from = options.from ? Date.parse(options.from) : null;
        const to = options.to ? Date.parse(options.to) : null;
        if ((options.from && !Number.isFinite(from)) || (options.to && !Number.isFinite(to)))
            throw Object.assign(new Error("Invalid records time range"), { status: 400 });

        const matches = record => {
            if ((record.sequence || 0) >= beforeSequence) return false;
            if (model && !model.has(String(record.model ?? ""))) return false;
            if (outcome && !outcome.has(String(record.outcome ?? ""))) return false;
            if (statusCode && !statusCode.has(String(record.statusCode ?? ""))) return false;
            if (authIndex && !authIndex.has(String(record.finalAuthIndex ?? ""))) return false;
            if (apiFormat && !apiFormat.has(String(record.apiFormat ?? ""))) return false;
            if (requestCategory && !requestCategory.has(String(record.requestCategory ?? ""))) return false;
            if (streamMode && !streamMode.has(String(record.streamMode ?? ""))) return false;
            if (clientIp && !clientIp.has(String(record.clientIp ?? ""))) return false;
            const timestamp = Date.parse(record.finishedAt);
            if (from !== null && timestamp < from) return false;
            if (to !== null && timestamp > to) return false;
            return true;
        };
        const ordered = [];
        for (let index = this.records.length - 1; index >= 0 && ordered.length <= limit; index--) {
            const record = this.records[index];
            if (matches(record)) ordered.push(record);
        }
        const hasMore = ordered.length > limit;
        const records = ordered.slice(0, limit);
        const lastSequence = records.at(-1)?.sequence;
        return {
            dataset_revision: this.datasetRevision,
            has_more: hasMore,
            latest_sequence: this.sequence,
            next_cursor:
                hasMore && Number.isInteger(lastSequence)
                    ? Buffer.from(JSON.stringify({ before: lastSequence, revision: this.datasetRevision })).toString(
                          "base64url"
                      )
                    : null,
            records,
            reset: false,
        };
    }

    /**
     * Public import entry point. Drops newly finished stats during import, waits
     * for already queued appends, then rewrites the stats file from a stable baseline.
     */
    importJsonl(content) {
        if (!this.enabled) {
            throw new Error("Usage stats are disabled");
        }
        if (this.isImportingStats) {
            throw new Error("Usage stats import is already in progress");
        }
        if (typeof content !== "string") {
            throw new Error("Invalid JSONL content");
        }

        this.isImportingStats = true;

        const importPromise = this.appendPromise
            .catch(() => {})
            .then(() => this.storage.call("import", { content }))
            .then(async result => {
                await this._refreshPersistedSummary();
                this.records = [];
                return result;
            })
            .finally(() => {
                this.isImportingStats = false;
            });

        this.appendPromise = importPromise.catch(() => {});
        return importPromise;
    }

    async exportBatch(afterId = 0, limit = 500) {
        if (!this.enabled) return [];
        await this.ready;
        await this.appendPromise.catch(() => {});
        return this.storage.call("export", { afterId, limit });
    }

    _scheduleCleanup() {
        if (!this.enabled || !this.retentionDays || this.cleanupTimer) return;
        const delay = this.cleanupIntervalMinutes * 60 * 1000;
        this.cleanupState.nextCleanupAt = new Date(Date.now() + delay).toISOString();
        this.cleanupTimer = setTimeout(async () => {
            this.cleanupTimer = null;
            await this.runCleanup().catch(() => {});
            this._scheduleCleanup();
        }, delay);
        this.cleanupTimer.unref?.();
    }

    async runCleanup() {
        if (!this.enabled || !this.retentionDays || this.cleanupState.status === "running") return null;
        this.cleanupState.status = "running";
        this.cleanupState.nextCleanupAt = null;
        this.cleanupState.lastAttemptAt = new Date().toISOString();
        const started = Date.now();
        try {
            const result = await this.storage.call("cleanup", { now: started });
            this.cleanupState.lastDeletedRecords = result.deleted;
            this.cleanupState.lastSuccessAt = new Date().toISOString();
            this.cleanupState.error = null;
            this.cleanupState.status = "idle";
            if (result.deleted) {
                this.datasetRevision += 1;
                this.records = this.records.filter(
                    record => Date.parse(record.finishedAt) > started - this.retentionDays * DAY_MS
                );
            }
            return result;
        } catch (error) {
            this.cleanupState.status = "error";
            this.cleanupState.error = error.message;
            if (this.logger) this.logger.error(`[UsageStats] Cleanup failed: ${error.message}`);
            throw error;
        }
    }

    async getStorageSnapshot() {
        const serverTime = Date.now();
        if (!this.enabled)
            return {
                backend: "sqlite",
                cleanup_status: "disabled",
                enabled: false,
                server_time: new Date(serverTime).toISOString(),
                storage_status: "disabled",
            };
        await this.ready;
        const state = await this.storage.call("storage");
        return {
            backend: "sqlite",
            cleanup_error: this.cleanupState.error,
            cleanup_interval_minutes: this.cleanupIntervalMinutes,
            cleanup_status: this.retentionDays ? this.cleanupState.status : "disabled",
            database_bytes: state.databaseBytes,
            enabled: true,
            expiration_cutoff: this.retentionDays
                ? new Date(serverTime - this.retentionDays * DAY_MS).toISOString()
                : null,
            last_cleanup_attempt_at: this.cleanupState.lastAttemptAt,
            last_cleanup_success_at: this.cleanupState.lastSuccessAt,
            last_deleted_records: this.cleanupState.lastDeletedRecords,
            next_cleanup_at: this.retentionDays ? this.cleanupState.nextCleanupAt : null,
            next_record_expires_at: state.nextRecordExpiresAt,
            retained_records: state.retainedRecords,
            retention_days: this.retentionDays,
            retention_mode: this.retentionDays ? "days" : "forever",
            server_time: new Date(serverTime).toISOString(),
            storage_status: this.storageStatus,
            wal_bytes: state.walBytes,
        };
    }

    async close() {
        if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
        await this.appendPromise.catch(() => {});
        await this.storage?.close();
    }

    _pushAttempt(tracker, authIndex, accountName) {
        const normalizedAccountName = this._normalizeAccountName(accountName);
        const accountKey = this._buildAccountKey(authIndex, normalizedAccountName);

        tracker.attemptCount += 1;
        tracker.attempts.push({ accountKey });
    }

    _updateSummary(record) {
        const durationMs = this._normalizeDurationMs(record.durationMs);
        this.summary.totalRequests += 1;
        this.summary.totalDurationMs += durationMs;

        if (record.outcome === "success") {
            this.summary.successCount += 1;
        } else if (record.outcome === "aborted") {
            this.summary.abortedCount += 1;
        } else {
            this.summary.errorCount += 1;
        }
    }

    _updateBreakdown(targetMap, key) {
        const currentKey = key || "unknown";
        const existing = targetMap.get(currentKey) || { count: 0, key: currentKey };
        existing.count += 1;
        targetMap.set(currentKey, existing);
    }

    _updateAccountStats(record) {
        const durationMs = this._normalizeDurationMs(record.durationMs);
        const accountKey = record.accountKey || this._buildAccountKey(record.finalAuthIndex, record.finalAccountName);
        const existing = this.accountStats.get(accountKey) || {
            abortedCount: 0,
            accountKey,
            accountName: record.finalAccountName,
            authIndex: record.finalAuthIndex,
            errorCount: 0,
            lastPath: null,
            lastUsedAt: record.finishedAt,
            modelCounts: {},
            successCount: 0,
            totalDurationMs: 0,
            totalRequests: 0,
        };

        existing.accountName = record.finalAccountName;
        existing.authIndex = record.finalAuthIndex;
        const modelKey = record.model || "unknown";
        existing.modelCounts[modelKey] = (existing.modelCounts[modelKey] || 0) + 1;
        existing.lastPath = record.path || existing.lastPath;
        existing.lastUsedAt = record.finishedAt;
        existing.totalDurationMs += durationMs;
        existing.totalRequests += 1;

        if (record.outcome === "success") {
            existing.successCount += 1;
        } else if (record.outcome === "aborted") {
            existing.abortedCount += 1;
        } else {
            existing.errorCount += 1;
        }

        this.accountStats.set(accountKey, existing);
    }

    _updateModelStats(record) {
        const modelKey = record.model || "unknown";
        const existing = this.modelStats.get(modelKey) || {
            abortedCount: 0,
            accountCounts: {},
            errorCount: 0,
            modelKey,
            successCount: 0,
            totalDurationMs: 0,
            totalRequests: 0,
        };
        existing.totalRequests += 1;
        existing.totalDurationMs += this._normalizeDurationMs(record.durationMs);
        if (record.outcome === "success") existing.successCount += 1;
        else if (record.outcome === "aborted") existing.abortedCount += 1;
        else existing.errorCount += 1;

        const accountKey = record.accountKey || this._buildAccountKey(record.finalAuthIndex, record.finalAccountName);
        const account = existing.accountCounts[accountKey] || {
            accountName: record.finalAccountName,
            authIndex: record.finalAuthIndex,
            count: 0,
            error: 0,
            key: accountKey,
        };
        account.count += 1;
        if (record.outcome === "error") account.error += 1;
        existing.accountCounts[accountKey] = account;
        this.modelStats.set(modelKey, existing);
    }

    _serializeModelStats() {
        return [...this.modelStats.values()]
            .map(model => ({
                ...model,
                accountCounts: Object.values(model.accountCounts).sort((a, b) => b.count - a.count),
                avgDurationMs: model.totalRequests > 0 ? Math.round(model.totalDurationMs / model.totalRequests) : 0,
                successRate:
                    model.totalRequests > 0 ? Number(((model.successCount / model.totalRequests) * 100).toFixed(1)) : 0,
            }))
            .sort((a, b) => b.totalRequests - a.totalRequests);
    }

    _serializeBreakdown(sourceMap) {
        return Array.from(sourceMap.values()).sort((a, b) => b.count - a.count);
    }

    _normalizeOutcome(outcome) {
        if (outcome === "success" || outcome === "aborted") {
            return outcome;
        }
        return "error";
    }

    _normalizeDurationMs(value) {
        const durationMs = Number(value);
        return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    }

    _normalizeAuthIndex(value) {
        return Number.isInteger(value) && value >= 0 ? value : null;
    }

    _normalizeAccountName(value) {
        if (typeof value !== "string") return null;
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
    }

    _resolveAccountName(authIndex) {
        if (!this.authSource?.accountNameMap || authIndex === null) return null;
        return this._normalizeAccountName(this.authSource.accountNameMap.get(authIndex));
    }

    _buildAccountKey(authIndex, accountName) {
        if (authIndex === null) {
            return accountName ? `unassigned:${accountName}` : "unassigned";
        }

        return `${authIndex}:${accountName || "N/A"}`;
    }

    _parseAccountKey(accountKey) {
        if (!accountKey || accountKey === "unassigned") {
            return { accountName: null, authIndex: null };
        }
        const colonIdx = accountKey.indexOf(":");
        if (colonIdx === -1) {
            return { accountName: accountKey, authIndex: null };
        }
        const authIndex = Number(accountKey.slice(0, colonIdx));
        const accountName = accountKey.slice(colonIdx + 1);
        return { accountName, authIndex: Number.isFinite(authIndex) ? authIndex : null };
    }

    static createEmptySnapshot() {
        return {
            accounts: [],
            models: [],
            records: [],
            startedAt: null,
            summary: {
                abortedCount: 0,
                activeRequests: 0,
                avgDurationMs: 0,
                errorCount: 0,
                formatBreakdown: [],
                requestCategoryBreakdown: [],
                streamModeBreakdown: [],
                successCount: 0,
                successRate: 0,
                totalRequests: 0,
                uniqueAccountPairs: 0,
                uptimeSeconds: 0,
            },
        };
    }

    static createEmptySummarySnapshot() {
        const snapshot = UsageStatsService.createEmptySnapshot();
        delete snapshot.records;
        return { ...snapshot, dataset_revision: 0 };
    }
}

module.exports = UsageStatsService;
