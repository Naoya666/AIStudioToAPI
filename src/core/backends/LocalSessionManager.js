const BrowserManager = require("../BrowserManager");
const { LocalEngine, unavailable } = require("./LocalEngine");
const { LocalTransport } = require("./LocalTransport");
const { parseProxyFromEnv } = require("../../utils/ProxyUtils");
const { snapshotEgress } = require("../../proxy/ProxyEgressIdentity");
const { withHardTimeout } = require("../../utils/TimeoutUtils");

function proxyURL(proxy) {
    if (!proxy) return "";
    const url = new URL(proxy.server);
    if (proxy.username) url.username = proxy.username;
    if (proxy.password) url.password = proxy.password;
    return url.href;
}

// Reuse the existing account pool/admission/egress policy. Only session lifecycle
// differs; local records contain transport/benefit and never page/context objects.
class LocalSessionManager extends BrowserManager {
    constructor(logger, config, authSource, engine = new LocalEngine({ logger })) {
        super(logger, config, authSource);
        this.backend = "local";
        this.engine = engine;
        engine.on("unavailable", () => {
            this.browserGeneration++;
            for (const [index, data] of this.contexts) {
                data.transport.dispose();
                clearInterval(data.healthMonitorInterval);
                this.contextUnavailable.set(index, {
                    at: Date.now(),
                    error: unavailable(),
                    reason: "local_engine_exit",
                });
            }
            this.contexts.clear();
            this.scheduler?.drain();
        });
    }
    _ensureBrowser() {
        return this.engine.ensure();
    }
    _ensureBrowserForPool() {
        return this.engine.ensure();
    }
    _startBackgroundWakeup() {
        return Promise.resolve();
    }
    _activateContext(_context, _page, index) {
        this._currentAuthIndex = index;
    }
    notifyUserActivity(index = this.currentAuthIndex) {
        this.markContextRequest(index);
    }
    isContextReady(index) {
        const data = this.contexts.get(index);
        const transport = data?.transport;
        return !!(
            data &&
            !data.draining &&
            !["UNAVAILABLE", "RECONNECTING"].includes(data.state) &&
            data.browserGeneration === this.browserGeneration &&
            transport?.ready &&
            !transport.closed &&
            this.engine.ready &&
            transport.connection?.readyState === 1 &&
            this.connectionRegistry?.getConnectionByAuth(index, false) === transport.connection
        );
    }
    async _initializeContext(index, _background, attempt) {
        this._assertCurrentInitAttempt(attempt);
        await this.engine.ensure();
        const storage = this.authSource.getAuth(index);
        if (!storage) throw unavailable();
        attempt.sessionVersion = storage._accountSessionVersion || 0;
        attempt.browserGeneration = this.browserGeneration;
        const selected = this._proxyResolver
            ? await this._proxyResolver(index)
            : this.stickyProxyManager.getProxyForAuth(index) || { proxy: parseProxyFromEnv() };
        const proxyInfo = snapshotEgress(selected);
        attempt.proxyInfo = proxyInfo;
        const controller = new AbortController();
        const oldCancel = attempt.cancel;
        attempt.cancel = reason => {
            controller.abort();
            oldCancel?.(reason);
        };
        let session;
        try {
            session = await this.engine.json(
                "POST",
                "/sessions",
                {
                    // Existing saved auth contexts contain one Google account (authuser=0).
                    authUser: storage.authUser ?? 0,

                    model: "gemini-3.8-flash",

                    proxy: proxyURL(proxyInfo.proxy),
                    state: { cookies: storage.cookies, origins: storage.origins || [] },
                },
                { signal: controller.signal, timeoutMs: Math.max(1, attempt.deadlineAt - Date.now()) }
            );
            this._assertCurrentInitAttempt(attempt);
            await this.engine.json(
                "POST",
                `/sessions/${session.id}/activate`,
                {},
                { signal: controller.signal, timeoutMs: 5000 }
            );
            this._assertCurrentInitAttempt(attempt);
            const transport = new LocalTransport({
                authIndex: index,
                catalog: session.catalog,
                engine: this.engine,
                logger: this.logger,
                resources: this.playgroundResources,
                session: session.id,
                timeoutMs: this.config.makerSuiteTimeoutMs,
            });
            const data = {
                attemptId: attempt.id,
                benefit: transport.benefit,
                browserGeneration: this.browserGeneration,
                createdAt: Date.now(),
                proxyInfo,
                sessionVersion: attempt.sessionVersion,
                state: "READY",
                transport,
            };
            this.contexts.set(index, data);
            transport.connect(this.connectionRegistry, attempt);
            this._assertCurrentInitAttempt(attempt);
            this.contextUnavailable.delete(index);
            this._startHealthMonitor(index);
            await this.recordBenefit(index, data);
            await this._updateAuthFile(index);
            return data;
        } catch (error) {
            const data = this.contexts.get(index);
            if (session && data?.transport.session === session.id) {
                this.contexts.delete(index);
                clearInterval(data.healthMonitorInterval);
                data.transport.dispose();
            }
            if (error.authState === "session_expired" && this._isCurrentInitAttempt(attempt))
                await this.authSource.markAsExpired?.(index, attempt.sessionVersion);
            if (session)
                await this.engine.json("DELETE", `/sessions/${session.id}`, null, { timeoutMs: 5000 }).catch(() => {});
            throw error;
        }
    }
    async _handleContextInitWatchdog(attempt) {
        if (!this._isCurrentInitAttempt(attempt)) return;
        attempt.cancel?.("local_session_init_timeout");
        this.logger.warn(`[Backend] backend=local account=${attempt.authIndex} event=init_timeout`);
        if (this.contexts.get(attempt.authIndex)?.attemptId === attempt.id)
            await this.closeContext(attempt.authIndex, { skipInitWait: true });
    }
    async recordBenefit(index, data) {
        const login = this.authSource.accountLoginService;
        const account = login?.state?.accounts.find(a => a.authIndex === index);
        if (account)
            await login.recordBenefit(
                account.accountId,
                data.sessionVersion,
                {
                    rawTier: data.benefit.rawTier,
                    reason: data.benefit.failureReason,
                    source: "normal-query",
                    state: data.benefit.state,
                },
                () => this.contexts.get(index) === data && !data.transport.closed
            );
    }
    _startHealthMonitor(index) {
        const data = this.contexts.get(index);
        if (!data || data.healthMonitorInterval) return;
        data.healthMonitorInterval = setInterval(() => this._updateAuthFile(index).catch(() => {}), 30000);
        data.healthMonitorInterval.unref();
    }
    async _updateAuthFile(index) {
        const data = this.contexts.get(index);
        if (!data || data.authUpdateRunning || !this.config.enableAuthUpdate || data.transport.closed) return;
        data.authUpdateRunning = true;
        try {
            const state = await this.engine.json("GET", `/sessions/${data.transport.session}/state`, null, {
                timeoutMs: 5000,
            });
            const login = this.authSource.accountLoginService;
            if (this.contexts.get(index) !== data) return;
            if (login?.state)
                await login.exclusive(
                    () => this.contexts.get(index) === data && login.refreshSession(index, data.sessionVersion, state)
                );
        } finally {
            data.authUpdateRunning = false;
        }
    }
    async launchOrSwitchContext(index) {
        if (this.scheduler) await this.ensureWorkerContext(index);
        else if (!this.isContextReady(index)) await this._getOrStartContextInit(index);
        this._currentAuthIndex = index;
        return this.contexts.get(index);
    }
    async attemptLightweightReconnect(index) {
        if (this.isContextReady(index)) return true;
        // Never reissue a request during recovery; only future admission can create a session.
        this.markContextState(index, "UNAVAILABLE", { reason: "local_engine_unavailable" });
        return false;
    }
    async closeContext(index, { skipInitWait = false } = {}) {
        if (!skipInitWait) this._contextInitAttempts.get(index)?.cancel?.("session closing");
        const data = this.contexts.get(index);
        if (!data) return;
        await withHardTimeout(() => this._updateAuthFile(index), 5000, {
            operation: "local session cookie persistence",
            status: 504,
        }).catch(() => {});
        if (this.contexts.get(index) !== data) return;
        this.contexts.delete(index);
        this.connectionRegistry?.cancelReconnect?.(index);
        this.connectionRegistry?.closeMessageQueuesForAuth?.(index, "context_closed");
        clearInterval(data.healthMonitorInterval);
        data.transport.dispose();
        this.pendingContextClosures.delete(index);
        await this.engine
            .json("DELETE", `/sessions/${data.transport.session}`, null, { timeoutMs: 5000 })
            .catch(() => {});
        this.scheduler?.drain();
    }
    async closeBrowser() {
        this.isClosingIntentionally = true;
        for (const attempt of this._contextInitAttempts.values()) attempt.cancel?.("service stopping");
        await Promise.allSettled(
            [...this.contexts.keys()].map(index => this.closeContext(index, { skipInitWait: true }))
        );
        await this.engine.close();
        this._currentAuthIndex = -1;
    }
    async preCleanupForSwitch(target) {
        return super.preCleanupForSwitch(target);
    }
    getContextPoolSnapshot() {
        return super.getContextPoolSnapshot().map(item => ({
            ...item,
            backend: "local",
            makersuite_active: this.getTransport(item.auth_index)?.active.size || 0,
        }));
    }
    async queryBenefit(index, signal) {
        const storage = this.authSource.getAuth(index);
        const selected = this._proxyResolver ? await this._proxyResolver(index) : { proxy: parseProxyFromEnv() };
        const session = await this.engine.json(
            "POST",
            "/sessions",
            {
                authUser: storage.authUser ?? 0,
                model: "gemini-3.8-flash",
                proxy: proxyURL(selected.proxy),
                state: storage,
            },
            { signal, timeoutMs: 60000 }
        );
        const transport = new LocalTransport({
            authIndex: index,
            catalog: session.catalog,
            engine: this.engine,
            logger: this.logger,
            session: session.id,
            timeoutMs: 30000,
        });
        try {
            return transport.benefit;
        } finally {
            transport.dispose();
            await this.engine.json("DELETE", `/sessions/${session.id}`, null, { timeoutMs: 5000 }).catch(() => {});
        }
    }
}
module.exports = { LocalSessionManager, proxyURL };
