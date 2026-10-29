const BrowserManager = require("../core/BrowserManager");
const ConnectionRegistry = require("../core/ConnectionRegistry");
const { withHardTimeout } = require("../utils/TimeoutUtils");
const { studioAccessState } = require("../auth/TargetServiceValidation");

class TargetSessionValidator {
    constructor({
        browser,
        storageState,
        proxy,
        targetUrl,
        timeout,
        stepTimeout,
        onPage,
        onContext,
        onSignal,
        onFailure,
    }) {
        // Never forward page text, URLs, cookies or exception messages to logs.
        const signals = [
            "Privacy protection layer active",
            "Received authIndex request",
            "Connection successful",
            "transport ready",
        ];
        const logger = Object.fromEntries(
            ["info", "debug", "warn", "error", "success"].map(level => [
                level,
                message => {
                    const signal = signals.find(value => String(message).includes(value));
                    if (signal) onSignal?.(signal);
                },
            ])
        );
        const authSource = {
            getAuth: index => (index === 0 ? storageState : null),
            markAsExpired: async () => {},
        };
        this.manager = new BrowserManager(
            logger,
            {
                enableAuthUpdate: false,
                scheduler: {
                    contextCleanupTimeoutMs: stepTimeout,
                    contextCreationTimeoutMs: stepTimeout,
                    contextInitTotalTimeoutMs: timeout,
                    contextOperationTimeoutMs: stepTimeout,
                },
            },
            authSource
        );
        this.manager.browser = browser;
        this.manager.targetUrl = targetUrl;
        this.registry = new ConnectionRegistry(logger, null, () => 0, this.manager);
        this.manager.setConnectionRegistry(this.registry);
        this.proxy = proxy;
        this.cleanupTimeout = stepTimeout;
        this.ownedContexts = new Set();
        this.creationTasks = new Set();
        const create = this.manager._createBrowserContext.bind(this.manager);
        this.manager._createBrowserContext = (...args) => {
            const task = (async () => {
                const context = await create(...args);
                this.ownedContexts.add(context);
                if (this.closed) {
                    await context.close();
                    throw new Error("Validation already closed");
                }
                onContext?.(context);
                context.on("page", onPage);
                return context;
            })();
            this.creationTasks.add(task);
            task.finally(() => this.creationTasks.delete(task)).catch(() => {});
            return task;
        };
        // BrowserManager's raw HTML debug artifacts are unsuitable for a login
        // executor. Its supervisor owns masked screenshots and bounded cleanup.
        this.manager._saveDebugArtifacts = async () => onFailure?.();
        const critical = this.manager._isCriticalPageError.bind(this.manager);
        this.manager._isCriticalPageError = error =>
            ["service_permission_required", "manual_challenge", "service_initialization_failed"].includes(
                error.reason
            ) || critical(error);
        const check = this.manager._checkPageErrors.bind(this.manager);
        this.manager._checkPageErrors = async (...args) => {
            const body = await args[0].locator("body").innerText({ timeout: stepTimeout });
            const { permissionRequired } = await args[0].evaluate(studioAccessState);
            const reason = permissionRequired
                ? "service_permission_required"
                : /captcha|verify you are human/i.test(body)
                  ? "manual_challenge"
                  : null;
            if (reason) throw Object.assign(new Error(reason), { reason, retryable: false });
            const errors = await check(...args);
            if (
                errors.appletFailed ||
                errors.concurrentUpdates ||
                (errors.snapshotFailed && !args[0].playgroundTransport?.ready)
            )
                throw Object.assign(new Error("service_initialization_failed"), {
                    reason: "service_initialization_failed",
                    retryable: true,
                });
            return errors;
        };
        const status = this.manager._checkPageStatusAndErrors.bind(this.manager);
        this.manager._checkPageStatusAndErrors = async (...args) => {
            await status(...args);
            await this.manager._checkPageErrors(args[0]);
        };
    }

    async validate() {
        this.manager.setProxyResolver(async () => ({ proxy: this.proxy, source: "login_validation" }));
        let result;
        try {
            result = await this.manager._getOrStartContextInit(0);
        } catch (error) {
            if (error.phase === "playground_initialization")
                throw Object.assign(new Error("service_initialization_unverified"), {
                    reason: "service_initialization_unverified",
                    retryable: true,
                });
            throw error;
        }
        await this.manager._checkPageErrors(result.page);
        // Login commits require a live in-process transport published only
        // after this executor has verified the official Playground WAA service.
        if (this.registry.getConnectionByAuth(0, false)?.readyState !== 1)
            throw Object.assign(new Error("service_initialization_unverified"), {
                reason: "service_initialization_unverified",
                retryable: true,
            });
        return result;
    }

    async close() {
        this.closed = true;
        this.manager.isClosingIntentionally = true;
        for (const attempt of this.manager._contextInitAttempts.values()) attempt.cancel?.("validation_closed");
        // A watchdog can reject initialization while its context creation or
        // cleanup is still settling. Do not acknowledge executor cleanup early.
        await Promise.allSettled([...this.creationTasks]);
        const cleanup = await Promise.allSettled(
            [...this.ownedContexts].map(context =>
                withHardTimeout(
                    async () => {
                        if (!this.manager.browser.contexts().includes(context)) return;
                        // Playwright's close() returns early if another owner has already
                        // begun closing. Wait for the actual close event before reuse.
                        const closed = new Promise(resolve => context.once("close", resolve));
                        await context.close();
                        if (this.manager.browser.contexts().includes(context)) await closed;
                    },
                    this.cleanupTimeout,
                    { operation: "validation context cleanup" }
                )
            )
        );
        if (cleanup.some(result => result.status === "rejected")) throw new Error("Validation context cleanup failed");
        this.ownedContexts.clear();
        this.manager.contexts.clear();
        for (const connection of this.registry.connectionsByAuth.values()) connection.close();
        for (const timer of this.registry.reconnectGraceTimers.values()) clearTimeout(timer);
        this.registry.reconnectGraceTimers.clear();
        for (const { timeoutId } of this.registry.lightweightReconnectTimeouts.values()) clearTimeout(timeoutId);
        this.registry.lightweightReconnectTimeouts.clear();
        this.registry.closeAllMessageQueues();
        this.registry.connectionsByAuth.clear();
        this.registry.removeAllListeners();
        this.manager.setConnectionRegistry(null);
    }
}
module.exports = TargetSessionValidator;
