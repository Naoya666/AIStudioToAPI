const { accountForIndex, canUseModel, modelQuota, resolveTier } = require("../accounts/AccountTierPolicy");
const { isArgon } = require("./BuildBenefitContext");
const fs = require("fs");
const path = require("path");
const { isUserAbortedError } = require("../utils/CustomErrors");

const schedulerError = (message, status = 503) => Object.assign(new Error(message), { status });
const PACIFIC_TIMEZONE = "America/Los_Angeles";
const PACIFIC_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: PACIFIC_TIMEZONE,
    year: "numeric",
});
const PERSISTENT_403_THRESHOLD_MS = 48 * 60 * 60 * 1000;
const PACIFIC_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: PACIFIC_TIMEZONE,
    year: "numeric",
});

function pacificDateTimeParts(timestamp) {
    const parts = Object.fromEntries(
        PACIFIC_DATE_TIME_FORMATTER.formatToParts(new Date(timestamp))
            .filter(part => part.type !== "literal")
            .map(part => [part.type, Number(part.value)])
    );
    return parts;
}

function nextDateKey(dateKey) {
    const [year, month, day] = dateKey.split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(
        next.getUTCDate()
    ).padStart(2, "0")}`;
}

function calculateNextPacificResetAt(now, configuredTime, skipDate = null) {
    const [targetHour, targetMinute] = configuredTime.split(":").map(Number);
    const current = pacificDateTimeParts(now);
    const currentDate = `${current.year}-${String(current.month).padStart(2, "0")}-${String(current.day).padStart(
        2,
        "0"
    )}`;
    const currentMinute = current.hour * 60 + current.minute;
    const targetMinutes = targetHour * 60 + targetMinute;
    let targetDate =
        currentMinute <= targetMinutes && skipDate !== currentDate ? currentDate : nextDateKey(currentDate);
    if (skipDate === targetDate) targetDate = nextDateKey(targetDate);

    // Searching real instants avoids depending on the host timezone and naturally handles DST:
    // the first valid minute after a missing wall time wins, and a repeated wall time is seen once.
    let candidate =
        currentMinute === targetMinutes && targetDate === currentDate ? now : Math.ceil(now / 60000) * 60000;
    for (let count = 0; count < 3 * 24 * 60; count++, candidate += 60000) {
        const parts = pacificDateTimeParts(candidate);
        const date = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
        if (date === targetDate && parts.hour * 60 + parts.minute >= targetMinutes) return candidate;
        if (date > targetDate) {
            targetDate = nextDateKey(targetDate);
        }
    }
    throw new Error(`Cannot calculate next ${PACIFIC_TIMEZONE} reset time`);
}

const { normalizeModelName } = require("./ModelName");

function getModelDailyQuota(model, account = {}) {
    return modelQuota(model, account);
}

function isValidDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const [, year, month, day] = match.map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function classifyError(error = {}) {
    if (require("../utils/UpstreamBlock").isPromptBlocked(error)) return "prompt_blocked";
    if (require("../utils/MakerSuiteAuth").isBridgeAuthFailure(error)) return "bridge_auth";
    if (isUserAbortedError(error) || error.reason === "client_disconnect") return "aborted";
    if (
        error.kind === "transport" ||
        error.code === "QUEUE_CLOSED" ||
        [
            "page_closed",
            "context_closed",
            "connection_lost",
            "reconnect_cleanup",
            "grace_period_timeout",
            "retry_replaced",
        ].includes(error.kind || error.reason)
    )
        return "transport";
    const message = String(error.message || "");
    const explicitStatus = Number(error.status ?? error.code);
    const messageStatus = Number(
        /^\s*\[(\d{3})\]/.exec(message)?.[1] || /Google API returned error:\s*(\d{3})/i.exec(message)?.[1]
    );
    const status = Number.isFinite(explicitStatus) ? explicitStatus : messageStatus;
    if (status === 403) return "risk_controlled";
    if (error.accountUnhealthy) return "account";
    if (/^unsupported$/i.test(message.trim())) return "unsupported";
    if (
        error.isAuthExpired ||
        status === 401 ||
        /account (?:suspended|disabled)|cookie.*(?:expired|invalid)|login (?:failed|required)/i.test(message)
    )
        return "account";
    if (status === 429 || /RESOURCE_EXHAUSTED/.test(message)) return "rate_limited";
    if (
        /PERMISSION_DENIED|model.*(?:unsupported|unavailable for account)|(?:unsupported|no access to).*model/i.test(
            message
        )
    )
        return "unsupported";
    if (status >= 500 || /websocket|network|connection|queue.*(?:closed|timeout)|upstream|timed out/i.test(message))
        return "temporary";
    return "request";
}

function observedHttpStatus(error = {}, kind) {
    const message = String(error.message || "");
    const explicitStatus = Number(error.status ?? error.code);
    const messageStatus = Number(
        /^\s*\[(\d{3})\]/.exec(message)?.[1] || /Google API returned error:\s*(\d{3})/i.exec(message)?.[1]
    );
    if (Number.isInteger(explicitStatus) && explicitStatus >= 100 && explicitStatus <= 599) return explicitStatus;
    if (Number.isInteger(messageStatus) && messageStatus >= 100 && messageStatus <= 599) return messageStatus;
    if (kind === "rate_limited" && /RESOURCE_EXHAUSTED/.test(message)) return 429;
    return null;
}

class ModelScheduler {
    constructor(config, authSource, logger) {
        this.config = config;
        this.authSource = authSource;
        this.logger = logger;
        this.accounts = new Map();
        this.fileAffinities = new Map();
        this.hiddenModels = new Set();
        this.pending = [];
        this.workers = Array.from({ length: config.globalConcurrency }, (_, id) => ({ id, lease: null }));
        this.sequence = 0;
        this.closed = false;
        this.random = typeof config.random === "function" ? config.random : Math.random;
        this.now = typeof config.now === "function" ? config.now : Date.now;
        this.setTimer = typeof config.setTimer === "function" ? config.setTimer : setTimeout;
        this.clearTimer = typeof config.clearTimer === "function" ? config.clearTimer : clearTimeout;
        this.cooldownWakeTimer = null;
        this.nextCooldownCheckAt = null;
        this.dailyResetTimer = null;
        this.lastDailyResetPacificDate = null;
        this.metrics = {
            dispatch_timeout: 0,
            local_transport: 0,
            samples: {
                context_wait_ms: [],
                http_headers_ms: [],
                model_first_output_ms: [],
                request_complete_ms: [],
                stream_start_ms: [],
                upstream_ttfb_ms: [],
            },
            upstream_error: 0,
        };
        this.load();
        this._scheduleCooldownWake();
        if (this.config.dailyResetEnabled !== false) this._scheduleDailyReset();
    }

    account(index) {
        // Email survives auth file re-numbering; anonymous auth sources use their index.
        const key = this.authSource.accountNameMap.get(index) || `auth-${index}`;
        if (!this.accounts.has(key))
            this.accounts.set(key, {
                continuous_403_since: null,
                disabled: false,
                disabled_at: null,
                disabled_reason: null,
                healthy: true,
                key,
                last_error: null,
                models: Object.create(null),
            });
        const account = this.accounts.get(key);
        account.index = index;
        account.inflight ??= 0;
        account.disabled ??= false;
        account.disabled_at ??= null;
        account.disabled_reason ??= null;
        account.continuous_403_since ??= null;
        return account;
    }

    getPacificDateKey(now = Date.now()) {
        const parts = Object.fromEntries(
            PACIFIC_DATE_FORMATTER.formatToParts(new Date(now))
                .filter(part => part.type !== "literal")
                .map(part => [part.type, part.value])
        );
        return `${parts.year}-${parts.month}-${parts.day}`;
    }

    rolloverDailyUsage(slot, now = Date.now()) {
        const date = this.getPacificDateKey(now);
        if (slot.daily_request_date === date) return false;
        slot.daily_request_count = 0;
        slot.daily_failure_count = 0;
        slot.daily_request_date = date;
        return true;
    }

    slot(account, model, now = Date.now()) {
        if (!Object.hasOwn(account.models, model))
            account.models[model] = {
                consecutive_failures: 0,
                cooldown_until: 0,
                daily_failure_count: 0,
                daily_request_count: 0,
                daily_request_date: this.getPacificDateKey(now),
                failure_count: 0,
                inflight: 0,
                last_error: null,
                last_error_kind: null,
                last_http_status: null,
                last_used_at: 0,
                rate_limited: false,
                request_count: 0,
                risk_control_failures: 0,
                success_count: 0,
                unsupported: false,
            };
        const slot = account.models[model];
        if (this.rolloverDailyUsage(slot, now)) this.saveSoon();
        if (slot.cooldown_until && slot.cooldown_until <= now) {
            slot.rate_limited = false;
            slot.cooldown_until = 0;
        }
        return slot;
    }

    getVisibleModels() {
        if (this._roundVisibleModels) return this._roundVisibleModels;
        const models = new Set(
            [...this._snapshotModels()].filter(model => !model.startsWith("__") && !this.hiddenModels.has(model))
        );
        if (this._draining) this._roundVisibleModels = models;
        return models;
    }

    accountPoolRestriction(account, models = this.getVisibleModels()) {
        if (!this.config.modelAllowlist) return null;
        const allowed = [...models].filter(model => this.isTierAllowed(account.index, model));
        if (!allowed.length) return "model_permissions_empty";
        if (allowed.every(model => account.models[model]?.unsupported)) return "models_unsupported";
        if (
            allowed.some(model => account.models[model]?.unsupported) &&
            allowed.every(model => {
                const slot = account.models[model];
                return slot?.unsupported || (slot?.rate_limited && slot.cooldown_until > this.now());
            })
        )
            return "models_unavailable";
        return null;
    }

    isAccountQuotaExhausted(account, now = this.now(), models = this.getVisibleModels()) {
        const allowed = [...models].filter(model => this.isTierAllowed(account.index, model));
        return (
            allowed.length > 0 &&
            allowed.every(model => {
                const slot = account.models[model];
                return slot?.rate_limited === true && slot.cooldown_until > now;
            })
        );
    }

    isAccountPoolResident(index, now = this.now(), models = this.getVisibleModels()) {
        const account = this.account(index);
        return (
            this.authSource.getRotationIndices().includes(index) &&
            account.healthy &&
            !account.disabled &&
            !this.authSource.isExpired?.(index) &&
            !this.accountPoolRestriction(account, models) &&
            !this.isAccountQuotaExhausted(account, now, models)
        );
    }

    isResourceEligible(account, model, now = this.now()) {
        const slot = account.models[model];
        if (!this.isTierAllowed(account.index, model)) return false;
        return (
            account.healthy &&
            !account.disabled &&
            !this.authSource.isExpired?.(account.index) &&
            !this.hiddenModels.has(model) &&
            !slot?.unsupported &&
            (!slot?.cooldown_until || slot.cooldown_until <= now)
        );
    }

    isTierAllowed(index, model) {
        if (
            model !== "__files__" &&
            this.config.registeredModels &&
            !this.config.registeredModels.includes(normalizeModelName(model))
        )
            return false;
        return canUseModel(accountForIndex(this.authSource, index), model, this.config.modelAllowlist);
    }

    permissionsChanged() {
        this.sequence++;
        this._eligibleRound = null;
        this._selectionPass = null;
        this._validationQueue = null;
        this._validationCursor = 0;
        this._roundModels = null;
        this._roundVisibleModels = null;
        this.drain();
        this.coordinateContextPool();
    }

    noEligibleError(model) {
        if (!this.authSource.getRotationIndices().some(index => this.isTierAllowed(index, model)))
            return Object.assign(schedulerError(`No accounts allowed by tier for model ${model}`, 403), {
                code: "MODEL_TIER_DENIED",
                reason: "model_tier_denied",
            });
        return Object.assign(schedulerError(`No eligible accounts for model ${model}`), {
            code: "NO_ELIGIBLE_ACCOUNTS",
        });
    }

    assertModelAccessible(model) {
        const normalized = model === "__files__" ? model : normalizeModelName(model);
        if (
            normalized !== "__files__" &&
            this.config.registeredModels &&
            !this.config.registeredModels.includes(normalized)
        )
            throw Object.assign(schedulerError(`Unknown model ${normalized}`, 404), { code: "UNKNOWN_MODEL" });
        if (this.hiddenModels.has(normalized))
            throw Object.assign(schedulerError(`Model ${normalized} is disabled`, 403), { code: "MODEL_DISABLED" });
        return normalized;
    }

    coordinateContextPool() {
        if (this.closed || this.poolCoordinationQueued) return;
        this.poolCoordinationQueued = true;
        setImmediate(() => {
            this.poolCoordinationQueued = false;
            if (this.closed || this.recovering || this.paused) return;
            this._scheduleCooldownWake();
            this.browserManager?.reconcileContextPool?.();
        });
    }

    _scheduleCooldownWake() {
        this.clearTimer(this.cooldownWakeTimer);
        this.cooldownWakeTimer = null;
        this.nextCooldownCheckAt = null;
        if (this.closed) return;
        const now = this.now();
        const models = this.getVisibleModels();
        const deadlines = [...this.accounts.values()].flatMap(account =>
            [...models]
                .map(model => account.models[model])
                .filter(slot => slot?.rate_limited === true && slot.cooldown_until > now)
                .map(slot => slot.cooldown_until)
        );
        if (!deadlines.length) return;
        this.nextCooldownCheckAt = Math.min(...deadlines);
        this.cooldownWakeTimer = this.setTimer(
            () => {
                this.cooldownWakeTimer = null;
                if (this.closed) return;
                const firedAt = this.now();
                for (const account of this.accounts.values())
                    for (const model of models) {
                        const slot = account.models[model];
                        if (slot?.rate_limited && slot.cooldown_until <= firedAt) {
                            slot.rate_limited = false;
                            slot.cooldown_until = 0;
                        }
                    }
                this.sequence++;
                this.saveSoon();
                this.drain();
                this._scheduleCooldownWake();
            },
            Math.min(2147483647, Math.max(1, this.nextCooldownCheckAt - now))
        );
        this.cooldownWakeTimer?.unref?.();
    }

    noteBenefitState() {
        this._eligibleRound = null;
    }

    eligibleAccounts(model, excluded = new Set()) {
        let eligible = this._eligibleRound?.get(model);
        if (!eligible) {
            eligible = this.authSource
                .getRotationIndices()
                .map(index => this.account(index))
                .filter(account => this.isResourceEligible(account, model));
            this._eligibleRound?.set(model, eligible);
        }
        return excluded.size ? eligible.filter(account => !excluded.has(account.key)) : eligible;
    }

    candidates(model, excluded = new Set()) {
        return this.eligibleAccounts(model, excluded);
    }

    readyCandidates(model, excluded = new Set()) {
        const eligible = this.eligibleAccounts(model, excluded);
        if ((!this.config.readyContextOnly && !isArgon(model)) || !this.browserManager) return eligible;
        return eligible.filter(account => {
            if (!this.browserManager.isContextReady(account.index)) return false;
            if (isArgon(model)) {
                const benefit = this.browserManager.contexts?.get(account.index)?.page?.buildBenefit;
                if (benefit?.disposed || benefit?.isCurrent?.() === false) return false;
                return true;
            }
            return true;
        });
    }

    needsContextForRequest(item, account = null, ignoreReadyAccount = null) {
        if (item.signal?.aborted || this.hiddenModels.has(item.model)) return false;
        if (
            account &&
            (item.excluded.has(account.key) ||
                !this.authSource.getRotationIndices().includes(account.index) ||
                !this.isResourceEligible(account, item.model))
        )
            return false;
        return !this.readyCandidates(item.model, item.excluded).some(
            candidate => candidate.index !== ignoreReadyAccount && this.canLease(candidate, item.model)
        );
    }

    hasUnmetContextDemand(authIndex, models) {
        const account = this.account(authIndex);
        // The initializer must retain its own demand until publication, including
        // internal file contexts that are not ordinary warm-pool residents.
        const ignoreReadyAccount = this.browserManager?.initializingContexts?.has(authIndex) ? authIndex : null;
        return this.pending.some(
            item =>
                models.has(item.model) &&
                this.needsContextForRequest(item, account, ignoreReadyAccount) &&
                (ignoreReadyAccount !== null || !this.hasInitializingContextForRequest(item))
        );
    }

    hasInitializingContextForRequest(item, indices = this.browserManager?.initializingContexts || []) {
        return [...indices].some(index => {
            const account = this.account(index);
            return (
                !item.excluded.has(account.key) &&
                this.authSource.getRotationIndices().includes(index) &&
                this.isResourceEligible(account, item.model)
            );
        });
    }

    canLease(account, model) {
        if (this.browserManager?.benefitCheckingIndices?.has(account.index)) return false;
        if (isArgon(model)) {
            const benefit = this.browserManager?.contexts?.get(account.index)?.page?.buildBenefit;
            if (benefit?.disposed || benefit?.isCurrent?.() === false) return false;
        }
        if (!this.isTierAllowed(account.index, model)) return false;
        if (account.key === this.drainingAccount) return false;
        if (model !== "__files__" && this.isAccountQuotaExhausted(account)) return false;
        const accountLimit = this.config.accountConcurrency || 0;
        const modelLimit = this.config.accountModelConcurrency?.[model] ?? accountLimit;
        if (accountLimit && account.inflight >= accountLimit) return false;
        if (modelLimit && this.slot(account, model).inflight >= modelLimit) return false;
        if (this.config.readyContextOnly && this.browserManager) {
            if (!this.browserManager.isContextReady(account.index)) return false;
            const contextLimit = this.config.contextMaxConcurrency || 0;
            return !contextLimit || account.inflight < contextLimit;
        }
        return (
            account.inflight > 0 ||
            (this._draining
                ? this._roundActiveAccountCount
                : [...this.accounts.values()].filter(entry => entry.inflight > 0).length) < this.config.maxWorkers
        );
    }

    active(model) {
        return this.workers.filter(worker => worker.lease?.model === model).length;
    }

    acquire(model, excluded = new Set(), signal) {
        if (this.closed) return Promise.reject(schedulerError("Scheduler is shutting down"));
        if (this.recovering) return Promise.reject(schedulerError("Service recovering", 503));
        try {
            model = this.assertModelAccessible(model);
        } catch (error) {
            return Promise.reject(error);
        }
        if (!this.authSource.getRotationIndices().some(index => this.isTierAllowed(index, model)))
            return Promise.reject(this.noEligibleError(model));
        const atLimit =
            this.pending.length >= (this.config.globalQueueSize ?? 1000) ||
            this.pending.filter(item => item.model === model).length >= this.config.queueSize;
        const immediate =
            atLimit &&
            !this.paused &&
            this.workers.some(worker => !worker.lease) &&
            this.readyCandidates(model, excluded).some(account => this.canLease(account, model));
        if (atLimit && !immediate) return Promise.reject(schedulerError("Queue full", 429));
        if (signal?.aborted) return Promise.reject(schedulerError("Client disconnected", 499));
        const eligible = this.eligibleAccounts(model, excluded);
        if (!eligible.length) return Promise.reject(this.noEligibleError(model));
        // Record accepted discovery only after validation and access checks. Other
        // accounts remain unknown until they actually participate in this model.
        this.slot(eligible[0], model, this.now());
        return new Promise((resolve, reject) => {
            const item = { createdAt: Date.now(), excluded, model, order: ++this.sequence, reject, resolve, signal };
            item.abort = () => {
                this.remove(item);
                reject(schedulerError("Client disconnected", 499));
                this.drain();
            };
            signal?.addEventListener("abort", item.abort, { once: true });
            if (this.pending.length >= (this.config.globalQueueSize ?? 1000) && !immediate) {
                signal?.removeEventListener("abort", item.abort);
                reject(schedulerError("Queue full", 429));
                return;
            }
            this.pending.push(item);
            this.drain();
            if (this.pending.includes(item)) {
                if (
                    this.pending.filter(entry => entry.model === model).length > this.config.queueSize ||
                    this.pending.length > (this.config.globalQueueSize ?? 1000)
                ) {
                    this.remove(item);
                    reject(schedulerError(`Queue full for model ${model}`, 429));
                } else {
                    item.timer = setTimeout(() => {
                        this.remove(item);
                        this.metrics.dispatch_timeout++;
                        reject(schedulerError(`Queue timeout for model ${model}`, 504));
                    }, this.config.queueTimeoutMs);
                }
            }
        });
    }

    remove(item) {
        const index = this.pending.indexOf(item);
        if (index >= 0) this.pending.splice(index, 1);
        clearTimeout(item.timer);
        item.signal?.removeEventListener("abort", item.abort);
        this.coordinateContextPool();
    }

    drain() {
        if (this.closed || this.recovering || this.paused || this._draining) return;
        this._draining = true;
        const started = performance.now();
        const deadline = started + (this.config.drainBudgetMs ?? 8);
        this._roundModels = null;
        this._eligibleRound = new Map();
        this._roundActiveAccountCount = [...this.accounts.values()].filter(account => account.inflight > 0).length;
        try {
            this._drainRound(deadline);
        } finally {
            this._roundModels = null;
            this._roundVisibleModels = null;
            this._eligibleRound = null;
            this._draining = false;
            this.metrics.drain_rounds = (this.metrics.drain_rounds || 0) + 1;
            this.metrics.last_drain_ms = performance.now() - started;
        }
    }

    _continueDrain() {
        if (this._drainQueued || this.closed) return;
        this._drainQueued = setImmediate(() => {
            this._drainQueued = null;
            this.drain();
        });
    }

    _drainRound(deadline) {
        if (this.closed) return;
        this.coordinateContextPool();
        // Reservation and selection are synchronous: there is no await between checking and leasing.
        // Resume a finite validation pass instead of rescanning its prefix forever.
        this._validationQueue ||= [...this.pending];
        this._validationCursor ||= 0;
        while (this._validationCursor < this._validationQueue.length) {
            if (this._validationCursor && performance.now() >= deadline) {
                this._continueDrain();
                return;
            }
            const item = this._validationQueue[this._validationCursor++];
            if (!this.pending.includes(item)) continue;
            if (this.hiddenModels.has(item.model)) {
                this.remove(item);
                item.reject(
                    Object.assign(schedulerError(`Model ${item.model} is disabled`, 403), { code: "MODEL_DISABLED" })
                );
            } else if (!this.eligibleAccounts(item.model, item.excluded).length) {
                this.remove(item);
                item.reject(this.noEligibleError(item.model));
            }
        }
        if (this.paused) return;
        if (performance.now() >= deadline) {
            this._continueDrain();
            return;
        }
        this._signalContextDemand(deadline);
        // Stop replenishing one context when a waiting model needs a different account.
        // Existing streams finish normally; this prevents permanent starvation at capacity.
        const activeAccounts = [...this.accounts.values()].filter(account => account.inflight > 0);
        const waitingForContext = this.pending.some(item => {
            const candidates = this.candidates(item.model, item.excluded);
            return candidates.length && candidates.every(account => !account.inflight);
        });
        if (waitingForContext && activeAccounts.length >= this.config.maxWorkers) {
            if (!activeAccounts.some(account => account.key === this.drainingAccount)) {
                const draining = activeAccounts.sort((a, b) => {
                    const ranked = this.browserManager?.compareAccountsForDraining?.(a.index, b.index);
                    return ranked || a.inflight - b.inflight || a.index - b.index;
                })[0];
                this.drainingAccount = draining.key;
                this.browserManager?.beginAccountDrain?.(draining.index, "context_capacity");
            }
        } else {
            this.drainingAccount = null;
        }
        for (const worker of this.workers.filter(entry => !entry.lease)) {
            if (performance.now() >= deadline) {
                if (
                    !this.browserManager ||
                    !this.config.readyContextOnly ||
                    [...(this.browserManager.contexts?.values() || [])].some(data => data.state === "READY")
                )
                    this._continueDrain();
                break;
            }
            const selection = this._selectPendingItem(deadline);
            if (!selection.done) {
                this._continueDrain();
                break;
            }
            const item = selection.item;
            if (!item) break;
            if (!this.pending.includes(item) || !this._canDispatchItem(item)) continue;
            const accounts = this.readyCandidates(item.model, item.excluded).filter(account =>
                this.canLease(account, item.model)
            );
            accounts.sort((a, b) => {
                const x = this.slot(a, item.model),
                    y = this.slot(b, item.model);
                const recentTransportFailures = account =>
                    Date.now() - (account.last_transport_failure_at || 0) < 60000
                        ? account.local_transport_failures || 0
                        : 0;
                return (
                    x.inflight - y.inflight ||
                    a.inflight - b.inflight ||
                    recentTransportFailures(a) - recentTransportFailures(b) ||
                    (this.config.strategy === "least_used" ? x.request_count - y.request_count : 0) ||
                    x.last_used_at - y.last_used_at ||
                    (x.last_selected || 0) - (y.last_selected || 0) ||
                    a.index - b.index
                );
            });
            const account = accounts[0];
            const slot = this.slot(account, item.model);
            if (!account.inflight) this._roundActiveAccountCount++;
            account.inflight++;
            slot.inflight++;
            slot.last_used_at = Date.now();
            slot.last_selected = ++this.sequence;
            const lease = {
                account,
                attempted: false,
                model: item.model,
                recorded: false,
                released: false,
                sessionVersion: this._requestSessionVersion(account.index),
                slot,
                worker,
            };
            worker.lease = lease;
            this.remove(item);
            this.observe("context_wait_ms", Date.now() - item.createdAt);
            item.resolve(lease);
        }
        // Dispatch can consume the last ready slot. Reassess the remaining queue
        // now, rather than waiting for a lease to finish before expanding.
        if (this.pending.length && performance.now() < deadline) this._signalContextDemand(deadline);
        if (!this._drainQueued) {
            this._validationQueue = null;
            this._validationCursor = 0;
        }
    }

    _canDispatchItem(item) {
        if (item.signal?.aborted || this.hiddenModels.has(item.model)) return false;
        const active = this.active(item.model);
        const allocation = this.config.allocation[item.model];
        const staticLimit =
            allocation?.preferred ??
            Math.max(
                1,
                this.config.globalConcurrency -
                    Object.values(this.config.allocation).reduce((sum, entry) => sum + entry.preferred, 0)
            );
        return (
            active < (this.config.modelConcurrency[item.model] ?? this.config.globalConcurrency) &&
            (this.config.dynamic || active < staticLimit) &&
            this.readyCandidates(item.model, item.excluded).some(account => this.canLease(account, item.model))
        );
    }

    _selectPendingItem(deadline) {
        const pass = (this._selectionPass ||= { best: null, cursor: 0, items: [...this.pending], priority: Infinity });
        while (pass.cursor < pass.items.length) {
            if (performance.now() >= deadline) return { done: false };
            const item = pass.items[pass.cursor++];
            if (!this.pending.includes(item) || !this._canDispatchItem(item)) continue;
            const active = this.active(item.model);
            const allocation = this.config.allocation[item.model] || { min: 0, preferred: 1 };
            const priority = active < allocation.min ? 0 : active < allocation.preferred ? 1 : 2;
            if (priority < pass.priority || (priority === pass.priority && item.order < pass.best.order)) {
                pass.best = item;
                pass.priority = priority;
            }
        }
        this._selectionPass = null;
        return { done: true, item: pass.best };
    }

    _signalContextDemand(deadline = Infinity) {
        if (!this.browserManager || (!this.config.readyContextOnly && !this.pending.some(item => isArgon(item.model))))
            return;
        if (this.browserManager._contextInitTasks?.size >= this.config.contextInitConcurrency) return;
        const demanded = new Set();
        const requests = [];
        const offset = this._demandOffset || 0;
        for (let n = 0; n < this.pending.length; n++) {
            if (performance.now() >= deadline) break;
            const item = this.pending[(offset + n) % this.pending.length];
            if (!this.config.readyContextOnly && !isArgon(item.model)) continue;
            this._demandOffset = (offset + n + 1) % this.pending.length;
            if (!this.needsContextForRequest(item)) continue;
            // An admitted initializer already covers this request's next dispatch
            // opportunity. Its settlement will re-evaluate any remaining queue.
            if (this.hasInitializingContextForRequest(item)) continue;
            if (
                this.hasInitializingContextForRequest(
                    item,
                    requests.map(request => request.authIndex)
                )
            )
                continue;
            const cold = this.eligibleAccounts(item.model, item.excluded).find(
                account => !demanded.has(account.index) && !this.browserManager.isContextReady(account.index)
            );
            if (cold && !demanded.has(cold.index)) {
                demanded.add(cold.index);
                requests.push({ authIndex: cold.index, model: item.model });
                if (requests.length >= this.config.contextInitConcurrency) break;
            }
        }
        if (this.browserManager.requestContexts) this.browserManager.requestContexts(requests);
        else for (const { authIndex, model } of requests) this.browserManager.requestContext(authIndex, model);
    }

    beginRecovery(reason) {
        this.recovering = true;
        this._selectionPass = null;
        this._validationQueue = null;
        this._validationCursor = 0;
        const error = Object.assign(schedulerError(`Service recovering: ${reason}`, 503), {
            kind: "transport",
            reason: "service_recovery",
        });
        for (const item of [...this.pending]) {
            this.remove(item);
            item.reject(error);
        }
        for (const worker of this.workers) {
            const lease = worker.lease;
            if (lease) {
                try {
                    lease.abort?.(error);
                } catch (cause) {
                    this.logger.error?.(`[Scheduler] Recovery abort failed: ${cause.message}`);
                } finally {
                    this.release(lease);
                }
            }
        }
    }

    startAttempt(lease) {
        if (!lease || lease.attempted || lease.released) return;
        const now = Date.now();
        lease.attempted = true;
        lease.sessionVersion = this._requestSessionVersion(lease.account.index);
        this.rolloverDailyUsage(lease.slot, now);
        lease.slot.daily_request_count++;
        lease.slot.request_count++;
        lease.slot.last_used_at = now;
        this.browserManager?.markContextRequest?.(lease.account.index, now);
        this.saveSoon();
    }

    _requestSessionVersion(index) {
        const context = this.browserManager?.contexts?.get(index);
        return (
            context?.page?.accountSessionVersion ??
            context?.sessionVersion ??
            this.authSource.accountLoginService?.state?.accounts.find(account => account.authIndex === index)
                ?.sessionVersion
        );
    }

    failure(lease, error) {
        if (!lease || lease.recorded) return lease?.expirationPromise;
        if (require("../utils/UpstreamBlock").isPromptBlocked(error)) {
            lease.recorded = true;
            return;
        }
        let kind = classifyError(error);
        if (
            (isArgon(lease.model) || error.transport === "makersuite") &&
            (Number(error.status) === 403 ||
                /PERMISSION_DENIED|RPC.*(?:Code|code)\s*7/.test(String(error.message || "")))
        )
            kind = "unsupported";
        if (["BUILD_BENEFIT_NOT_READY", "MODEL_TIER_DENIED", "MODEL_DISABLED", "UNKNOWN_MODEL"].includes(error.code))
            return;
        if (kind === "aborted" || kind === "bridge_auth") return;
        if (kind === "transport") {
            lease.recorded = true;
            lease.account.local_transport_failures = (lease.account.local_transport_failures || 0) + 1;
            lease.account.last_transport_failure_at = Date.now();
            this.metrics.local_transport++;
            return;
        }
        const upstreamAuthExpired =
            kind === "account" &&
            ((Number(error.status) === 401 && error.upstreamError?.status === "UNAUTHENTICATED") ||
                /Google API returned error:\s*401\s+UNAUTHENTICATED\b/i.test(String(error.message || "")));
        const currentSession = this.authSource.accountLoginService?.state?.accounts.find(
            account => account.authIndex === lease.account.index
        );
        if (upstreamAuthExpired && currentSession && lease.sessionVersion !== currentSession.sessionVersion) {
            // A late response from a retired Context must not disable its replacement.
            lease.recorded = true;
            return;
        }
        lease.recorded = true;
        const { account, slot } = lease;
        this._recordAccountObservedResult(account, observedHttpStatus(error, kind));
        this.rolloverDailyUsage(slot);
        slot.daily_failure_count++;
        slot.failure_count++;
        this.metrics.upstream_error++;
        if (kind === "risk_controlled") slot.risk_control_failures = (slot.risk_control_failures || 0) + 1;
        else slot.consecutive_failures++;
        slot.last_error = String(error.message || "Request failed").slice(0, 2000);
        slot.last_error_kind = kind;
        if (error.transport) slot.last_transport = error.transport;
        const httpStatus = Number(error.status ?? error.code);
        slot.last_http_status = Number.isFinite(httpStatus)
            ? httpStatus
            : kind === "risk_controlled"
              ? 403
              : kind === "rate_limited"
                ? 429
                : null;
        account.last_error = slot.last_error;
        if (kind === "account") account.healthy = false;
        if (kind === "unsupported") slot.unsupported = true;
        if (kind === "rate_limited") {
            slot.rate_limited = true;
            slot.cooldown_until = this.now() + this.config.rateLimitCooldownMs;
        }
        if (kind === "temporary")
            slot.cooldown_until =
                Date.now() + this.config.tempErrorCooldownMs * Math.min(4, 2 ** (slot.consecutive_failures - 1));
        if (kind === "risk_controlled") {
            const multipliers = [1, 3, 6, 18];
            const multiplier = multipliers[Math.min(slot.risk_control_failures - 1, multipliers.length - 1)];
            const jitter = this.config.riskControlJitter === false ? 1 : 0.9 + this.random() * 0.2;
            const cooldown = Math.min(
                this.config.riskControlMaxCooldownMs,
                Math.round(this.config.riskControlCooldownMs * multiplier * jitter)
            );
            slot.cooldown_until = Date.now() + cooldown;
            this.logger.warn?.(
                `[Scheduler] Risk control account #${account.index}, model ${lease.model}, consecutive=${slot.risk_control_failures}, cooldown_until=${slot.cooldown_until}`
            );
        }
        this.sequence++;
        this.saveSoon();
        this.coordinateContextPool();
        if (upstreamAuthExpired && this.authSource.markAsExpired) {
            // Keep failure accounting synchronous; callers can await the durable session update.
            lease.expirationPromise = Promise.resolve()
                .then(() => this.authSource.markAsExpired(account.index, lease.sessionVersion))
                .catch(cause => {
                    this.logger.error?.(
                        `[Scheduler] Failed to expire auth #${account.index} after upstream 401: ${cause.message}`
                    );
                });
            return lease.expirationPromise;
        }
    }

    release(lease, success = false) {
        if (!lease || lease.released) return;
        lease.released = true;
        this.metrics.completed = (this.metrics.completed || 0) + 1;
        if (success && lease.attempted && !lease.recorded) {
            this._recordAccountObservedResult(lease.account, 200);
            lease.slot.success_count++;
            lease.slot.consecutive_failures = 0;
            lease.slot.risk_control_failures = 0;
            lease.slot.last_error = null;
            lease.slot.last_error_kind = null;
            lease.slot.last_http_status = null;
        }
        lease.account.inflight--;
        lease.slot.inflight--;
        lease.worker.lease = null;
        this.saveSoon();
        this.drain();
        this.browserManager?.handleAccountLeaseReleased?.(lease.account.index);
    }

    _recordAccountObservedResult(account, status) {
        if (status === 403) {
            if (account.continuous_403_since == null) {
                account.continuous_403_since = this.now();
                this.sequence++;
                this.saveSoon();
            }
            return;
        }
        if (status !== null && status !== undefined && account.continuous_403_since != null) {
            account.continuous_403_since = null;
            this.sequence++;
            this.saveSoon();
        }
    }

    _persistent403Snapshot(account, now = this.now()) {
        const since = account.continuous_403_since ?? null;
        const duration = since === null ? 0 : Math.max(0, now - since);
        return {
            continuous_403_duration_ms: duration,
            continuous_403_since: since,
            persistent_403: since !== null && duration >= PERSISTENT_403_THRESHOLD_MS,
        };
    }

    isAccountManuallyDisabled(index) {
        return this.account(index).disabled === true;
    }

    disable(index, reason = "manual") {
        const account = this.account(index);
        if (account.disabled) return { account_id: index, changed: false, disabled: true };
        account.disabled = true;
        account.disabled_at = Date.now();
        account.disabled_reason = reason;
        this.sequence++;
        this.flush();
        this.browserManager?.handleAccountDisabled?.(index);
        this.drain();
        return { account_id: index, changed: true, disabled: true };
    }

    resetAllRateLimits() {
        let resetCount = 0;
        // Synchronous update preserves active leases; later 429 responses can set a new cooldown.
        for (const account of this.accounts.values()) {
            for (const slot of Object.values(account.models)) {
                if (!slot.rate_limited) continue;
                slot.rate_limited = false;
                slot.cooldown_until = 0;
                resetCount++;
            }
        }
        if (resetCount) this.sequence++;
        this.flush();
        this.drain();
        return resetCount;
    }

    resetAllAccounts() {
        let resetAccountCount = 0;
        let resetModelCount = 0;
        // Limit the override to accounts that are currently valid rotation candidates.
        for (const index of this.authSource.getRotationIndices()) {
            const account = this.account(index);
            if (
                account.disabled ||
                !account.healthy ||
                account.last_error !== null ||
                account.disabled_at !== null ||
                account.disabled_reason !== null
            ) {
                account.disabled = false;
                account.disabled_at = null;
                account.disabled_reason = null;
                account.healthy = true;
                account.last_error = null;
                resetAccountCount++;
            }
            for (const slot of Object.values(account.models)) {
                if (
                    !slot.unsupported &&
                    !slot.rate_limited &&
                    !slot.cooldown_until &&
                    !slot.consecutive_failures &&
                    !slot.risk_control_failures &&
                    slot.last_error === null
                )
                    continue;
                Object.assign(slot, {
                    consecutive_failures: 0,
                    cooldown_until: 0,
                    last_error: null,
                    last_error_kind: null,
                    last_http_status: null,
                    rate_limited: false,
                    risk_control_failures: 0,
                    unsupported: false,
                });
                resetModelCount++;
            }
        }
        if (resetAccountCount || resetModelCount) this.sequence++;
        this.flush();
        this.drain();
        this.browserManager?.handleAccountsEnabled?.();
        return { reset_account_count: resetAccountCount, reset_model_count: resetModelCount };
    }

    resetDailyCooldowns() {
        let affectedAccountCount = 0;
        let affectedSlotCount = 0;
        for (const index of this.authSource.getRotationIndices()) {
            const account = this.account(index);
            let accountChanged = false;
            for (const slot of Object.values(account.models)) {
                const changed = Boolean(
                    slot.cooldown_until ||
                    slot.rate_limited ||
                    slot.risk_control_failures ||
                    slot.consecutive_failures ||
                    slot.last_error !== null ||
                    slot.last_error_kind !== null ||
                    slot.last_http_status !== null
                );
                if (!changed) continue;
                Object.assign(slot, {
                    consecutive_failures: 0,
                    cooldown_until: 0,
                    last_error: null,
                    last_error_kind: null,
                    last_http_status: null,
                    rate_limited: false,
                    risk_control_failures: 0,
                });
                affectedSlotCount++;
                accountChanged = true;
            }
            if (accountChanged) affectedAccountCount++;
        }
        if (affectedSlotCount) this.sequence++;
        this.flush();
        this.drain();
        return { affected_account_count: affectedAccountCount, affected_slot_count: affectedSlotCount };
    }

    _scheduleDailyReset() {
        if (this.closed || this.config.dailyResetEnabled === false) return;
        const now = this.now();
        const executeAt = calculateNextPacificResetAt(now, this.config.dailyResetTime, this.lastDailyResetPacificDate);
        const delay = Math.max(0, executeAt - now);
        this.dailyResetTimer = this.setTimer(() => {
            this.dailyResetTimer = null;
            if (this.closed) return;
            const firedAt = this.now();
            const pacificDate = this.getPacificDateKey(firedAt);
            if (this.lastDailyResetPacificDate !== pacificDate) {
                this.lastDailyResetPacificDate = pacificDate;
                const result = this.resetDailyCooldowns();
                this.logger.info?.(
                    `[Scheduler] Daily cooldown reset ${JSON.stringify({
                        configured_time: this.config.dailyResetTime,
                        pacific_date: pacificDate,
                        ...result,
                    })}`
                );
            }
            this._scheduleDailyReset();
        }, delay);
        this.dailyResetTimer?.unref?.();
    }

    reset(index, model) {
        const account = this.account(index);
        if (account.inflight) throw schedulerError("Account has active requests", 409);
        let changed = false;
        if (!model) {
            changed = Boolean(
                !account.healthy ||
                account.last_error !== null ||
                account.disabled ||
                account.disabled_at !== null ||
                account.disabled_reason !== null
            );
            account.healthy = true;
            account.last_error = null;
            account.disabled = false;
            account.disabled_at = null;
            account.disabled_reason = null;
        }
        const slots = model ? [this.slot(account, model)] : Object.values(account.models);
        for (const slot of slots) {
            changed ||= Boolean(
                slot.consecutive_failures ||
                slot.cooldown_until ||
                slot.last_error !== null ||
                slot.last_error_kind !== null ||
                slot.last_http_status !== null ||
                slot.rate_limited ||
                slot.risk_control_failures ||
                slot.unsupported
            );
            Object.assign(slot, {
                consecutive_failures: 0,
                cooldown_until: 0,
                last_error: null,
                last_error_kind: null,
                last_http_status: null,
                rate_limited: false,
                risk_control_failures: 0,
                unsupported: false,
            });
        }
        if (changed) this.sequence++;
        this.flush();
        this.drain();
        if (!model) this.browserManager?.handleAccountEnabled?.(index);
        return { account_id: index, changed, scope: model ? "model" : "account", ...(model ? { model } : {}) };
    }

    _snapshotModels() {
        if (this._roundModels) return this._roundModels;
        const names = new Set([
            ...(this.config.registeredModels || []),
            ...Object.keys(this.config.allocation),
            ...this.pending.map(item => item.model),
            ...[...this.accounts.values()].flatMap(account => Object.keys(account.models)),
        ]);
        const models = new Set([...names].map(model => (model.startsWith("__") ? model : normalizeModelName(model))));
        if (this._draining) this._roundModels = models;
        return models;
    }

    _visibleSnapshotModels() {
        return this.getVisibleModels();
    }

    hideModel(model) {
        const normalized = normalizeModelName(model);
        if (!this._snapshotModels().has(normalized)) throw schedulerError(`Unknown scheduler model ${normalized}`, 404);
        if (this.hiddenModels.has(normalized)) return { changed: false, hidden: true, model: normalized };
        this.hiddenModels.add(normalized);
        for (const item of [...this.pending]) {
            if (item.model !== normalized) continue;
            this.remove(item);
            item.reject(
                Object.assign(schedulerError(`Model ${normalized} is disabled`, 403), { code: "MODEL_DISABLED" })
            );
        }
        this.sequence++;
        this.flush();
        this.drain();
        return { changed: true, hidden: true, model: normalized };
    }

    showModel(model) {
        const normalized = normalizeModelName(model);
        const changed = this.hiddenModels.delete(normalized);
        if (changed) {
            this.sequence++;
            this.flush();
        }
        this.drain();
        return { changed, hidden: false, model: normalized };
    }

    isModelHidden(model) {
        return this.hiddenModels.has(normalizeModelName(model));
    }

    hiddenModelsSnapshot() {
        return [...this.hiddenModels].sort((a, b) => a.localeCompare(b));
    }

    _slotStatus(account, slot, rotationIndices) {
        if (account.disabled) return "ACCOUNT_DISABLED";
        if (!account.healthy || !rotationIndices.includes(account.index)) return "UNHEALTHY";
        if (slot.unsupported) return "UNSUPPORTED";
        if (
            slot.last_error_kind === "risk_controlled" ||
            (slot.risk_control_failures > 0 && slot.cooldown_until && slot.cooldown_until > Date.now())
        ) {
            return "RISK_CONTROLLED";
        }
        if (slot.rate_limited) return "RATE_LIMITED";
        if (slot.cooldown_until) return "COOLDOWN";
        return "HEALTHY";
    }

    _accountFlags(account, now = Date.now(), rotationIndices = this.authSource.getRotationIndices()) {
        let has403 = false;
        let has429 = false;
        for (const model of Object.keys(account.models || {})) {
            if (this.hiddenModels.has(model)) continue;
            const status = this._slotStatus(account, this.slot(account, model, now), rotationIndices);
            if (status === "RISK_CONTROLLED") has403 = true;
            else if (status === "RATE_LIMITED" || status === "COOLDOWN") has429 = true;
        }
        return { has403, has429 };
    }

    accountsOverviewSnapshot() {
        const now = this.now();
        const rotationIndices = this.authSource.getRotationIndices();
        const summary = {
            disabled: 0,
            healthy: 0,
            persistent_403: 0,
            rate_limited: 0,
            risk_controlled: 0,
            total: 0,
            unhealthy: 0,
        };
        const accounts = rotationIndices.map(index => {
            const account = this.account(index);
            const { has403, has429 } = this._accountFlags(account, now, rotationIndices);
            const state = account.disabled
                ? "disabled"
                : has403
                  ? "risk_controlled"
                  : has429
                    ? "rate_limited"
                    : account.healthy
                      ? "healthy"
                      : "unhealthy";
            summary[state]++;
            summary.total++;
            const persistent403 = this._persistent403Snapshot(account, now);
            if (persistent403.persistent_403) summary.persistent_403++;
            return {
                ...persistent403,
                disabled: account.disabled,
                disabled_at: account.disabled_at,
                disabled_reason: account.disabled_reason,
                has_403: has403,
                has_429: has429,
                healthy: account.healthy,
                index,
                inflight: account.inflight,
                key: account.key,
                tier: resolveTier(accountForIndex(this.authSource, index)),
            };
        });
        return { accounts, revision: `accounts:${this.sequence}`, summary };
    }

    summarySnapshot() {
        const now = this.now();
        const indices = this.authSource.getRotationIndices();
        for (const index of indices) this.account(index);
        const models = this._visibleSnapshotModels();
        const quotaModels = [...models]
            .map(model => ({ limit: getModelDailyQuota(model), model }))
            .filter(entry => entry.limit !== null)
            .sort((a, b) => a.model.localeCompare(b.model));
        const quotaAccounts = indices.map(index => this.account(index));
        const quotaByModel = quotaModels.map(({ model }) => {
            let dailyRequests = 0;
            let estimatedRemainingQuota = 0;
            let totalQuota = 0;
            let trackedAccounts = 0;
            const limits = new Set();
            for (const account of quotaAccounts) {
                const limit = getModelDailyQuota(model, accountForIndex(this.authSource, account.index));
                const slot = account.models[model];
                const requests =
                    slot?.daily_request_date === this.getPacificDateKey(now) ? slot.daily_request_count : 0;
                dailyRequests += requests;
                if (!this.isTierAllowed(account.index, model)) continue;
                totalQuota += limit;
                trackedAccounts++;
                limits.add(limit);
                estimatedRemainingQuota += Math.max(0, limit - requests);
            }
            return {
                daily_requests: dailyRequests,
                estimated_remaining_quota: estimatedRemainingQuota,
                model,
                quota_per_account: limits.size === 1 ? [...limits][0] : null,
                total_quota: totalQuota,
                tracked_accounts: trackedAccounts,
            };
        });
        const contexts = this.browserManager?.getContextPoolSnapshot?.() || [];
        const contextCount = state => contexts.filter(context => context.state === state).length;
        const busyContexts = contextCount("BUSY");
        const readyContexts = contextCount("READY");
        const occupiedIndices =
            this.browserManager?._contextCapacityIndices?.() ||
            new Set(
                contexts
                    .filter(context => !["COLD", "UNAVAILABLE"].includes(context.state))
                    .map(context => context.auth_index)
            );
        return {
            accounts_summary: this.accountsOverviewSnapshot().summary,
            active_browser_workers: contexts.filter(context => context.inflight > 0).length,
            active_workers: this.workers.filter(worker => worker.lease).length,
            busy_browser_workers: busyContexts,
            contexts_summary: {
                all_visible_models_rate_limited:
                    models.size > 0 &&
                    indices.length > 0 &&
                    indices.every(index => this.isAccountQuotaExhausted(this.account(index), now, models)),
                busy: busyContexts,
                closing: contextCount("CLOSING"),
                configured_min_ready: this.config.contextPoolMinReady,
                draining: contextCount("DRAINING"),
                effective_warm_target: Math.min(
                    this.config.contextPoolMinReady,
                    indices.filter(index => this.isAccountPoolResident(index, now, models)).length
                ),
                initializing: contextCount("INITIALIZING"),
                max: this.config.maxWorkers,
                next_cooldown_check_at: this.nextCooldownCheckAt,
                occupied: occupiedIndices.size,
                quota_exhausted_accounts: indices.filter(index =>
                    this.isAccountQuotaExhausted(this.account(index), now, models)
                ).length,
                ready: readyContexts,
                reconnecting: contextCount("RECONNECTING"),
                unavailable: contextCount("UNAVAILABLE"),
                unavailable_occupied: contexts.filter(
                    context => context.state === "UNAVAILABLE" && occupiedIndices.has(context.auth_index)
                ).length,
            },
            idle_browser_workers: readyContexts,
            idle_workers: this.workers.filter(worker => !worker.lease).length,
            initializing_browser_workers: contextCount("INITIALIZING"),
            max_browser_workers: this.config.maxWorkers,
            metrics: this.metricsSnapshot(),
            models: [...models]
                .map(model => {
                    const slots = [...this.accounts.values()]
                        .map(account => (Object.hasOwn(account.models, model) ? this.slot(account, model, now) : null))
                        .filter(Boolean);
                    return {
                        active_workers: this.active(model),
                        available_accounts: this.eligibleAccounts(model, new Set()).length,
                        configured_workers: this.config.allocation[model] || { min: 0, preferred: 1 },
                        daily_requests: slots.reduce((sum, slot) => sum + slot.daily_request_count, 0),
                        model,
                        queue_length: this.pending.filter(item => item.model === model).length,
                        rate_limited_accounts: slots.filter(slot => slot.rate_limited).length,
                        ready_accounts: this.readyCandidates(model, new Set()).length,
                        tier_allowed_accounts: indices.filter(index => this.isTierAllowed(index, model)).length,
                    };
                })
                .sort((a, b) => a.model.localeCompare(b.model)),
            queued_requests: this.pending.length,
            quota_by_model: quotaByModel,
            ready_browser_workers: readyContexts + busyContexts,
            reconnecting_browser_workers: contextCount("RECONNECTING"),
            unavailable_browser_workers: contextCount("UNAVAILABLE"),
            usage_window: {
                date: this.getPacificDateKey(now),
                timezone: PACIFIC_TIMEZONE,
            },
        };
    }

    /**
     * Side-effect-free scheduler projection for the anonymous dashboard.
     * Missing accounts and slots are interpreted as their default state rather
     * than being materialized through account() / slot().
     */
    publicSummarySnapshot() {
        const now = Date.now();
        const date = this.getPacificDateKey(now);
        const indices = this.authSource.getRotationIndices();
        const models = [...this._visibleSnapshotModels()].sort((a, b) => a.localeCompare(b));
        const accountFor = index => {
            const key = this.authSource.accountNameMap.get(index) || `auth-${index}`;
            return this.accounts.get(key) || null;
        };
        const slotFor = (account, model) => account?.models?.[model] || null;
        const dailyRequests = slot => (slot?.daily_request_date === date ? slot.daily_request_count || 0 : 0);
        const isRateLimited = slot =>
            Boolean(slot?.rate_limited && (!slot.cooldown_until || slot.cooldown_until > now));
        const isAvailable = (account, slot) =>
            (account?.healthy ?? true) &&
            !account?.disabled &&
            !slot?.unsupported &&
            (!slot?.cooldown_until || slot.cooldown_until <= now);

        return {
            active: this.workers.filter(worker => worker.lease).length,
            limit: this.workers.length,
            models: models.map(model => {
                const accountSlots = indices.map(index => {
                    const account = accountFor(index);
                    return { account, index, slot: slotFor(account, model) };
                });
                const quotaPerAccount = getModelDailyQuota(model);
                const today = accountSlots.reduce((sum, item) => sum + dailyRequests(item.slot), 0);
                return {
                    active: this.active(model),
                    availableAccounts: accountSlots.filter(
                        item =>
                            isAvailable(item.account, item.slot) &&
                            !this.authSource.isExpired?.(item.index) &&
                            this.isTierAllowed(item.index, model)
                    ).length,
                    estimatedRemaining:
                        quotaPerAccount === null
                            ? null
                            : accountSlots.reduce(
                                  (sum, item) =>
                                      sum +
                                      (this.isTierAllowed(item.index, model)
                                          ? Math.max(
                                                0,
                                                getModelDailyQuota(
                                                    model,
                                                    accountForIndex(this.authSource, item.index)
                                                ) - dailyRequests(item.slot)
                                            )
                                          : 0),
                                  0
                              ),
                    model,
                    queued: this.pending.filter(item => item.model === model).length,
                    rateLimitedAccounts: accountSlots.filter(item => isRateLimited(item.slot)).length,
                    tierAllowedAccounts: indices.filter(index => this.isTierAllowed(index, model)).length,
                    todayRequests: today,
                };
            }),
            queued: this.pending.length,
            usageWindow: { date, timezone: PACIFIC_TIMEZONE },
        };
    }

    contextsSnapshot() {
        const contexts = this.browserManager?.getContextPoolSnapshot?.() || [];
        return {
            contexts: contexts.map(context => ({
                auth_index: context.auth_index,
                connection_epoch: context.connection_epoch || null,
                created_at: context.created_at || null,
                drain_reason: context.drain_reason || null,
                draining: Boolean(context.draining),
                eviction_priority: context.eviction_priority || null,
                inflight: context.inflight || 0,
                last_disconnect_reason: context.last_disconnect_reason
                    ? String(context.last_disconnect_reason).slice(0, 500)
                    : null,
                last_request_at: context.last_request_at || null,
                state: context.state,
            })),
            revision: `contexts:${this.sequence}:${contexts.length}`,
        };
    }

    accountsSnapshot(indices) {
        const rotationIndices = this.authSource.getRotationIndices();
        const requested = indices === undefined ? rotationIndices : indices;
        const now = this.now();
        return {
            accounts: requested.map(index => {
                const account = this.account(index);
                const models = Object.keys(account.models)
                    .filter(model => !model.startsWith("__") && !this.hiddenModels.has(model))
                    .sort()
                    .map(model => {
                        const slot = this.slot(account, model, now);
                        return {
                            cooldown_until: slot.cooldown_until || null,
                            daily_failures: slot.daily_failure_count,
                            daily_requests: slot.daily_request_count,
                            inflight: slot.inflight,
                            last_error: slot.last_error ? String(slot.last_error).slice(0, 500) : null,
                            last_error_kind: slot.last_error_kind || null,
                            last_http_status: slot.last_http_status || null,
                            model,
                            risk_control_failures: slot.risk_control_failures || 0,
                            status: this._slotStatus(account, slot, rotationIndices),
                        };
                    });
                const { has403, has429 } = this._accountFlags(account, now, rotationIndices);
                return {
                    ...this._persistent403Snapshot(account, now),
                    disabled: account.disabled,
                    disabled_at: account.disabled_at,
                    disabled_reason: account.disabled_reason,
                    has_403: has403,
                    has_429: has429,
                    healthy: account.healthy,
                    index: account.index,
                    inflight: account.inflight,
                    key: account.key,
                    models,
                };
            }),
            revision: `accounts:${this.sequence}`,
        };
    }

    snapshot() {
        const summary = this.summarySnapshot();
        const details = this.accountsSnapshot([...this.accounts.values()].map(account => account.index));
        const accounts = details.accounts.map(account => ({
            ...account,
            models: Object.fromEntries(
                account.models.map(slot => {
                    const internal = this.account(account.index).models[slot.model];
                    return [slot.model, { ...internal, ...slot }];
                })
            ),
        }));
        const quotaTotal = summary.quota_by_model.reduce((sum, item) => sum + item.estimated_remaining_quota, 0);
        return {
            ...summary,
            accounts,
            contexts: this.contextsSnapshot().contexts,
            estimated_remaining_quota: quotaTotal,
            models: summary.models.map(model => {
                const slots = [...this.accounts.values()].map(account => account.models[model.model]).filter(Boolean);
                return {
                    ...model,
                    failures: slots.reduce((sum, slot) => sum + slot.failure_count, 0),
                    requests: slots.reduce((sum, slot) => sum + slot.request_count, 0),
                    success: slots.reduce((sum, slot) => sum + slot.success_count, 0),
                };
            }),
            quota_tracked_accounts: this.authSource.getRotationIndices().length,
            quota_tracked_models: summary.quota_by_model.length,
            workers: this.workers.map(worker => ({
                account_id: worker.lease?.account.index ?? null,
                id: worker.id,
                model: worker.lease?.model ?? null,
            })),
        };
    }

    observe(name, value) {
        if (!Number.isFinite(value) || !this.metrics.samples[name]) return;
        const samples = this.metrics.samples[name];
        samples.push(Math.max(0, value));
        if (samples.length > 1000) samples.splice(0, samples.length - 1000);
    }

    metricsSnapshot() {
        const percentile = (values, fraction) => {
            if (!values.length) return null;
            const sorted = [...values].sort((a, b) => a - b);
            return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
        };
        return {
            dispatch_timeout: this.metrics.dispatch_timeout,
            local_transport: this.metrics.local_transport,
            timings: Object.fromEntries(
                Object.entries(this.metrics.samples).map(([name, samples]) => [
                    name,
                    {
                        count: samples.length,
                        p50: percentile(samples, 0.5),
                        p95: percentile(samples, 0.95),
                        p99: percentile(samples, 0.99),
                    },
                ])
            ),
            upstream_error: this.metrics.upstream_error,
        };
    }

    load() {
        if (!this.config.statePath) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.config.statePath, "utf8"));
            if (![1, 2, 3, 4, 5, 6, 7].includes(data.version) || !Array.isArray(data.accounts))
                throw new Error("Unsupported scheduler state");
            if (data.version >= 4) {
                if (!Array.isArray(data.hiddenModels) || data.hiddenModels.some(model => typeof model !== "string"))
                    throw new Error("Invalid hidden scheduler models");
                this.hiddenModels = new Set(data.hiddenModels.map(normalizeModelName));
            }
            this.fileAffinities = new Map(data.fileAffinities || []);
            for (const account of data.accounts) {
                if (typeof account.key !== "string" || !account.models || typeof account.models !== "object")
                    throw new Error("Invalid account state");
                account.models = Object.assign(Object.create(null), account.models);
                account.inflight = 0;
                account.disabled ??= false;
                account.disabled_at ??= null;
                account.disabled_reason ??= null;
                if (data.version < 7) account.continuous_403_since = null;
                else if (
                    account.continuous_403_since !== null &&
                    (!Number.isSafeInteger(account.continuous_403_since) || account.continuous_403_since < 0)
                ) {
                    throw new Error("Invalid continuous 403 scheduler state");
                }
                account.continuous_403_since ??= null;
                for (const slot of Object.values(account.models)) {
                    slot.risk_control_failures ??= 0;
                    slot.last_error_kind ??= null;
                    slot.last_http_status ??= null;
                    if (
                        !slot.last_error_kind &&
                        slot.last_error &&
                        classifyError({ message: slot.last_error }) === "risk_controlled"
                    ) {
                        slot.last_error_kind = "risk_controlled";
                        slot.last_http_status = 403;
                        slot.risk_control_failures = Math.max(1, slot.risk_control_failures);
                        slot.unsupported = false;
                    }
                    if (data.version === 1) {
                        slot.daily_request_count = 0;
                        slot.daily_failure_count = 0;
                        slot.daily_request_date = this.getPacificDateKey();
                    } else if (
                        !Number.isInteger(slot.daily_request_count) ||
                        slot.daily_request_count < 0 ||
                        !isValidDateKey(slot.daily_request_date)
                    ) {
                        throw new Error("Invalid daily scheduler state");
                    }
                    if (data.version === 2) slot.daily_failure_count = 0;
                    if (!Number.isInteger(slot.daily_failure_count) || slot.daily_failure_count < 0)
                        throw new Error("Invalid daily scheduler failure state");
                    slot.inflight = 0;
                }
                this.accounts.set(account.key, account);
            }
            if (data.version === 1)
                this.logger.warn(
                    "[Scheduler] Upgraded version 1 state: today's Pacific-time request counts start at zero; cumulative statistics were preserved."
                );
            if (data.version === 2)
                this.logger.warn(
                    "[Scheduler] Upgraded version 2 state: today's Pacific-time failure counts start at zero; cumulative statistics were preserved."
                );
        } catch (error) {
            if (error.code !== "ENOENT") {
                this.accounts.clear();
                this.fileAffinities.clear();
                this.hiddenModels.clear();
                this.logger.warn(`[Scheduler] Cannot load state: ${error.message}`);
                // Preserve malformed state for diagnosis before a new snapshot replaces it.
                try {
                    fs.copyFileSync(this.config.statePath, `${this.config.statePath}.corrupt-${Date.now()}`);
                } catch (backupError) {
                    this.logger.error(`[Scheduler] Cannot back up corrupt state: ${backupError.message}`);
                }
            }
        }
    }

    saveSoon() {
        if (!this.config.statePath || this.saveTimer || this.closed) return;
        this.saveTimer = setTimeout(() => this.flush(), 250);
        this.saveTimer.unref();
    }

    flush() {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        if (!this.config.statePath) return;
        try {
            fs.mkdirSync(path.dirname(this.config.statePath), { recursive: true });
            const temporary = `${this.config.statePath}.${process.pid}.tmp`;
            fs.writeFileSync(
                temporary,
                JSON.stringify({
                    accounts: [...this.accounts.values()],
                    fileAffinities: [...this.fileAffinities],
                    hiddenModels: this.hiddenModelsSnapshot(),
                    version: 7,
                }),
                {
                    mode: 0o600,
                }
            );
            fs.renameSync(temporary, this.config.statePath);
        } catch (error) {
            this.logger.error(`[Scheduler] Cannot persist state: ${error.message}`);
        }
    }

    close() {
        this.closed = true;
        clearImmediate(this._drainQueued);
        this.clearTimer(this.cooldownWakeTimer);
        this.cooldownWakeTimer = null;
        this.nextCooldownCheckAt = null;
        this.clearTimer(this.dailyResetTimer);
        this.dailyResetTimer = null;
        for (const item of [...this.pending]) {
            this.remove(item);
            item.reject(schedulerError("Scheduler is shutting down"));
        }
        this.flush();
    }
}
module.exports = {
    calculateNextPacificResetAt,
    classifyError,
    getModelDailyQuota,
    ModelScheduler,
    normalizeModelName,
};
