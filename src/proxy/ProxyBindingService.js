const { egressKey, snapshotEgress } = require("./ProxyEgressIdentity");
const { getProxySummaryFromEnv, parseProxyFromEnv } = require("../utils/ProxyUtils");

class ProxyBindingService {
    constructor(store, manager, browserManager, authSource) {
        this.store = store;
        this.manager = manager;
        this.browserManager = browserManager;
        this.authSource = authSource;
    }

    accountKey(authIndex) {
        const name = this.authSource.accountNameMap.get(authIndex);
        return typeof name === "string" && name.trim() ? name.trim().toLowerCase() : `auth-${authIndex}`;
    }

    resolve(authIndex) {
        return this.resolveKey(this.accountKey(authIndex), authIndex);
    }

    resolveAccount(account) {
        if (account.authIndex !== null) return this.resolve(account.authIndex);
        return this.resolveKey(account.email?.trim().toLowerCase() || account.accountId, null);
    }

    resolveKey(accountKey, authIndex) {
        return snapshotEgress(this._resolveKey(accountKey, authIndex));
    }

    _resolveKey(accountKey, authIndex) {
        const snapshot = this.store.snapshotForAccount
            ? this.store.snapshotForAccount(accountKey)
            : this.store.snapshot();
        const desiredNodeId = snapshot.bindings[accountKey]?.desiredNodeId || null;
        const egressGroup = snapshot.bindings[accountKey]?.egressGroup || "";
        if (desiredNodeId) {
            const node = snapshot.nodes.find(entry => entry.id === desiredNodeId);
            if (!node)
                throw Object.assign(new Error(`Bound proxy node does not exist: ${desiredNodeId}`), {
                    code: "PROXY_POOL_NODE_MISSING",
                });
            if (node.type === "direct") {
                if (node.enabled === false)
                    throw Object.assign(new Error(`Bound direct node is disabled: ${node.name}`), {
                        code: "PROXY_POOL_NODE_UNAVAILABLE",
                    });
                return {
                    appliedNodeId: node.id,
                    display: "direct",
                    proxy: null,
                    source: "direct_node",
                };
            }
            if (!snapshot.settings.enabled)
                throw Object.assign(new Error("Proxy pool is disabled for a bound account"), {
                    code: "PROXY_POOL_DISABLED",
                });
            if (node.enabled === false || node.status === "missing")
                throw Object.assign(new Error(`Bound proxy node is unavailable: ${node.name}`), {
                    code: "PROXY_POOL_NODE_UNAVAILABLE",
                });
            if (!this.manager.status.ready)
                throw Object.assign(new Error("Mihomo is not ready for a bound account"), { code: "MIHOMO_NOT_READY" });
            return {
                appliedNodeId: node.id,
                display: `socks5://127.0.0.1:${node.localPort}`,
                egressGroup: egressGroup || node.egressGroup || "",
                proxy: {
                    bypass: "localhost,127.0.0.1,::1",
                    server: `socks5://127.0.0.1:${node.localPort}`,
                },
                source: "mihomo_pool",
            };
        }
        const sticky = authIndex === null ? null : this.browserManager.stickyProxyManager.getProxyForAuth(authIndex);
        if (sticky) return { ...sticky, appliedNodeId: null, egressGroup, source: "sticky_proxy_file" };
        const environment = parseProxyFromEnv();
        if (environment)
            return {
                appliedNodeId: null,
                display: getProxySummaryFromEnv().server,
                egressGroup,
                proxy: environment,
                source: "environment",
            };
        return { appliedNodeId: null, display: "direct", proxy: null, source: "direct" };
    }

    currentAccounts() {
        const accounts = this.authSource.availableIndices.map(authIndex => ({
            accountKey: this.accountKey(authIndex),
            accountName: this.authSource.accountNameMap.get(authIndex) || `auth-${authIndex}`,
            authIndex,
        }));
        for (const account of this.authSource.accountLoginService?.state?.accounts || []) {
            if (account.authIndex !== null) continue;
            accounts.push({
                accountKey: account.email?.trim().toLowerCase() || account.accountId,
                accountName: account.email || account.displayName || account.accountId,
                authIndex: null,
            });
        }
        const uniqueAccounts = new Map();
        for (const account of accounts) {
            if (!uniqueAccounts.has(account.accountKey)) uniqueAccounts.set(account.accountKey, account);
        }
        return [...uniqueAccounts.values()];
    }

    existingBindings(snapshot = this.store.snapshot()) {
        return this.currentAccounts()
            .map(({ accountKey }) => snapshot.bindings[accountKey])
            .filter(Boolean);
    }

    list() {
        const snapshot = this.store.snapshot();
        const accounts = this.currentAccounts();
        return accounts.map(({ accountKey, accountName, authIndex }) => {
            const desiredNodeId = snapshot.bindings[accountKey]?.desiredNodeId || null;
            const data = this.browserManager.contexts.get(authIndex);
            const appliedNodeId = data?.proxyInfo?.appliedNodeId || null;
            let source = data?.proxyInfo?.source || null;
            let error = this.browserManager.contextUnavailable.get(authIndex)?.error?.message || null;
            if (!source && !data) {
                try {
                    source = this.resolveKey(accountKey, authIndex).source;
                } catch (cause) {
                    const desired = snapshot.nodes.find(node => node.id === desiredNodeId);
                    source = desired?.type === "direct" ? "direct_node" : "mihomo_pool";
                    error ||= cause.message;
                }
            }
            let desiredEgressKey = null;
            try {
                desiredEgressKey = this.resolveKey(accountKey, authIndex).egressKey;
            } catch {
                // Unavailable configured routes retain their existing error state.
            }
            const appliedEgressKey = data?.proxyInfo ? egressKey(data.proxyInfo) : null;
            const inflight = authIndex === null ? 0 : this.browserManager.scheduler?.account(authIndex).inflight || 0;
            let state = desiredNodeId
                ? data
                    ? desiredNodeId === appliedNodeId
                        ? "applied"
                        : "pending"
                    : "offline"
                : data && appliedNodeId
                  ? "pending"
                  : "unbound";
            if (data && desiredEgressKey && desiredEgressKey !== appliedEgressKey) state = "pending";
            if (data?.proxyPoolState === "draining") state = "draining";
            if (data?.proxyPoolState === "rebuilding") state = "rebuilding";
            if (error && desiredNodeId) state = "error";
            return {
                accountKey,
                accountName,
                appliedEgressKey,
                appliedNodeId,
                authIndex,
                contextState:
                    authIndex === null
                        ? "NOT_LOGGED_IN"
                        : data?.state ||
                          (this.browserManager.initializingContexts.has(authIndex) ? "INITIALIZING" : "COLD"),
                desiredEgressKey,
                desiredNodeId,
                egressGroup: snapshot.bindings[accountKey]?.egressGroup || "",
                error,
                inflight,
                proxySource: source,
                state,
            };
        });
    }
}

module.exports = ProxyBindingService;
