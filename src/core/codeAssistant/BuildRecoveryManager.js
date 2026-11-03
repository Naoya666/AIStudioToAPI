const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { BuildRecoveryStore } = require("./BuildRecoveryStore");
const { BuildRuntime } = require("./BuildRuntime");
const { buildError, errorInfo } = require("./BuildError");
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
    reconcile() {
        if (this.fault) return;
        let records;
        try {
            records = this.store.read();
        } catch (error) {
            this.storageFailed(error);
            return;
        }
        const completed = Object.entries(records).filter(([, entry]) => entry.cleanupStage === "done");
        for (const [, entry] of completed) this.knownBlocked.add(entry.account);
        const entries = Object.entries(records).filter(([, entry]) => entry.cleanupStage !== "done");
        const outstanding = new Set(entries.map(([, entry]) => entry.account));
        const blocked = new Set(
            entries
                .filter(([id]) => !this.store.active.has(id) || this.store.executing.has(id))
                .map(([, entry]) => entry.account)
        );
        for (const index of this.system.authSource.getRotationIndices()) {
            const account = this.system.scheduler.account(index);
            if (blocked.has(account.key) || (this.knownBlocked.has(account.key) && outstanding.has(account.key))) {
                account.buildRecoveryBlocked = true;
                this.knownBlocked.add(account.key);
            } else if (
                this.knownBlocked.has(account.key) &&
                account.buildRecoveryReason !== "recovery_state_inconsistent"
            ) {
                account.buildRecoveryBlocked = false;
                account.buildRecoveryReason = null;
            } else if (account.buildRecoveryBlocked) account.buildRecoveryReason = "recovery_state_inconsistent";
        }
        if (completed.length) {
            if (this.system.scheduler.flush?.() !== false) {
                try {
                    for (const [id] of completed) this.store.save(id, null);
                } catch (error) {
                    this.storageFailed(error);
                }
            } else this.storageFailed(new Error("Scheduler recovery checkpoint could not be persisted"));
        } else this.system.scheduler.saveSoon();
        this.system.scheduler.drain();
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
                    ? "quarantined"
                    : "scheduled";
        entry.nextAttemptAt = nextAttemptAt;
        this.store.save(op, entry);
        this.block(entry.account);
    }
    retryAt(entry, error) {
        if (error.recoveryNextAttemptAt) return error.recoveryNextAttemptAt;
        const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(20, entry.consecutiveFailures || 0));
        error.recoveryNextAttemptAt =
            this.now() +
            Math.max(
                error.rateLimit?.retryAfterMs || 0,
                error.status === 403 ? 300000 : Math.round(delay * (1 + Math.random() * 0.2))
            );
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
            if (storage) await storage.call("build_recovery_insert", record);
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
        if (this.closed || this.task || this.fault) return;
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
                entry.cleanupStage === "done" ||
                entry.retryState === "quarantined" ||
                entry.nextAttemptAt > this.now()
            )
                continue;
            const account = [...scheduler.accounts.values()].find(a => a.key === entry.account);
            if (
                !account ||
                (this.allowedIndices && !this.allowedIndices.has(account.index)) ||
                account.inflight ||
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
            if (entry.cleanupStage === "verify_pending") {
                entry.retryState = "quarantined";
                entry.lastError ||= errorInfo(
                    buildError({
                        message: "Upstream submission result unknown; manual verification required",
                        status: 400,
                    })
                );
                this.store.save(op, entry);
                return;
            }
            const data = browser.contexts.get(account.index);
            const page = data?.page;
            const session = page?.accountSessionVersion ?? data?.sessionVersion ?? null;
            if (
                entry.retryState === "waiting_auth" &&
                entry.failedSessionVersion === session &&
                (entry.failedAuthRecoveryAt ?? null) === this.authRecoveryAt(account.index)
            )
                continue;
            if (!browser.isContextReady(account.index) || !page?.playgroundTransport?.ready) {
                if (entry.retryState !== "waiting_context") {
                    entry.retryState = "waiting_context";
                    this.store.save(op, entry);
                }
                browser.requestRecoveryContext(account.index);
                return;
            }
            this.activeAccounts.add(account.key);
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
                await runtime.cleanup(op, entry);
            } catch (error) {
                entry.failedSessionVersion = session;
                this.failed(op, entry, error);
            } finally {
                this.activeAccounts.delete(account.key);
            }
            this.reconcile();
            browser.finishRecoveryContext?.(account.index);
            return; // one bounded operation per tick, global recovery concurrency is one
        }
    }
    retryAccount(index) {
        if (this.fault || !this.system.authSource.getRotationIndices().includes(index)) return;
        const key = this.system.scheduler.account(index).key;
        for (const [id, entry] of Object.entries(this.store.read())) {
            if (
                entry.account === key &&
                entry.retryState === "quarantined" &&
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
                      .filter(
                          ([id, entry]) =>
                              !this.store.active.has(id) ||
                              this.store.executing.has(id) ||
                              this.knownBlocked.has(entry.account)
                      )
                      .map(([, entry]) => entry)
                : [];
        } catch (error) {
            this.storageFailed(error);
        }
        const count = state => entries.filter(e => e.retryState === state).length;
        return {
            active_recoveries: this.activeAccounts.size,
            blocked_accounts: [...this.system.scheduler.accounts.values()].filter(a => a.buildRecoveryBlocked).length,
            fault: this.fault,
            fault_error: this.faultError || null,
            inconsistent_accounts: [...this.system.scheduler.accounts.values()]
                .filter(a => a.buildRecoveryReason === "recovery_state_inconsistent")
                .map(a => a.index),
            next_attempt_at: entries.some(e => e.nextAttemptAt)
                ? Math.min(...entries.map(e => e.nextAttemptAt).filter(Boolean))
                : null,
            oldest_pending_age_ms: entries.some(e => e.createdAt)
                ? this.now() - Math.min(...entries.map(e => e.createdAt).filter(Boolean))
                : null,
            operations: entries.map(e => ({
                attempts: e.attempts,
                lastError: e.lastError,
                nextAttemptAt: e.nextAttemptAt,
                operationId: e.operationId,
                requestId: e.requestId,
                stage: e.cleanupStage,
                state: e.retryState,
                updatedAt: e.updatedAt,
            })),
            pending_operations: entries.length,
            quarantined: count("quarantined"),
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
