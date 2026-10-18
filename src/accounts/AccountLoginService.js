const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { resolveTier, TIERS } = require("./AccountTierPolicy");
const BenefitCheckQueue = require("./BenefitCheckQueue");
const AccountStore = require("./AccountStore");
const AccountLoginQueue = require("./AccountLoginQueue");
const LoginArtifactService = require("./LoginArtifactService");
const Totp = require("./TotpService");
const { config } = require("./AccountConfig");
const { emailKey, parseImport } = require("./AuthenticatorImportService");
const active = task => ["queued", "running", "retry_wait"].includes(task.status);
const error = (message, status = 400) => Object.assign(new Error(message), { status });

class AccountLoginService {
    constructor(system, options = {}) {
        this.system = system;
        this.logger = system.logger;
        this.authDir = options.authDir || path.join(process.cwd(), "configs/auth");
        this.store = new AccountStore(options.storePath || process.env.ACCOUNT_STORE_PATH || "./data/accounts.sqlite");
        this.artifacts = new LoginArtifactService(
            options.artifactDir || process.env.ACCOUNT_LOGIN_ARTIFACT_DIR || "./data/account-login-artifacts"
        );
        this.chain = Promise.resolve();
        this.previews = new Map();
        this.invalidated = new Set();
        this.queue = new AccountLoginQueue(this, options.workerPath);
        this.benefitQueue = new BenefitCheckQueue(this);
    }
    exclusive(work) {
        this.pendingOperations ||= 0;
        if (this.pendingOperations >= 1000) return Promise.reject(error("Account operation queue is full", 503));
        this.pendingOperations++;
        const result = this.chain
            .then(() => {
                if (this.storageFailed)
                    throw error("Account storage unavailable; restart after repairing storage", 503);
                return work();
            })
            .finally(() => {
                this.pendingOperations--;
            });
        this.chain = result.catch(() => {});
        return result;
    }
    async initialize({ startQueue = true } = {}) {
        const initialConfig = this.system.configurationService
            ? { ...this.system.configurationService.running.login }
            : config();
        this.state = (await this.store.call("load")) || {
            accounts: [],
            artifacts: [],
            commits: [],
            config: initialConfig,
            configSource: "environment/default",
            tasks: [],
        };
        this.state.config = {
            ...initialConfig,
            autoRecovery: this.state.config.autoRecovery ?? initialConfig.autoRecovery,
            concurrency: this.state.config.concurrency,
            paused: this.state.config.paused,
        };
        this.system?.configurationService?.initializeAccounts(this.state);
        for (const account of this.state.accounts) {
            account.recoveryEmail ??= null;
            account.manualTier ??= null;
        }
        this.state.benefitTasks ||= [];
        for (const task of this.state.benefitTasks)
            if (["queued", "waiting", "running"].includes(task.status))
                Object.assign(task, { finishedAt: Date.now(), reason: "interrupted", status: "failed" });
        await this.artifacts.initialize();
        await fs.mkdir(this.authDir, { mode: 0o700, recursive: true });
        for (const task of this.state.tasks) await this.queue.recover(task);
        // Roll forward only commits that reached the atomic file boundary.
        for (const commit of this.state.commits) {
            const account = this.state.accounts.find(item => item.accountId === commit.accountId);
            const file = await this.readAuth(commit.authIndex);
            if (account && file?._accountSessionVersion === commit.sessionVersion) {
                Object.assign(account, {
                    authIndex: commit.authIndex,
                    lastFailure: commit.expired ? account.lastFailure : null,
                    lastSuccessAt: Date.now(),
                    recoveryState: "idle",
                    sessionState: commit.expired ? "expired" : "valid",
                    sessionVersion: commit.sessionVersion,
                });
                const task = this.state.tasks.find(item => item.taskId === commit.taskId);
                if (task) Object.assign(task, { finishedAt: Date.now(), status: "succeeded", token: null });
            }
        }
        this.state.commits = [];
        this.system.authSource.reloadAuthSources(true);
        await this.syncAccounts();
        this.state.nextSessionVersion = Math.max(
            this.state.nextSessionVersion || 1,
            ...this.state.accounts.map(account => account.sessionVersion + 1)
        );
        for (const task of this.state.tasks.filter(active)) {
            const account = this.state.accounts.find(item => item.accountId === task.accountId);
            if (
                !account ||
                account.credentialVersion !== task.credentialVersion ||
                account.sessionVersion !== task.sessionVersion
            ) {
                task.status = "cancelled";
                continue;
            }
            if (task.status === "running") {
                task.history.push({
                    attempt: task.attempts,
                    endedAt: Date.now(),
                    error: "interrupted",
                    phase: task.phase,
                });
                task.token = null;
                if (task.attempts >= this.state.config.maxAttempts || task.deadline <= Date.now())
                    this.failTask(task, "interrupted");
                else {
                    task.status = "retry_wait";
                    task.nextAttemptAt = Date.now();
                    account.recoveryState = "retry_wait";
                }
            }
        }
        // Older versions kept failure summaries after a successful session commit.
        for (const account of this.state.accounts)
            if (account.sessionState === "valid" && account.recoveryState === "idle") account.lastFailure = null;
        await this.cleanup();
        await this.save();
        this.cleanupTimer = setInterval(
            () =>
                this.exclusive(async () => {
                    await this.cleanup();
                    await this.save();
                }).catch(() => this.logger.error("[Accounts] Artifact cleanup failed")),
            3600000
        );
        this.cleanupTimer.unref();
        if (startQueue) await this.queue.start();
    }
    async save() {
        try {
            return await this.store.call(
                "save",
                this.system.configurationService
                    ? { ...this.state, config: { paused: this.state.config.paused } }
                    : this.state
            );
        } catch (cause) {
            this.storageFailed = true;
            this.queue.stopped = true;
            throw cause;
        }
    }
    async readAuth(index) {
        try {
            return JSON.parse(await fs.readFile(path.join(this.authDir, `auth-${index}.json`), "utf8"));
        } catch {
            return null;
        }
    }
    async syncAccounts() {
        for (const authIndex of this.system.authSource.availableIndices) {
            if (this.state.accounts.some(account => account.authIndex === authIndex)) continue;
            const file = await this.readAuth(authIndex);
            this.state.accounts.push(
                this.newAccount({
                    authIndex,
                    displayName: file?.accountName || `#${authIndex}`,
                    email: emailKey(file?.accountName),
                    sessionState: file?.expired ? "expired" : "valid",
                    sessionVersion: file?._accountSessionVersion || 0,
                })
            );
        }
    }
    newAccount(values) {
        return {
            accountId: randomUUID(),
            authIndex: null,
            autoRecovery: true,
            credentialVersion: 1,
            currentTaskId: null,
            displayName: "",
            email: null,
            lastExpiredAt: null,
            lastFailure: null,
            lastSuccessAt: null,
            manualTier: null,
            password: null,
            recoveryEmail: null,
            recoveryState: "credentials_missing",
            sessionState: "missing",
            sessionVersion: 0,
            totp: null,
            ...values,
        };
    }
    account(id) {
        const account = this.state.accounts.find(item => item.accountId === id);
        if (!account) throw error("Account not found", 404);
        return account;
    }
    publicAccount(account) {
        const { password, totp, recoveryEmail, ...metadata } = account;
        const task = this.state.tasks.find(item => item.taskId === account.currentTaskId);
        return {
            ...metadata,
            benefitTask: this.benefitQueue.latest(account.accountId),
            disabled:
                account.authIndex !== null &&
                this.system.scheduler?.isAccountManuallyDisabled(account.authIndex) === true,
            hasPassword: !!password,
            hasRecoveryEmail: !!recoveryEmail,
            hasTotpSecret: !!totp,
            isDuplicate:
                account.authIndex !== null &&
                (this.system.authSource.duplicateIndices || []).includes(account.authIndex),
            loginStopping: this.isLoginStopping(account.accountId),
            nextAttemptAt: task?.nextAttemptAt || null,
            tier: resolveTier(account),
        };
    }
    list() {
        return this.state.accounts.map(account => this.publicAccount(account));
    }
    selectedAccounts(input) {
        if (input?.all === true) return this.state.accounts.slice();
        if (!Array.isArray(input?.accountIds) || !input.accountIds.length) throw error("Select at least one account");
        return [...new Set(input.accountIds)].map(id => this.account(id));
    }
    async setRecovery(input) {
        if (typeof input.autoRecovery !== "boolean") throw error("autoRecovery must be boolean");
        if (!Array.isArray(input.accounts) || !input.accounts.length) throw error("Select at least one account");
        const accounts = input.accounts.map(entry => {
            const account = this.account(entry.accountId);
            if (account.credentialVersion !== entry.credentialVersion)
                throw error("Credentials changed; reload before saving", 409);
            return account;
        });
        for (const account of accounts) account.autoRecovery = input.autoRecovery;
        await this.save();
        return { updated: accounts.length };
    }
    credentials(id) {
        const account = this.account(id);
        return {
            autoRecovery: account.autoRecovery,
            benefitLastCheck: account.benefitLastCheck || null,
            benefitObservation: account.benefitObservation || null,
            credentialVersion: account.credentialVersion,
            email: account.email,
            manualTier: account.manualTier ?? null,
            password: account.password,
            recoveryEmail: account.recoveryEmail,
            tier: resolveTier(account),
            totpSecret: account.totp?.secret || null,
        };
    }
    invalidate(account) {
        this.benefitQueue.cancelAccount(account.accountId);
        for (const task of this.state.tasks.filter(task => task.accountId === account.accountId && active(task))) {
            task.token = null;
            task.status = "cancelled";
            task.finishedAt = Date.now();
            setImmediate(() => this.queue.cancel(task.taskId).catch(() => {}));
        }
        account.currentTaskId = null;
        account.recoveryState = account.password ? "idle" : "credentials_missing";
    }
    validateCredentials(input, creating = false) {
        if (input.manualTier !== undefined && !TIERS.includes(input.manualTier)) throw error("Invalid manual tier");
        if (["benefitObservation", "benefitLastCheck", "effectiveTier", "tier", "conflict"].some(key => key in input))
            throw error("Benefit results are read-only");
        if ((creating || input.email !== undefined) && !emailKey(input.email))
            throw error("A complete login email is required");
        if (
            (creating || input.password !== undefined) &&
            (typeof input.password !== "string" || !input.password || input.password.length > 4096)
        )
            throw error("Password must be nonempty; use clearPassword to remove it");
        if (input.recoveryEmail !== undefined && !emailKey(input.recoveryEmail))
            throw error("Invalid recovery email; use clearRecoveryEmail to remove it");
        if (input.totpSecret !== undefined && !input.totpSecret)
            throw error("Use clearTotpSecret to remove the authenticator");
        if (input.totpSecret !== undefined) {
            try {
                return Totp.normalize(input.totpSecret);
            } catch {
                throw error("Invalid or unsupported TOTP secret");
            }
        }
    }
    async create(input, login = this.state.config.autoRecovery && input.autoRecovery !== false) {
        if (this.deduplicating) throw error("Account deduplication is in progress", 409);
        const totp = this.validateCredentials(input, true);
        if (this.state.accounts.some(account => account.email === emailKey(input.email)))
            throw error("Email already exists; edit the existing account", 409);
        if (login && this.state.tasks.filter(active).length >= this.state.config.queueLimit)
            throw error("Login queue is full; retry later", 429);
        const account = this.newAccount({
            autoRecovery: input.autoRecovery !== false,
            displayName: emailKey(input.email),
            email: emailKey(input.email),
            manualTier: input.manualTier ?? null,
            password: input.password,
            recoveryEmail: emailKey(input.recoveryEmail),
            recoveryState: "idle",
            totp: totp || null,
        });
        this.state.accounts.push(account);
        const task = login ? this.enqueue(account, "new") : null;
        await this.save();
        return { account: this.publicAccount(account), taskId: task?.taskId };
    }
    async edit(id, input) {
        if (this.deduplicating) throw error("Account deduplication is in progress", 409);
        const account = this.account(id);
        if (input.credentialVersion !== account.credentialVersion)
            throw error("Credentials changed; reload before saving", 409);
        const totp = this.validateCredentials(input);
        if (
            input.email !== undefined &&
            this.state.accounts.some(item => item !== account && item.email === emailKey(input.email))
        )
            throw error("Email conflict", 409);
        if (input.autoRecovery !== undefined && typeof input.autoRecovery !== "boolean")
            throw error("autoRecovery must be boolean");
        const changes = [
            "email",
            "password",
            "totpSecret",
            "recoveryEmail",
            "clearRecoveryEmail",
            "clearPassword",
            "clearTotpSecret",
        ].some(key => input[key] !== undefined);
        if (changes) {
            const manuallyStopped =
                account.recoveryState === "manual_required" && account.lastFailure?.error === "cancelled";
            this.invalidate(account);
            if (manuallyStopped) account.recoveryState = "manual_required";
            account.credentialVersion++;
        }
        if (input.email !== undefined) account.email = emailKey(input.email);
        if (input.password !== undefined) account.password = input.password;
        if (totp) account.totp = totp;
        if (input.recoveryEmail !== undefined) account.recoveryEmail = emailKey(input.recoveryEmail);
        if (input.clearRecoveryEmail === true) account.recoveryEmail = null;
        if (input.clearPassword === true) account.password = null;
        if (input.clearTotpSecret === true) account.totp = null;
        if (input.autoRecovery !== undefined) account.autoRecovery = input.autoRecovery;
        if (input.manualTier !== undefined) {
            account.manualTier = input.manualTier;
            if (!changes) {
                account.credentialVersion++;
                // Tier-only edits do not invalidate an already authorized login.
                for (const task of this.state.tasks)
                    if (task.accountId === account.accountId && active(task))
                        task.credentialVersion = account.credentialVersion;
            }
        }
        if (changes && !account.password) account.recoveryState = "credentials_missing";
        await this.save();
        if (input.manualTier !== undefined) this.notifyTierChanged();
        return this.publicAccount(account);
    }
    isLoginStopping(accountId) {
        return this.state.tasks.some(
            task =>
                task.accountId === accountId && !active(task) && (task.executor || this.queue.running.has(task.taskId))
        );
    }
    enqueue(account, source) {
        if (this.isLoginStopping(account.accountId))
            throw error("Previous login executor is still stopping; retry later", 409);
        if (this.deduplicating) throw error("Account deduplication is in progress", 409);
        const existing = this.state.tasks.find(task => task.accountId === account.accountId && active(task));
        if (existing) {
            // An explicit login must also release an automatic task held by the global switch.
            if (source === "manual") existing.source = "manual";
            return existing;
        }
        if (!account.email || !account.password) {
            account.recoveryState = "credentials_missing";
            throw error("Login credentials missing");
        }
        if (this.state.tasks.filter(active).length >= this.state.config.queueLimit)
            throw error("Login queue is full; retry later", 429);
        const task = {
            accountId: account.accountId,
            attempts: 0,
            createdAt: Date.now(),
            credentialVersion: account.credentialVersion,
            deadline: null,
            history: [],
            nextAttemptAt: Date.now(),
            phase: "queued",
            sessionVersion: account.sessionVersion,
            source,
            status: "queued",
            taskId: randomUUID(),
            token: null,
        };
        this.state.tasks.push(task);
        account.currentTaskId = task.taskId;
        account.recoveryState = "queued";
        return task;
    }
    async login(id) {
        const task = this.enqueue(this.account(id), "manual");
        await this.save();
        return { taskId: task.taskId };
    }
    failTask(task, reason) {
        Object.assign(task, {
            error: reason,
            finishedAt: Date.now(),
            status: reason === "cancelled" ? "cancelled" : "failed",
            token: null,
        });
        const account = this.state.accounts.find(item => item.accountId === task.accountId);
        if (account) {
            account.recoveryState = reason === "credentials_missing" ? "credentials_missing" : "manual_required";
            account.lastFailure = { error: reason, phase: task.phase, taskId: task.taskId };
            account.currentTaskId = null;
        }
    }
    async cancel(id) {
        const task = this.state.tasks.find(item => item.taskId === id);
        if (!task) throw error("Task not found", 404);
        if (active(task)) {
            task.history.push({ attempt: task.attempts, endedAt: Date.now(), error: "cancelled", phase: task.phase });
            this.failTask(task, "cancelled");
        }
        await this.save();
        // The queue completion needs this same service lock: never await it here.
        setImmediate(() => this.queue.cancel(id).catch(() => {}));
        return { status: task.status, stopping: this.isLoginStopping(task.accountId) };
    }
    async batchCancelLogin(input) {
        const ids = input?.accountIds;
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !id || id.length > 256))
            throw error("Select at least one account ID");
        const result = { cancelled: 0, failed: 0, results: [], stopping: 0, unnecessary: 0 };
        for (const accountId of new Set(ids)) {
            try {
                this.account(accountId);
                const tasks = this.state.tasks.filter(task => task.accountId === accountId && active(task));
                for (const task of tasks) await this.cancel(task.taskId);
                const status = this.isLoginStopping(accountId)
                    ? "stopping"
                    : tasks.length
                      ? "cancelled"
                      : "unnecessary";
                result[status]++;
                result.results.push({ accountId, status });
            } catch (cause) {
                result.failed++;
                result.results.push({
                    accountId,
                    error: cause.status ? cause.message : "Account service unavailable",
                    status: "failed",
                });
            }
        }
        return result;
    }
    async scanRecovery() {
        if (this.deduplicating) return;
        if (!this.state.config.autoRecovery) return;
        for (const account of this.state.accounts)
            if (
                account.sessionState === "expired" &&
                account.autoRecovery &&
                !this.isLoginStopping(account.accountId) &&
                ["idle", "queued", "credentials_missing"].includes(account.recoveryState)
            ) {
                if (account.authIndex !== null && this.system.scheduler?.isAccountManuallyDisabled(account.authIndex))
                    continue;
                if (!account.password || !account.email) {
                    account.recoveryState = "credentials_missing";
                    continue;
                }
                try {
                    this.enqueue(account, "expired");
                } catch (cause) {
                    if (cause.status !== 429) throw cause;
                    account.recoveryState = "queued";
                }
            }
    }
    resolveProxy(account) {
        if (this.system.proxyPoolService) return this.system.proxyPoolService.bindings.resolveAccount(account).proxy;
        const { parseProxyFromEnv } = require("../utils/ProxyUtils");
        return parseProxyFromEnv();
    }
    async atomicAuth(index, data, validate = () => {}) {
        const target = path.join(this.authDir, `auth-${index}.json`);
        const temporary = `${target}.${randomUUID()}.tmp`;
        const file = await fs.open(temporary, "wx", 0o600);
        try {
            await file.writeFile(JSON.stringify(data, null, 2));
            await file.sync();
        } finally {
            await file.close();
        }
        try {
            validate();
            await fs.rename(temporary, target);
        } catch (cause) {
            await fs.unlink(temporary).catch(() => {});
            throw cause;
        }
        const directory = await fs.open(this.authDir, "r");
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    }
    async nextIndex() {
        const files = await fs.readdir(this.authDir);
        const indices = files.filter(file => /^auth-\d+\.json$/.test(file)).map(file => Number(file.match(/\d+/)[0]));
        return Math.max(-1, ...indices, ...this.state.accounts.map(account => account.authIndex ?? -1)) + 1;
    }
    async retireContext(index) {
        const browser = this.system.browserManager;
        if (!browser || index === null) return;
        this.invalidated.add(index);
        browser.abortedContexts.add(index);
        this.system.connectionRegistry?.closeMessageQueuesForAuth(index, "session_replaced");
        const attempt = browser._contextInitAttempts?.get(index);
        if (attempt) {
            attempt.aborted = true;
            attempt.abortReason = "session_replaced";
        }
        await Promise.race([
            Promise.all([
                browser.closeContext(index, { keepBrowser: true, skipInitWait: true }),
                attempt?.context?.close(),
            ]),
            new Promise((_, reject) => {
                const timer = setTimeout(
                    () => reject(error("Old account context cleanup timed out", 503)),
                    this.state.config.cleanupTimeout
                );
                timer.unref();
            }),
        ]);
        browser.contextUnavailable.delete(index);
        this.system.connectionRegistry?.closeConnectionByAuth?.(index);
        browser.abortedContexts.delete(index);
    }
    async commitSession(account, data, task = null, validate = () => {}) {
        validate();
        const index = account.authIndex ?? (await this.nextIndex());
        const nextVersion = Math.max(account.sessionVersion + 1, this.state.nextSessionVersion || 1);
        this.state.nextSessionVersion = nextVersion + 1;
        const preserveExpired = !task && data.expired === true;
        const commit = {
            accountId: account.accountId,
            authIndex: index,
            expired: preserveExpired,
            sessionVersion: nextVersion,
            taskId: task?.taskId,
        };
        this.state.commits.push(commit);
        await this.save();
        await this.retireContext(account.authIndex);
        const old = (await this.readAuth(index)) || {};
        const merged = {
            ...old,
            _accountSessionVersion: nextVersion,
            accountName: data.accountName || account.email,
            cookies: data.cookies,
            origins: data.origins,
        };
        if (preserveExpired) merged.expired = true;
        else delete merged.expired;
        delete merged.password;
        delete merged.totpSecret;
        delete merged.totp;
        delete merged.recoveryEmail;
        delete merged.recovery_email;
        await this.atomicAuth(index, merged, validate);
        this.system.authSource.reloadAuthSources(true);
        Object.assign(account, {
            authIndex: index,
            currentTaskId: null,
            lastFailure: preserveExpired ? account.lastFailure : null,
            lastSuccessAt: Date.now(),
            recoveryState: "idle",
            sessionState: preserveExpired ? "expired" : "valid",
            sessionVersion: nextVersion,
        });
        this.invalidated.delete(index);
        this.state.commits = this.state.commits.filter(item => item !== commit);
        if (task) Object.assign(task, { finishedAt: Date.now(), status: "succeeded" });
        await this.save();
        if (!preserveExpired && this.system.scheduler?.account) {
            const scheduledAccount = this.system.scheduler.account(index);
            scheduledAccount.healthy = true;
            scheduledAccount.last_error = null;
            this.system.scheduler.saveSoon();
        }
        this.system.browserManager?.rebalanceContextPool().catch(() => {});
        return index;
    }
    async completeAttempt(slot, result) {
        const task = this.state.tasks.find(item => item.taskId === slot.taskId);
        const account = this.state.accounts.find(item => item.accountId === task?.accountId);
        if (task && !slot.cleanupFailed) delete task.executor;
        if (
            !task ||
            task.status !== "running" ||
            !account ||
            account.credentialVersion !== task.credentialVersion ||
            account.sessionVersion !== task.sessionVersion
        ) {
            if (task) await this.save();
            return;
        }
        let artifact = null,
            screenshotReason = slot.screenshot?.reason || "not_generated";
        if (slot.screenshot?.buffer) {
            try {
                artifact = await this.artifacts.save(account.accountId, task.taskId, slot.screenshot.buffer);
                this.state.artifacts.push(artifact);
                screenshotReason = null;
            } catch {
                screenshotReason = "storage_error";
            }
        }
        task.history.push({
            artifactId: artifact?.id || null,
            attempt: task.attempts,
            controls: result.controls || [],
            diagnostics: result.diagnostics,
            endedAt: Date.now(),
            error: result.error || null,
            executorExit: result.executorExit,
            frameKinds: result.frameKinds,
            phase: task.phase,
            screenshotReason,
            startedAt: slot.startedAt,
            termsOutcome: result.termsOutcome,
        });
        if (result.storageState && !result.error && result.email === account.email && task.deadline > Date.now()) {
            try {
                await this.commitSession(account, result.storageState, task, () => {
                    if (
                        require("node:perf_hooks").performance.now() >= slot.deadline ||
                        task.status !== "running" ||
                        task.credentialVersion !== account.credentialVersion ||
                        task.sessionVersion !== account.sessionVersion
                    )
                        throw error("Execution no longer authorized", 409);
                });
                return;
            } catch {
                this.failTask(task, "session_commit_failed");
            }
        } else if (result.retryable && task.attempts < slot.config.maxAttempts && task.deadline > Date.now() + 30000) {
            const delay = task.attempts === 1 ? 30000 : 120000;
            task.nextAttemptAt = Date.now() + delay + Math.floor(Math.random() * 3000);
            task.status = "retry_wait";
            account.recoveryState = "retry_wait";
        } else this.failTask(task, result.error || "account_mismatch");
        account.lastFailure = {
            artifactId: artifact?.id || null,
            error: result.error || task.error,
            phase: task.phase,
            screenshotReason,
            taskId: task.taskId,
        };
        await this.save();
    }
    // All legacy mutations enter this same serialized boundary.
    async upload(data) {
        if (this.deduplicating) throw error("Account deduplication is in progress", 409);
        if (typeof data === "string") {
            try {
                data = JSON.parse(data);
            } catch {
                throw error("Invalid authentication JSON");
            }
        }
        if (!data || !Array.isArray(data.cookies) || !Array.isArray(data.origins)) throw error("Invalid storageState");
        const email = emailKey(data.accountName);
        const candidates = this.state.accounts.filter(account => email && account.email === email);
        if (candidates.length > 1) throw error("Duplicate email; resolve account mapping before replacing Cookie", 409);
        let account = candidates[0];
        if (!account) {
            account = this.newAccount({ displayName: data.accountName || "", email });
            this.state.accounts.push(account);
        }
        this.invalidate(account);
        account.sessionVersion++;
        return this.commitSession(account, data);
    }
    async removeIndex(index, { dedup = false } = {}) {
        if (this.deduplicating && !dedup) throw error("Account deduplication is in progress", 409);
        const account = this.state.accounts.find(item => item.authIndex === index);
        if (account) {
            this.invalidate(account);
            this.state.accounts = this.state.accounts.filter(item => item !== account);
        }
        this.invalidated.add(index);
        await this.save();
        await fs.unlink(path.join(this.authDir, `auth-${index}.json`));
        this.system.authSource.reloadAuthSources(true);
    }
    async prepareDeduplicate(groups, choices = {}) {
        const conflicts = [];
        const prepared = groups.map(group => {
            const candidates = this.state.accounts.filter(account =>
                [group.keptIndex, ...group.removedIndices].includes(account.authIndex)
            );
            const keep = candidates.find(account => account.authIndex === group.keptIndex);
            const conflict =
                new Set(candidates.map(account => account.manualTier ?? null)).size > 1 ||
                new Set(candidates.map(account => account.password).filter(Boolean)).size > 1 ||
                new Set(candidates.map(account => account.totp?.secret).filter(Boolean)).size > 1 ||
                new Set(candidates.map(account => account.recoveryEmail).filter(Boolean)).size > 1;
            const choice = choices[group.email];
            let source = null;
            if (conflict) {
                source = candidates.find(account => account.accountId === choice?.accountId);
                if (
                    !source ||
                    candidates.some(account => choice?.versions?.[account.accountId] !== account.credentialVersion)
                )
                    conflicts.push({
                        candidates: candidates.map(account => this.publicAccount(account)),
                        email: group.email,
                        keptIndex: group.keptIndex,
                    });
            }
            return { candidates, conflict, keep, source };
        });
        if (conflicts.length) return { conflicts };
        this.deduplicating = true;
        for (const { candidates, keep, source, conflict } of prepared) {
            if (!keep) continue;
            for (const account of candidates) this.invalidate(account);
            keep.password = conflict ? source.password : candidates.find(account => account.password)?.password || null;
            keep.recoveryEmail = conflict
                ? source.recoveryEmail
                : candidates.find(account => account.recoveryEmail)?.recoveryEmail || null;
            keep.totp = conflict ? source.totp : candidates.find(account => account.totp)?.totp || null;
            keep.manualTier = conflict ? (source.manualTier ?? null) : (keep.manualTier ?? null);
            keep.credentialVersion++;
        }
        await this.save();
        return { conflicts: [] };
    }
    async markExpired(index, version) {
        const account = this.state.accounts.find(item => item.authIndex === index);
        if (!account || this.invalidated.has(index) || (version !== undefined && version !== account.sessionVersion))
            return false;
        const data = await this.readAuth(index);
        if (!data || data.expired) return false;
        data.expired = true;
        await this.atomicAuth(index, data);
        account.sessionState = "expired";
        account.lastExpiredAt = Date.now();
        this.system.authSource.reloadAuthSources(true);
        await this.scanRecovery();
        await this.save();
        return true;
    }
    async refreshSession(index, version, state, restore = false) {
        const account = this.state.accounts.find(item => item.authIndex === index);
        if (!account || this.invalidated.has(index) || version !== account.sessionVersion) return false;
        const data = await this.readAuth(index);
        if (!data || (data.expired && !restore)) return false;
        if (state) {
            data.cookies = state.cookies;
            data.origins = state.origins;
        }
        if (restore) {
            delete data.expired;
            this.invalidate(account);
            account.sessionState = "valid";
        }
        await this.atomicAuth(index, data);
        if (restore) {
            account.lastFailure = null;
            account.lastSuccessAt = Date.now();
        }
        this.system.authSource.reloadAuthSources(true);
        await this.save();
        return true;
    }
    preview(sessionId, kind, content) {
        for (const [id, preview] of this.previews) if (preview.expiresAt < Date.now()) this.previews.delete(id);
        if (this.previews.size >= 20) throw error("Too many pending import previews", 429);
        let parsed;
        try {
            parsed = parseImport(kind, content);
        } catch {
            throw error(
                kind === "csv"
                    ? "Invalid CSV: provide an email,password header and valid quoted fields (maximum 1 MiB)"
                    : "Invalid import format or size"
            );
        }
        const rows = parsed.rows.map((row, index) => {
            const matches = this.state.accounts.filter(account => account.email && account.email === row.email);
            const account = matches.length === 1 ? matches[0] : null;
            return {
                ...row,
                accountId: account?.accountId || null,
                conflict: !!(
                    account &&
                    ((row.totp && account.totp && row.totp.secret !== account.totp.secret) ||
                        (row.recoveryEmail && account.recoveryEmail && row.recoveryEmail !== account.recoveryEmail) ||
                        (row.password && account.password && row.password !== account.password))
                ),
                credentialVersion: account?.credentialVersion,
                index,
                matches: matches.length,
                recoveryEmailConflict: !!(
                    account &&
                    row.recoveryEmail &&
                    account.recoveryEmail &&
                    row.recoveryEmail !== account.recoveryEmail
                ),
                unchanged: !!(
                    account &&
                    row.totp &&
                    account.totp?.secret === row.totp.secret &&
                    !row.password &&
                    !row.recoveryEmail
                ),
            };
        });
        const id = randomUUID();
        this.previews.set(id, {
            complete: parsed.complete,
            expiresAt: Date.now() + 600000,
            kind,
            rows,
            sessionId,
            versions: Object.fromEntries(
                this.state.accounts.map(account => [account.accountId, account.credentialVersion])
            ),
        });
        return {
            batches: parsed.batches,
            complete: parsed.complete,
            previewId: id,
            rows: rows.map(({ password, totp, recoveryEmail, ...row }) => ({
                ...row,
                hasPassword: !!password,
                hasRecoveryEmail: !!recoveryEmail,
                hasTotpSecret: !!totp,
            })),
        };
    }
    async importCommit(sessionId, input) {
        if (input.skipExisting !== undefined && typeof input.skipExisting !== "boolean")
            throw error("skipExisting must be boolean");
        const preview = this.previews.get(input.previewId);
        if (!preview || preview.sessionId !== sessionId || preview.expiresAt < Date.now())
            throw error("Preview expired or unavailable", 409);
        if (preview.result) return preview.result;
        if (!preview.complete) throw error("Migration batch is incomplete", 409);
        if (!Array.isArray(input.rows) || input.rows.length > 1000) throw error("Invalid import choices");
        const autoLogin = this.state.config.autoRecovery;
        const result = { created: 0, errors: [], failed: 0, loginQueued: 0, loginWarnings: [], skipped: 0, updated: 0 },
            seen = new Set();
        for (const choice of input.rows) {
            const row = preview.rows[choice.index];
            try {
                if (!row || seen.has(choice.index)) throw error("Invalid or duplicate import choice");
                seen.add(choice.index);
                if (choice.skip || row.unchanged) {
                    result.skipped++;
                    continue;
                }
                if (row.error) throw error(row.error);
                const accountId = choice.accountId || row.accountId;
                const matches =
                    preview.kind === "csv"
                        ? this.state.accounts.filter(account => account.email && account.email === row.email)
                        : [];
                if (input.skipExisting && (accountId || matches.length)) {
                    result.skipped++;
                    continue;
                }
                if (matches.length > 1)
                    throw error("Multiple matching accounts; resolve duplicates and preview again", 409);

                if (!accountId) {
                    if (preview.kind !== "csv" || !row.email) {
                        result.skipped++;
                        continue;
                    }
                    const created = await this.create(
                        {
                            email: row.email,
                            password: row.password,
                            ...(row.totp ? { totpSecret: row.totp.secret } : {}),
                            ...(row.recoveryEmail ? { recoveryEmail: row.recoveryEmail } : {}),
                        },
                        false
                    );
                    result.created++;
                    if (autoLogin && created.account.autoRecovery) {
                        try {
                            this.enqueue(this.account(created.account.accountId), "new");
                            await this.save();
                            result.loginQueued++;
                        } catch (cause) {
                            if (!cause.status) throw cause;
                            result.loginWarnings.push({
                                accountId: created.account.accountId,
                                error: cause.message,
                                index: choice.index,
                            });
                        }
                    }
                    continue;
                }
                const account = this.account(accountId);
                if (account.credentialVersion !== preview.versions[accountId])
                    throw error("Credentials changed; preview again", 409);
                if (preview.kind === "csv" && account.email !== row.email)
                    throw error("CSV requires exact email matching");
                if (
                    ((row.password && account.password && row.password !== account.password) ||
                        (row.totp && account.totp && row.totp.secret !== account.totp.secret) ||
                        (row.recoveryEmail && account.recoveryEmail && row.recoveryEmail !== account.recoveryEmail)) &&
                    !choice.overwrite
                )
                    throw error("Explicit overwrite required", 409);
                await this.edit(accountId, {
                    credentialVersion: account.credentialVersion,
                    ...(row.password ? { password: row.password } : {}),
                    ...(row.totp ? { totpSecret: row.totp.secret } : {}),
                    ...(row.recoveryEmail ? { recoveryEmail: row.recoveryEmail } : {}),
                });
                result.updated++;
            } catch (cause) {
                if (this.storageFailed) throw cause;
                result.failed++;
                result.errors.push({ error: cause.message, index: choice.index });
            }
        }
        preview.result = result;
        await this.save();
        return result;
    }
    async cleanup() {
        await this.artifacts.cleanup(this.state.artifacts, this.state.config);
        const cutoff = Date.now() - this.state.config.logDays * 86400000;
        this.state.tasks = this.state.tasks.filter(
            task => active(task) || task.executor || !task.finishedAt || task.finishedAt > cutoff
        );
    }
    notifyTierChanged() {
        const scheduler = this.system.scheduler;
        if (scheduler) {
            scheduler.sequence = (scheduler.sequence || 0) + 1;
            scheduler._eligibleRound = null;
            scheduler._selectionPass = null;
            scheduler.drain?.();
        }
    }
    async recordBenefit(accountId, sessionVersion, result, isCurrent = () => true) {
        return this.exclusive(async () => {
            const account = this.state.accounts.find(item => item.accountId === accountId);
            if (
                !account ||
                account.sessionVersion !== sessionVersion ||
                this.invalidated.has(account.authIndex) ||
                !isCurrent() ||
                this.closed
            )
                return false;
            const checkedAt = Date.now();
            const succeeded = ["ready-free", "ready-paid"].includes(result.state);
            if (succeeded)
                account.benefitObservation = {
                    observedAt: checkedAt,
                    rawTier: result.state === "ready-free" ? null : result.rawTier,
                    sessionVersion,
                    source: result.source || "query",
                    state: result.state,
                };
            account.benefitLastCheck = {
                checkedAt,
                reason: succeeded ? null : result.reason || "query_failed",
                sessionVersion,
                status: succeeded ? "succeeded" : "failed",
            };
            await this.save();
            this.notifyTierChanged();
            return true;
        });
    }
    async close() {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.cleanupTimer);
        await this.benefitQueue.close();
        await this.queue.close();
        await this.chain;
        await this.save();
        await this.store.close();
    }
}
module.exports = AccountLoginService;
