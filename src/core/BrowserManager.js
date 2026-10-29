const { egressKey, snapshotEgress } = require("../proxy/ProxyEgressIdentity");
const { accountForIndex, canUseModel, resolveTier } = require("../accounts/AccountTierPolicy");
/**
 * File: src/core/BrowserManager.js
 * Description: Browser manager for launching and controlling headless Firefox instances with authentication contexts
 *
 * Author: Ellinav, iBenzene, bbbugg, 挈挈
 */

const { BuildBenefitContext } = require("./BuildBenefitContext");
const { PlaygroundTransport } = require("./PlaygroundTransport");
const fs = require("fs");
const path = require("path");
const { firefox } = require("playwright");
const { pageErrors } = require("../auth/TargetServiceValidation");
const os = require("os");

const { parseProxyFromEnv } = require("../utils/ProxyUtils");
const StickyProxyManager = require("../utils/StickyProxyManager");
const {
    AuthExpiredError,
    isAuthExpiredError,
    ContextAbortedError,
    isContextAbortedError,
} = require("../utils/CustomErrors");
const { OperationTimeoutError, withHardTimeout } = require("../utils/TimeoutUtils");

const WS_INIT_TIMEOUT_MS = 120000;
const CONSENT_RETRY_INTERVAL_MS = 2500;
const CONSENT_TIMEOUT_GRACE_MS = 7500;
const CONTEXT_CREATION_TIMEOUT_MS = 120000;
const FIREFOX_DOH_DISABLED_PREFS = {
    "network.trr.mode": 5,
    "network.trr.uri": "",
};

/**
 * Browser Manager Module
 * Responsible for launching, managing, and switching browser contexts
 */
class BrowserManager {
    constructor(logger, config, authSource) {
        this.logger = logger;
        this.config = config;
        this.authSource = authSource;
        this.stickyProxyManager = new StickyProxyManager(logger, authSource);
        this.stickyProxyManager.isEnabled();
        this.browser = null;
        this.browserGeneration = 0;
        this.browserState = "STOPPED";
        this._lifecycleTail = Promise.resolve();
        this.poolMetrics = { capacity_skips: 0, demand_batches: 0, scans: 0 };

        // Multi-context architecture: Store all initialized contexts
        // Map: authIndex -> {context, page, healthMonitorInterval}
        this.contexts = new Map();

        // Context pool state tracking
        this.initializingContexts = new Set(); // Indices currently being initialized in background
        this.abortedContexts = new Set(); // Indices that should be aborted during background init
        this._backgroundPreloadTask = null; // Current background preload task promise (only one at a time)
        this._backgroundPreloadAbort = false; // Flag to signal background task to abort

        // Legacy single context references (for backward compatibility)
        this.context = null;
        this.page = null;

        // currentAuthIndex is the single source of truth for current account, accessed via getter/setter
        // -1 means no account is currently active (invalid/error state)
        this._currentAuthIndex = -1;

        // Flag to distinguish intentional close from unexpected disconnect
        // Used by ConnectionRegistry callback to skip unnecessary reconnect attempts
        this.isClosingIntentionally = false;

        // ConnectionRegistry reference (set after construction to avoid circular dependency)
        this.connectionRegistry = null;
        this._onAuthQueuesDrained = null;
        this._isSystemBusyProvider = null;
        this.pendingContextClosures = new Map();
        this.contextDemand = new Map();
        this.contextUnavailable = new Map();
        this.closingContexts = new Set();
        this._contextInitTasks = new Map();
        this.contextCapacityReservations = new Map();
        this._contextPoolReplacements = new Map();
        this._contextCapacityClosures = new Map();
        this._contextClosureTasks = new Map();
        this._contextInitAttempts = new Map();
        this._contextInitSequence = 0;
        this._contextPoolRunning = false;
        this._ensureBrowserTask = null;
        // Firefox can hang when multiple BrowserContext creation commands are
        // issued at the same time. Serialize only that short protocol step;
        // page navigation and WebSocket initialization remain parallel.
        this._contextCreationQueue = Promise.resolve();
        this._proxyResolver = null;
        this.contextCreationTimeoutMs = config.scheduler?.contextCreationTimeoutMs || CONTEXT_CREATION_TIMEOUT_MS;
        this.contextOperationTimeoutMs = config.scheduler?.contextOperationTimeoutMs || 10000;
        this.contextInitTotalTimeoutMs = config.scheduler?.contextInitTotalTimeoutMs || 180000;
        this.contextCleanupTimeoutMs = config.scheduler?.contextCleanupTimeoutMs || 5000;
        this.browserRpcFailureWindowMs = config.scheduler?.browserRpcFailureWindowMs || 60000;
        this.browserRpcFailureThreshold = config.scheduler?.browserRpcFailureThreshold || 2;
        this._browserRpcFailures = [];
        this._browserRecoveryTask = null;
        this._contextCleanupTimeoutCount = 0;

        // Background wakeup service status (instance-level, tracks this.page)
        // Prevents multiple BackgroundWakeup instances from running simultaneously
        this.backgroundWakeupRunning = false;

        // Added for background wakeup logic from new core
        this.noButtonCount = 0;

        // WebSocket initialization state per context - prevents cross-contamination
        // between concurrent init/reconnect operations on different accounts
        // Map: authIndex -> { success: boolean, failed: boolean }
        this._wsInitState = new Map();

        // Target URL for AI Studio app
        this.targetUrl = "https://aistudio.google.com/prompts/new_chat?temporary=true";

        // Firefox/Camoufox does not use Chromium-style command line args.
        // We keep this empty; Camoufox has its own anti-fingerprinting optimizations built-in.
        this.launchArgs = [];

        // Firefox-specific preferences for optimization (passed to firefox.launch)
        this.firefoxUserPrefs = {
            "app.update.enabled": false, // Disable auto updates
            "browser.cache.disk.enable": false, // Disable disk cache
            "browser.ping-centre.telemetry": false, // Disable ping telemetry
            "browser.safebrowsing.enabled": false, // Disable safe browsing
            "browser.safebrowsing.malware.enabled": false, // Disable malware check
            "browser.safebrowsing.phishing.enabled": false, // Disable phishing check
            "browser.search.update": false, // Disable search engine auto-update
            "browser.shell.checkDefaultBrowser": false, // Skip default browser check
            "browser.tabs.warnOnClose": false, // No warning on closing tabs
            "datareporting.policy.dataSubmissionEnabled": false, // Disable data reporting
            "dom.min_background_timeout_value": 1, // Disable background tab timer throttling (default: 1000ms)
            "dom.min_timeout_value": 1, // Reduce global minimum timer interval (default: 4ms per HTML5 spec)
            "dom.min_tracking_background_timeout_value": 1, // Disable tracking script background throttling (default: 10000ms)
            "dom.timeout.background_budget_regeneration_rate": 200, // Increase budget regeneration rate to prevent budget exhaustion
            "dom.timeout.background_throttling_max_budget": 100, // Increase max timer budget to reduce throttling frequency
            "dom.timeout.budget_throttling_max_delay": 0, // Disable budget-based forced delay (default: 11250ms)
            "dom.timeout.throttling_delay": 2147483647, // Prevent throttling from ever activating (default: 50ms)
            "dom.webnotifications.enabled": false, // Disable notifications
            "extensions.update.enabled": false, // Disable extension auto-update
            "general.smoothScroll": false, // Disable smooth scrolling
            "gfx.webrender.all": false, // Disable WebRender (GPU-based renderer)
            "layers.acceleration.disabled": true, // Disable GPU hardware acceleration
            "media.autoplay.default": 5, // 5 = Block all autoplay
            "media.volume_scale": "0.0", // Mute audio
            "network.dns.disablePrefetch": true, // Disable DNS prefetching
            "network.http.speculative-parallel-limit": 0, // Disable speculative connections
            "network.prefetch-next": false, // Disable link prefetching
            ...FIREFOX_DOH_DISABLED_PREFS, // Disable DoH/TRR to respect system DNS/hosts
            "permissions.default.geo": 0, // 0 = Always deny geolocation
            "services.sync.enabled": false, // Disable Firefox Sync
            "toolkit.cosmeticAnimations.enabled": false, // Disable UI animations
            "toolkit.telemetry.archive.enabled": false, // Disable telemetry archive
            "toolkit.telemetry.enabled": false, // Disable telemetry
            "toolkit.telemetry.unified": false, // Disable unified telemetry
        };
    }

    get currentAuthIndex() {
        return this._currentAuthIndex;
    }

    set currentAuthIndex(value) {
        this._currentAuthIndex = value;
    }

    _getBrowserExecutablePath() {
        if (this.config.browserExecutablePath) {
            return this.config.browserExecutablePath;
        }

        const platform = os.platform();
        if (platform === "linux") {
            return path.join(process.cwd(), "camoufox-linux", "camoufox");
        }
        if (platform === "win32") {
            return path.join(process.cwd(), "camoufox", "camoufox.exe");
        }
        if (platform === "darwin") {
            return path.join(process.cwd(), "camoufox-macos", "Camoufox.app", "Contents", "MacOS", "camoufox");
        }

        throw new Error(`Unsupported operating system: ${platform}`);
    }

    /**
     * Set the ConnectionRegistry reference (called after construction to avoid circular dependency)
     * @param {ConnectionRegistry} connectionRegistry - The ConnectionRegistry instance
     */
    setConnectionRegistry(connectionRegistry) {
        if (this.connectionRegistry && this._onAuthQueuesDrained) {
            this.connectionRegistry.off("authQueuesDrained", this._onAuthQueuesDrained);
        }
        this.connectionRegistry = connectionRegistry;
        if (this.connectionRegistry) {
            this._onAuthQueuesDrained = authIndex => {
                this.scheduler?.coordinateContextPool?.();
                this._closePendingContextIfIdle(authIndex).catch(error => {
                    this.logger.error(
                        `[ContextPool] Failed to close pending context #${authIndex} after queue drain: ${error.message}`
                    );
                });
            };
            this.connectionRegistry.on("authQueuesDrained", this._onAuthQueuesDrained);
        }
    }

    setSystemBusyProvider(provider) {
        this._isSystemBusyProvider = typeof provider === "function" ? provider : null;
    }

    setProxyResolver(resolver) {
        this._proxyResolver = typeof resolver === "function" ? resolver : null;
    }

    isAccountContextIdle(authIndex) {
        return this._isContextIdle(authIndex);
    }

    async rebuildAccountContext(authIndex) {
        await this.closeContext(authIndex, { keepBrowser: true });
        this.contextUnavailable.delete(authIndex);
        if (this.scheduler) await this.ensureWorkerContext(authIndex);
        else await this.launchOrSwitchContext(authIndex);
    }

    _isSystemBusy() {
        try {
            return this._isSystemBusyProvider?.() === true;
        } catch (error) {
            this.logger.warn(`[ContextPool] Failed to read system busy state: ${error.message}`);
            return false;
        }
    }

    _setInitPhase(attempt, phase) {
        if (!attempt) return;
        attempt.phase = phase;
        attempt.phaseStartedAt = Date.now();
        attempt.operation = null;
        attempt.operationStartedAt = null;
    }

    _isCurrentInitAttempt(attempt) {
        if (attempt?.browserGeneration !== undefined && attempt.browserGeneration !== this.browserGeneration)
            return false;
        const service = this.authSource?.accountLoginService;
        if (service?.state && attempt?.sessionVersion !== undefined) {
            const account = service.state.accounts.find(item => item.authIndex === attempt.authIndex);
            if (
                !account ||
                service.invalidated.has(attempt.authIndex) ||
                account.sessionVersion !== attempt.sessionVersion
            )
                return false;
        }
        if (!this._contextInitAttempts) return Boolean(attempt && !attempt.aborted);
        return Boolean(attempt && this._contextInitAttempts?.get(attempt.authIndex) === attempt && !attempt.aborted);
    }

    _assertCurrentInitAttempt(attempt) {
        if (this._isCurrentInitAttempt(attempt)) return;
        throw new ContextAbortedError(attempt?.authIndex ?? -1, attempt?.abortReason || "superseded init attempt");
    }

    async _runInitOperation(attempt, operation, task, timeoutMs = this.contextOperationTimeoutMs) {
        if (!attempt) return withHardTimeout(task, timeoutMs || 10000, { operation, reason: "page_operation_timeout" });
        timeoutMs = timeoutMs || 10000;
        this._assertCurrentInitAttempt(attempt);
        attempt.operation = operation;
        attempt.operationStartedAt = Date.now();
        try {
            const result = await withHardTimeout(task, timeoutMs, {
                attemptId: attempt.id,
                authIndex: attempt.authIndex,
                code: "PLAYWRIGHT_RPC_TIMEOUT",
                operation,
                phase: attempt.phase,
                reason: "playwright_rpc_timeout",
            });
            this._assertCurrentInitAttempt(attempt);
            return result;
        } catch (error) {
            if (error?.code === "PLAYWRIGHT_RPC_TIMEOUT") {
                const now = Date.now();
                this.logger.error(
                    `[Context#${attempt.authIndex}] context_init_timeout attempt=${attempt.id} reason=${error.reason} phase=${error.phase || attempt.phase || "unknown"} operation=${operation} elapsed_ms=${now - attempt.startedAt} phase_elapsed_ms=${attempt.phaseStartedAt ? now - attempt.phaseStartedAt : 0} operation_elapsed_ms=${attempt.operationStartedAt ? now - attempt.operationStartedAt : 0} page_url=${this._safePageUrl(attempt.page)} proxy_source=${attempt.proxyInfo?.source || "unknown"} applied_node_id=${attempt.proxyInfo?.appliedNodeId || "none"} ws_console_success=${attempt.ws?.success || false}`
                );
                this._recordBrowserRpcTimeout(attempt, error);
            }
            throw error;
        } finally {
            attempt.operation = null;
            attempt.operationStartedAt = null;
        }
    }

    _recordBrowserRpcTimeout(attempt, error) {
        if (attempt.browserGeneration !== undefined && attempt.browserGeneration !== this.browserGeneration) return;
        // Mouse is mandatory, but a failed page action is not proof of browser failure.
        if (error.operation?.startsWith("mouse.") || error.operation === "context.storageState") return;
        const now = Date.now();
        this._browserRpcFailures = (this._browserRpcFailures || []).filter(
            item => now - item.at <= (this.browserRpcFailureWindowMs || 60000)
        );
        this._browserRpcFailures.push({ at: now, authIndex: attempt.authIndex });
        if (new Set(this._browserRpcFailures.map(item => item.authIndex)).size < (this.browserRpcFailureThreshold || 2))
            return;
        this._confirmBrowserFault("playwright_rpc_timeout");
    }

    _confirmBrowserFault(reason) {
        if (this._browserProbeTask || this._recovering || !this.browser) return;
        const browser = this.browser;
        const pages = [...this.contexts.values(), ...(this._contextInitAttempts?.values() || [])]
            .map(data => data.page)
            .filter(page => page && !page.isClosed());
        if (!pages.length) return;
        this._browserProbeTask = Promise.all(
            pages.slice(0, 3).map(page =>
                withHardTimeout(() => page.evaluate(() => true), this.contextCleanupTimeoutMs || 5000).then(
                    () => true,
                    () => false
                )
            )
        )
            .then(results => {
                if (this.browser === browser && !results.some(Boolean)) this._triggerBrowserRecovery(reason);
            })
            .finally(() => {
                this._browserProbeTask = null;
            });
    }

    _requestApplicationRecovery(reason) {
        this.browserState = "FAILED";
        this._recovering = true;
        this.scheduler?.beginRecovery?.(reason);
        this.logger.error(
            `[Browser] application_recovery_requested reason=${reason} generation=${this.browserGeneration}`
        );
        process.send?.({ reason, type: "runtime-recovery" });
    }

    _triggerBrowserRecovery(reason) {
        if (this._browserRecoveryTask) return this._browserRecoveryTask;
        if (this.scheduler?.closed) return;
        const policy = this.config?.scheduler || this.scheduler?.config || {};
        if (this._recoveryStableAt && Date.now() - this._recoveryStableAt >= (policy.browserRecoveryStableMs || 300000))
            this._recoveryAttempts = 0;
        this._recoveryStableAt = null;
        this._recoveryAttempts = (this._recoveryAttempts || 0) + 1;
        this._recovering = true;
        for (const data of this.contexts.values()) {
            data.state = "RECONNECTING";
            data.lastDisconnectReason = "browser_recovery";
        }
        this.browserState = "RECOVERING";
        this.scheduler?.beginRecovery?.(reason);
        if (this._recoveryAttempts > (policy.browserRecoveryMaxAttempts || 3)) {
            this._requestApplicationRecovery("browser_recovery_budget_exhausted");
            return;
        }
        this.logger.error(
            `[Browser] browser_recovery_started reason=${reason} generation=${this.browserGeneration} attempt=${this._recoveryAttempts}`
        );
        this._browserRecoveryTask = (async () => {
            await this.closeBrowser();
            if (this.scheduler?.closed) return;
            const delay = Math.min(
                60000,
                (policy.browserRecoveryBackoffMs || 5000) * 2 ** (this._recoveryAttempts - 1)
            );
            await new Promise(resolve => {
                this._recoveryTimer = setTimeout(resolve, delay + Math.floor(Math.random() * delay * 0.2));
            });
            if (this.scheduler?.closed) return;
            await this._ensureBrowser({ recovery: true });
            if (this.scheduler) {
                const index =
                    this._poolCandidates()[0] ??
                    this.authSource
                        .getRotationIndices()
                        .find(authIndex => this.scheduler.isAccountPoolResident?.(authIndex) !== false);
                if (index !== undefined) this.contextUnavailable.delete(index);
                if (index === undefined) throw new Error("No context available for recovery readiness");
                this._recoveryAuthIndex = index;
                try {
                    await this._startPooledContext(index);
                } finally {
                    this._recoveryAuthIndex = undefined;
                }
                if (!this.isContextReady(index)) throw new Error("Recovery context did not become ready");
            } else {
                const index = this.authSource.getRotationIndices()[0];
                this._recoveryAuthIndex = index;
                try {
                    await this._getOrStartContextInit(index);
                } finally {
                    this._recoveryAuthIndex = undefined;
                }
            }
            this._recovering = false;
            this.browserState = "RUNNING";
            this._recoveryStableAt = Date.now();
            if (this.scheduler) this.scheduler.recovering = false;
            this.logger.info(
                `[Browser] browser_recovery_service_ready reason=${reason} generation=${this.browserGeneration}`
            );
            this.scheduler?.drain?.();
        })()
            .catch(error => {
                this.logger.error(
                    `[Browser] browser_recovery_failed reason=${reason} error=${JSON.stringify(error.message)}`
                );
                this._requestApplicationRecovery("browser_recovery_failed");
            })
            .finally(() => {
                this._browserRpcFailures = [];
                this._contextCleanupTimeoutCount = 0;
                this._browserRecoveryTask = null;
                if (!this._recovering) this._pumpContextPool();
            });
        return this._browserRecoveryTask;
    }

    _contextInitTimeoutError(attempt) {
        const now = Date.now();
        const timeoutMs = this.contextInitTotalTimeoutMs || 180000;
        return new OperationTimeoutError(
            `Context initialization #${attempt.authIndex} timed out after ${timeoutMs}ms`,
            {
                attemptId: attempt.id,
                authIndex: attempt.authIndex,
                code: "CONTEXT_INIT_TOTAL_TIMEOUT",
                elapsedMs: now - attempt.startedAt,
                operation: attempt.operation,
                phase: attempt.phase,
                reason: "context_init_total_timeout",
                timeoutMs,
            }
        );
    }

    _safePageUrl(page) {
        try {
            return page?.url?.() || "unknown";
        } catch (_error) {
            return "unknown";
        }
    }

    _considerCleanupRecovery() {
        const healthy = [...(this.contexts?.keys() || [])].some(index => this.isContextReady(index));
        const capacity = this.scheduler?.config?.maxWorkers || this.config?.maxContexts || 1;
        if (!healthy && (this._contextCapacityClosures?.size || 0) >= capacity)
            this._triggerBrowserRecovery("context_cleanup_timeout");
        else this._confirmBrowserFault("context_cleanup_timeout");
    }

    _closeTrackedContext(owner, authIndex) {
        this._contextClosureTasks ??= new Map();
        const existing = this._contextClosureTasks.get(owner);
        if (existing) return existing.task;
        const browser = this.browser;
        const generation = this.browserGeneration;
        const task = Promise.resolve().then(() => owner.context.close());
        // A late initialization cleanup must not claim capacity in a new browser.
        if (owner.browserGeneration !== undefined && owner.browserGeneration !== generation) return task;
        this._contextCapacityClosures ??= new Map();
        this._contextCapacityClosures.set(owner, authIndex);
        // Allow one cleanup timeout plus one grace interval for late success.
        // Keep physical capacity reserved until success or a browser reset. A
        // responsive sibling page cannot settle this context's failed close.
        const timer = setTimeout(
            () => {
                if (
                    this.browser !== browser ||
                    this.browserGeneration !== generation ||
                    !this._contextCapacityClosures.has(owner)
                )
                    return;
                this.logger.error(
                    `[Context#${authIndex}] context_cleanup_stalled generation=${generation} browser_recovery_required=true`
                );
                this._triggerBrowserRecovery("context_cleanup_stalled");
            },
            2 * (this.contextCleanupTimeoutMs || 5000)
        );
        timer.unref?.();
        const entry = { task, timer };
        this._contextClosureTasks.set(owner, entry);
        task.then(
            () => {
                clearTimeout(timer);
                if (this._contextClosureTasks.get(owner) !== entry) return;
                this._contextClosureTasks.delete(owner);
                if (this.browser !== browser || this.browserGeneration !== generation) return;
                if (!this._contextCapacityClosures.delete(owner)) return;
                this.scheduler?.coordinateContextPool?.();
                this._pumpContextPool();
            },
            () => {
                // Rejection is not proof of physical closure. The watchdog
                // resolves the reservation through the existing recovery path.
            }
        ).catch(error => this.logger.warn(`[Browser] Context cleanup callback failed: ${error.message}`));
        return task;
    }

    async _closeAttemptContext(attempt) {
        attempt?.page?.makerSuiteBridge?.dispose();
        attempt?.page?.buildBenefit?.dispose();
        if (!attempt?.context) return { closed: false, skipped: true };
        if (attempt.cleanupTask) return attempt.cleanupTask;
        const startedAt = Date.now();
        const cleanupTimeoutMs = this.contextCleanupTimeoutMs || 5000;
        attempt.cleanupTask = (async () => {
            const closeTask = this._closeTrackedContext(attempt, attempt.authIndex).then(
                () => ({ closed: true }),
                error => ({ closed: false, error })
            );
            let cleanupTimer;
            const result = await Promise.race([
                closeTask,
                new Promise(resolve => {
                    cleanupTimer = setTimeout(() => resolve({ closed: false, timedOut: true }), cleanupTimeoutMs);
                }),
            ]).finally(() => clearTimeout(cleanupTimer));
            if (attempt.browserGeneration !== undefined && attempt.browserGeneration !== this.browserGeneration)
                return result;
            if (result.timedOut) {
                this._contextCleanupTimeoutCount = (this._contextCleanupTimeoutCount || 0) + 1;
                this.logger.error(
                    `[Context#${attempt.authIndex}] context_cleanup_timeout attempt=${attempt.id} timeout_ms=${cleanupTimeoutMs} browser_suspect=true`
                );
                if (this._contextCleanupTimeoutCount >= 2) this._considerCleanupRecovery();
            } else if (result.error) {
                this._considerCleanupRecovery();
                this.logger.warn(
                    `[Context#${attempt.authIndex}] context_init_cleanup attempt=${attempt.id} context_closed=false duration_ms=${Date.now() - startedAt} error=${JSON.stringify(result.error.message)}`
                );
            } else {
                this._contextCleanupTimeoutCount = 0;
                this.logger.info(
                    `[Context#${attempt.authIndex}] context_init_cleanup attempt=${attempt.id} context_closed=true duration_ms=${Date.now() - startedAt}`
                );
            }
            return result;
        })();
        return attempt.cleanupTask;
    }

    async _handleContextInitWatchdog(attempt) {
        if (!this._isCurrentInitAttempt(attempt)) return;
        const now = Date.now();
        const operation = attempt.operation;
        const operationStartedAt = attempt.operationStartedAt;
        attempt.aborted = true;
        attempt.abortReason = "context_init_total_timeout";
        const published = this.contexts.get(attempt.authIndex);
        if (published?.attemptId === attempt.id) this.contexts.delete(attempt.authIndex);
        const currentEpoch = this.connectionRegistry?.getConnectionEpoch?.(attempt.authIndex) ?? null;
        this.logger.error(
            `[Context#${attempt.authIndex}] context_init_timeout attempt=${attempt.id} reason=context_init_total_timeout phase=${attempt.phase || "unknown"} operation=${operation || "none"} elapsed_ms=${now - attempt.startedAt} phase_elapsed_ms=${attempt.phaseStartedAt ? now - attempt.phaseStartedAt : 0} operation_elapsed_ms=${operationStartedAt ? now - operationStartedAt : 0} page_url=${this._safePageUrl(attempt.page)} proxy_source=${attempt.proxyInfo?.source || "unknown"} applied_node_id=${attempt.proxyInfo?.appliedNodeId || "none"} ws_console_success=${attempt.ws.success} connection_epoch_before=${attempt.connectionEpoch ?? "none"} connection_epoch_current=${currentEpoch ?? "none"} browser_connected=${Boolean(this.browser?.isConnected?.() ?? this.browser)}`
        );
        await this._closeAttemptContext(attempt);
    }

    getContextInitHealth() {
        const now = Date.now();
        const attempts = [...(this._contextInitAttempts?.values() || [])];
        const staleAfter = (this.contextInitTotalTimeoutMs || 180000) + 10000;
        const ages = attempts.map(attempt => now - attempt.startedAt);
        return {
            browserState: this.browserState || "STOPPED",
            cleanupPending: this._contextCapacityClosures?.size || 0,
            generation: this.browserGeneration || 0,
            initializing: attempts.length,
            metrics: this.poolMetrics || {},
            oldestInitializingMs: ages.length ? Math.max(...ages) : 0,
            ready: [...this.contexts.keys()].filter(index => this.isContextReady(index)).length,
            recovering: Boolean(this._recovering),
            recoveryAttempts: this._recoveryAttempts || 0,
            staleInitializing: ages.filter(age => age > staleAfter).length,
        };
    }

    /**
     * Helper: Check for page errors that require refresh
     * @returns {Object} Object with error flags
     */
    async _checkPageErrors(page, attempt = null) {
        try {
            return await this._runInitOperation(attempt, "page_errors.evaluate", () => page.evaluate(pageErrors));
        } catch (e) {
            if (e?.code === "PLAYWRIGHT_RPC_TIMEOUT") throw e;
            return { appletFailed: false, concurrentUpdates: false, snapshotFailed: false };
        }
    }

    _isCriticalPageError(error) {
        const msg = error?.message || "";
        return (
            msg.includes("Execution context was destroyed") ||
            msg.includes("Target page, context or browser has been closed") ||
            msg.includes("Protocol error") ||
            msg.includes("Navigation failed because page was closed")
        );
    }

    _throwIfContextInitAborted(authIndex, isBackgroundTask = false, logPrefix = null, action = "Context init") {
        if (this.abortedContexts.has(authIndex)) {
            if (logPrefix) {
                this.logger.info(`${logPrefix} ${action} aborted (context marked for deletion)`);
            }
            throw new ContextAbortedError(authIndex, "marked for deletion");
        }

        if (isBackgroundTask && this._backgroundPreloadAbort) {
            if (logPrefix) {
                this.logger.info(`${logPrefix} ${action} aborted (background preload aborted)`);
            }
            throw new ContextAbortedError(authIndex, "background preload aborted");
        }
    }

    async _findAndClickButtonByText(
        page,
        text,
        logPrefix = "[Browser]",
        debugName = "button",
        click = true,
        attempt = null
    ) {
        try {
            if (typeof page.getByRole === "function") {
                const locator = page.getByRole("button", { exact: true, name: text }).first();
                const key = text.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
                const count = await this._runInitOperation(attempt, `${key}.locator.count`, () => locator.count());
                const found =
                    count > 0 &&
                    (await this._runInitOperation(attempt, `${key}.locator.isVisible`, () => locator.isVisible()));
                if (!found) return { clicked: false, found: false };
                if (
                    click &&
                    (await this._runInitOperation(attempt, `${key}.locator.isEnabled`, () => locator.isEnabled()))
                ) {
                    await this._runInitOperation(attempt, `${key}.locator.click`, () =>
                        locator.click({ timeout: 2000 })
                    );
                    return { clicked: true, found: true };
                }
                return { clicked: false, found: true };
            }

            // Compatibility fallback for tests and older Playwright page adapters.
            return await this._runInitOperation(attempt, `${text}.fallback.evaluate`, () =>
                page.evaluate(
                    ({ click, text }) => {
                        // eslint-disable-next-line no-undef
                        const buttons = document.querySelectorAll("button, [role='button']");
                        for (const btn of buttons) {
                            const rect = btn.getBoundingClientRect();
                            const isVisible = rect.width > 0 && rect.height > 0;
                            const btnText = (btn.innerText || btn.textContent || "").trim();
                            if (isVisible && btnText === text) {
                                if (click) btn.click();
                                return { clicked: click, found: true };
                            }
                        }
                        return { clicked: false, found: false };
                    },
                    { click, text }
                )
            );
        } catch (error) {
            // Element not visible or doesn't exist is expected here,
            // but propagate clearly critical browser/page issues.
            if (error && error.message) {
                const msg = error.message;
                if (this._isCriticalPageError(error) || error.code === "PLAYWRIGHT_RPC_TIMEOUT") {
                    throw error;
                }
                if (this.logger && typeof this.logger.debug === "function") {
                    this.logger.debug(`${logPrefix} Ignored error while checking ${debugName}: ${msg}`);
                }
            }
        }

        return { clicked: false, found: false };
    }

    async _clickButtonByTextIfVisible(page, text, logPrefix = "[Browser]", debugName = "button", attempt = null) {
        const result = await this._findAndClickButtonByText(page, text, logPrefix, debugName, true, attempt);
        return result.clicked;
    }

    _hasNewOpenConnection(attempt) {
        if (!attempt || !this.connectionRegistry) return false;
        const connection = this.connectionRegistry.getConnectionByAuth(attempt.authIndex, false);
        const epoch = this.connectionRegistry.getConnectionEpoch?.(attempt.authIndex) ?? null;
        return (
            connection?.readyState === 1 &&
            epoch != null &&
            (attempt.connectionEpoch == null || epoch > attempt.connectionEpoch)
        );
    }

    async _clickLaunchButtonIfVisible(page, logPrefix = "[Browser]", attempt = null) {
        try {
            this.logger.debug(`${logPrefix} 🔍 Checking for Launch button...`);

            const clicked = await this._runInitOperation(attempt, "launch_button.evaluate", () =>
                page.evaluate(() => {
                    const isVisible = element => {
                        const rect = element.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    };
                    const getText = element => (element.innerText || element.textContent || "").trim();
                    const hasLaunchText = element => getText(element).includes("Launch");
                    const clickTarget = element => {
                        const target = element.closest("button, [role='button']") || element;
                        target.click();
                        return true;
                    };

                    // eslint-disable-next-line no-undef
                    const controls = Array.from(document.querySelectorAll("button, div[role='button']"));
                    for (const control of controls) {
                        if (!isVisible(control)) continue;

                        const ariaLabel = control.getAttribute("aria-label") || "";
                        if (hasLaunchText(control) || ariaLabel.includes("Launch")) {
                            return clickTarget(control);
                        }
                    }

                    // eslint-disable-next-line no-undef
                    const spans = Array.from(document.querySelectorAll("button span, [role='button'] span"));
                    for (const span of spans) {
                        if (!isVisible(span)) continue;
                        if (hasLaunchText(span)) {
                            return clickTarget(span);
                        }
                    }

                    return false;
                })
            );

            if (clicked) {
                this.logger.info(`${logPrefix} Launch button clicked successfully`);
                return true;
            }
        } catch (error) {
            if (this._isCriticalPageError(error) || error.code === "PLAYWRIGHT_RPC_TIMEOUT") {
                throw error;
            }
            this.logger.warn(`${logPrefix} ⚠️ Error while checking for Launch button: ${error.message}`);
        }

        return false;
    }

    /**
     * Helper: Wait for WebSocket initialization with log monitoring
     * Supports abort for background tasks and context deletion
     * @param {object} page - Playwright page object
     * @param {string} logPrefix - Log prefix for messages
     * @param {number} timeout - Timeout in milliseconds (default 120000)
     * @param {object} attempt - Initialization attempt whose state is being observed
     * @param {boolean} isBackgroundTask - Whether this is a background preload task (default false)
     * @returns {Promise<boolean>} true if initialization succeeded, false if failed or aborted
     */
    async _waitForWebSocketInit(
        page,
        logPrefix = "[Browser]",
        timeout = WS_INIT_TIMEOUT_MS,
        attempt = null,
        isBackgroundTask = false
    ) {
        this.logger.info(
            `${logPrefix} ⏳ Waiting for Continue/Launch button or WebSocket initialization (timeout: ${timeout / 1000}s)...`
        );

        const startTime = Date.now();
        const checkInterval = 1000; // Check every 1 second
        const consentRetryIntervalMs = this.consentRetryIntervalMs ?? CONSENT_RETRY_INTERVAL_MS;
        const consentTimeoutGraceMs = this.consentTimeoutGraceMs ?? CONSENT_TIMEOUT_GRACE_MS;
        const authIndex = attempt?.authIndex ?? -1;
        const wsState = attempt?.ws || { failed: false, success: false };
        let consentFound = false;
        let consentClosed = false;
        let lastConsentClickAt = 0;
        let skipClicked = false;
        let graceDeadline = null;
        let iteration = 0;

        try {
            while (Date.now() - startTime < timeout || (graceDeadline !== null && Date.now() < graceDeadline)) {
                this._throwIfContextInitAborted(authIndex, isBackgroundTask, logPrefix, "WebSocket wait");

                if (wsState.success) {
                    this.logger.info(`${logPrefix} ws_connected attempt=${attempt?.id || "reconnect"} source=console`);
                    return true;
                }

                if (this._hasNewOpenConnection(attempt)) {
                    wsState.success = true;
                    this.logger.info(`${logPrefix} ws_connected attempt=${attempt.id} source=registry`);
                    return true;
                }

                if (wsState.failed) {
                    this.logger.warn(`${logPrefix} Initialization failed`);
                    attempt.failureReason = "ws_connection_timeout";
                    return false;
                }

                const now = Date.now();
                const continueText = "Continue to the app";
                const shouldClickConsent = now - lastConsentClickAt >= consentRetryIntervalMs;
                const consent = await this._findAndClickButtonByText(
                    page,
                    continueText,
                    logPrefix,
                    `popup "${continueText}"`,
                    shouldClickConsent,
                    attempt
                );
                if (consent.found) {
                    if (!consentFound) this.logger.info(`${logPrefix} button_found name="${continueText}"`);
                    consentFound = true;
                    if (consent.clicked) {
                        lastConsentClickAt = now;
                        this.logger.info(`${logPrefix} click_dispatched name="${continueText}"`);
                    }
                } else if (consentFound && !consentClosed) {
                    consentClosed = true;
                    this.logger.info(`${logPrefix} dialog_closed name="${continueText}"`);
                }

                if (!skipClicked) {
                    const skipText = "Skip";
                    skipClicked = await this._clickButtonByTextIfVisible(
                        page,
                        skipText,
                        logPrefix,
                        `popup "${skipText}"`,
                        attempt
                    );
                    if (skipClicked) {
                        this.logger.info(`${logPrefix} click_dispatched name="${skipText}"`);
                    }
                }

                if (iteration % 5 === 0) {
                    await this._clickLaunchButtonIfVisible(page, logPrefix, attempt);
                }

                // Check for page errors
                const errors = await this._checkPageErrors(page, attempt);
                if (errors.appletFailed || errors.concurrentUpdates || errors.snapshotFailed) {
                    this.logger.warn(`${logPrefix} Detected page error: ${JSON.stringify(errors)}`);
                    return false;
                }
                // Random mouse movement while waiting (80% chance per iteration)
                if (Math.random() < 0.3) {
                    try {
                        const vp = page.viewportSize() || { height: 1080, width: 1920 };
                        const randomX = Math.floor(Math.random() * (vp.width * 0.7));
                        const randomY = Math.floor(Math.random() * (vp.height * 0.7));
                        await this._simulateHumanMovement(page, randomX, randomY, attempt);
                    } catch (e) {
                        if (e?.code === "PLAYWRIGHT_RPC_TIMEOUT") throw e;
                        // Ignore movement errors
                    }
                }
                // Wait before next check
                iteration++;
                await this._runInitOperation(attempt, "ws_wait.waitForTimeout", () =>
                    page.waitForTimeout(checkInterval)
                );

                // A consent control first observed/clicked at the boundary gets one bounded grace period.
                if (
                    graceDeadline === null &&
                    Date.now() - startTime >= timeout &&
                    consent.found &&
                    now >= startTime + timeout - checkInterval
                ) {
                    graceDeadline = Date.now() + consentTimeoutGraceMs;
                    this.logger.info(`${logPrefix} consent_grace_started duration_ms=${consentTimeoutGraceMs}`);
                }
            }

            // Event-loop stalls can cross the boundary; perform authoritative final checks before cleanup.
            if (wsState.success || this._hasNewOpenConnection(attempt)) {
                wsState.success = true;
                this.logger.info(`${logPrefix} ws_connected attempt=${attempt?.id || "reconnect"} source=final_check`);
                return true;
            }
            const finalConsent = await this._findAndClickButtonByText(
                page,
                "Continue to the app",
                logPrefix,
                'popup "Continue to the app"',
                true,
                attempt
            );
            if (finalConsent.found && graceDeadline === null) {
                this.logger.info(`${logPrefix} button_found name="Continue to the app" boundary=true`);
                if (finalConsent.clicked) {
                    this.logger.info(`${logPrefix} click_dispatched name="Continue to the app" boundary=true`);
                }
                const boundaryGraceDeadline = Date.now() + consentTimeoutGraceMs;
                this.logger.info(`${logPrefix} consent_grace_started duration_ms=${consentTimeoutGraceMs}`);
                while (Date.now() < boundaryGraceDeadline) {
                    if (wsState.success || this._hasNewOpenConnection(attempt)) {
                        wsState.success = true;
                        this.logger.info(
                            `${logPrefix} ws_connected attempt=${attempt?.id || "reconnect"} source=consent_grace`
                        );
                        return true;
                    }
                    await this._runInitOperation(attempt, "consent_grace.waitForTimeout", () =>
                        page.waitForTimeout(checkInterval)
                    );
                    await this._findAndClickButtonByText(
                        page,
                        "Continue to the app",
                        logPrefix,
                        'popup "Continue to the app"',
                        true,
                        attempt
                    );
                }
            }
            attempt.failureReason =
                finalConsent.found || (consentFound && !consentClosed)
                    ? "consent_dialog_timeout"
                    : "ws_connection_timeout";
            this.logger.error(
                `${logPrefix} initialization_timeout reason=${attempt.failureReason} after ${timeout / 1000}s`
            );
            return false;
        } catch (error) {
            // Re-throw aborts and critical page/browser errors so callers keep the original failure reason.
            if (
                isContextAbortedError(error) ||
                this._isCriticalPageError(error) ||
                error?.code === "PLAYWRIGHT_RPC_TIMEOUT"
            ) {
                throw error;
            }
            // For other errors, log and return false
            this.logger.error(`${logPrefix} Error during WebSocket initialization wait: ${error.message}`);
            return false;
        }
    }

    /**
     * Feature: Update authentication file
     * Writes the current storageState back to the auth file, effectively extending session validity.
     * @param {number} authIndex - The auth index to update
     */
    async _updateAuthFile(authIndex, attempt = null) {
        // Retrieve the target account's context from the multi-context Map to avoid cross-contamination of auth data by using this.context
        const contextData = this.contexts.get(authIndex);
        if (!contextData || !contextData.context) return;

        // Check availability of auto-update feature from config
        if (!this.config.enableAuthUpdate) {
            return;
        }

        try {
            const configDir = path.join(process.cwd(), "configs", "auth");
            const authFilePath = path.join(configDir, `auth-${authIndex}.json`);

            // Read original file content to preserve all fields (e.g. accountName, custom fields)
            // Relies on AuthSource validation (checks valid index AND file existence)
            const authData = this.authSource.getAuth(authIndex);
            if (!authData) {
                this.logger.warn(
                    `[Auth Update] Auth source #${authIndex} returned no data (invalid index or file missing), skipping update.`
                );
                return;
            }

            if (contextData.authUpdateRunning) return;
            contextData.authUpdateRunning = true;
            const snapshotTask = Promise.resolve().then(() => contextData.context.storageState());
            snapshotTask
                .finally(() => {
                    contextData.authUpdateRunning = false;
                })
                .catch(() => {});
            const storageState = await withHardTimeout(() => snapshotTask, this.contextOperationTimeoutMs || 10000, {
                operation: "context.storageState",
                reason: "auth_refresh_timeout",
            });
            if (this.contexts.get(authIndex) !== contextData) return;

            if (attempt) this._assertCurrentInitAttempt(attempt);

            if (this.authSource.accountLoginService?.state) {
                await this.authSource.accountLoginService.exclusive(() => {
                    if (this.contexts.get(authIndex) !== contextData) return;
                    return this.authSource.accountLoginService.refreshSession(
                        authIndex,
                        contextData.page?.accountSessionVersion,
                        storageState
                    );
                });
                return;
            }

            // Merge new credentials into existing data
            authData.cookies = storageState.cookies;
            authData.origins = storageState.origins;

            // Note: We do NOT force-set accountName. If it was there, it stays; if not, it remains missing.
            // This preserves the "missing state" as requested.

            // Overwrite the file with merged data
            await fs.promises.writeFile(authFilePath, JSON.stringify(authData, null, 2));

            this.logger.info(`[Auth Update] 💾 Successfully updated auth credentials for account #${authIndex}`);
        } catch (error) {
            this.logger.error(`[Auth Update] ❌ Failed to update auth file: ${error.message}`);
        }
    }

    /**
     * Get pool target indices based on current account and rotation order
     * @param {number} maxContexts - Max pool size (0 = unlimited)
     * @returns {number[]} Target indices for the pool
     */
    // _getPoolTargetIndices(maxContexts) {
    //     const rotation = this.authSource.getRotationIndices();
    //     if (rotation.length === 0) return [];
    //     if (maxContexts === 0 || maxContexts >= rotation.length) return [...rotation];
    //
    //     const currentCanonical =
    //         this._currentAuthIndex >= 0 ? this.authSource.getCanonicalIndex(this._currentAuthIndex) : null;
    //     const startPos = currentCanonical !== null ? rotation.indexOf(currentCanonical) : -1;
    //     const start = startPos >= 0 ? startPos : 0;
    //
    //     const result = [];
    //     for (let i = 0; i < maxContexts && i < rotation.length; i++) {
    //         result.push(rotation[(start + i) % rotation.length]);
    //     }
    //     return result;
    // }

    /**
     * Interface: Notify user activity
     * Used to force wake up the Launch detection when a request comes in
     */
    notifyUserActivity(authIndex = this._currentAuthIndex) {
        const workerState = this.contexts.get(authIndex);
        if (workerState) workerState.noButtonCount = 0;
        if (this.noButtonCount > 0) {
            this.logger.info("[Browser] ⚡ User activity detected, forcing Launch detection wakeup...");
            this.noButtonCount = 0;
        }
    }

    /**
     * Helper: Generate a consistent numeric seed from a string
     * Used to keep fingerprints consistent for the same account index
     */
    _generateIdentitySeed(str) {
        let hashValue = 0;
        for (let i = 0; i < str.length; i++) {
            const charCode = str.charCodeAt(i);
            hashValue = (hashValue << 5) - hashValue + charCode;
            hashValue |= 0; // Convert to 32bit integer
        }
        return Math.abs(hashValue);
    }

    /**
     * Feature: Generate Privacy Protection Script (Stealth Mode)
     * Injects specific GPU info and masks webdriver properties to avoid bot detection.
     */
    _getPrivacyProtectionScript(authIndex) {
        let seedSource = `account_salt_${authIndex}`;

        // Attempt to use accountName (email) for better consistency across index reordering
        try {
            const authData = this.authSource.getAuth(authIndex);
            if (authData && authData.accountName && typeof authData.accountName === "string") {
                const cleanName = authData.accountName.trim().toLowerCase();
                if (cleanName.length > 0) {
                    seedSource = `account_email_${cleanName}`;
                }
            }
        } catch (e) {
            // Fallback to index-based seed if auth data read fails
        }

        // Use a consistent seed so the fingerprint remains static for this specific account
        let seed = this._generateIdentitySeed(seedSource);

        // Pseudo-random generator based on the seed
        const deterministicRandom = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };

        // Select a GPU profile consistent with this account
        const gpuProfiles = [
            { renderer: "Intel Iris OpenGL Engine", vendor: "Intel Inc." },
            {
                renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)",
                vendor: "Google Inc. (NVIDIA)",
            },
            {
                renderer: "ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
                vendor: "Google Inc. (AMD)",
            },
        ];
        const profile = gpuProfiles[Math.floor(deterministicRandom() * gpuProfiles.length)];

        // We inject a noise variable to make the environment unique but stable
        const randomArtifact = Math.floor(deterministicRandom() * 1000);

        return `
            (function() {
                window._browserGeneration = ${this.browserGeneration || 0};
                window._browserAttemptId = ${JSON.stringify(this._contextInitAttempts?.get(authIndex)?.id || null)};
                if (window._privacyProtectionInjected) return;
                window._privacyProtectionInjected = true;

                try {
                    // 1. Mask WebDriver property
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

                    // 2. Mock Plugins if empty
                    if (navigator.plugins.length === 0) {
                        Object.defineProperty(navigator, 'plugins', {
                            get: () => new Array(${3 + Math.floor(deterministicRandom() * 3)}),
                        });
                    }

                    // 3. Spoof WebGL Renderer (High Impact)
                    const getParameterProxy = WebGLRenderingContext.prototype.getParameter;
                    WebGLRenderingContext.prototype.getParameter = function(parameter) {
                        // 37445: UNMASKED_VENDOR_WEBGL
                        // 37446: UNMASKED_RENDERER_WEBGL
                        if (parameter === 37445) return '${profile.vendor}';
                        if (parameter === 37446) return '${profile.renderer}';
                        return getParameterProxy.apply(this, arguments);
                    };

                    // 4. Inject benign noise
                    window['_canvas_noise_${randomArtifact}'] = '${randomArtifact}';

                    if (window === window.top) {
                        console.log("[ProxyClient] Privacy protection layer active: ${profile.renderer}");

                    }
                } catch (err) {
                    console.error("[ProxyClient] Failed to inject privacy script", err);
                }
            })();
        `;
    }

    /**
     * Feature: Natural Mouse Movement
     * Simulates human-like mouse jitters instead of instant teleportation
     */
    async _simulateHumanMovement(page, targetX, targetY, attempt = null) {
        try {
            // Split movement into 3 segments with random deviations
            const steps = 3;
            for (let i = 1; i <= steps; i++) {
                const intermediateX = targetX + (Math.random() - 0.5) * (100 / i);
                const intermediateY = targetY + (Math.random() - 0.5) * (100 / i);

                // Final step must be precise
                const destX = i === steps ? targetX : intermediateX;
                const destY = i === steps ? targetY : intermediateY;

                await this._runInitOperation(attempt, `mouse.move.${i}`, () =>
                    page.mouse.move(destX, destY, {
                        steps: 5 + Math.floor(Math.random() * 5), // Optimized speed (was 10-20)
                    })
                );
            }
        } catch (e) {
            e.reason ||= "required_mouse_failed";
            throw e;
        }
    }

    /**
     * Feature: Smart "Code" Button Clicking
     * Tries multiple selectors (Code, Develop, Edit, Icons) to be robust against UI changes.
     */
    // async _smartClickCode(page) {
    //     const selectors = [
    //         // Priority 1: Exact text match (Fastest)
    //         'button:text("Code")',
    //         // Priority 2: Alternative texts used by Google
    //         'button:text("Develop")',
    //         'button:text("Edit")',
    //         // Priority 3: Fuzzy attribute matching
    //         'button[aria-label*="Code"]',
    //         'button[aria-label*="code"]',
    //         // Priority 4: Icon based
    //         'button mat-icon:text("code")',
    //         'button span:has-text("Code")',
    //     ];
    //
    //     this.logger.info('[Browser] Trying to locate "Code" entry point using smart selectors...');
    //
    //     for (const selector of selectors) {
    //         try {
    //             // Use a short timeout for quick fail-over
    //             const element = page.locator(selector).first();
    //             if (await element.isVisible({ timeout: 2000 })) {
    //                 this.logger.info(`[Browser] ✅ Smart match: "${selector}", clicking...`);
    //                 // Direct click with force as per new logic
    //                 await element.click({ force: true, timeout: 10000 });
    //                 return true;
    //             }
    //         } catch (e) {
    //             // Ignore timeout for single selector, try next
    //         }
    //     }
    //
    //     throw new Error('Unable to find "Code" button or alternatives (Smart Click Failed)');
    // }

    /**
     * Helper: Load and configure build.js script content
     * Applies environment-specific configurations (TARGET_DOMAIN, LOG_LEVEL)
     * @returns {string} Configured build.js script content
     */
    // _loadAndConfigureBuildScript() {
    //     let buildScriptContent = fs.readFileSync(
    //         path.join(__dirname, "..", "..", "scripts", "client", "build.js"),
    //         "utf-8"
    //     );
    //
    //     if (process.env.TARGET_DOMAIN) {
    //         const lines = buildScriptContent.split("\n");
    //         let domainReplaced = false;
    //         for (let i = 0; i < lines.length; i++) {
    //             if (lines[i].includes("this.targetDomain =")) {
    //                 this.logger.info(`[Config] Found targetDomain line: ${lines[i]}`);
    //                 lines[i] = `        this.targetDomain = "${process.env.TARGET_DOMAIN}";`;
    //                 this.logger.info(`[Config] Replaced with: ${lines[i]}`);
    //                 domainReplaced = true;
    //                 break;
    //             }
    //         }
    //         if (domainReplaced) {
    //             buildScriptContent = lines.join("\n");
    //         } else {
    //             this.logger.warn("[Config] Failed to find targetDomain line in build.js, ignoring.");
    //         }
    //     }
    //
    //     if (process.env.WS_PORT) {
    //         // WS_PORT environment variable is no longer supported
    //         this.logger.error(
    //             `[Config] ❌ WS_PORT environment variable is deprecated and no longer supported. ` +
    //                 `The WebSocket port is now fixed at 9998. Please remove WS_PORT from your .env file.`
    //         );
    //         // Do not modify the default WS_PORT - keep it at 9998
    //     }
    //
    //     // Inject LOG_LEVEL configuration into build.js
    //     // Read from LoggingService.currentLevel instead of environment variable
    //     // This ensures runtime log level changes are respected when browser restarts
    //     const LoggingService = require("../utils/LoggingService");
    //     const currentLogLevel = LoggingService.currentLevel; // 0=DEBUG, 1=INFO, 2=WARN, 3=ERROR
    //     const currentLogLevelName = LoggingService.getLevel(); // "DEBUG", "INFO", etc.
    //
    //     if (currentLogLevel !== 1) {
    //         const lines = buildScriptContent.split("\n");
    //         let levelReplaced = false;
    //         for (let i = 0; i < lines.length; i++) {
    //             // Match "currentLevel: <number>," pattern, ignoring comments
    //             // This is more robust than looking for specific comments like "// Default: INFO"
    //             if (/^\s*currentLevel:\s*\d+/.test(lines[i])) {
    //                 this.logger.info(`[Config] Found LOG_LEVEL config line: ${lines[i]}`);
    //                 lines[i] = `    currentLevel: ${currentLogLevel}, // Injected: ${currentLogLevelName}`;
    //                 this.logger.info(`[Config] Replaced with: ${lines[i]}`);
    //                 levelReplaced = true;
    //                 break;
    //             }
    //         }
    //         if (levelReplaced) {
    //             buildScriptContent = lines.join("\n");
    //         } else {
    //             this.logger.warn("[Config] Failed to find LOG_LEVEL config line in build.js, using default INFO.");
    //         }
    //     }
    //
    //     return buildScriptContent;
    // }

    /**
     * Activate a context as the current one: update legacy references, reset wakeup state,
     * and start background services (health monitor + wakeup + active trigger).
     * @param {object} ctx - The browser context object
     * @param {object} pg - The page object
     * @param {number} authIndex - The auth index being activated
     */
    _activateContext(ctx, pg, authIndex) {
        this.context = ctx;
        this.page = pg;
        this._currentAuthIndex = authIndex;
        this.noButtonCount = 0;
        this._startHealthMonitor();
        this._startBackgroundWakeup();
        this._sendActiveTrigger("[Browser]", pg);
    }

    /**
     * Helper: Send active trigger
     * Sends a trigger request to wake up Google backend
     * This is a fire-and-forget operation - we don't wait for the trigger request to complete
     * @param {string} logPrefix - Log prefix for step messages (e.g., "[Browser]" or "[Reconnect]")
     * @param {Page} page - The page object to use (defaults to this.page if not provided)
     */
    _sendActiveTrigger(logPrefix = "[Browser]", page = null) {
        if ((page || this.page)?.playgroundTransport) return;
        // Active Trigger (Hack to wake up Google Backend)
        this.logger.info(`${logPrefix} ⚡ Sending active trigger request to Launch flow...`);

        // Use provided page or fall back to this.page
        const targetPage = page || this.page;

        // Fire-and-forget: send trigger request in background without waiting
        targetPage
            .evaluate(async () => {
                try {
                    await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=ActiveTrigger", {
                        headers: { "Content-Type": "application/json" },
                        method: "GET",
                    });
                } catch (e) {
                    console.log("[ProxyClient] Active trigger sent");
                }
            })
            .catch(() => {
                // Silently ignore errors - this is a best-effort trigger
            });
    }

    /**
     * Helper: Navigate to target page and wake up the page
     * Contains the common navigation and page activation logic
     * @param {Page} page - The page object to navigate
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     */
    async _navigateAndWakeUpPage(page, logPrefix = "[Browser]", attempt = null) {
        this.logger.debug(`${logPrefix} Navigating to target page...`);

        await this._runInitOperation(
            attempt,
            "page.goto",
            () =>
                page.goto(this.targetUrl, {
                    timeout: 180000,
                    waitUntil: "domcontentloaded",
                }),
            Math.min(180000, this.contextInitTotalTimeoutMs || 180000)
        );
        this.logger.debug(`${logPrefix} Page loaded.`);

        // Wait for page to stabilize
        await this._runInitOperation(attempt, "navigation_stabilize.waitForTimeout", () =>
            page.waitForTimeout(2000 + Math.random() * 1000)
        );
    }

    /**
     * Helper: Verify navigation to correct page and retry if needed
     * Throws error on failure, which will be caught by the caller's try-catch block
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     * @throws {Error} If navigation fails after retry
     */
    // async _verifyAndRetryNavigation(logPrefix = "[Browser]") {
    //     let currentUrl = this.page.url();
    //
    //     if (!currentUrl.includes(this.expectedAppId)) {
    //         this.logger.warn(`${logPrefix} ⚠️ Page redirected to: ${currentUrl}`);
    //         this.logger.info(`${logPrefix} Expected app ID: ${this.expectedAppId}`);
    //         this.logger.info(`${logPrefix} Attempting to navigate again...`);
    //
    //         // Reset WebSocket initialization flags before re-navigation
    //         this._wsInitSuccess = false;
    //         this._wsInitFailed = false;
    //
    //         // Wait a bit before retrying
    //         await this.page.waitForTimeout(2000);
    //
    //         // Try navigating again
    //         await this.page.goto(this.targetUrl, {
    //             timeout: 180000,
    //             waitUntil: "domcontentloaded",
    //         });
    //         await this.page.waitForTimeout(2000);
    //
    //         // Check URL again
    //         currentUrl = this.page.url();
    //         if (!currentUrl.includes(this.expectedAppId)) {
    //             this.logger.error(`${logPrefix} ❌ Still on wrong page after retry: ${currentUrl}`);
    //             throw new Error(
    //                 `Failed to navigate to correct page. Current URL: ${currentUrl}, Expected app ID: ${this.expectedAppId}`
    //             );
    //         } else {
    //             this.logger.info(`${logPrefix} ✅ Successfully navigated to correct page on retry: ${currentUrl}`);
    //         }
    //     } else {
    //         this.logger.info(`${logPrefix} ✅ Confirmed on correct page: ${currentUrl}`);
    //     }
    // }

    async _diagnoseMakerSuiteSession(page) {
        const title = await withHardTimeout(() => page.title(), 1500);
        const url = new URL(page.url());
        return url.hostname === "accounts.google.com" ||
            /ServiceLogin/.test(url.pathname) ||
            title.includes("Sign in") ||
            title.includes("登录")
            ? "expired"
            : "unverified";
    }

    /**
     * Helper: Check page status and detect various error conditions
     * Detects: cookie expiration, region restrictions, 403 errors, page load failures
     * @param {Page} page - The page object to check
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     * @param {number} authIndex - The auth index being checked (default: -1). When >= 0 and a login redirect is detected, this method will await this.authSource.markAsExpired(authIndex) to mark the auth as expired.
     * @throws {Error} If any error condition is detected
     */
    async _checkPageStatusAndErrors(page, logPrefix = "[Browser]", authIndex = -1, attempt = null) {
        const currentUrl = page.url();
        let pageTitle = "";
        try {
            pageTitle = await this._runInitOperation(attempt, "page.title", () => page.title());
        } catch (e) {
            if (e?.code === "PLAYWRIGHT_RPC_TIMEOUT") throw e;
            this.logger.warn(`${logPrefix} Unable to get page title: ${e.message}`);
        }

        this.logger.debug(`${logPrefix} [Diagnostic] URL: ${currentUrl}`);
        this.logger.debug(`${logPrefix} [Diagnostic] Title: "${pageTitle}"`);

        // Check for various error conditions
        if (
            currentUrl.includes("accounts.google.com") ||
            currentUrl.includes("ServiceLogin") ||
            pageTitle.includes("Sign in") ||
            pageTitle.includes("登录")
        ) {
            // Mark auth as expired if authIndex is provided
            if (authIndex >= 0 && this.authSource) {
                await this.authSource.markAsExpired(authIndex, page.accountSessionVersion);
            }
            throw new AuthExpiredError();
        }

        if (pageTitle.includes("Available regions") || pageTitle.includes("not available")) {
            throw new Error(
                "🚨 The current IP does not support access to Google AI Studio. Please change the IP and restart!"
            );
        }

        if (pageTitle.includes("403") || pageTitle.includes("Forbidden")) {
            throw new Error("🚨 403 Forbidden: Current IP reputation too low, access denied by Google risk control.");
        }

        if (currentUrl === "about:blank") {
            throw new Error("🚨 Page load failed (about:blank), possibly network timeout or browser crash.");
        }
    }

    /**
     * Feature: Background Health Monitor (The "Scavenger")
     * Periodically cleans up popups and keeps the session alive.
     * In multi-context mode, stores the interval in the context data.
     */
    _startHealthMonitor(authIndex = this._currentAuthIndex) {
        if (authIndex < 0) {
            this.logger.warn("[Browser] Cannot start health monitor: no active auth index");
            return;
        }

        // Get context data
        const contextData = this.contexts.get(authIndex);
        if (!contextData) {
            this.logger.warn(`[Browser] Cannot start health monitor: context #${authIndex} not found`);
            return;
        }

        // Clear existing interval if any
        if (contextData.healthMonitorInterval) {
            clearInterval(contextData.healthMonitorInterval);
        }

        this.logger.info(`[Context#${authIndex}] 🛡️ Background health monitor service (Scavenger) started...`);

        let tickCount = 0;

        // Run every 4 seconds
        contextData.healthMonitorInterval = setInterval(async () => {
            if (
                contextData.monitorRunning ||
                this.contexts.get(authIndex) !== contextData ||
                this._recovering ||
                this.benefitCheckingIndices?.has(authIndex)
            )
                return;
            contextData.monitorRunning = true;
            try {
                // Check if this is still the current active account
                // This prevents background contexts from running healthMonitor unnecessarily
                if (!this.scheduler && this._currentAuthIndex !== authIndex) {
                    // Silently skip - this context is not active
                    return;
                }

                const page = contextData.page;
                // Double check page status
                if (!page || page.isClosed()) {
                    if (contextData.healthMonitorInterval) {
                        clearInterval(contextData.healthMonitorInterval);
                        contextData.healthMonitorInterval = null;
                        this.logger.info(`[HealthMonitor#${authIndex}] Page closed, stopped background task.`);
                    }
                    return;
                }

                tickCount++;

                try {
                    // 1. Keep-Alive: Random micro-actions (30% chance)
                    if (Math.random() < 0.3) {
                        try {
                            // Optimized randomness based on viewport
                            const vp = page.viewportSize() || { height: 1080, width: 1920 };

                            // Scroll
                            // eslint-disable-next-line no-undef
                            await this._runInitOperation(null, "monitor.scroll", () =>
                                page.evaluate(() => globalThis.window.scrollBy(0, (Math.random() - 0.5) * 20))
                            );
                            // Human-like mouse jitter
                            const x = Math.floor(Math.random() * (vp.width * 0.8));
                            const y = Math.floor(Math.random() * (vp.height * 0.8));
                            await this._simulateHumanMovement(page, x, y);
                        } catch (e) {
                            await this._handleRequiredMouseFailure(authIndex, contextData, e);
                            return;
                        }
                    }

                    // 2. Anti-Timeout: Move to top-left corner (1,1) every ~1 minute (15 ticks)
                    if (tickCount % 15 === 0) {
                        try {
                            await this._simulateHumanMovement(page, 1, 1);
                        } catch (e) {
                            await this._handleRequiredMouseFailure(authIndex, contextData, e);
                            return;
                        }
                    }

                    // 3. Auto-Save Auth: Every ~24 hours (21600 ticks * 4s = 86400s)
                    if (tickCount % 21600 === 0) {
                        try {
                            this.logger.info(
                                `[HealthMonitor#${authIndex}] 💾 Triggering daily periodic auth file update...`
                            );
                            await this._updateAuthFile(authIndex);
                        } catch (e) {
                            this.logger.warn(`[HealthMonitor#${authIndex}] Auth update failed: ${e.message}`);
                        }
                    }

                    if (page.playgroundTransport) return;

                    // 4. Popup & Overlay Cleanup
                    await this._runInitOperation(null, "monitor.overlay", () =>
                        page.evaluate(() => {
                            const blockers = [
                                "div.cdk-overlay-backdrop",
                                "div.cdk-overlay-container",
                                "div.cdk-global-overlay-wrapper",
                            ];

                            const targetTexts = [
                                "Reload",
                                "Retry",
                                "Got it",
                                "Dismiss",
                                "Not now",
                                "Continue to the app",
                                "Skip",
                            ];

                            // Remove passive blockers
                            blockers.forEach(selector => {
                                // eslint-disable-next-line no-undef
                                document.querySelectorAll(selector).forEach(el => el.remove());
                            });

                            // Click active buttons if visible
                            // eslint-disable-next-line no-undef
                            document.querySelectorAll("button").forEach(btn => {
                                // Check if the element occupies space (simple visibility check)
                                const rect = btn.getBoundingClientRect();
                                const isVisible = rect.width > 0 && rect.height > 0;

                                if (isVisible) {
                                    const text = (btn.innerText || "").trim();
                                    const ariaLabel = btn.getAttribute("aria-label");

                                    // Match text or aria-label
                                    if (targetTexts.includes(text) || ariaLabel === "Close") {
                                        console.log(`[ProxyClient] HealthMonitor clicking: ${text || "Close Button"}`);
                                        btn.click();
                                    }
                                }
                            });
                        })
                    );
                } catch (err) {
                    if (err.reason === "page_operation_timeout")
                        await this._handleRequiredMouseFailure(authIndex, contextData, err);
                    // Silent catch to prevent log spamming on navigation
                }
            } catch (globalError) {
                // Catch any other unexpected errors in the interval
                this.logger.warn(`[HealthMonitor#${authIndex}] Detailed error: ${globalError.message}`);
                // If the page is definitely gone, stop the monitor
                if (globalError.message.includes("Target page, context or browser has been closed")) {
                    if (contextData.healthMonitorInterval) {
                        clearInterval(contextData.healthMonitorInterval);
                        contextData.healthMonitorInterval = null;
                        this.logger.info(
                            `[HealthMonitor#${authIndex}] Page closed (detected by error), stopped background task.`
                        );
                    }
                }
            } finally {
                contextData.monitorRunning = false;
            }
        }, 4000);
    }

    async _handleRequiredMouseFailure(authIndex, data, error) {
        if (this.contexts.get(authIndex) !== data) return;
        this.logger.warn(`[Context#${authIndex}] required_mouse_failed reason=${error.reason || "mouse_failed"}`);
        data.state = "RECONNECTING";
        data.draining = true;
        clearInterval(data.healthMonitorInterval);
        data.healthMonitorInterval = null;
        // Do not change account eligibility. Existing streams get a bounded grace period.
        const deadline = Date.now() + (this.contextCleanupTimeoutMs || 5000);
        while (!this._isContextIdle(authIndex) && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 100));
        if (this.contexts.get(authIndex) !== data) return;
        await this.closeContext(authIndex, { keepBrowser: true });
        this.requestContext(authIndex);
    }

    /**
     * Helper: Save debug information (screenshot and HTML) to root directory
     * @param {string} suffix - Suffix for the debug file names
     * @param {number} [authIndex] - Optional auth index to get the correct page from contexts Map
     * @param {object} [explicitPage] - Optional explicit page object to use (for cases where page is not yet in contexts)
     */
    async _saveDebugArtifacts(suffix = "final", authIndex = null, explicitPage = null) {
        // Prioritize explicit page, then retrieve from contexts Map, finally fall back to this.page
        let targetPage = explicitPage;
        if (!targetPage) {
            targetPage = this.page;
            if (authIndex !== null && this.contexts.has(authIndex)) {
                const ctxData = this.contexts.get(authIndex);
                if (ctxData && ctxData.page) {
                    targetPage = ctxData.page;
                }
            }
        }
        if (!targetPage || targetPage.isClosed()) return;
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
            const screenshotPath = path.join(process.cwd(), `debug_screenshot_${suffix}_${timestamp}.png`);
            await targetPage.screenshot({
                fullPage: true,
                path: screenshotPath,
            });
            this.logger.info(`[Debug] Failure screenshot saved to: ${screenshotPath}`);

            const htmlPath = path.join(process.cwd(), `debug_page_source_${suffix}_${timestamp}.html`);
            const htmlContent = await targetPage.content();
            fs.writeFileSync(htmlPath, htmlContent);
            this.logger.info(`[Debug] Failure page source saved to: ${htmlPath}`);
        } catch (e) {
            this.logger.error(`[Debug] Failed to save debug artifacts: ${e.message}`);
        }
    }

    /**
     * Feature: Background Wakeup & "Launch" Button Handler
     * Specifically handles the "Rocket/Launch" button which blocks model loading.
     * This service is bound to this.page (instance-level), not individual contexts.
     * Only one instance should run at a time, tracking the current active page.
     */
    async _startBackgroundWakeup(workerState = this) {
        if (workerState.page?.playgroundTransport) return;
        // Prevent multiple instances from running simultaneously
        if (workerState.backgroundWakeupRunning) {
            this.logger.info("[Browser] BackgroundWakeup already running, skipping duplicate start.");
            return;
        }

        this.logger.debug("[Browser] Starting BackgroundWakeup initialization...");
        workerState.backgroundWakeupRunning = true;

        // Initial buffer - wait before starting the main loop to let page stabilize
        await new Promise(r => setTimeout(r, 1500));

        // Verify page is still valid after the initial delay
        try {
            if (!workerState.page || workerState.page.isClosed()) {
                workerState.backgroundWakeupRunning = false;
                this.logger.info(
                    "[Browser] BackgroundWakeup stopped: page became null or closed during startup delay."
                );
                return;
            }
        } catch (error) {
            workerState.backgroundWakeupRunning = false;
            this.logger.warn(`[Browser] BackgroundWakeup stopped: error checking page status: ${error.message}`);
            return;
        }

        this.logger.info("[Browser] 🛡️ Background Wakeup Service (Rocket Handler) started...");

        // Main loop: directly use workerState.page, automatically follows context switches
        while (workerState.page && !workerState.page.isClosed()) {
            try {
                const currentPage = workerState.page; // Capture for this iteration

                // 1. Force page wake-up
                await currentPage.bringToFront().catch(() => {});

                // Micro-movements to trigger rendering frames in headless mode
                const vp = currentPage.viewportSize() || { height: 1080, width: 1920 };
                const moveX = Math.floor(Math.random() * (vp.width * 0.3));
                const moveY = Math.floor(Math.random() * (vp.height * 0.3));
                await this._simulateHumanMovement(currentPage, moveX, moveY);

                // 2. Intelligent Scan for "Launch" or "Rocket" button
                const targetInfo = await currentPage.evaluate(() => {
                    // Optimized precise check
                    try {
                        const preciseCandidates = Array.from(
                            // eslint-disable-next-line no-undef
                            document.querySelectorAll(".interaction-modal p, .interaction-modal button")
                        );
                        for (const el of preciseCandidates) {
                            if (/Launch|rocket_launch/i.test((el.innerText || "").trim())) {
                                const rect = el.getBoundingClientRect();
                                if (rect.width > 0 && rect.height > 0) {
                                    return {
                                        found: true,
                                        tagName: el.tagName,
                                        text: (el.innerText || "").trim().substring(0, 15),
                                        x: rect.left + rect.width / 2,
                                        y: rect.top + rect.height / 2,
                                    };
                                }
                            }
                        }
                    } catch (e) {
                        /* empty */
                    }

                    const MIN_Y = 400;
                    const MAX_Y = 800;

                    const isValid = rect => rect.width > 0 && rect.height > 0 && rect.top > MIN_Y && rect.top < MAX_Y;

                    // eslint-disable-next-line no-undef
                    const candidates = Array.from(document.querySelectorAll("button, span, div, a, i"));

                    for (const el of candidates) {
                        const text = (el.innerText || "").trim();
                        // Match "Launch" or material icon "rocket_launch"
                        if (!/Launch|rocket_launch/i.test(text)) continue;

                        let targetEl = el;
                        let rect = targetEl.getBoundingClientRect();

                        // Recursive parent check (up to 3 levels)
                        let parentDepth = 0;
                        while (parentDepth < 3 && targetEl.parentElement) {
                            if (targetEl.tagName === "BUTTON" || targetEl.getAttribute("role") === "button") break;
                            const parent = targetEl.parentElement;
                            const pRect = parent.getBoundingClientRect();
                            if (isValid(pRect)) {
                                targetEl = parent;
                                rect = pRect;
                            }
                            parentDepth++;
                        }

                        if (isValid(rect)) {
                            return {
                                found: true,
                                tagName: targetEl.tagName,
                                text: text.substring(0, 15),
                                x: rect.left + rect.width / 2,
                                y: rect.top + rect.height / 2,
                            };
                        }
                    }
                    return { found: false };
                });

                // 3. Execute Click if found
                if (targetInfo.found) {
                    this.logger.info(`[Browser] 🎯 Found Rocket/Launch button [${targetInfo.tagName}], engaging...`);

                    // Physical Click
                    await currentPage.mouse.move(targetInfo.x, targetInfo.y, { steps: 5 });
                    await new Promise(r => setTimeout(r, 300));
                    await currentPage.mouse.down();
                    await new Promise(r => setTimeout(r, 400));
                    await currentPage.mouse.up();

                    this.logger.info(`[Browser] 🖱️ Physical click executed. Verifying...`);
                    await new Promise(r => setTimeout(r, 1500));

                    // Strategy B: JS Click (Fallback)
                    const isStillThere = await currentPage.evaluate(() => {
                        // eslint-disable-next-line no-undef
                        const els = Array.from(document.querySelectorAll('button, span, div[role="button"]'));
                        return els.some(el => {
                            const r = el.getBoundingClientRect();
                            return (
                                /Launch|rocket_launch/i.test(el.innerText) && r.top > 400 && r.top < 800 && r.height > 0
                            );
                        });
                    });

                    if (isStillThere) {
                        this.logger.warn(`[Browser] ⚠️ Physical click ineffective, attempting JS force click...`);
                        await currentPage.evaluate(() => {
                            const candidates = Array.from(
                                // eslint-disable-next-line no-undef
                                document.querySelectorAll('button, span, div[role="button"]')
                            );
                            for (const el of candidates) {
                                const r = el.getBoundingClientRect();
                                if (/Launch|rocket_launch/i.test(el.innerText) && r.top > 400 && r.top < 800) {
                                    (el.closest("button") || el).click();
                                    return true;
                                }
                            }
                        });
                        await new Promise(r => setTimeout(r, 2000));
                    } else {
                        this.logger.info(`[Browser] ✅ Click successful, button disappeared.`);
                        // Long sleep on success, but check for context switches every second
                        for (let i = 0; i < 60; i++) {
                            if (!workerState.page || workerState.page.isClosed() || workerState.noButtonCount === 0) {
                                this.logger.info(`[Browser] ⚡ Woken up early due to user activity or context switch.`);
                                break; // Wake up early if user activity detected
                            }
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    }
                } else {
                    workerState.noButtonCount++;
                    // Smart Sleep
                    if (workerState.noButtonCount > 20) {
                        // Long sleep, but check for user activity
                        for (let i = 0; i < 30; i++) {
                            if (!workerState.page || workerState.page.isClosed() || workerState.noButtonCount === 0)
                                break; // Woken up by request
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    } else {
                        await new Promise(r => setTimeout(r, 1500));
                    }
                }
            } catch (e) {
                // Ignore errors during page navigation/reload
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // Reset flag when loop exits
        workerState.backgroundWakeupRunning = false;

        // Log the reason for stopping
        if (!workerState.page) {
            this.logger.info("[Browser] Background Wakeup Service stopped: workerState.page is null.");
        } else if (workerState.page.isClosed()) {
            this.logger.info("[Browser] Background Wakeup Service stopped: workerState.page was closed.");
        } else {
            this.logger.info("[Browser] Background Wakeup Service stopped: unknown reason.");
        }
    }

    async launchBrowserForVNC(extraArgs = {}) {
        const selectedProxy = extraArgs.proxyInfo || null;
        const stickyProxy = selectedProxy
            ? null
            : this.stickyProxyManager.reserveProxyForNewAccount("VNC account binding");
        this.logger.info("🚀 [VNC] Launching a new, separate, headful browser instance for VNC session...");
        const browserExecutablePath = this._getBrowserExecutablePath();
        if (!fs.existsSync(browserExecutablePath)) {
            throw new Error(`Browser executable not found at path: ${browserExecutablePath}`);
        }

        const proxyConfig = selectedProxy ? selectedProxy.proxy : stickyProxy ? stickyProxy.proxy : parseProxyFromEnv();
        if (proxyConfig) {
            this.logger.info(
                selectedProxy
                    ? `[VNC] Launching browser with selected Mihomo node: ${selectedProxy.nodeId}`
                    : stickyProxy
                      ? `[VNC] Launching browser with proxy: ${stickyProxy.display}`
                      : `[VNC] 🌐 Using proxy: ${proxyConfig.server}`
            );
        }

        // This browser instance is temporary and specific to the VNC session.
        // It does NOT affect the main `this.browser` used for the API proxy.
        const vncBrowser = await firefox.launch({
            env: {
                ...process.env,
                ...extraArgs.env,
            },
            executablePath: browserExecutablePath,
            firefoxUserPrefs: FIREFOX_DOH_DISABLED_PREFS,
            headless: false,
            ...(proxyConfig ? { proxy: proxyConfig } : {}),
        });

        vncBrowser.on("disconnected", () => {
            this.logger.warn("ℹ️ [VNC] The temporary VNC browser instance has been disconnected.");
        });

        this.logger.info("✅ [VNC] Temporary VNC browser instance launched successfully.");

        let contextOptions = {};
        if (extraArgs.isMobile) {
            this.logger.info("[VNC] Mobile client detected; applying Firefox Android context for VNC login.");
            contextOptions = {
                hasTouch: true,
                userAgent: "Mozilla/5.0 (Android 10; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0",
            };
        }

        const context = await vncBrowser.newContext(
            proxyConfig ? { ...contextOptions, proxy: proxyConfig } : contextOptions
        );
        this.logger.info("✅ [VNC] VNC browser context successfully created.");

        // Return both the browser and context so the caller can manage their lifecycle.
        return { browser: vncBrowser, context, selectedProxy, stickyProxy };
    }

    /**
     * Preload a pool of contexts at startup
     * Synchronously initializes the first context, then starts remaining in background
     * @param {number[]} startupOrder - Ordered list of auth indices to try
     * @param {number} maxContexts - Max pool size (0 = unlimited)
     * @returns {Promise<{firstReady: number|null}>}
     */
    async preloadContextPool(startupOrder, maxContexts) {
        const poolSize = maxContexts === 0 ? startupOrder.length : Math.min(maxContexts, startupOrder.length);
        this.logger.info(
            `🚀 [ContextPool] Starting pool preload (pool=${poolSize}, order=[${startupOrder.join(", ")}])...`
        );

        // Abort any existing background preload/rebalance to ensure clean state
        await this.abortBackgroundPreload();

        // Launch browser if not already running
        if (!this.browser) {
            await this._ensureBrowser();
        }

        // Synchronously try ALL indices until one succeeds (fallback beyond poolSize)
        let firstReady = null;

        for (let i = 0; i < startupOrder.length; i++) {
            const authIndex = startupOrder[i];

            // If already initialized, use it directly
            if (this.contexts.has(authIndex)) {
                this.logger.info(`[ContextPool] Context #${authIndex} already exists, reusing`);
                firstReady = authIndex;
                break;
            }

            // If being initialized by another task, wait for it to finish and verify success
            if (this._contextInitTasks.has(authIndex)) {
                this.logger.info(`[ContextPool] Context #${authIndex} being initialized, waiting...`);
                await this._waitForContextInit(authIndex);
                if (this.contexts.has(authIndex)) {
                    this.logger.info(`[ContextPool] Context #${authIndex} initialized successfully, reusing`);
                    firstReady = authIndex;
                    break;
                }
                this.logger.warn(`[ContextPool] Context #${authIndex} initialization failed, trying next`);
                continue;
            }

            try {
                this.logger.info(`[ContextPool] Initializing context #${authIndex}...`);
                await this._getOrStartContextInit(authIndex);
                firstReady = authIndex;
                this.logger.info(`✅ [ContextPool] First context #${authIndex} ready.`);
                break;
            } catch (error) {
                this.logger.error(`❌ [ContextPool] Context #${authIndex} failed: ${error.message}`);
            }
        }

        if (firstReady === null) {
            if (this.browser) await this.closeBrowser();
            return { firstReady: null };
        }

        // Early return if pool size is 1 (single context mode) - no need for background preload
        if (poolSize === 1) {
            this.logger.info(`[ContextPool] Single context mode (maxContexts=1), skipping background preload.`);
            return { firstReady };
        }

        // Background: calculate remaining contexts using rotation order (same logic as rebalanceContextPool)
        // This ensures startup pool matches the rotation order used during account switching
        const rotation = this.authSource.getRotationIndices();
        const currentCanonical = this.authSource.getCanonicalIndex(firstReady);
        const startPos = currentCanonical !== null ? Math.max(rotation.indexOf(currentCanonical), 0) : 0;
        const ordered = [];
        for (let i = 0; i < rotation.length; i++) {
            ordered.push(rotation[(startPos + i) % rotation.length]);
        }

        // Calculate how many more contexts we need to reach poolSize
        const needCount = poolSize - this.contexts.size;
        if (needCount > 0) {
            // Get candidates from ordered list (excluding already initialized contexts)
            // Convert existing contexts to canonical indices to handle duplicate accounts
            const existingCanonical = new Set(
                [...this.contexts.keys()].map(idx => this.authSource.getCanonicalIndex(idx) ?? idx)
            );
            const candidates = ordered.filter(
                idx => !existingCanonical.has(idx) && !this.initializingContexts.has(idx)
            );

            if (candidates.length > 0) {
                this.logger.info(
                    `[ContextPool] Background preload will try [${candidates.join(", ")}] to reach pool size ${poolSize} (need ${needCount} more)`
                );
                // Pass all candidates, not just the first needCount
                // This allows the background task to try subsequent accounts if earlier ones fail
                this._preloadBackgroundContexts(candidates, poolSize);
            }
        }

        return { firstReady };
    }

    /**
     * Launch browser instance if not already running
     */
    async ensureWorkerContext(authIndex) {
        if (this.benefitCheckingIndices?.has(authIndex))
            throw new ContextAbortedError(authIndex, "benefit check in progress");
        if (!this.scheduler) return this.launchOrSwitchContext(authIndex);
        if (this.scheduler.closed) throw new Error("Scheduler is shutting down");
        if (this._recovering) throw new ContextAbortedError(authIndex, "browser recovering");
        if (this.isContextReady(authIndex)) return;
        this._foregroundContextWaiters ??= new Map();
        this._foregroundContextWaiters.set(authIndex, (this._foregroundContextWaiters.get(authIndex) || 0) + 1);
        try {
            this.requestContext(authIndex);
            const deadline = Date.now() + this.scheduler.config.queueTimeoutMs;
            while (!this.isContextReady(authIndex)) {
                if (this.scheduler.closed) throw new Error("Scheduler is shutting down");
                const unavailable = this.contextUnavailable.get(authIndex);
                if (unavailable?.error && !this._contextInitTasks.has(authIndex)) throw unavailable.error;
                if (Date.now() >= deadline) throw new Error(`Timeout waiting for ready context #${authIndex}`);
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        } finally {
            const remaining = this._foregroundContextWaiters.get(authIndex) - 1;
            if (remaining) this._foregroundContextWaiters.set(authIndex, remaining);
            else {
                this._foregroundContextWaiters.delete(authIndex);
                const demand = this.contextDemand.get(authIndex);
                if (demand) {
                    demand.unscoped = false;
                    demand.unscopedUntil = 0;
                    if (!demand.models?.size && !demand.model) this.contextDemand.delete(authIndex);
                }
            }
            this.scheduler.coordinateContextPool?.();
        }
    }

    isContextReady(authIndex) {
        const data = this.contexts.get(authIndex);
        if (
            !data?.page ||
            data.page.isClosed() ||
            data.draining ||
            data.mouseReady === false ||
            (data.browserGeneration !== undefined && data.browserGeneration !== this.browserGeneration) ||
            this._poolClosingContexts?.has(authIndex)
        )
            return false;
        const connection = this.connectionRegistry?.getConnectionByAuth(authIndex, false);
        const connected = connection && (connection.readyState === undefined || connection.readyState === 1);
        return Boolean(connected && !["RECONNECTING", "UNAVAILABLE"].includes(data.state));
    }

    isContextClosing(authIndex) {
        return this.isClosingIntentionally || this.closingContexts.has(authIndex);
    }

    markContextState(authIndex, state, details = {}) {
        const data = this.contexts.get(authIndex);
        if (data) Object.assign(data, details, { state });
        if (state === "UNAVAILABLE") this.contextUnavailable.set(authIndex, { ...details, at: Date.now() });
        if (state === "READY") this.contextUnavailable.delete(authIndex);
        this.scheduler?.drain();
    }

    getContextPoolSnapshot() {
        const closing = new Set([
            ...(this._poolClosingContexts || []),
            ...(this._contextPoolReplacements?.keys() || []),
            ...(this._contextCapacityClosures?.values() || []),
        ]);
        const contexts = [...this.contexts.entries()].map(([authIndex, data]) => {
            const inflight = this.scheduler?.account(authIndex).inflight || 0;
            let state = data.state || "READY";
            if (closing.has(authIndex)) state = "CLOSING";
            else if (data.draining) state = "DRAINING";
            else if (this.isContextReady(authIndex)) state = inflight > 0 ? "BUSY" : "READY";
            return {
                auth_index: authIndex,
                build_benefit: data.page?.buildBenefit
                    ? {
                          query_status: data.page.buildBenefit.queryStatus || null,
                          reason: data.page.buildBenefit.failureReason || null,
                          source: data.page.buildBenefit.source || null,
                          state: data.page.buildBenefit.state,
                          tier: resolveTier(accountForIndex(this.authSource, authIndex)),
                      }
                    : null,
                connection_epoch: this.connectionRegistry?.getConnectionEpoch(authIndex) || null,
                created_at: data.createdAt || null,
                drain_reason: data.drainReason || this.pendingContextClosures.get(authIndex) || null,
                draining: Boolean(data.draining),
                eviction_priority: this.contextEvictionReason(authIndex),
                inflight,
                last_disconnect_reason: data.lastDisconnectReason || null,
                last_request_at: data.lastRequestAt || null,
                makersuite_active: data.page?.makerSuiteBridge?.active.size || 0,
                state,
            };
        });
        for (const authIndex of closing) {
            if (!contexts.some(item => item.auth_index === authIndex))
                contexts.push({ auth_index: authIndex, connection_epoch: null, inflight: 0, state: "CLOSING" });
        }
        for (const authIndex of this.initializingContexts) {
            if (!contexts.some(item => item.auth_index === authIndex))
                contexts.push({ auth_index: authIndex, connection_epoch: null, inflight: 0, state: "INITIALIZING" });
        }
        for (const [authIndex, info] of this.contextUnavailable) {
            if (!contexts.some(item => item.auth_index === authIndex))
                contexts.push({
                    auth_index: authIndex,
                    connection_epoch: null,
                    inflight: 0,
                    last_disconnect_reason: info.reason || info.error?.message || null,
                    state: "UNAVAILABLE",
                });
        }
        for (const authIndex of this.authSource.getRotationIndices()) {
            if (!contexts.some(item => item.auth_index === authIndex)) {
                contexts.push({ auth_index: authIndex, connection_epoch: null, inflight: 0, state: "COLD" });
            }
        }
        return contexts.sort((a, b) => a.auth_index - b.auth_index);
    }

    getAccountEgressKey(authIndex) {
        const current = this.contexts.get(authIndex)?.proxyInfo || this._contextInitAttempts?.get(authIndex)?.proxyInfo;
        if (current) return egressKey(current);
        const info = this._proxyResolver
            ? this._proxyResolver(authIndex)
            : this.stickyProxyManager.getProxyForAuth(authIndex) || { proxy: parseProxyFromEnv() };
        if (info?.then) throw new Error("Proxy planning requires a synchronous resolver");
        return egressKey(info);
    }

    startContextPool() {
        if (!this.scheduler || this._contextPoolRunning) return;
        this._contextPoolRunning = true;
        this.scheduler.coordinateContextPool?.();
        this._pumpContextPool();
    }

    requestContext(authIndex, model = null) {
        if (
            !this.scheduler ||
            this.scheduler.closed ||
            this.scheduler.isAccountManuallyDisabled?.(authIndex) === true ||
            this.isContextReady(authIndex)
        )
            return;
        this.contextDemand ??= new Map();
        const previous = this.contextDemand.get(authIndex);
        const models = new Set(previous?.models || (previous?.model ? [previous.model] : []));
        if (model) models.add(model);
        this.contextDemand.set(authIndex, {
            at: Date.now(),
            model,
            models,
            unscoped: previous?.unscoped || !model,
            unscopedUntil: !model
                ? Date.now() + (this.scheduler.config.queueTimeoutMs || 120000)
                : previous?.unscopedUntil,
        });
        if (!this._demandBatch) this._pumpContextPool();
    }

    requestContexts(requests) {
        if (!requests.length) return;
        this._demandBatch = true;
        try {
            for (const { authIndex, model } of requests) this.requestContext(authIndex, model);
        } finally {
            this._demandBatch = false;
        }
        if (this.poolMetrics) this.poolMetrics.demand_batches++;
        this._pumpContextPool();
    }

    _hasValidContextDemand(authIndex) {
        const demand = this.contextDemand?.get(authIndex);
        if (!demand) return false;
        const account = this.scheduler.account(authIndex);
        if (account.disabled || account.healthy === false || this.authSource.isExpired?.(authIndex)) return false;
        if (this._foregroundContextWaiters?.has(authIndex)) return true;
        if ((demand.unscoped || !demand.model) && demand.unscopedUntil > Date.now()) return true;
        return this._hasQueuedContextDemand(authIndex);
    }

    _hasQueuedContextDemand(authIndex) {
        const demand = this.contextDemand?.get(authIndex);
        if (!demand) return false;
        const scheduler = this.scheduler;
        const models = demand.models || new Set(demand.model ? [demand.model] : []);
        if (scheduler.hasUnmetContextDemand) return scheduler.hasUnmetContextDemand(authIndex, models);
        // Compatibility with scheduler adapters that do not expose queue inspection.
        if (!scheduler.isResourceEligible) return true;
        const account = scheduler.account(authIndex);
        return [...models].some(
            model =>
                scheduler.isResourceEligible(account, model) &&
                scheduler.pending.some(item => item.model === model && !item.excluded.has(account.key))
        );
    }

    _contextPoolPurpose(authIndex) {
        if (this._foregroundContextWaiters?.has(authIndex)) return "foreground";
        if (this._hasQueuedContextDemand(authIndex)) return "demand";
        return this._hasValidContextDemand(authIndex) ? "recovery" : "warm";
    }

    _canKeepPooledContext(authIndex) {
        if (this.scheduler.closed) return false;
        return (
            (this.scheduler.isAccountPoolResident?.(authIndex) ??
                this.scheduler.isAccountManuallyDisabled?.(authIndex) !== true) ||
            this._hasValidContextDemand(authIndex) ||
            this.scheduler.workers?.some(
                worker => worker.lease?.account.index === authIndex && worker.lease.model === "__files__"
            )
        );
    }

    reconcileContextPool() {
        if (!this.scheduler || this.scheduler.closed || this._reconcilingPool) return;
        this._reconcilingPool = true;
        try {
            let restored = false;
            for (const index of this.contexts.keys()) restored = this._cancelObsoletePoolReplacement(index) || restored;
            const now = this.scheduler.now();
            const models = this.scheduler.getVisibleModels();
            for (const [index] of this.contextDemand) {
                if (!this._hasValidContextDemand(index)) this.contextDemand.delete(index);
            }
            for (const index of new Set([...this.contexts.keys(), ...this.initializingContexts])) {
                const data = this.contexts.get(index);
                const exhausted = this.scheduler.isAccountQuotaExhausted(this.scheduler.account(index), now, models);
                const restriction = this.scheduler.accountPoolRestriction?.(this.scheduler.account(index), models);
                const reason = restriction || "visible_models_rate_limited";
                const retire = (exhausted || restriction) && !this._canKeepPooledContext(index);
                const quotaDrain = [
                    "visible_models_rate_limited",
                    "model_permissions_empty",
                    "models_unsupported",
                    "models_unavailable",
                ].includes(data?.drainReason);
                if (!retire) {
                    if (
                        quotaDrain &&
                        !this._poolClosingContexts?.has(index) &&
                        [
                            "visible_models_rate_limited",
                            "model_permissions_empty",
                            "models_unsupported",
                            "models_unavailable",
                        ].includes(this.pendingContextClosures.get(index))
                    ) {
                        this._cancelPendingContextClosure(index, "quota_eligibility_restored");
                        data.draining = false;
                        data.drainReason = null;
                        restored = true;
                    }
                    continue;
                }
                // An in-progress initializer is revalidated before publication. Do not
                // abort it here: a newly discovered model may restore its eligibility.
                if (!data || this.initializingContexts.has(index) || this._poolClosingContexts?.has(index)) continue;
                if (!data.draining) {
                    data.drainReason = reason;
                    this.logger.info(
                        `[ContextPool] Draining #${index}: reason=${reason}, visible_models=${models.size}, inflight=${this.scheduler.account(index).inflight}`
                    );
                    this.beginAccountDrain(index, reason);
                }
                this.handleAccountLeaseReleased(index);
            }
            if (restored) this.scheduler.drain();
            this._pumpContextPool();
        } finally {
            this._reconcilingPool = false;
        }
    }

    _egressKeyForPool(index) {
        try {
            return this.getAccountEgressKey(index);
        } catch {
            return null;
        }
    }

    orderContextCandidates(indices, limit = indices.length, plannedIndices = []) {
        if (this.scheduler.config.strategy !== "different_proxy_first" || !limit || !indices.length)
            return indices.slice(0, limit);
        // This runs only when a new context is needed. One route lookup per
        // account, with occupancy read from applied contexts and admitted inits.
        const keys = new Map();
        const keyFor = index => {
            if (!keys.has(index)) keys.set(index, this._egressKeyForPool(index));
            return keys.get(index);
        };
        const counts = new Map();
        const occupied = new Set([...this.contexts.keys(), ...this.initializingContexts, ...plannedIndices]);
        for (const index of occupied) {
            if (this.contexts.get(index)?.draining || this._poolClosingContexts?.has(index)) continue;
            const key = keyFor(index);
            if (key) counts.set(key, (counts.get(key) || 0) + 1);
        }
        const groups = new Map();
        for (const index of indices) {
            const key = keyFor(index);
            if (!key) continue;
            if (!groups.has(key)) groups.set(key, { accounts: [], cursor: 0 });
            groups.get(key).accounts.push(index);
        }
        const result = [];
        while (groups.size && result.length < limit) {
            let bestKey;
            let minimum = Infinity;
            for (const key of groups.keys()) {
                const count = counts.get(key) || 0;
                if (count < minimum) {
                    bestKey = key;
                    minimum = count;
                }
            }
            const group = groups.get(bestKey);
            result.push(group.accounts[group.cursor++]);
            counts.set(bestKey, minimum + 1);
            if (group.cursor === group.accounts.length) groups.delete(bestKey);
        }
        return result;
    }

    getEgressPoolSnapshot(models) {
        const groups = new Map();
        const byModel = Object.fromEntries([...models].map(model => [model, new Map()]));
        // Observability derives from existing contexts; never resolve cold routes.
        for (const [index, data] of this.contexts) {
            if (!data.proxyInfo) continue;
            const key = egressKey(data.proxyInfo);
            if (!groups.has(key)) groups.set(key, { contexts: 0, inflight: 0, key, ready_contexts: 0 });
            const group = groups.get(key);
            const account = this.scheduler.account(index);
            group.contexts++;
            group.inflight += account.inflight;
            if (!this.isContextReady(index)) continue;
            group.ready_contexts++;
            for (const model of models) {
                if (!this.scheduler.isResourceEligible(account, model) || !this.scheduler.canLease(account, model))
                    continue;
                const counts = byModel[model];
                counts.set(key, (counts.get(key) || 0) + 1);
            }
        }
        return {
            by_model: Object.fromEntries(
                Object.entries(byModel).map(([model, counts]) => [
                    model,
                    [...counts].map(([key, ready_accounts]) => ({ key, ready_accounts })),
                ])
            ),
            groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)),
        };
    }

    _modelWarmTargets() {
        if (this.scheduler.config.enabled === false) return [];
        return Object.entries(this.scheduler.config.modelContextWarmTargets || {}).filter(([, target]) => target > 0);
    }

    _backgroundContextLimit() {
        return this.scheduler.config.maxWorkers;
    }

    _warmCoverageIndices(includeScheduled = true) {
        const indices = new Set([...this.contexts.keys()]);
        if (includeScheduled) {
            for (const index of this.initializingContexts) indices.add(index);
            for (const index of this.contextCapacityReservations?.keys() || []) indices.add(index);
        }
        const rotation = new Set(this.authSource.getRotationIndices());
        return [...indices].filter(
            index =>
                rotation.has(index) &&
                !this.benefitCheckingIndices?.has(index) &&
                !this.contexts.get(index)?.draining &&
                !this._poolClosingContexts?.has(index) &&
                !this._contextPoolReplacements?.has(index) &&
                ![...(this._contextCapacityClosures?.values() || [])].includes(index) &&
                (this.isContextReady(index) ||
                    (includeScheduled &&
                        (this.initializingContexts.has(index) || this.contextCapacityReservations?.has(index))))
        );
    }

    getModelWarmCoverage(model) {
        const eligible = index => this.scheduler.isResourceEligible(this.scheduler.account(index), model);
        const ready = this._warmCoverageIndices(false).filter(eligible).length;
        const scheduled = this._warmCoverageIndices().filter(eligible).length;
        const target = this.scheduler.config.modelContextWarmTargets?.[model] || 0;
        return { deficit: Math.max(0, target - ready), initializing: scheduled - ready, ready, target };
    }

    _warmCoverageCounts(indices = this._warmCoverageIndices()) {
        return this._modelWarmTargets().map(([model, target]) => ({
            count: indices.filter(index => this.scheduler.isResourceEligible(this.scheduler.account(index), model))
                .length,
            model,
            target,
        }));
    }

    _warmCandidateGain(index, counts) {
        return counts.filter(
            ({ model, target, count }) =>
                count < target && this.scheduler.isResourceEligible(this.scheduler.account(index), model)
        ).length;
    }

    // Select at most M-1 coverage accounts; every other account remains shared,
    // even when it can also serve a target model. Prefer incumbents on equal gain.
    _modelWarmPlan() {
        const protectedIndices = new Set();
        if (!this._modelWarmTargets().length) return protectedIndices;
        const admitted = new Set([
            ...this._warmCoverageIndices(),
            ...[...this.contexts.values()].flatMap(data =>
                data.poolReplacement ? [data.poolReplacement.incoming] : []
            ),
        ]);
        const candidates = this.authSource
            .getRotationIndices()
            .filter(
                index =>
                    !this.benefitCheckingIndices?.has(index) &&
                    !this.contexts.get(index)?.draining &&
                    !this._poolClosingContexts?.has(index) &&
                    !this._contextPoolReplacements?.has(index) &&
                    ![...(this._contextCapacityClosures?.values() || [])].includes(index) &&
                    (this.scheduler.isAccountPoolResident?.(index) ?? true) &&
                    (!this.contextUnavailable.get(index)?.retryAt ||
                        this.contextUnavailable.get(index).retryAt <= Date.now())
            );
        while (protectedIndices.size < this.scheduler.config.maxWorkers - 1 && candidates.length) {
            const counts = this._warmCoverageCounts([...protectedIndices]);
            const gain = Math.max(...candidates.map(index => this._warmCandidateGain(index, counts)));
            if (!gain) break;
            let best = candidates.filter(index => this._warmCandidateGain(index, counts) === gain);
            if (best.some(index => admitted.has(index))) best = best.filter(index => admitted.has(index));
            const index = this.orderContextCandidates(best, 1, [...protectedIndices])[0];
            if (index === undefined) break;
            protectedIndices.add(index);
            candidates.splice(candidates.indexOf(index), 1);
        }
        return protectedIndices;
    }

    getWarmSharingSnapshot() {
        const protectedIndices = this._modelWarmPlan();
        const protectedCount = [...this.contexts.keys()].filter(index => protectedIndices.has(index)).length;
        return {
            protected_contexts: protectedCount,
            shared_contexts: Math.max(0, this.contexts.size - protectedCount),
            shared_minimum: this._modelWarmTargets().length ? 1 : 0,
        };
    }

    orderPoolInitializationCandidates(indices, limit = indices.length, plannedIndices = []) {
        if (!this._modelWarmTargets().length) return this.orderContextCandidates(indices, limit, plannedIndices);
        indices = indices.filter(
            index =>
                !this.contexts.get(index)?.draining &&
                !this._poolClosingContexts?.has(index) &&
                !this._contextPoolReplacements?.has(index)
        );
        const counts = this._warmCoverageCounts([...new Set([...this._warmCoverageIndices(), ...plannedIndices])]);
        const groups = new Map();
        for (const index of indices) {
            const gain = this._warmCandidateGain(index, counts);
            if (!groups.has(gain)) groups.set(gain, []);
            groups.get(gain).push(index);
        }
        const ordered = [];
        for (const gain of [...groups.keys()].sort((a, b) => b - a))
            ordered.push(
                ...this.orderContextCandidates(groups.get(gain), indices.length, [...plannedIndices, ...ordered])
            );
        return ordered.slice(0, limit);
    }

    _poolReplacementNeeded(data) {
        const replacement = data?.poolReplacement;
        if (!replacement) return true;
        const { incoming, purpose } = replacement;
        if (this.scheduler.closed || this.isContextReady(incoming)) return false;
        return purpose === "warm"
            ? this._modelWarmPlan().has(incoming)
            : purpose === "foreground"
              ? this._foregroundContextWaiters?.has(incoming)
              : this._hasQueuedContextDemand(incoming);
    }

    _cancelObsoletePoolReplacement(index) {
        const data = this.contexts.get(index);
        if (!data?.poolReplacement || this._poolReplacementNeeded(data)) return false;
        delete data.poolReplacement;
        // A later disable/recovery drain owns its own lifecycle and must survive.
        if (!["model_warm_target", "context_capacity"].includes(data.drainReason)) return false;
        this._cancelPendingContextClosure(index, "replacement_no_longer_needed");
        Object.assign(data, { draining: false, drainReason: null });
        return true;
    }

    _poolCandidates() {
        if (this.poolMetrics) this.poolMetrics.scans++;
        const rotation = this.authSource.getRotationIndices();
        const closing = new Set([
            ...(this._poolClosingContexts || []),
            ...(this._contextPoolReplacements?.keys() || []),
            ...(this._contextCapacityClosures?.values() || []),
        ]);
        const enabled = index => this.scheduler.isAccountManuallyDisabled?.(index) !== true;
        const now = this.scheduler.now?.() ?? Date.now();
        const models = this.scheduler.getVisibleModels?.();
        const residents = new Set(
            rotation.filter(
                index => enabled(index) && (this.scheduler.isAccountPoolResident?.(index, now, models) ?? true)
            )
        );
        const resident = index => residents.has(index);
        for (const index of this.contextDemand?.keys() || [])
            if (!enabled(index) || !this._hasValidContextDemand(index)) this.contextDemand.delete(index);
        const demanded = [...(this.contextDemand?.keys() || [])].filter(
            index => rotation.includes(index) && enabled(index)
        );
        const target = Math.min(
            this.scheduler.config.contextPoolMinReady,
            residents.size,
            this._backgroundContextLimit()
        );
        const readyCount = rotation.filter(index => resident(index) && this.isContextReady(index)).length;
        const warmingCount = [...this.initializingContexts].filter(resident).length;
        const needWarm = Math.max(0, target - readyCount - warmingCount);
        const warmStatus = `${target}:${residents.size}`;
        if (warmStatus !== this._lastWarmStatus) {
            this._lastWarmStatus = warmStatus;
            this.logger.info(`[ContextPool] Warm target=${target}, candidates=${residents.size}`);
        }
        const warm = needWarm
            ? this.orderContextCandidates(
                  rotation.filter(index => {
                      const unavailable = this.contextUnavailable.get(index);
                      return (
                          resident(index) &&
                          !demanded.includes(index) &&
                          !this.isContextReady(index) &&
                          !this.initializingContexts.has(index) &&
                          (!this.contexts.has(index) || this._isContextIdle(index)) &&
                          !this.contexts.get(index)?.draining &&
                          !closing.has(index) &&
                          (!unavailable?.retryAt || unavailable.retryAt <= Date.now())
                      );
                  }),
                  needWarm
              )
            : [];
        const coverageCounts = this._warmCoverageCounts();
        const coverageWarm = [...this._modelWarmPlan()].filter(
            index => !this.isContextReady(index) && this._warmCandidateGain(index, coverageCounts) > 0
        );
        return [...new Set([...coverageWarm, ...demanded, ...warm])].filter(index => {
            const unavailable = this.contextUnavailable.get(index);
            return (
                enabled(index) &&
                !this.isContextReady(index) &&
                !this.initializingContexts.has(index) &&
                (!this.contexts.has(index) || this._isContextIdle(index)) &&
                !this.contexts.get(index)?.draining &&
                !closing.has(index) &&
                (!unavailable?.retryAt || unavailable.retryAt <= Date.now())
            );
        });
    }

    _pumpContextPool() {
        if (
            !this.scheduler ||
            this.scheduler.closed ||
            this.scheduler.paused ||
            this._recovering ||
            this._browserRecoveryTask ||
            this.isClosingIntentionally ||
            this._pumpingContextPool
        )
            return;
        if (this._contextInitTasks.size >= this.scheduler.config.contextInitConcurrency) {
            if (this.poolMetrics) this.poolMetrics.capacity_skips++;
            return;
        }
        this._pumpingContextPool = true;
        try {
            for (const authIndex of this._poolCandidates()) {
                if (this._contextInitTasks.size >= this.scheduler.config.contextInitConcurrency) break;
                this._startPooledContext(authIndex);
                // No capacity was admitted. Wait for a lease, close or init to finish.
                if (!this._contextInitTasks.has(authIndex)) break;
            }
        } finally {
            this._pumpingContextPool = false;
        }
    }

    _contextCapacityIndices() {
        return new Set([
            ...this.contexts.keys(),
            ...this.initializingContexts,
            ...(this.contextCapacityReservations?.keys() || []),
            ...(this._poolClosingContexts || []),
            ...(this._contextPoolReplacements?.keys() || []),
            ...(this._contextCapacityClosures?.values() || []),
        ]);
    }

    _reserveContextCapacity(authIndex, purpose = "foreground") {
        this.contextCapacityReservations ??= new Map();
        if (
            this.benefitCheckingIndices?.has(authIndex) ||
            this.scheduler.closed ||
            (this._recovering && this._recoveryAuthIndex !== authIndex) ||
            this.isClosingIntentionally ||
            this._contextInitTasks.size >= this.scheduler.config.contextInitConcurrency ||
            this.contextCapacityReservations.has(authIndex) ||
            this._poolClosingContexts?.has(authIndex) ||
            this._contextPoolReplacements?.has(authIndex) ||
            [...(this._contextCapacityClosures?.values() || [])].includes(authIndex) ||
            (this.contexts.has(authIndex) && !this._isContextIdle(authIndex))
        )
            return null;
        const occupied = this._contextCapacityIndices();
        if (!occupied.has(authIndex) && occupied.size >= this.scheduler.config.maxWorkers) {
            const status = `${occupied.size}:${this.scheduler.config.maxWorkers}:${this.contextCapacityReservations.size}`;
            if (this._lastContextCapacityWait !== status) {
                this._lastContextCapacityWait = status;
                this.logger.debug(
                    `[ContextPool] Waiting for capacity: occupied=${occupied.size}, max=${this.scheduler.config.maxWorkers}, reserved=${this.contextCapacityReservations.size}, purpose=${purpose}`
                );
            }
            this._replaceIdlePooledContext(authIndex, purpose);
            return null;
        }
        // This synchronous claim precedes both init registration and every await.
        const reservation = { authIndex };
        this.contextCapacityReservations.set(authIndex, reservation);
        this._lastContextCapacityWait = null;
        return reservation;
    }

    _releaseContextCapacity(authIndex, reservation) {
        if (!reservation || this.contextCapacityReservations?.get(authIndex) !== reservation) return;
        this.contextCapacityReservations.delete(authIndex);
    }

    _replaceIdlePooledContext(authIndex, purpose) {
        // Coverage and real demand share the existing capacity/close machinery.
        // Shared accounts drain first; in-flight requests always finish normally.
        if (
            purpose !== "warm" &&
            purpose !== "foreground" &&
            (purpose !== "demand" || !this._hasQueuedContextDemand(authIndex))
        )
            return;
        this._contextPoolReplacements ??= new Map();
        // Finish one replacement before selecting another victim for the same demand.
        if (this._contextPoolReplacements.size || this._poolClosingContexts?.size) return;
        if ([...this.contexts.values()].some(data => data.poolReplacement)) return;
        const protectedIndices = this._modelWarmPlan();
        if (purpose === "warm" && !protectedIndices.has(authIndex)) return;
        const activeTargets = this._modelWarmTargets().length > 0;
        const idle = [...this.contexts.keys()]
            .filter(
                index =>
                    index !== authIndex &&
                    !this.contexts.get(index)?.draining &&
                    !this.benefitCheckingIndices?.has(index) &&
                    !this.initializingContexts.has(index) &&
                    !this.contextCapacityReservations?.has(index) &&
                    (activeTargets || this._isContextIdle(index)) &&
                    (purpose !== "warm" || !protectedIndices.has(index))
            )
            .sort(
                (a, b) =>
                    Number(protectedIndices.has(a)) - Number(protectedIndices.has(b)) ||
                    Number(!this._isContextIdle(a)) - Number(!this._isContextIdle(b)) ||
                    this._compareContextEviction(a, b)
            )[0];
        if (idle === undefined) return;
        if (!this._isContextIdle(idle)) {
            const data = this.contexts.get(idle);
            data.poolReplacement = { incoming: authIndex, purpose };
            this.beginAccountDrain(idle, purpose === "warm" ? "model_warm_target" : "context_capacity");
            this.logger.info(`[ContextPool] Draining shared context #${idle} for #${authIndex}, purpose=${purpose}`);
            this.scheduler.drain();
            return;
        }
        const owner = {};
        this._contextPoolReplacements.set(idle, owner);
        Object.assign(this.contexts.get(idle), { draining: true, drainReason: "context_capacity" });
        this.logger.info(
            `[ContextPool] Evicting context #${idle} for #${authIndex} (${this.contextEvictionReason(idle)}), purpose=${purpose}`
        );
        // Mark synchronously, then close. Closing capacity is retained until settlement.
        Promise.resolve()
            .then(() => {
                if (this._contextPoolReplacements.get(idle) !== owner) return;
                return this.closeContext(idle, { keepBrowser: true });
            })
            .catch(error => this.logger.error(`[ContextPool] Replacement close #${idle} failed: ${error.message}`))
            .finally(() => {
                if (this._contextPoolReplacements.get(idle) !== owner) return;
                this._contextPoolReplacements.delete(idle);
                this.scheduler?.coordinateContextPool?.();
                this._pumpContextPool();
            });
    }

    async _ensureBrowserForPool() {
        await this._ensureBrowser({ recovery: this._recoveryAuthIndex !== undefined });
    }

    markContextRequest(authIndex, now = Date.now()) {
        const data = this.contexts.get(authIndex);
        if (data) data.lastRequestAt = now;
    }

    _isContextIdle(authIndex) {
        if (this.benefitCheckingIndices?.has(authIndex)) return false;
        return !this.scheduler?.account(authIndex).inflight && !this._hasActiveQueueForAuth(authIndex);
    }

    rankContextForEviction(authIndex, now = Date.now()) {
        const data = this.contexts.get(authIndex) || {};
        const rotation = this.authSource.getRotationIndices();
        const account = this.scheduler?.account(authIndex);
        const unusableSlots =
            this.scheduler?.accountPoolRestriction?.(account) ||
            this.scheduler?.isAccountQuotaExhausted?.(account, now) ||
            false;
        return [
            account?.disabled ? 0 : 1,
            !account?.healthy || !rotation.includes(authIndex) || this.authSource.isExpired?.(authIndex) ? 0 : 1,
            unusableSlots ? 0 : 1,
            this.contextDemand.has(authIndex) ? 1 : 0,
            data.lastRequestAt || 0,
            data.createdAt || 0,
            authIndex,
        ];
    }

    contextEvictionReason(authIndex, now = Date.now()) {
        const rank = this.rankContextForEviction(authIndex, now);
        if (rank[0] === 0) return "account_disabled";
        if (rank[1] === 0) return "account_unhealthy";
        if (rank[2] === 0)
            return (
                this.scheduler?.accountPoolRestriction?.(this.scheduler.account(authIndex)) ||
                "visible_models_rate_limited"
            );
        if (rank[3] === 0) return "no_account_context_demand";
        return "healthy_idle_lru";
    }

    _compareContextEviction(a, b, now = Date.now()) {
        const left = this.rankContextForEviction(a, now);
        const right = this.rankContextForEviction(b, now);
        for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i];
        return 0;
    }

    compareAccountsForDraining(a, b) {
        const protectedIndices = this._modelWarmPlan();
        return Number(protectedIndices.has(a)) - Number(protectedIndices.has(b)) || this._compareContextEviction(a, b);
    }

    beginAccountDrain(authIndex, reason = "context_capacity") {
        const data = this.contexts.get(authIndex);
        if (!data) return false;
        if (!data.draining) data.drainReason = reason;
        data.draining = true;
        return this._scheduleContextClosureWhenIdle(authIndex, reason);
    }

    handleAccountDisabled(authIndex) {
        this.contextDemand.delete(authIndex);
        if (this.initializingContexts.has(authIndex)) this.abortedContexts.add(authIndex);
        const data = this.contexts.get(authIndex);
        if (!data) return;
        data.draining = true;
        data.drainReason = "account_disabled";
        this.pendingContextClosures.delete(authIndex);
        if (!this._isContextIdle(authIndex)) {
            this._scheduleContextClosureWhenIdle(authIndex, "account_disabled");
            return;
        }
        this.closeContext(authIndex, { keepBrowser: true })
            .then(() => this._pumpContextPool())
            .catch(error =>
                this.logger.error(`[ContextPool] Failed to close disabled context #${authIndex}: ${error.message}`)
            );
    }

    handleAccountEnabled(authIndex) {
        const data = this.contexts.get(authIndex);
        if (
            data?.drainReason === "account_disabled" ||
            this.pendingContextClosures.get(authIndex) === "account_disabled"
        ) {
            data && Object.assign(data, { draining: false, drainReason: null });
        }
        if (this.pendingContextClosures.get(authIndex) === "account_disabled")
            this._cancelPendingContextClosure(authIndex, "account_enabled");
        this._pumpContextPool();
    }

    handleAccountsEnabled() {
        for (const authIndex of this.authSource.getRotationIndices()) this.handleAccountEnabled(authIndex);
    }

    handleAccountLeaseReleased(authIndex) {
        const data = this.contexts.get(authIndex);
        if ((!data?.draining && !this.pendingContextClosures.has(authIndex)) || !this._isContextIdle(authIndex)) return;
        this._closePendingContextIfIdle(authIndex).catch(error =>
            this.logger.error(`[ContextPool] Failed to finish draining context #${authIndex}: ${error.message}`)
        );
    }

    async _createBrowserContext(options, authIndex) {
        const owner = this.browser;
        const generation = this.browserGeneration;
        let releaseTurn;
        const previousTurn = this._contextCreationQueue || Promise.resolve();
        const currentTurn = new Promise(resolve => {
            releaseTurn = resolve;
        });
        this._contextCreationQueue = previousTurn.catch(() => {}).then(() => currentTurn);

        await previousTurn.catch(() => {});

        let creationTimedOut = false;
        let timeoutId;
        try {
            if (
                this.isClosingIntentionally ||
                !owner ||
                owner !== this.browser ||
                generation !== this.browserGeneration
            )
                throw new ContextAbortedError(authIndex, "browser generation changed before context creation");

            const creationTask = owner.newContext(options);
            // If Playwright eventually completes after the watchdog fired, close
            // the orphan instead of letting an untracked context leak.
            creationTask
                .then(context => {
                    if (creationTimedOut || owner !== this.browser) context.close().catch(() => {});
                })
                .catch(() => {});

            const timeoutMs = this.contextCreationTimeoutMs || CONTEXT_CREATION_TIMEOUT_MS;
            const timeoutTask = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    creationTimedOut = true;
                    reject(
                        Object.assign(
                            new Error(`Timed out creating browser context #${authIndex} after ${timeoutMs}ms`),
                            {
                                authIndex,
                                code: "CONTEXT_CREATION_TIMEOUT",
                                reason: "context_creation_timeout",
                                timeoutMs,
                            }
                        )
                    );
                }, timeoutMs);
            });

            return await Promise.race([creationTask, timeoutTask]);
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
            releaseTurn();
        }
    }

    _startPooledContext(authIndex) {
        if (this._contextInitTasks.has(authIndex)) return this._contextInitTasks.get(authIndex);
        if (
            !this.scheduler ||
            this.scheduler.closed ||
            this.isContextReady(authIndex) ||
            (this._recovering && this._recoveryAuthIndex !== authIndex)
        )
            return Promise.resolve();
        const purpose = this._contextPoolPurpose(authIndex);
        if (purpose === "warm" && !this._poolCandidates().includes(authIndex)) return Promise.resolve();
        const reservation = this._reserveContextCapacity(authIndex, purpose);
        if (!reservation) return Promise.resolve();
        return this._getOrStartContextInit(authIndex, {
            capacityReservation: reservation,
            isBackgroundTask: true,
            onError: error => {
                if (isContextAbortedError(error)) return;
                const failures = (this.contextUnavailable.get(authIndex)?.failures || 0) + 1;
                const delay = Math.min(60000, 5000 * 2 ** Math.min(4, failures - 1));
                const retryAt = Date.now() + delay;
                this.contextUnavailable.set(authIndex, {
                    at: Date.now(),
                    error,
                    failures,
                    reason: error.reason,
                    retryAt,
                });
                this.contextDemand.delete(authIndex);
                this.logger.error(`[ContextPool] Context #${authIndex} unavailable: ${error.message}`);
                const retryTimer = setTimeout(() => this._pumpContextPool(), delay);
                retryTimer.unref?.();
            },
            onSettledAfterRelease: () => {
                this.scheduler?.drain();
                this.scheduler?.coordinateContextPool?.();
                this._pumpContextPool();
            },
            runner: async attempt => {
                await this._ensureBrowserForPool();
                this._assertCurrentInitAttempt(attempt);
                if (this.scheduler.closed) throw new ContextAbortedError(authIndex, "scheduler closed");
                if (this.contextCapacityReservations.get(authIndex) !== reservation)
                    throw new ContextAbortedError(authIndex, "capacity reservation lost");
                if (!this._canKeepPooledContext(authIndex))
                    throw new ContextAbortedError(authIndex, "account not eligible for pool");
                const stale = this.contexts.get(authIndex);
                if (stale) {
                    // Admission prevents leasing a stale context while it is rebuilt.
                    if (!this._isContextIdle(authIndex))
                        throw new ContextAbortedError(authIndex, "context acquired before rebuild");
                    await this.closeContext(authIndex, { keepBrowser: true, skipInitWait: true });
                }
                this._assertCurrentInitAttempt(attempt);
                await this._initializeContext(authIndex, true, attempt);
                this._assertCurrentInitAttempt(attempt);
                if (!this._canKeepPooledContext(authIndex)) {
                    await this.closeContext(authIndex, { keepBrowser: true, skipInitWait: true });
                    throw new ContextAbortedError(authIndex, "account not eligible after initialization");
                }
                const data = this.contexts.get(authIndex);
                if (!data || !this.connectionRegistry.getConnectionByAuth(authIndex, false))
                    throw Object.assign(new Error("WebSocket not ready after context initialization"), {
                        reason: "connection_lost",
                    });
                Object.assign(data, { lastDisconnectReason: null, noButtonCount: 0, state: "READY" });
                this.contextDemand.delete(authIndex);
                this.contextUnavailable.delete(authIndex);
                this._startHealthMonitor(authIndex);
                this._startBackgroundWakeup(data).catch(error => {
                    this.logger.warn(`[Worker#${authIndex}] Wakeup stopped: ${error.message}`);
                });
                return { context: data.context, page: data.page };
            },
        });
    }

    _withBrowserLifecycle(operation) {
        const task = (this._lifecycleTail || Promise.resolve()).catch(() => {}).then(operation);
        this._lifecycleTail = task.catch(() => {});
        return task;
    }

    _ensureBrowser(options = {}) {
        if (this._recovering && !options.recovery)
            return Promise.reject(new ContextAbortedError(-1, "browser recovering"));
        if (!this._ensureBrowserTask) {
            const task = this._withBrowserLifecycle(() => {
                if (this._recovering && !options.recovery) throw new ContextAbortedError(-1, "browser recovering");
                return this._launchBrowser();
            });
            this._ensureBrowserTask = task;
            task.finally(() => {
                if (this._ensureBrowserTask === task) this._ensureBrowserTask = null;
            }).catch(() => {});
        }
        return this._ensureBrowserTask;
    }

    async _launchBrowser() {
        if (this.browser) return;
        this.browserState = "STARTING";

        const isStickyProxyEnabled = this.stickyProxyManager.isEnabled();
        const proxyConfig = this._proxyResolver || isStickyProxyEnabled ? null : parseProxyFromEnv();
        if (isStickyProxyEnabled) {
            this.logger.info(
                "[Browser] Sticky proxy mode enabled; main browser launch will not use environment proxy."
            );
        }
        this.logger.info("🚀 [Browser] Launching main browser instance...");
        const browserExecutablePath = this._getBrowserExecutablePath();
        if (!fs.existsSync(browserExecutablePath)) {
            this._currentAuthIndex = -1;
            throw new Error(`Browser executable not found at path: ${browserExecutablePath}`);
        }
        const browser = await firefox.launch({
            args: this.launchArgs,
            executablePath: browserExecutablePath,
            firefoxUserPrefs: this.firefoxUserPrefs,
            headless: true,
            ...(proxyConfig ? { proxy: proxyConfig } : {}),
        });
        this.browser = browser;
        this.browserGeneration = (this.browserGeneration || 0) + 1;
        this.browserState = this._recovering ? "RECOVERING" : "RUNNING";
        browser.on("disconnected", () => {
            if (this.browser !== browser) return;
            const unexpected = !this.isClosingIntentionally;
            this.browser = null;
            this._cleanupAllContexts();
            if (unexpected) this._triggerBrowserRecovery("browser_disconnected");
        });
        this.logger.info("✅ [Browser] Main browser instance launched successfully.");
    }

    /**
     * Abort any ongoing background preload task and wait for it to complete
     * This is a public method that encapsulates access to internal preload state
     * @returns {Promise<void>} Resolves when the background task has been aborted and cleaned up
     */
    async abortBackgroundPreload() {
        if (!this._backgroundPreloadTask) {
            return; // No task to abort
        }

        this.logger.info(`[ContextPool] Aborting background preload task...`);
        this._backgroundPreloadAbort = true;

        try {
            await this._backgroundPreloadTask;
        } catch (error) {
            // Ignore errors from aborted task
            this.logger.debug(`[ContextPool] Background preload aborted: ${error.message}`);
        }

        this.logger.info(`[ContextPool] Background preload aborted successfully`);
    }

    /**
     * Background sequential initialization of contexts (fire-and-forget)
     * Only one instance should be active at a time - new calls abort old ones
     * @param {number[]} indices - Auth indices to initialize (candidates, may exceed pool size)
     * @param {number} maxPoolSize - Stop when this.contexts.size reaches this limit (0 = no limit)
     */
    async _preloadBackgroundContexts(indices, maxPoolSize = 0) {
        // If there's an existing background task, abort it and wait for it to finish
        await this.abortBackgroundPreload();

        // Reset abort flag and create new background task
        this._backgroundPreloadAbort = false;
        const currentTask = this._executePreloadTask(indices, maxPoolSize);
        this._backgroundPreloadTask = currentTask;

        // Don't await here - this is fire-and-forget
        // But ensure we clean up the task reference when done
        currentTask
            .catch(error => {
                this.logger.error(`[ContextPool] Background preload task failed: ${error.message}`);
            })
            .finally(() => {
                // Only clear if this is still the current task
                if (this._backgroundPreloadTask === currentTask) {
                    this._backgroundPreloadTask = null;
                }
            });
    }

    _hasActiveQueueForAuth(authIndex) {
        if (this.connectionRegistry?.hasMessageQueueForAuth) {
            return this.connectionRegistry.hasMessageQueueForAuth(authIndex);
        }
        return false;
    }

    _cancelPendingContextClosure(authIndex, reason = "closure_cancelled") {
        if (!this.pendingContextClosures.has(authIndex)) {
            return false;
        }
        this.pendingContextClosures.delete(authIndex);
        this.logger.info(`[ContextPool] Cancelled pending close for context #${authIndex} (${reason}).`);
        return true;
    }

    _scheduleContextClosureWhenIdle(authIndex, reason) {
        if (!this.contexts.has(authIndex)) {
            return false;
        }
        const existingReason = this.pendingContextClosures.get(authIndex);
        if (existingReason) {
            this.logger.debug(
                `[ContextPool] Context #${authIndex} is already pending close (${existingReason}), active queues are still present`
            );
            return false;
        }
        this.pendingContextClosures.set(authIndex, reason);
        this.logger.info(
            `[ContextPool] Deferring close for busy context #${authIndex} (active queue(s) present, reason: ${reason})`
        );
        return false;
    }

    async _closeContextForPoolIfPossible(authIndex, reason) {
        if (!this._isContextIdle(authIndex)) {
            return this._scheduleContextClosureWhenIdle(authIndex, reason);
        }

        this.pendingContextClosures.delete(authIndex);
        await this.closeContext(authIndex);
        return true;
    }

    async _closePendingContextIfIdle(authIndex) {
        if (!this.pendingContextClosures.has(authIndex)) {
            return false;
        }
        const data = this.contexts.get(authIndex);
        if (this._cancelObsoletePoolReplacement(authIndex)) return false;
        if (authIndex === this._currentAuthIndex && !data?.draining) {
            this.logger.debug(
                `[ContextPool] Skipping pending close for context #${authIndex} because it is active again as current.`
            );
            return false;
        }
        if (!this.contexts.has(authIndex)) {
            this.pendingContextClosures.delete(authIndex);
            return false;
        }

        if (!this._isContextIdle(authIndex)) {
            this.logger.debug(
                `[ContextPool] Pending close for context #${authIndex} is still waiting on active queue(s).`
            );
            return false;
        }

        const pendingReason = this.pendingContextClosures.get(authIndex);
        if (
            [
                "visible_models_rate_limited",
                "model_permissions_empty",
                "models_unsupported",
                "models_unavailable",
            ].includes(pendingReason) &&
            this._canKeepPooledContext(authIndex)
        ) {
            this._cancelPendingContextClosure(authIndex, "quota_eligibility_restored");
            Object.assign(data, { draining: false, drainReason: null });
            return false;
        }
        this.pendingContextClosures.delete(authIndex);
        this.logger.info(
            `[ContextPool] Closing deferred context #${authIndex} now that all queues are drained (reason: ${pendingReason}).`
        );
        await this.closeContext(authIndex, { keepBrowser: Boolean(this.scheduler) });
        if (this.scheduler) {
            this.scheduler.coordinateContextPool?.();
            this._pumpContextPool();
            return true;
        }
        if (this._isSystemBusy()) {
            this.logger.info("[ContextPool] Skipping rebalance after deferred close because system is busy.");
            return true;
        }
        this.rebalanceContextPool().catch(error => {
            this.logger.error(`[ContextPool] Rebalance after deferred close failed: ${error.message}`);
        });
        return true;
    }

    async _flushPendingContextClosures() {
        for (const authIndex of [...this.pendingContextClosures.keys()]) {
            await this._closePendingContextIfIdle(authIndex);
        }
    }

    _prioritizeContextsForRemoval(indices) {
        const idle = [];
        const busy = [];

        for (const authIndex of indices) {
            if (this._hasActiveQueueForAuth(authIndex)) {
                busy.push({ authIndex });
            } else {
                idle.push(authIndex);
            }
        }

        return { busy, idle };
    }

    /**
     * Internal method to execute the actual preload task
     * @private
     */
    async _executePreloadTask(indices, maxPoolSize) {
        this.logger.info(
            `[ContextPool] Background preload starting for [${indices.join(", ")}] (poolCap=${maxPoolSize || "unlimited"})...`
        );

        let aborted = false;

        for (const authIndex of indices) {
            // Check if abort was requested
            if (this._backgroundPreloadAbort) {
                this.logger.info(`[ContextPool] Background preload aborted by request`);
                aborted = true;
                break;
            }

            // Check if browser is available, launch if needed
            if (!this.browser) {
                this.logger.info(`[ContextPool] Browser not available, launching browser for background preload...`);
                try {
                    await this._ensureBrowser();
                    this.logger.info(`[ContextPool] Browser launched successfully for background preload`);
                } catch (error) {
                    this.logger.error(
                        `[ContextPool] Failed to launch browser for background preload: ${error.message}`
                    );
                    break;
                }
            }

            // Check pool size limit
            if (maxPoolSize > 0 && this.contexts.size >= maxPoolSize) {
                this.logger.info(`[ContextPool] Pool size limit reached, stopping preload`);
                break;
            }

            // Skip if already exists or being initialized by another task
            if (this.contexts.has(authIndex)) {
                this.logger.debug(`[ContextPool] Context #${authIndex} already exists, skipping`);
                continue;
            }
            if (this.initializingContexts.has(authIndex)) {
                this.logger.info(
                    `[ContextPool] Context #${authIndex} already being initialized by another task, skipping`
                );
                continue;
            }

            try {
                this.logger.info(`[ContextPool] Background preload init context #${authIndex}...`);
                await this._getOrStartContextInit(authIndex, { isBackgroundTask: true });
                this.logger.info(`✅ [ContextPool] Background context #${authIndex} ready.`);
            } catch (error) {
                // Check if this is an abort error (user deleted the account during initialization or background preload was aborted)
                const isAbortError = isContextAbortedError(error);
                if (isAbortError) {
                    this.logger.info(`[ContextPool] Background context #${authIndex} aborted as requested`);
                    // If aborted due to background preload abort, mark as aborted
                    aborted = true;
                } else {
                    this.logger.error(`❌ [ContextPool] Background context #${authIndex} failed: ${error.message}`);
                }
            }
        }

        if (!aborted) {
            this.logger.info(`[ContextPool] Background preload complete.`);
        }
    }

    /**
     * Pre-cleanup before switching to a new account
     * Removes contexts that will be excess after the switch to avoid exceeding maxContexts
     * @param {number} targetAuthIndex - The account index we're about to switch to
     */
    async preCleanupForSwitch(targetAuthIndex) {
        const maxContexts = this.config.maxContexts;
        const isUnlimited = maxContexts === 0;

        // Abort any ongoing background preload task before cleanup
        // This prevents race conditions where background tasks continue initializing contexts
        // that will be immediately removed by the new rebalance after switch
        await this.abortBackgroundPreload();

        // Test: Check if initializingContexts is empty after aborting background task
        if (this.initializingContexts.size > 0) {
            const initializingList = [...this.initializingContexts].join(", ");
            this.logger.error(
                `[ContextPool] Pre-cleanup ERROR: initializingContexts not empty after aborting background task! Contexts still initializing: [${initializingList}]`
            );
            throw new Error(
                `Pre-cleanup failed: initializingContexts not empty (${initializingList}). This should not happen after aborting background task.`
            );
        }

        // In unlimited mode, no need to pre-cleanup
        if (isUnlimited) {
            this.logger.debug(`[ContextPool] Pre-cleanup skipped: unlimited mode`);
            return;
        }

        // If target context already exists or is being initialized, no new context will be created
        if (this.contexts.has(targetAuthIndex)) {
            this.logger.debug(`[ContextPool] Pre-cleanup skipped: target context #${targetAuthIndex} already exists`);
            return;
        }

        if (this.initializingContexts.has(targetAuthIndex)) {
            this.logger.debug(
                `[ContextPool] Pre-cleanup skipped: target context #${targetAuthIndex} is being initialized`
            );
            return;
        }

        // Calculate how many contexts we'll have after adding the new one
        // Include contexts that are currently being initialized in background
        const currentSize = this.contexts.size + this.initializingContexts.size;
        const futureSize = currentSize + 1;

        // If we won't exceed the limit, no cleanup needed
        if (futureSize <= maxContexts) {
            this.logger.debug(
                `[ContextPool] Pre-cleanup skipped: future size ${futureSize} (${this.contexts.size} ready + ${this.initializingContexts.size} initializing + 1 new) <= maxContexts ${maxContexts}`
            );
            return;
        }

        // We need to remove (futureSize - maxContexts) contexts
        const removeCount = futureSize - maxContexts;

        // Build removal priority list (from lowest to highest priority to keep):
        // Priority 1: Old duplicate accounts (removedIndices from duplicateGroups)
        // Priority 2: Expired accounts (not the target if target is expired)
        // Priority 3: Accounts in rotation, ordered by distance from target (farthest first)

        const rotation = this.authSource.getRotationIndices();
        const targetCanonical = this.authSource.getCanonicalIndex(targetAuthIndex);
        const duplicateGroups = this.authSource.getDuplicateGroups();
        const expiredIndices = this.authSource.expiredIndices || [];

        // Get all old duplicate indices (not in rotation)
        const oldDuplicates = new Set();
        for (const group of duplicateGroups) {
            for (const idx of group.removedIndices) {
                oldDuplicates.add(idx);
            }
        }

        // Build rotation order starting from target (accounts closer to target have higher priority)
        // Special case: If target is expired, use targetAuthIndex directly as startPos
        const isTargetExpired = expiredIndices.includes(targetAuthIndex);
        let startPos;
        if (isTargetExpired) {
            // For expired accounts, find rotation position by comparing index values (expired accounts are never in rotation)
            startPos = rotation.indexOf(targetAuthIndex);
            if (startPos === -1) {
                // Target not in rotation (it's expired), find closest position by index value
                startPos = 0;
                for (let i = 0; i < rotation.length; i++) {
                    if (rotation[i] > targetAuthIndex) {
                        startPos = i;
                        break;
                    }
                }
            }
        } else {
            startPos = Math.max(rotation.indexOf(targetCanonical), 0);
        }
        const orderedFromTarget = [];
        for (let i = 0; i < rotation.length; i++) {
            orderedFromTarget.push(rotation[(startPos + i) % rotation.length]);
        }

        // Collect all context indices (existing + initializing)
        const allContextIndices = new Set([...this.contexts.keys(), ...this.initializingContexts]);

        // Build removal priority list
        const removalPriority = [];

        // Special case: If target is an old duplicate, prioritize removing its canonical version
        // Because we're about to create the old duplicate, and they're the same account
        const isTargetOldDuplicate = oldDuplicates.has(targetAuthIndex);
        if (isTargetOldDuplicate) {
            // Find the canonical version of target in existing contexts
            for (const idx of allContextIndices) {
                if (this.authSource.getCanonicalIndex(idx) === targetCanonical && idx === targetCanonical) {
                    removalPriority.push(idx);
                    break;
                }
            }
        }

        // Priority 1: Old duplicate accounts (lowest priority to keep)
        for (const idx of allContextIndices) {
            if (oldDuplicates.has(idx) && !removalPriority.includes(idx)) {
                removalPriority.push(idx);
            }
        }

        // Priority 2: Expired accounts (except target if target is expired)
        for (const idx of allContextIndices) {
            if (expiredIndices.includes(idx) && idx !== targetAuthIndex && !removalPriority.includes(idx)) {
                removalPriority.push(idx);
            }
        }

        // Priority 3: Accounts in rotation, from farthest to closest (reverse rotation order)
        for (let i = orderedFromTarget.length - 1; i >= 0; i--) {
            const canonical = orderedFromTarget[i];
            // Find all contexts with this canonical index
            for (const idx of allContextIndices) {
                if (this.authSource.getCanonicalIndex(idx) === canonical && !removalPriority.includes(idx)) {
                    removalPriority.push(idx);
                }
            }
        }

        const { busy, idle } = this._prioritizeContextsForRemoval(removalPriority);
        const toRemoveNow = idle.slice(0, removeCount);
        const toDefer = busy.slice(0, Math.max(0, removeCount - toRemoveNow.length));

        this.logger.info(
            `[ContextPool] Pre-cleanup before switch to #${targetAuthIndex}: immediate=[${toRemoveNow}], deferred=[${toDefer.map(
                entry => entry.authIndex
            )}] (${this.contexts.size} ready + ${this.initializingContexts.size} initializing)`
        );

        for (const idx of toRemoveNow) {
            await this._closeContextForPoolIfPossible(idx, "pre_cleanup_for_switch");
        }

        for (const entry of toDefer) {
            this._scheduleContextClosureWhenIdle(entry.authIndex, "pre_cleanup_for_switch");
        }

        if (toDefer.length > 0) {
            this.logger.warn(
                `[ContextPool] Allowing temporary MAX_CONTEXTS overflow while busy contexts drain before switch to #${targetAuthIndex}.`
            );
        }
    }

    /**
     * Rebalance context pool after account changes
     * Removes excess contexts and starts missing ones in background
     */
    async rebalanceContextPool() {
        if (this.scheduler) {
            const valid = new Set(this.authSource.getRotationIndices());
            for (const index of this.contextDemand.keys()) if (!valid.has(index)) this.contextDemand.delete(index);
            for (const index of this.contextUnavailable.keys())
                if (!valid.has(index)) this.contextUnavailable.delete(index);
            this.startContextPool();
            this.scheduler.coordinateContextPool?.();
            this._pumpContextPool();
            return;
        }
        const maxContexts = this.config.maxContexts;
        // maxContexts === 0 means unlimited pool size
        const isUnlimited = maxContexts === 0;

        // Build full rotation ordered from current account
        const rotation = this.authSource.getRotationIndices();
        const currentCanonical =
            this._currentAuthIndex >= 0 ? this.authSource.getCanonicalIndex(this._currentAuthIndex) : null;
        const startPos = currentCanonical !== null ? Math.max(rotation.indexOf(currentCanonical), 0) : 0;
        const ordered = [];
        for (let i = 0; i < rotation.length; i++) {
            ordered.push(rotation[(startPos + i) % rotation.length]);
        }

        // Targets = first maxContexts from ordered (or all available if unlimited)
        // In unlimited mode, include all valid accounts (rotation + duplicates), excluding expired
        let targets;
        if (isUnlimited) {
            // Filter out expired accounts from availableIndices
            const nonExpiredAvailable = this.authSource.availableIndices.filter(idx => !this.authSource.isExpired(idx));
            targets = new Set(nonExpiredAvailable);
        } else {
            targets = new Set(ordered.slice(0, maxContexts));
        }

        for (const idx of targets) {
            this._cancelPendingContextClosure(idx, "rebalance_target");
        }

        // Remove contexts not in targets (except current)
        // Special handling: if current account is a duplicate (old version), also remove its canonical version
        // BUT only in limited mode - in unlimited mode, keep all contexts
        const toRemove = [];
        const currentCanonicalIndex = currentCanonical; // Already calculated above
        const isDuplicateAccount =
            this._currentAuthIndex >= 0 &&
            currentCanonicalIndex !== null &&
            currentCanonicalIndex !== this._currentAuthIndex;

        for (const idx of this.contexts.keys()) {
            // Skip current account
            if (idx === this._currentAuthIndex) continue;

            // If current is a duplicate AND we're in limited mode, remove the canonical version (we're using the old one)
            if (!isUnlimited && isDuplicateAccount && idx === currentCanonicalIndex) {
                toRemove.push(idx);
                continue;
            }

            // Remove if not in targets
            if (!targets.has(idx)) {
                toRemove.push(idx);
            }
        }

        // Candidates: all accounts from ordered that are not yet initialized
        // Pass the full ordered list to allow fallback if target accounts fail
        // The background task will stop when poolSize is reached
        // Convert activeContexts to canonical indices to handle duplicate accounts
        const activeContextsRaw = new Set([...this.contexts.keys()].filter(idx => !toRemove.includes(idx)));
        const activeContexts = new Set(
            [...activeContextsRaw].map(idx => this.authSource.getCanonicalIndex(idx) ?? idx)
        );
        // Don't filter out initializingContexts here - let _executePreloadTask handle it
        // This ensures that if a background task is aborted, the account will be retried
        // If a foreground task is running, _executePreloadTask will skip it (line 1382)
        const candidates = ordered.filter(idx => !activeContexts.has(idx));

        const { busy, idle } = this._prioritizeContextsForRemoval(toRemove);

        this.logger.info(
            `[ContextPool] Rebalance: targets=[${[...targets]}], removeNow=[${idle}], removeDeferred=[${busy.map(
                entry => entry.authIndex
            )}], candidates=[${candidates}]`
        );

        for (const idx of idle) {
            await this._closeContextForPoolIfPossible(idx, "rebalance");
        }

        for (const entry of busy) {
            this._scheduleContextClosureWhenIdle(entry.authIndex, "rebalance");
        }

        // Preload candidates if ready and initializing contexts still leave room in the pool
        const poolOccupancy = this.contexts.size + this.initializingContexts.size;
        if (candidates.length > 0 && (isUnlimited || poolOccupancy < maxContexts)) {
            this._preloadBackgroundContexts(candidates, isUnlimited ? 0 : maxContexts);
        }
    }

    /**
     * Wait for a background context initialization to complete
     * @param {number} authIndex - The auth index to wait for
     * @param {number} timeoutMs - Timeout in milliseconds
     */
    async _waitForContextInit(authIndex, timeoutMs = 120000) {
        const task = this._contextInitTasks.get(authIndex);
        if (task) {
            try {
                return await task;
            } catch (_) {
                return undefined;
            }
        }
        const start = Date.now();
        while (this.initializingContexts.has(authIndex)) {
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Timeout waiting for context #${authIndex} initialization`);
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }

    /**
     * Return the sole in-flight initialization for an account, or synchronously
     * claim ownership and create it. The owner that publishes the Promise is
     * also the only code allowed to release the tracking markers.
     */
    _getOrStartContextInit(authIndex, options = {}) {
        if (this.benefitCheckingIndices?.has(authIndex))
            return Promise.reject(new ContextAbortedError(authIndex, "benefit check in progress"));
        if (this.isClosingIntentionally || (this._recovering && this._recoveryAuthIndex !== authIndex))
            return Promise.reject(new ContextAbortedError(authIndex, "browser recovering"));
        const existing = this._contextInitTasks.get(authIndex);
        if (existing) return existing;

        // Legacy callers must use the same admission rule when the scheduler is active.
        if (this.scheduler?.config?.readyContextOnly && !options.capacityReservation) {
            const reservation = this._reserveContextCapacity(authIndex);
            if (!reservation)
                return Promise.reject(
                    new ContextAbortedError(authIndex, "waiting for context capacity; use ensureWorkerContext")
                );
            options = { ...options, capacityReservation: reservation };
        }

        this._contextInitSequence = (this._contextInitSequence || 0) + 1;
        const startedAt = Date.now();
        const attempt = {
            aborted: false,
            abortReason: null,
            authIndex,
            connectionEpoch: this.connectionRegistry?.getConnectionEpoch?.(authIndex) ?? null,
            context: null,
            deadlineAt: startedAt + (this.contextInitTotalTimeoutMs || 180000),
            id: `${authIndex}:${this._contextInitSequence}`,
            operation: null,
            operationStartedAt: null,
            page: null,
            phase: "queued",
            phaseStartedAt: startedAt,
            settled: false,
            startedAt,
            ws: { failed: false, success: false },
        };
        const isBackgroundTask = options.isBackgroundTask === true;
        const runner =
            options.runner || (currentAttempt => this._initializeContext(authIndex, isBackgroundTask, currentAttempt));

        this.initializingContexts.add(authIndex);
        this._contextInitAttempts ||= new Map();
        this._contextInitAttempts.set(authIndex, attempt);
        this._wsInitState ||= new Map();
        this._wsInitState.set(authIndex, attempt.ws); // Observability only; never read for correctness.
        this.logger.info(`[Context#${authIndex}] init_started attempt=${attempt.id}`);
        const runnerTask = Promise.resolve().then(() => runner(attempt));
        const cancellationTask = new Promise((_, reject) => {
            attempt.cancel = reason => {
                attempt.aborted = true;
                attempt.abortReason = reason;
                reject(new ContextAbortedError(authIndex, reason));
            };
        });
        runnerTask.catch(() => {});
        runnerTask.then(
            () => {
                if (attempt.aborted)
                    this.logger.warn(
                        `[Context#${authIndex}] context_init_late_settlement attempt=${attempt.id} outcome=resolved ignored=true`
                    );
            },
            () => {
                if (attempt.aborted)
                    this.logger.warn(
                        `[Context#${authIndex}] context_init_late_settlement attempt=${attempt.id} outcome=rejected ignored=true`
                    );
            }
        );
        let watchdogTimer;
        const watchdogTask = new Promise((_, reject) => {
            watchdogTimer = setTimeout(() => {
                const error = this._contextInitTimeoutError(attempt);
                this._handleContextInitWatchdog(attempt).catch(cleanupError =>
                    this.logger.error(
                        `[Context#${authIndex}] context_init_cleanup_failed attempt=${attempt.id} error=${JSON.stringify(cleanupError.message)}`
                    )
                );
                reject(error);
            }, this.contextInitTotalTimeoutMs || 180000);
        });
        const task = Promise.race([runnerTask, watchdogTask, cancellationTask])
            .catch(error => {
                if (!options.onError) throw error;
                options.onError(error);
            })
            .finally(() => {
                clearTimeout(watchdogTimer);
                attempt.cancel = null;
                attempt.settled = true;
                let released = false;
                if (
                    this._contextInitTasks.get(authIndex) === task &&
                    this._contextInitAttempts.get(authIndex) === attempt
                ) {
                    this._contextInitTasks.delete(authIndex);
                    this._contextInitAttempts.delete(authIndex);
                    this.initializingContexts.delete(authIndex);
                    this.abortedContexts.delete(authIndex);
                    this._releaseContextCapacity(authIndex, options.capacityReservation);
                    released = true;
                }
                this.logger.info(
                    `[Context#${authIndex}] init_finished attempt=${attempt.id} released=${released} initializing_count=${this.initializingContexts.size} pending_init=${this._contextInitTasks.size}`
                );
                if (released) {
                    // Pool callbacks decide whether capacity permits another scheduling pass.
                    if (options.onSettledAfterRelease) options.onSettledAfterRelease();
                    else this.scheduler?.drain?.();
                }
            });
        this._contextInitTasks.set(authIndex, task);
        return task;
    }

    /**
     * Initialize a single context for the given auth index
     * This is a helper method used by both preloadContextPool and launchOrSwitchContext
     * @param {number} authIndex - The auth index to initialize
     * @param {boolean} isBackgroundTask - Whether this is a background preload task (can be aborted by _backgroundPreloadAbort)
     * @returns {Promise<{context, page}>}
     */
    async _initializeContext(authIndex, isBackgroundTask = false, attempt = null) {
        let context = null;
        let page = null;

        if (!attempt) {
            throw Object.assign(new Error("Context initialization must be started through single-flight ownership"), {
                reason: "state_tracking_invariant_violation",
            });
        }
        const logPrefix = `[Context#${authIndex} attempt=${attempt.id}]`;

        try {
            this._setInitPhase(attempt, "preparing");
            this._assertCurrentInitAttempt(attempt);
            // Check if this context has been marked for abort before starting
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            let proxyInfo = this._proxyResolver
                ? await this._proxyResolver(authIndex)
                : (() => {
                      const stickyProxy = this.stickyProxyManager.getProxyForAuth(authIndex);
                      return stickyProxy
                          ? { ...stickyProxy, source: "sticky_proxy_file" }
                          : { proxy: parseProxyFromEnv(), source: parseProxyFromEnv() ? "environment" : "direct" };
                  })();
            proxyInfo = snapshotEgress(proxyInfo);
            const proxyConfig = proxyInfo?.proxy || null;
            attempt.proxyInfo = proxyInfo;
            if (proxyInfo?.source === "sticky_proxy_file") {
                this.logger.info(
                    `[Context#${authIndex}] Using sticky proxy for account "${proxyInfo.accountKey}": ${proxyInfo.display}`
                );
            } else if (proxyInfo?.source === "mihomo_pool") {
                this.logger.info(
                    `[Context#${authIndex}] Using Mihomo node ${proxyInfo.appliedNodeId} via ${proxyInfo.display}`
                );
            }
            const storageStateObject = this.authSource.getAuth(authIndex);
            attempt.sessionVersion = storageStateObject?._accountSessionVersion || 0;
            if (!storageStateObject) {
                throw new Error(`Failed to get or parse auth source for index ${authIndex}.`);
            }

            // Viewport Randomization
            const randomWidth = 1920 + Math.floor(Math.random() * 50);
            const randomHeight = 1080 + Math.floor(Math.random() * 50);

            // Check abort status before expensive operations
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            attempt.browserGeneration = this.browserGeneration;
            this._setInitPhase(attempt, "context_creation");
            context = await this._createBrowserContext(
                {
                    deviceScaleFactor: 1,
                    storageState: storageStateObject,
                    viewport: { height: randomHeight, width: randomWidth },
                    ...(proxyConfig ? { proxy: proxyConfig } : {}),
                },
                authIndex
            );
            attempt.context = context;

            // Check abort status after context creation
            this._assertCurrentInitAttempt(attempt);
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            // Inject Privacy Script immediately after context creation
            this._setInitPhase(attempt, "page_creation");
            const privacyScript = this._getPrivacyProtectionScript(authIndex);
            await this._runInitOperation(attempt, "context.addInitScript", () => context.addInitScript(privacyScript));

            page = await this._runInitOperation(attempt, "context.newPage", () => context.newPage());
            page.accountSessionVersion = storageStateObject._accountSessionVersion || 0;
            attempt.page = page;
            const benefitAccountId = accountForIndex(this.authSource, authIndex).accountId;
            const benefit = new BuildBenefitContext(page, {
                authIndex,
                canUse: () =>
                    canUseModel(
                        accountForIndex(this.authSource, authIndex),
                        "gemini-4-argon",
                        this.config?.scheduler?.modelAllowlist
                    ),
                isCurrent: () => {
                    const service = this.authSource?.accountLoginService;
                    const session = service?.state?.accounts.find(account => account.authIndex === authIndex);
                    return (
                        page.buildBenefit === benefit &&
                        attempt.browserGeneration === this.browserGeneration &&
                        (!service?.state ||
                            (session?.accountId === benefitAccountId &&
                                session?.sessionVersion === page.accountSessionVersion &&
                                !service.invalidated.has(authIndex)))
                    );
                },
                onChange: () => {
                    if (this.scheduler) {
                        this.scheduler.noteBenefitState?.(authIndex, benefit.state);
                        this.scheduler._eligibleRound = null;
                        this.scheduler._selectionPass = null;
                        this.scheduler.drain();
                    }
                },
                onObservation: result => {
                    const service = this.authSource?.accountLoginService;
                    if (service && benefitAccountId)
                        service
                            .recordBenefit(
                                benefitAccountId,
                                page.accountSessionVersion,
                                result,
                                () => benefit.isCurrent() && !benefit.disposed
                            )
                            .catch(() => {});
                },
            });
            page.buildBenefit = benefit;
            benefit.dispatcher = true;
            const bridge = new PlaygroundTransport({
                authIndex,
                benefit,
                context,
                logger: this.logger,
                page,
                requireRegistration: true,
                timeoutMs: this.config?.makerSuiteTimeoutMs,
                validateSession: () => this._diagnoseMakerSuiteSession(page),
            });
            bridge.resources = this.playgroundResources;
            page.makerSuiteBridge = bridge;
            page.playgroundTransport = bridge;
            await this._runInitOperation(attempt, "benefit.install", () => benefit.install());
            await this._runInitOperation(attempt, "makersuite.install", () => bridge.install());

            // Pure JS Wakeup (Focus & Mouse Movement)
            // Skip focus operations for background tasks to avoid window focus conflicts
            if (!isBackgroundTask) {
                try {
                    this._setInitPhase(attempt, "page_wakeup");
                    await this._runInitOperation(attempt, "page.bringToFront", () => page.bringToFront());
                    // eslint-disable-next-line no-undef
                    await this._runInitOperation(attempt, "page.focus.evaluate", () =>
                        page.evaluate(() => globalThis.window.focus())
                    );
                    const vp = page.viewportSize() || { height: 1080, width: 1920 };
                    const startX = Math.floor(Math.random() * (vp.width * 0.5));
                    const startY = Math.floor(Math.random() * (vp.height * 0.5));
                    await this._simulateHumanMovement(page, startX, startY, attempt);
                } catch (e) {
                    if (e?.code === "PLAYWRIGHT_RPC_TIMEOUT") throw e;
                    this.logger.warn(`[Context#${authIndex}] Wakeup minor error: ${e.message}`);
                }
            } else {
                this.logger.debug(`[Context#${authIndex}] Skipping focus operations for background task`);
            }

            page.on("console", msg => {
                const msgText = msg.text();
                if (
                    page.playgroundTransport?.bootstrapping &&
                    msgText.includes("MakerSuiteService/GenerateContent") &&
                    msgText.includes("CORS request did not succeed")
                )
                    return;
                if (msgText.includes("Content-Security-Policy")) {
                    return;
                }

                // Filter out WebGL not supported warning (expected when GPU is disabled for privacy)
                if (msgText.includes("WebGL not supported")) {
                    return;
                }

                if (msgText.includes("downloadable font: download failed")) {
                    return;
                }

                if (msgText.includes("[ProxyClient]")) {
                    const forwardedMessage = `${logPrefix} ${msgText.replace("[ProxyClient] ", "")}`;
                    const browserLogType = msg.type();

                    if (browserLogType === "debug") {
                        this.logger.debug(forwardedMessage);
                    } else if (browserLogType === "warning") {
                        this.logger.warn(forwardedMessage);
                    } else if (browserLogType === "error") {
                        this.logger.error(forwardedMessage);
                    } else {
                        this.logger.info(forwardedMessage);
                    }
                } else if (msg.type() === "error") {
                    this.logger.error(`${logPrefix} [Page Error] ${msgText}`);
                }

                // Check for WebSocket initialization status
                if (msgText.includes("Connection successful")) {
                    this.logger.debug(`${logPrefix} ✅ Detected successful WebSocket connection from browser`);
                    attempt.ws.success = true;
                } else if (msgText.includes("WebSocket initialization failed")) {
                    this.logger.warn(`${logPrefix} ❌ Detected WebSocket initialization failure from browser`);
                    attempt.ws.failed = true;
                }
            });

            // Check abort status before navigation (most time-consuming part)
            this._assertCurrentInitAttempt(attempt);
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            try {
                this._setInitPhase(attempt, "navigation");
                await this._navigateAndWakeUpPage(page, logPrefix, attempt);
            } catch (error) {
                if (!error.reason) error.reason = "navigation_timeout";
                if (!error.code) error.code = "NAVIGATION_TIMEOUT";
                Object.assign(error, {
                    attemptId: attempt.id,
                    authIndex,
                    phase: attempt.phase,
                });
                throw error;
            }

            // Check abort status after navigation
            this._assertCurrentInitAttempt(attempt);
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            this._setInitPhase(attempt, "page_validation");
            await this._checkPageStatusAndErrors(page, logPrefix, authIndex, attempt);

            this._assertCurrentInitAttempt(attempt);
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            this._setInitPhase(attempt, "playground_initialization");
            await this._runInitOperation(attempt, "playground.bootstrap", () => bridge.bootstrap(), WS_INIT_TIMEOUT_MS);
            this._assertCurrentInitAttempt(attempt);
            bridge.connect(this.connectionRegistry, attempt);

            // Required anti-idle movement, including connections established before the wait loop.
            this._setInitPhase(attempt, "required_mouse");
            await this._simulateHumanMovement(page, 1, 1, attempt);
            attempt.mouseReady = true;

            // Final check before adding to contexts map
            this._setInitPhase(attempt, "publishing");
            this._assertCurrentInitAttempt(attempt);
            this._throwIfContextInitAborted(authIndex, isBackgroundTask);

            // Save to contexts map - with atomic abort check to prevent race condition
            // between the check above and actually adding to the map
            if (
                this._isCurrentInitAttempt(attempt) &&
                !this.abortedContexts.has(authIndex) &&
                !(isBackgroundTask && this._backgroundPreloadAbort)
            ) {
                this.contexts.set(authIndex, {
                    attemptId: attempt.id,
                    browserGeneration: attempt.browserGeneration,
                    context,
                    createdAt: Date.now(),
                    healthMonitorInterval: null,
                    lastRequestAt: 0,
                    mouseReady: attempt.mouseReady,
                    page,
                    proxyInfo,
                    sessionVersion: page.accountSessionVersion,
                    state: "READY",
                });
            } else {
                this._throwIfContextInitAborted(authIndex, isBackgroundTask);
            }

            // Refresh independently of READY publication. Ownership is checked before writing.
            this._assertCurrentInitAttempt(attempt);
            setImmediate(() => this._updateAuthFile(authIndex).catch(error => this.logger.warn(error.message)));

            return { context, page };
        } catch (error) {
            // Check if this is an abort error
            const isAbortError = isContextAbortedError(error);
            // Check if this is an auth expiration error
            const isAuthExpired = isAuthExpiredError(error);

            if (isAbortError) {
                this.logger.info(`[Browser] Context #${authIndex} initialization aborted as requested.`);
            } else if (isAuthExpired) {
                this.logger.error(
                    `❌ [Browser] Context initialization failed for index ${authIndex} (auth expired), cleaning up...`
                );
                // Auth is already marked as expired in _checkPageStatusAndErrors
            } else {
                this.logger.error(`❌ [Browser] Context initialization failed for index ${authIndex}, cleaning up...`);
            }

            // Save debug artifacts before closing the page (only for non-abort errors)
            if (
                !isAbortError &&
                error?.code !== "PLAYWRIGHT_RPC_TIMEOUT" &&
                error?.code !== "CONTEXT_INIT_TOTAL_TIMEOUT" &&
                page &&
                !page.isClosed()
            ) {
                await this._saveDebugArtifacts("init_failed", authIndex, page);
            }

            // Remove from contexts map if it was added
            const current = this.contexts.get(authIndex);
            if (current?.attemptId === attempt.id) {
                this.contexts.delete(authIndex);
                this.logger.info(`[Browser] Removed failed context #${authIndex} from contexts map`);
            }

            // Close context if it was created
            if (context) await this._closeAttemptContext(attempt);
            throw error;
        }
    }

    async launchOrSwitchContext(authIndex) {
        if (this.benefitCheckingIndices?.has(authIndex))
            throw new ContextAbortedError(authIndex, "benefit check in progress");
        if (typeof authIndex !== "number" || authIndex < 0) {
            this.logger.error(`[Browser] Invalid authIndex: ${authIndex}. authIndex must be >= 0.`);
            this._currentAuthIndex = -1;
            throw new Error(`Invalid authIndex: ${authIndex}. Must be >= 0.`);
        }

        if (this.scheduler) {
            await this.ensureWorkerContext(authIndex);
            const data = this.contexts.get(authIndex);
            return { context: data.context, page: data.page };
        }

        this._cancelPendingContextClosure(authIndex, "context_reused");

        // [Auth Switch] Save current auth data before switching
        if (this.browser && this._currentAuthIndex >= 0 && this._currentAuthIndex !== authIndex) {
            try {
                await this._updateAuthFile(this._currentAuthIndex);
            } catch (e) {
                this.logger.warn(`[Browser] Failed to save current auth during switch: ${e.message}`);
            }
        }

        // Wait for background initialization if in progress
        if (this.initializingContexts.has(authIndex)) {
            this.logger.info(`[Browser] Context #${authIndex} is being initialized in background, waiting...`);
            await this._waitForContextInit(authIndex);
        }

        // Check if browser is running, launch if needed
        if (!this.browser) {
            await this._ensureBrowser();
        }

        // Check if context already exists (fast switch path)
        if (this.contexts.has(authIndex)) {
            this.logger.info("==================================================");
            this.logger.info(`⚡ [FastSwitch] Switching to pre-loaded context for account #${authIndex}`);
            this.logger.info("==================================================");

            // Validate that the page is still alive before switching
            const contextData = this.contexts.get(authIndex);
            if (!contextData || !contextData.page || contextData.page.isClosed()) {
                this.logger.warn(
                    `[FastSwitch] Page for account #${authIndex} is closed, cleaning up and re-initializing...`
                );
                // Clean up the dead context
                await this.closeContext(authIndex);
                // Fall through to slow path to re-initialize
            } else {
                // Quick auth status check without navigation
                try {
                    const currentUrl = contextData.page.url();
                    const pageTitle = await contextData.page.title();

                    // Check if redirected to login page (auth expired)
                    if (
                        currentUrl.includes("accounts.google.com") ||
                        currentUrl.includes("ServiceLogin") ||
                        pageTitle.includes("Sign in") ||
                        pageTitle.includes("登录")
                    ) {
                        this.logger.error(
                            `[FastSwitch] Account #${authIndex} auth expired (redirected to login), marking as expired...`
                        );
                        // Mark auth as expired
                        await this.authSource.markAsExpired(authIndex, contextData.page.accountSessionVersion);
                        // Clean up the expired context
                        await this.closeContext(authIndex);
                        // Don't retry initialization - auth is expired, it will fail again
                        throw new AuthExpiredError();
                    } else {
                        // Page is alive and auth is valid, proceed with fast switch
                        // If this account was marked as expired but is now valid, restore it
                        if (this.authSource.isExpired(authIndex)) {
                            this.logger.info(
                                `[FastSwitch] Account #${authIndex} was expired but is now valid, restoring...`
                            );
                            await this.authSource.unmarkAsExpired(authIndex, contextData.page.accountSessionVersion);
                            // Note: rebalanceContextPool() will be called by the caller (AuthSwitcher)
                        }

                        // Stop background tasks for old context
                        if (this._currentAuthIndex >= 0 && this.contexts.has(this._currentAuthIndex)) {
                            const oldContextData = this.contexts.get(this._currentAuthIndex);
                            if (oldContextData.healthMonitorInterval) {
                                clearInterval(oldContextData.healthMonitorInterval);
                                oldContextData.healthMonitorInterval = null;
                            }
                        }

                        // Switch to new context
                        this._activateContext(contextData.context, contextData.page, authIndex);
                        await this._flushPendingContextClosures();

                        this.logger.info(`✅ [FastSwitch] Switched to account #${authIndex} instantly!`);
                        return;
                    }
                } catch (error) {
                    // Check if this is an auth expiration error
                    const isAuthExpired = isAuthExpiredError(error);

                    if (isAuthExpired) {
                        // Auth is expired, don't retry - just throw the error
                        throw error;
                    }

                    // For other errors, clean up and retry with slow path
                    this.logger.warn(
                        `[FastSwitch] Failed to check auth status for account #${authIndex}: ${error.message}, cleaning up and re-initializing...`
                    );
                    // Clean up the problematic context
                    await this.closeContext(authIndex);
                    // Fall through to slow path to re-initialize
                }
            }
        }

        // Context doesn't exist, need to initialize it (slow path)
        this.logger.info("==================================================");
        this.logger.info(`🔄 [Browser] Context for account #${authIndex} not found, initializing...`);
        this.logger.info("==================================================");

        // Check again if another caller started initializing while we were checking
        // This protects against race condition where multiple callers finish waiting
        // at the same time and all try to initialize the same context
        if (this.initializingContexts.has(authIndex)) {
            this.logger.info(`[Browser] Another caller is initializing context #${authIndex}, waiting...`);
            await this._waitForContextInit(authIndex);
            // After waiting, recursively call to use the fast path or retry
            return await this.launchOrSwitchContext(authIndex);
        }

        try {
            // Stop background tasks for old context
            if (this._currentAuthIndex >= 0 && this.contexts.has(this._currentAuthIndex)) {
                const oldContextData = this.contexts.get(this._currentAuthIndex);
                if (oldContextData.healthMonitorInterval) {
                    clearInterval(oldContextData.healthMonitorInterval);
                    oldContextData.healthMonitorInterval = null;
                }
            }

            // Initialize new context (isBackgroundTask=false for foreground initialization)
            const { context, page } = await this._getOrStartContextInit(authIndex);

            this._activateContext(context, page, authIndex);
            await this._flushPendingContextClosures();

            // If this account was marked as expired but login succeeded, restore it
            if (this.authSource.isExpired(authIndex)) {
                this.logger.info(`[Browser] Account #${authIndex} was expired but login succeeded, restoring...`);
                await this.authSource.unmarkAsExpired(authIndex, page.accountSessionVersion);
                // Note: rebalanceContextPool() will be called by the caller (AuthSwitcher)
            }

            this.logger.info("==================================================");
            this.logger.info(`✅ [Browser] Account ${authIndex} context initialized successfully!`);
            this.logger.info("✅ [Browser] Browser client is ready.");
            this.logger.info("==================================================");
        } catch (error) {
            this.logger.error(`❌ [Browser] Account ${authIndex} context initialization failed: ${error.message}`);
            // Debug artifacts are already saved in _initializeContext's catch block

            // Clean up if HealthMonitor was started
            if (this.contexts.has(authIndex)) {
                const contextData = this.contexts.get(authIndex);
                if (contextData.healthMonitorInterval) {
                    clearInterval(contextData.healthMonitorInterval);
                    this.logger.info(`[Browser] Cleaned up health monitor for failed context #${authIndex}`);
                }
            }

            // Reset state
            this.context = null;
            this.page = null;
            this._currentAuthIndex = -1;
            // DO NOT reset backgroundWakeupRunning here!
            // If a BackgroundWakeup was running, it will detect this.page === null and exit on its own.
            // Resetting the flag here could allow a new instance to start before the old one exits.

            throw error;
        }
    }

    /**
     * Lightweight Reconnect: Refreshes the page and clicks "Continue to the app" button
     * without restarting the entire browser instance.
     *
     * This method is called when WebSocket connection is lost but the browser
     * process is still running. It's much faster than a full browser restart.
     *
     * @returns {Promise<boolean>} true if reconnect was successful, false otherwise
     */
    /**
     * Attempt lightweight reconnect for a specific account
     * Refreshes the page and re-injects the proxy script without restarting the browser
     * @param {number} authIndex - The auth index to reconnect (defaults to current if not specified)
     * @returns {Promise<boolean>} true if reconnect was successful, false otherwise
     */
    async attemptLightweightReconnect(authIndex = null) {
        // Use provided authIndex or fall back to current
        const targetAuthIndex = authIndex !== null ? authIndex : this._currentAuthIndex;

        if (targetAuthIndex < 0) {
            this.logger.warn("[Reconnect] Invalid auth index, cannot perform lightweight reconnect.");
            return false;
        }

        // Get the context data for this account
        const contextData = this.contexts.get(targetAuthIndex);
        if (!contextData || !contextData.page) {
            this.logger.warn(
                `[Reconnect] No context found for account #${targetAuthIndex}, cannot perform lightweight reconnect.`
            );
            return false;
        }

        const page = contextData.page;

        // Verify browser and page are still valid
        if (!this.browser || !page) {
            this.logger.warn(
                `[Reconnect] Browser or page is not available for account #${targetAuthIndex}, cannot perform lightweight reconnect.`
            );
            return false;
        }

        // Check if page is closed
        if (page.isClosed()) {
            this.logger.warn(
                `[Reconnect] Page is closed for account #${targetAuthIndex}, cannot perform lightweight reconnect.`
            );
            return false;
        }

        this.logger.info("==================================================");
        this.logger.info(`🔄 [Reconnect] Starting lightweight reconnect for account #${targetAuthIndex}...`);
        this.logger.info("==================================================");

        // Stop existing background tasks only if this is the current account
        const isCurrentAccount = targetAuthIndex === this._currentAuthIndex;
        if (isCurrentAccount) {
            const ctxData = this.contexts.get(targetAuthIndex);
            if (ctxData && ctxData.healthMonitorInterval) {
                clearInterval(ctxData.healthMonitorInterval);
                ctxData.healthMonitorInterval = null;
                this.logger.info("[Reconnect] Stopped background health monitor.");
            }
        }

        if (page.playgroundTransport) {
            const transport = page.playgroundTransport;
            try {
                contextData.state = "RECONNECTING";
                transport.connection?.close();
                await this._navigateAndWakeUpPage(page, "[Reconnect]");
                await this._checkPageStatusAndErrors(page, "[Reconnect]", targetAuthIndex);
                await this._runInitOperation(
                    null,
                    "playground.bootstrap",
                    () => transport.bootstrap(),
                    WS_INIT_TIMEOUT_MS
                );
                if (this.contexts.get(targetAuthIndex) !== contextData || contextData.draining) return false;
                await this._simulateHumanMovement(page, 1, 1);
                transport.connect(this.connectionRegistry, contextData);
                contextData.state = "READY";
                await this._updateAuthFile(targetAuthIndex);
                this._startHealthMonitor(targetAuthIndex);
                return true;
            } catch (error) {
                contextData.state = "UNAVAILABLE";
                if (isAuthExpiredError(error)) await this.closeContext(targetAuthIndex);
                return false;
            }
        }

        const reconnectAttempt = {
            authIndex: targetAuthIndex,
            connectionEpoch: this.connectionRegistry?.getConnectionEpoch?.(targetAuthIndex) ?? null,
            id: `reconnect:${targetAuthIndex}:${Date.now()}`,
            startedAt: Date.now(),
            ws: { failed: false, success: false },
        };
        const reconnectConsoleListener = msg => {
            const text = msg.text();
            if (text.includes("Connection successful")) reconnectAttempt.ws.success = true;
            if (text.includes("WebSocket initialization failed")) reconnectAttempt.ws.failed = true;
        };
        page.on("console", reconnectConsoleListener);

        try {
            // Keep this map for diagnostics; the waiter reads reconnectAttempt directly.
            this._wsInitState.set(targetAuthIndex, reconnectAttempt.ws);
            this.logger.info("[Reconnect] Reset WebSocket initialization state");

            // Navigate to target page and wake it up
            await this._navigateAndWakeUpPage(page, "[Reconnect]");

            // Check for cookie expiration, region restrictions, and other errors
            await this._checkPageStatusAndErrors(page, "[Reconnect]", targetAuthIndex);

            // Wait for WebSocket initialization (no retry)
            // Check if initialization already succeeded (console listener may have detected it)
            if (reconnectAttempt.ws.success || this._hasNewOpenConnection(reconnectAttempt)) {
                this.logger.info(`[Reconnect] ✅ WebSocket already initialized, skipping wait`);
            } else {
                // Wait for WebSocket initialization (120 second timeout)
                const initSuccess = await this._waitForWebSocketInit(
                    page,
                    "[Reconnect]",
                    WS_INIT_TIMEOUT_MS,
                    reconnectAttempt,
                    false
                );

                if (!initSuccess) {
                    this.logger.error("[Reconnect] WebSocket initialization failed.");
                    return false;
                }
            }

            await this._simulateHumanMovement(page, 1, 1);
            this._sendActiveTrigger("[Reconnect]", page);

            // [Auth Update] Save the refreshed cookies to the auth file immediately
            await this._updateAuthFile(targetAuthIndex);

            this.logger.info("==================================================");
            this.logger.info(`✅ [Reconnect] Lightweight reconnect successful for account #${targetAuthIndex}!`);
            this.logger.info("==================================================");

            // Restart background tasks only if this is the current account
            if (isCurrentAccount) {
                // Reset BackgroundWakeup state after reconnect
                this.noButtonCount = 0;
                this._startHealthMonitor();
                this._startBackgroundWakeup(); // Internal check prevents duplicate instances
            }

            return true;
        } catch (error) {
            // Check if this is an abort error (context was deleted during reconnect)
            const isAbortError = isContextAbortedError(error);
            // Check if this is an auth expiration error
            const isAuthExpired = isAuthExpiredError(error);

            if (isAbortError) {
                this.logger.info(
                    `[Reconnect] Lightweight reconnect aborted for account #${targetAuthIndex} (context deleted)`
                );
                return false;
            }

            if (isAuthExpired) {
                this.logger.error(
                    `❌ [Reconnect] Lightweight reconnect failed for account #${targetAuthIndex} (auth expired)`
                );
                // Auth is already marked as expired in _checkPageStatusAndErrors
                await this._saveDebugArtifacts("reconnect_expired", targetAuthIndex, page);
                // Close context for expired auth - it needs full re-initialization
                await this.closeContext(targetAuthIndex);
                return false;
            }

            this.logger.error(
                `❌ [Reconnect] Lightweight reconnect failed for account #${targetAuthIndex}: ${error.message}`
            );
            await this._saveDebugArtifacts("reconnect_failed", targetAuthIndex, page);
            // Keep context for non-expired failures - next request will try to refresh the page
            return false;
        } finally {
            page.off?.("console", reconnectConsoleListener);
        }
    }

    /**
     * Close a single context for a specific account
     *
     * IMPORTANT: When deleting an account, always call this method BEFORE closeConnectionByAuth()
     * Calling order: closeContext() -> closeConnectionByAuth()
     *
     * Reason: This method removes the context from the contexts Map BEFORE closing it.
     * When context.close() triggers WebSocket disconnect, ConnectionRegistry._removeConnection()
     * will check if the context still exists. If not found, it skips reconnect logic.
     * If you call closeConnectionByAuth() first, _removeConnection() will see the context
     * still exists and may trigger unnecessary reconnect attempts.
     *
     * @param {number} authIndex - The auth index to close
     */
    async closeContext(authIndex, { keepBrowser = false, skipInitWait = false } = {}) {
        this.pendingContextClosures.delete(authIndex);

        // If context is being initialized in background, signal abort and wait
        if (!skipInitWait && this.initializingContexts.has(authIndex)) {
            this.logger.info(`[Browser] Context #${authIndex} is being initialized, marking for abort and waiting...`);
            this.abortedContexts.add(authIndex);
            await this._waitForContextInit(authIndex);
            this.abortedContexts.delete(authIndex);
        }

        if (!this.contexts.has(authIndex)) {
            // Context doesn't exist (was never initialized or was aborted)
            // Still check if we need to close the browser
            // Only close if there are no contexts AND no contexts being initialized
            if (!keepBrowser && this.contexts.size === 0 && this.initializingContexts.size === 0 && this.browser) {
                this.logger.info(`[Browser] All contexts closed, closing browser instance...`);
                await this.closeBrowser();
            }
            return;
        }

        const contextData = this.contexts.get(authIndex);
        contextData.page?.makerSuiteBridge?.dispose();
        contextData.page?.buildBenefit?.dispose();
        this._closingContextOwners ??= new Map();
        this._closingContextOwners.set(authIndex, contextData);
        this.closingContexts.add(authIndex);
        this._poolClosingContexts ??= new Set();
        this._poolClosingContexts.add(authIndex);

        // Stop health monitor for this context
        if (contextData.healthMonitorInterval) {
            clearInterval(contextData.healthMonitorInterval);
            contextData.healthMonitorInterval = null;
            this.logger.info(`[Browser] Stopped health monitor for context #${authIndex}`);
        }

        // Remove from contexts map FIRST, before closing context
        // This ensures that when context.close() triggers WebSocket disconnect,
        // _removeConnection will see that the context is already gone and skip reconnect logic
        this.contexts.delete(authIndex);

        // Proactively close message queues BEFORE closing context to prevent race condition
        // Race condition: context.close() triggers async WebSocket 'close' event, which calls _removeConnection()
        // But _removeConnection() executes later in event loop, after switchAccount() may have updated currentAuthIndex
        // So we must close queues NOW for ANY account being closed (current or not)
        if (this.connectionRegistry) {
            const isCurrent = this._currentAuthIndex === authIndex;
            this.logger.info(
                `[Browser] Proactively closing message queues for account #${authIndex}${isCurrent ? " (current account)" : ""}`
            );
            this.connectionRegistry.closeMessageQueuesForAuth(authIndex, "context_closed");
        }

        // If this was the current context, reset current references
        if (this._currentAuthIndex === authIndex) {
            this.context = null;
            this.page = null;
            this._currentAuthIndex = -1;
            // DO NOT reset backgroundWakeupRunning here!
            // If a BackgroundWakeup was running, it will detect this.page === null and exit on its own.
            // Resetting the flag here could allow a new instance to start before the old one exits.
            this.logger.debug(`[Browser] Current context was closed, currentAuthIndex reset to -1.`);
        }

        // Close the context AFTER removing from map
        try {
            if (contextData.context) {
                const closing = this._closeTrackedContext(contextData, authIndex);
                await withHardTimeout(() => closing, this.contextCleanupTimeoutMs || 5000);
                this.logger.info(`[Browser] Context #${authIndex} closed.`);
            }
        } catch (e) {
            this.logger.warn(`[Browser] Error closing context #${authIndex}: ${e.message}`);
            this._considerCleanupRecovery();
        } finally {
            this._poolClosingContexts.delete(authIndex);
            this.scheduler?.coordinateContextPool?.();
            const cleanupTimer = setTimeout(() => {
                if (this._closingContextOwners.get(authIndex) !== contextData) return;
                this._closingContextOwners.delete(authIndex);
                this.closingContexts.delete(authIndex);
            }, 1000);
            cleanupTimer.unref?.();
        }

        // If this was the last context, close the browser to free resources
        // This ensures a clean state when all accounts are deleted
        // Only close if there are no contexts AND no contexts being initialized
        if (!keepBrowser && this.contexts.size === 0 && this.initializingContexts.size === 0 && this.browser) {
            this.logger.info(`[Browser] All contexts closed, closing browser instance...`);
            await this.closeBrowser();
        }
    }

    /**
     * Helper: Clean up all context resources (health monitors, etc.)
     * Called when browser is closing or has disconnected
     */
    _cleanupAllContexts() {
        // Clean up all context health monitors
        for (const [authIndex, contextData] of this.contexts.entries()) {
            contextData.page?.makerSuiteBridge?.dispose();
            contextData.page?.buildBenefit?.dispose();
            if (contextData.healthMonitorInterval) {
                clearInterval(contextData.healthMonitorInterval);
                contextData.healthMonitorInterval = null;
                this.logger.info(`[Browser] Stopped health monitor for context #${authIndex}`);
            }
        }

        // Reset all references
        for (const attempt of this._contextInitAttempts?.values() || []) {
            attempt.page?.makerSuiteBridge?.dispose();
            attempt.page?.buildBenefit?.dispose();
            attempt.cancel?.("browser reset");
        }
        this.contexts.clear();
        this.contextCapacityReservations?.clear();
        this._contextPoolReplacements?.clear();
        for (const entry of this._contextClosureTasks?.values() || []) clearTimeout(entry.timer);
        this._contextClosureTasks?.clear();
        this._contextCapacityClosures?.clear();
        this._poolClosingContexts?.clear();
        this.initializingContexts.clear();
        this.abortedContexts.clear();
        this.pendingContextClosures.clear();
        this.closingContexts.clear();
        this._closingContextOwners?.clear();
        this._wsInitState.clear();
        this._contextCreationQueue = Promise.resolve();
        this.context = null;
        this.page = null;
        this._currentAuthIndex = -1;
        // DO NOT reset backgroundWakeupRunning here!
        // If a BackgroundWakeup was running, it will detect this.page === null and exit on its own.
        // Resetting the flag here could allow a new instance to start before the old one exits.
    }

    /**
     * Unified cleanup method for the main browser instance.
     * Handles intervals, timeouts, and resetting all references.
     * In multi-context mode, cleans up all contexts.
     */
    closeBrowser() {
        if (this._closeBrowserTask) return this._closeBrowserTask;
        // Block admission synchronously, before waiting on an in-flight launch.
        this.isClosingIntentionally = true;
        const task = this._withBrowserLifecycle(async () => {
            const browser = this.browser;
            this.browserState = "CLOSING";
            for (const attempt of this._contextInitAttempts?.values() || []) attempt.cancel?.("browser closing");
            try {
                if (browser) await withHardTimeout(() => browser.close(), this.contextCleanupTimeoutMs || 5000);
                if (this.browser === browser) {
                    this.browser = null;
                    this._cleanupAllContexts();
                }
                const tasks = [...(this._contextInitTasks?.values() || [])];
                if (tasks.length)
                    await withHardTimeout(() => Promise.allSettled(tasks), this.contextCleanupTimeoutMs || 5000);
                this.browserState = this._recovering ? "RECOVERING" : "STOPPED";
            } catch (error) {
                this._requestApplicationRecovery("browser_close_timeout");
                throw error;
            } finally {
                this.isClosingIntentionally = false;
            }
        });
        this._closeBrowserTask = task;
        task.finally(() => {
            if (this._closeBrowserTask === task) this._closeBrowserTask = null;
        }).catch(() => {});
        return task;
    }

    async switchAccount(newAuthIndex) {
        this.logger.info(`🔄 [Browser] Starting account switch: from ${this._currentAuthIndex} to ${newAuthIndex}`);
        await this.launchOrSwitchContext(newAuthIndex);
        this.logger.info(`✅ [Browser] Account switch completed, current account: ${this._currentAuthIndex}`);
    }
}

module.exports = BrowserManager;
