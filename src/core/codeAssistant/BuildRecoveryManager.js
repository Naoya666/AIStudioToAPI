const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { BuildRecoveryStore } = require("./BuildRecoveryStore");
const { BuildRuntime } = require("./BuildRuntime");
const { buildError, errorInfo } = require("./BuildError");
const { withHardTimeout } = require("../../utils/TimeoutUtils");
const { atomicWrite } = require("../../config/ConfigurationService");
class BuildRecoveryManager {
    constructor(system, { statePath = path.join(process.cwd(), "data", "build-projects.json"), now = Date.now } = {}) {
        this.system = system;
        this.statePath = statePath;
        this.now = now;
        this.activeAccounts = new Set();
        this.knownBlocked = new Set();
        const bounded = (name, fallback, min, max) => {
            const value = Number(process.env[name] ?? fallback);
            if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
            return value;
        };
        this.eventTimeoutMs = 2000;
        this.rpcTimeoutMs = bounded("BUILD_RECOVERY_RPC_TIMEOUT_MS", 10000, 100, 60000);
        this.baseDelayMs = bounded("BUILD_RECOVERY_BACKOFF_MS", 5000, 1000, 300000);
        this.maxDelayMs = bounded("BUILD_RECOVERY_MAX_BACKOFF_MS", 300000, this.baseDelayMs, 3600000);
        this.allowedIndices =
            process.env.BUILD_RECOVERY_ACCOUNT_INDICES === undefined
                ? null
                : new Set(
                      process.env.BUILD_RECOVERY_ACCOUNT_INDICES.split(",")
                          .filter(Boolean)
                          .map(v => {
                              if (!/^\d+$/.test(v)) throw new Error("Invalid BUILD_RECOVERY_ACCOUNT_INDICES");
                              return Number(v);
                          })
                  );
        this.debtLimit = bounded("BUILD_CLEANUP_DEBT_LIMIT", 3, 1, 1000);
        this.nodeDebtLimit = bounded(
            "BUILD_CLEANUP_NODE_DEBT_LIMIT",
            Math.max(1, system.authSource.getRotationIndices().length) * this.debtLimit,
            1,
            100000
        );
        this.closed = false;
        this.fault = null;
        this.lockPath = `${statePath}.lock`;
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        try {
            // flock acts on the inherited open file description. The parent keeps
            // fd open for the full lifecycle, so process exit releases ownership
            // without stale-PID deletion races. Never unlink this lock inode.
            this.lockDescriptor = fs.openSync(this.lockPath, "a+", 0o600);
            const lock = spawnSync("flock", ["-n", "3"], {
                stdio: ["ignore", "ignore", "pipe", this.lockDescriptor],
                timeout: 3000,
            });
            if (lock.error || lock.status !== 0) {
                fs.closeSync(this.lockDescriptor);
                this.lockDescriptor = null;
                throw new Error(
                    lock.error
                        ? "Build recovery requires util-linux flock"
                        : "Build recovery journal already owned by a live process"
                );
            }
            this.ownsLock = true;
            fs.ftruncateSync(this.lockDescriptor, 0);
            fs.writeFileSync(this.lockDescriptor, String(process.pid));
            this.store = BuildRecoveryStore.open(statePath);
            for (const [id, entry] of Object.entries(this.store.read())) {
                if (entry.generationState === "active" && !this.store.active.has(id)) {
                    entry.generationState = "unknown";
                    entry.ownership = null;
                    this.store.save(id, entry);
                }
            }
            this.reconcile();
        } catch (error) {
            this.storageFailed(error);
        }
        this.timer = setInterval(() => this.wake(), 1000);
        this.timer.unref?.();
    }
    storageFailed(error) {
        this.fault = "recovery_storage_unavailable";
        this.faultError = error ? errorInfo(error) : null;
        this.system.logger?.error?.(`[BuildRecovery] ${this.fault}: ${error?.code || "journal failure"}`);
        for (const index of this.system.authSource.getRotationIndices())
            this.block(this.system.scheduler.account(index).key);
    }
    block(key) {
        this.knownBlocked.add(key);
        for (const account of this.system.scheduler.accounts.values())
            if (account.key === key) account.buildRecoveryBlocked = true;
        this.system.scheduler.saveSoon();
    }
    debtUsage(account, records = this.store.read()) {
        const pending = Object.entries(records).filter(
            ([, e]) => !e.deleteConfirmedAt && e.resourceState !== "verified_not_created"
        );
        const own = pending.filter(([, e]) => e.account === account.key);
        const live = own.filter(([id]) => this.store.active.has(id)).length;
        const reserved = Math.max(0, this.system.scheduler.channelInflight?.(account, "build") || 0);
        return {
            debt: own.filter(([id]) => !this.store.active.has(id)).length,
            pending,
            used: own.length + Math.max(0, reserved - live),
        };
    }
    admission(account) {
        if (this.fault || !this.store) return { allowed: false, reason: this.fault || "recovery_storage_unavailable" };
        try {
            const records = this.store.read();
            const usage = this.debtUsage(account, records);
            let total = usage.pending.length;
            for (const a of this.system.scheduler.accounts.values()) {
                const u = this.debtUsage(a, records);
                total += u.used - u.pending.filter(([, e]) => e.account === a.key).length;
            }
            const recovering = this.activeAccounts.has(account.key);
            const limit = usage.used >= this.debtLimit || total >= this.nodeDebtLimit;
            return {
                allowed: !recovering && !limit,
                debt: usage.debt,
                degraded: usage.debt > 0,
                reason: recovering ? "recovery_lease" : limit ? "cleanup_debt_limit" : null,
                used: usage.used,
            };
        } catch (error) {
            this.storageFailed(error);
            return { allowed: false, reason: this.fault };
        }
    }
    reconcile() {
        if (this.fault) return;
        try {
            let records = this.store.read();
            for (const index of this.system.authSource.getRotationIndices()) {
                const account = this.system.scheduler.account(index);
                // A persisted orphan flag is evidence of missing history, not evidence of no resource.
                if (
                    account.buildRecoveryBlocked &&
                    !this.knownBlocked.has(account.key) &&
                    !Object.values(records).some(e => e.account === account.key)
                ) {
                    const id = `orphan:${account.key}`;
                    this.store.save(id, {
                        account: account.key,
                        app: null,
                        cleanupStage: "verify_pending",
                        createdAt: this.now(),
                        lastError: errorInfo(
                            buildError({ message: "recovery_state_inconsistent: journal missing", status: 400 })
                        ),
                        nextAttemptAt: this.now(),
                        operationId: id,
                        projectState: "delete_pending",
                        resourceState: "discovery_pending",
                        retryState: "protocol_review",
                        schemaVersion: 3,
                        task: null,
                        taskState: "unknown",
                    });
                    records = this.store.read();
                }
                const policy = this.admission(account);
                this.knownBlocked.add(account.key);
                account.cleanupDebtCount = policy.debt || 0;
                account.buildCleanupDegraded = policy.degraded || false;
                account.buildRecoveryBlocked = !policy.allowed;
                account.buildRecoveryReason = policy.reason;
                account.buildRecoveryHoldUntil = policy.allowed ? null : this.now() + 300000;
            }
            this.system.scheduler.saveSoon();
            for (const [id, entry] of Object.entries(records)) {
                if (
                    entry.deleteConfirmedAt &&
                    (entry.complete || entry.cancelConfirmedAt || !entry.task) &&
                    this.now() - entry.deleteConfirmedAt > 30 * 86400000
                )
                    this.store.archive(id, entry);
            }
            this.system.scheduler.drain();
        } catch (error) {
            this.storageFailed(error);
        }
    }
    failed(op, entry, error) {
        const status = error.status;
        const nextAttemptAt = this.retryAt(entry, error);
        entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
        entry.lastError = errorInfo(error);
        const account = [...this.system.scheduler.accounts.values()].find(a => a.key === entry.account);
        entry.failedAuthRecoveryAt = this.authRecoveryAt(account?.index);
        entry.retryState =
            status === 401
                ? "waiting_auth"
                : status === 403
                  ? "waiting_permission"
                  : [400, 404].includes(status) || entry.cleanupStage === "verify_pending"
                    ? "protocol_review"
                    : "scheduled";
        entry.nextAttemptAt = nextAttemptAt;
        if (entry.deleteConfirmedAt) entry.auditNextAttemptAt = nextAttemptAt;
        this.store.save(op, entry);
        this.reconcile();
    }
    retryAt(entry, error) {
        if (error.recoveryNextAttemptAt) return error.recoveryNextAttemptAt;
        const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(20, entry.consecutiveFailures || 0));
        const account = [...this.system.scheduler.accounts.values()].find(a => a.key === entry.account);
        const full = account && this.debtUsage(account).used >= this.debtLimit;
        const classifiedDelay =
            [400, 403, 404].includes(error.status) || entry.cleanupStage === "verify_pending"
                ? 1800000
                : Math.min(this.maxDelayMs, Math.round(delay * (1 + Math.random() * 0.2)));
        error.recoveryNextAttemptAt =
            this.now() +
            Math.max(error.rateLimit?.retryAfterMs || 0, full ? Math.min(300000, classifiedDelay) : classifiedDelay);
        return error.recoveryNextAttemptAt;
    }
    async recordEvent(operationId, entry, event) {
        const account = [...this.system.scheduler.accounts.values()].find(a => a.key === entry.account);
        const record = {
            accountIndex: account?.index ?? null,
            cleanupStage: entry.cleanupStage,
            nextAttemptAt: entry.nextAttemptAt ?? null,
            operationId,
            outcome: event.error ? "failed" : "confirmed",
            requestId: entry.requestId ?? null,
            trigger: this.activeAccounts.has(entry.account) ? "background" : "foreground",
            ...event,
        };
        try {
            const storage = this.system.usageStatsService?.storage;
            if (storage)
                await withHardTimeout(() => storage.call("build_recovery_insert", record), this.eventTimeoutMs, {
                    operation: "Build recovery event checkpoint",
                    status: 504,
                });
            else {
                const file = `${this.statePath}.events.json`;
                const events = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
                events.push(record);
                atomicWrite(file, events.filter(e => e.endedAt >= this.now() - 30 * 86400000).slice(-10000));
            }
        } catch (error) {
            this.storageFailed(error);
            throw error;
        }
    }

    wake(index = null) {
        if (index !== null) this.preferredIndex = index;
        if (this.closed || this.task) return;
        if (this.fault) {
            if (!this.ownsLock) return;
            try {
                this.store ||= BuildRecoveryStore.open(this.statePath);
                this.store.read();
                this.fault = null;
                this.faultError = null;
                this.reconcile();
            } catch {
                return;
            }
        }
        this.task = this.run()
            .catch(error => this.storageFailed(error))
            .finally(() => {
                this.task = null;
            });
    }
    async run() {
        const scheduler = this.system.scheduler,
            browser = this.system.browserManager;
        const entries = Object.entries(this.store.read());
        const preferred = this.preferredIndex;
        this.preferredIndex = null;
        const preferredOffset =
            preferred === null || preferred === undefined
                ? -1
                : entries.findIndex(([, e]) => scheduler.account(preferred).key === e.account);
        const offset = preferredOffset >= 0 ? preferredOffset : this.cursor || 0;
        for (let n = 0; n < entries.length; n++) {
            const [op, entry] = entries[(offset + n) % entries.length];
            this.cursor = (offset + n + 1) % entries.length;
            if (this.closed || scheduler.closed) return;
            if (
                this.store.active.has(op) ||
                this.store.executing.has(op) ||
                (entry.cleanupStage === "done" &&
                    (!entry.task || entry.complete || entry.cancelConfirmedAt || entry.auditNextAttemptAt > this.now()))
            )
                continue;
            const account = [...scheduler.accounts.values()].find(a => a.key === entry.account);
            if (
                !account ||
                (this.allowedIndices && !this.allowedIndices.has(account.index)) ||
                account.disabled ||
                !account.healthy ||
                this.system.authSource.isExpired?.(account.index)
            )
                continue;
            if (scheduler.account(account.index).key !== entry.account) {
                if (entry.retryState !== "waiting_auth") {
                    entry.retryState = "waiting_auth";
                    entry.lastError = errorInfo(
                        buildError({ message: "Recovery account binding changed", phase: "cleanup", status: 401 })
                    );
                    this.store.save(op, entry);
                }
                continue;
            }
            const data = browser.contexts.get(account.index);
            const page = data?.page;
            const session = page?.accountSessionVersion ?? data?.sessionVersion ?? null;
            const sessionChanged =
                ["waiting_auth", "waiting_permission", "waiting_context"].includes(entry.retryState) &&
                (entry.failedSessionVersion !== session ||
                    (entry.failedAuthRecoveryAt ?? null) !== this.authRecoveryAt(account.index));
            if (entry.nextAttemptAt > this.now() && !sessionChanged) continue;
            if (!entry.app && !this.system.buildResourceVerifier?.lookup) {
                this.failed(op, entry, buildError({ message: "资源定位待核查：查询协议尚未验证", status: 400 }));
                continue;
            }
            // Reserve the current execution resource, stop new dispatch, and drain existing work.
            // This is a finite recovery lease even under continuous Playground traffic.
            browser.requestRecoveryContext(account.index);
            if (account.inflight) return;
            if (!browser.isContextReady(account.index) || !page?.playgroundTransport?.ready) {
                if (entry.retryState !== "waiting_context") {
                    entry.retryState = "waiting_context";
                    this.store.save(op, entry);
                }
                browser.requestRecoveryContext(account.index);
                return;
            }
            this.activeAccounts.add(account.key);
            this.reconcile();
            const runtime = new BuildRuntime({
                accountKey: account.key,
                page,
                recoveryManager: this,
                statePath: this.statePath,
            });
            runtime.assertCurrent = () => {
                if (
                    scheduler.account(account.index).key !== entry.account ||
                    !browser.isContextReady(account.index) ||
                    !this.isSessionCurrent(account.index, session) ||
                    browser.contexts.get(account.index) !== data ||
                    data.page !== page ||
                    page.isClosed?.() ||
                    (page.accountSessionVersion ?? data.sessionVersion ?? null) !== session ||
                    !page.playgroundTransport?.ready
                )
                    throw buildError({ message: "Recovery context changed", source: "local", status: 503 });
            };
            try {
                runtime.assertCurrent();
                runtime.cleanupDeadline = Date.now() + 35000;
                if (!entry.app) await this.discoverResource(runtime, op, entry);
                await runtime.cleanup(op, entry);
            } catch (error) {
                entry.failedSessionVersion = session;
                this.failed(op, entry, error);
            } finally {
                this.activeAccounts.delete(account.key);
            }
            browser.finishRecoveryContext?.(account.index);
            this.reconcile();
            for (let step = 1; step < entries.length; step++) {
                const candidate = (((offset + n) % entries.length) + step) % entries.length;
                if (entries[candidate][1].account !== entry.account) {
                    this.cursor = candidate;
                    break;
                }
            }
            return; // one bounded operation per tick, global recovery concurrency is one
        }
    }
    async bindResource(operationId, index, appId, revision) {
        if (this.fault || !this.store) throw buildError({ message: "Recovery storage unavailable", status: 503 });
        if (
            !Number.isSafeInteger(index) ||
            !this.system.authSource.getRotationIndices().includes(index) ||
            typeof appId !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(appId)
        )
            throw buildError({ message: "Invalid exact resource binding", status: 400 });
        const entry = this.store.read()[operationId];
        if (!entry || entry.account !== this.system.scheduler.account(index).key)
            throw buildError({ message: "Resource account mismatch", status: 409 });
        if (
            entry.app ||
            entry.revision !== revision ||
            this.store.active.has(operationId) ||
            this.store.executing.has(operationId)
        )
            throw buildError({ message: "Resource binding is stale or operation is owned", status: 409 });
        // This is a candidate only. Never delete it until a current-account read verifies identity.
        entry.resourceCandidate = appId;
        entry.retryState = "scheduled";
        entry.nextAttemptAt = this.now();
        this.store.save(operationId, entry);
        await this.recordEvent(operationId, entry, {
            endedAt: this.now(),
            method: "BindResourceIntent",
            outcome: "scheduled",
            startedAt: this.now(),
        });
        this.wake(index);
    }
    async discoverResource(runtime, op, entry) {
        const verifier = this.system.buildResourceVerifier;
        if (!verifier?.lookup || (!entry.operationMarker && !entry.resourceCandidate))
            throw buildError({ message: "资源定位待核查：尚无已验证的查询协议或精确资源绑定", status: 400 });
        runtime.assertCurrent();
        const result = await withHardTimeout(
            () =>
                verifier.lookup({
                    accountKey: entry.account,
                    appId: entry.resourceCandidate || null,
                    operationMarker: entry.operationMarker || null,
                    page: runtime.page,
                }),
            Math.min(10000, this.rpcTimeoutMs),
            { operation: "Build resource verification", status: 504 }
        );
        runtime.assertCurrent();
        if (
            !result?.verified ||
            result.accountKey !== entry.account ||
            typeof result.appId !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(result.appId) ||
            (entry.resourceCandidate && result.appId !== entry.resourceCandidate) ||
            (entry.operationMarker && result.operationMarker !== entry.operationMarker)
        )
            throw buildError({ message: "资源身份未唯一核实；保留定位债务", status: 400 });
        if (
            Object.entries(this.store.read()).some(
                ([id, e]) => id !== op && e.account === entry.account && e.app === result.appId
            )
        )
            throw buildError({ message: "Resource already belongs to another operation", status: 409 });
        entry.app = result.appId;
        entry.resourceState = "known";
        entry.cleanupStage = "delete_pending";
        entry.resourceVerifiedAt = this.now();
        this.store.save(op, entry);
        await this.recordEvent(op, entry, {
            endedAt: this.now(),
            method: "VerifyResourceIdentity",
            outcome: "confirmed",
            startedAt: this.now(),
        });
    }
    retryAccount(index) {
        if (this.fault || !this.system.authSource.getRotationIndices().includes(index)) return;
        const key = this.system.scheduler.account(index).key;
        for (const [id, entry] of Object.entries(this.store.read())) {
            if (
                entry.account === key &&
                ["quarantined", "protocol_review"].includes(entry.retryState) &&
                entry.cleanupStage !== "verify_pending"
            ) {
                entry.retryState = "scheduled";
                this.store.save(id, entry);
            }
        }
        this.wake(index);
    }
    authRecoveryAt(index) {
        return (
            this.system.authSource.accountLoginService?.state?.accounts.find(account => account.authIndex === index)
                ?.lastSuccessAt ?? null
        );
    }
    isSessionCurrent(index, version) {
        const service = this.system.authSource.accountLoginService;
        if (!service?.state) return true;
        return (
            !service.invalidated.has(index) &&
            service.state.accounts.some(account => account.authIndex === index && account.sessionVersion === version)
        );
    }
    snapshot() {
        let entries = [];
        try {
            entries = this.store
                ? Object.entries(this.store.read())
                      .filter(([id]) => !this.store.active.has(id) || this.store.executing.has(id))
                      .map(([, entry]) => entry)
                : [];
        } catch (error) {
            this.storageFailed(error);
        }
        const count = state => entries.filter(e => e.retryState === state).length;
        return {
            accounts: [...this.system.scheduler.accounts.values()].map(a => {
                const policy = this.admission(a);
                return {
                    index: a.index,
                    ...policy,
                    debtLimit: this.debtLimit,
                    nextAttemptAt: entries.some(e => e.account === a.key && !e.deleteConfirmedAt)
                        ? Math.min(
                              ...entries
                                  .filter(e => e.account === a.key && !e.deleteConfirmedAt)
                                  .map(e => e.nextAttemptAt || this.now())
                          )
                        : null,
                    temporaryHoldUntil: policy.allowed ? null : a.buildRecoveryHoldUntil || this.now() + 300000,
                };
            }),
            active_recoveries: this.activeAccounts.size,
            blocked_accounts: [...this.system.scheduler.accounts.values()].filter(a => a.buildRecoveryBlocked).length,
            debt_limit: this.debtLimit,
            degraded_accounts: [...this.system.scheduler.accounts.values()].filter(a => a.buildCleanupDegraded).length,
            deleted_projects: entries.filter(e => e.deleteConfirmedAt).length,
            fault: this.fault,
            fault_error: this.faultError || null,
            inconsistent_accounts: [...this.system.scheduler.accounts.values()]
                .filter(a =>
                    entries.some(
                        e => e.account === a.key && e.lastError?.message?.includes("recovery_state_inconsistent")
                    )
                )
                .map(a => a.index),
            next_attempt_at: entries.some(e => e.nextAttemptAt)
                ? Math.min(...entries.map(e => e.nextAttemptAt).filter(Boolean))
                : null,
            node_debt_limit: this.nodeDebtLimit,
            oldest_pending_age_ms: entries.some(e => !e.deleteConfirmedAt && e.createdAt)
                ? this.now() -
                  Math.min(
                      ...entries
                          .filter(e => !e.deleteConfirmedAt)
                          .map(e => e.createdAt)
                          .filter(Boolean)
                  )
                : null,
            operations: entries.map(e => ({
                accountIndex:
                    [...this.system.scheduler.accounts.values()].find(a => a.key === e.account)?.index ?? null,
                attempts: e.attempts,
                auditNextAttemptAt: e.auditNextAttemptAt || null,
                cancelConfirmedAt: e.cancelConfirmedAt || null,
                deletionEvidence: e.deletionEvidence || null,
                lastError: e.lastError,
                lastErrorsByMethod: e.lastErrorsByMethod || {},
                nextAttemptAt: e.nextAttemptAt,
                operationId: e.operationId,
                projectDeleted: Boolean(e.deleteConfirmedAt),
                requestId: e.requestId,
                resourceState: e.resourceState,
                revision: e.revision,
                stage: e.cleanupStage,
                state: e.retryState,
                taskState: e.taskState,
                taskTerminalAt: e.taskTerminalAt || null,
                updatedAt: e.updatedAt,
            })),
            pending_operations: entries.filter(e => !e.deleteConfirmedAt).length,
            protocol_review: count("protocol_review"),
            quarantined: count("quarantined"),
            resource_discovery: entries.filter(e => !e.app).length,
            resource_lookup_verified: Boolean(this.system.buildResourceVerifier?.lookup),
            task_stop_unverified: entries.filter(e => e.deleteConfirmedAt && !e.complete && !e.cancelConfirmedAt)
                .length,
            waiting_auth: count("waiting_auth"),
            waiting_context: count("waiting_context"),
            waiting_permission: count("waiting_permission"),
        };
    }
    async close() {
        this.closed = true;
        clearInterval(this.timer);
        await this.task;
        if (this.ownsLock && !this.store?.active.size && !this.store?.executing.size) {
            fs.closeSync(this.lockDescriptor);
            this.lockDescriptor = null;
            this.ownsLock = false;
        }
    }
}
module.exports = { BuildRecoveryManager };
