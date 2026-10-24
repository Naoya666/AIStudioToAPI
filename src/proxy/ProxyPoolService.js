const { normalizeGroup } = require("./ProxyEgressIdentity");
const crypto = require("crypto");
const axios = require("axios");
const { SocksProxyAgent } = require("socks-proxy-agent");
const ProxyPoolStore = require("./ProxyPoolStore");
const ProxyNodeParser = require("./ProxyNodeParser");
const MihomoManager = require("./MihomoManager");
const ProxyBindingService = require("./ProxyBindingService");

class ProxyPoolService {
    constructor({ authSource, browserManager, logger }) {
        this.logger = logger;
        this.browserManager = browserManager;
        this.store = new ProxyPoolStore(logger);
        this.manager = new MihomoManager(logger);
        this.bindings = new ProxyBindingService(this.store, this.manager, browserManager, authSource);
        this.tasks = new Map();
        this.testResults = new Map();
        browserManager.setProxyResolver(authIndex => this.bindings.resolve(authIndex));
    }

    async initialize() {
        const snapshot = this.store.snapshot();
        if (snapshot.settings.enabled) {
            try {
                await this.manager.start(snapshot);
            } catch (error) {
                this.logger.error(
                    `[ProxyPool] Mihomo startup failed; bound accounts will remain unavailable: ${error.message}`
                );
            }
        }
    }

    sanitizeNode(node) {
        const { password, ...safe } = node;
        return { ...safe, hasPassword: Boolean(password) };
    }

    status() {
        const data = this.store.snapshot();
        return {
            bindingCount: this.bindings.existingBindings(data).filter(item => item.desiredNodeId).length,
            enabled: data.settings.enabled,
            enabledNodeCount: data.nodes.filter(node => node.enabled !== false && node.status !== "missing").length,
            mihomo: this.manager.inspect(data.settings),
            nodeCount: data.nodes.length,
            subscriptionCount: data.subscriptions.length,
        };
    }

    settings() {
        const snapshot = this.store.snapshot();
        const { binaryPath, ...settings } = snapshot.settings;
        return {
            ...settings,
            binaryPath: binaryPath ? "(configured)" : "",
            exitIpUrl: snapshot.automation.exitIpUrl,
            healthTimeoutMs: snapshot.automation.healthTimeoutMs,
            revision: crypto
                .createHash("sha256")
                .update(JSON.stringify([snapshot.settings, snapshot.automation]))
                .digest("hex"),
            testUrl: snapshot.automation.testUrl,
        };
    }

    nodes() {
        const snapshot = this.store.snapshot();
        const bindings = this.bindings.existingBindings(snapshot);
        const contexts = [...this.browserManager.contexts.values()];
        return snapshot.nodes.map(node => ({
            ...this.sanitizeNode(node),
            ...(this.testResults.get(node.id) || {}),
            boundAccounts: bindings.filter(binding => binding.desiredNodeId === node.id).length,
            runningContexts: contexts.filter(context => context.proxyInfo?.appliedNodeId === node.id).length,
        }));
    }

    proxyForNode(id) {
        const snapshot = this.store.snapshot();
        const node = snapshot.nodes.find(entry => entry.id === id);
        if (!node) throw Object.assign(new Error("Node not found"), { status: 404 });
        if (node.type === "direct") {
            if (node.enabled === false)
                throw Object.assign(new Error("Selected direct node is disabled"), { status: 503 });
            return { display: "direct", nodeId: node.id, proxy: null, source: "direct_node" };
        }
        if (
            !snapshot.settings.enabled ||
            node.enabled === false ||
            node.status === "missing" ||
            !this.manager.status.ready
        )
            throw Object.assign(new Error("Selected VNC proxy node is unavailable"), { status: 503 });
        return {
            display: `socks5://127.0.0.1:${node.localPort}`,
            nodeId: node.id,
            proxy: {
                bypass: "localhost,127.0.0.1,::1",
                server: `socks5://127.0.0.1:${node.localPort}`,
            },
            source: "mihomo_pool",
        };
    }

    _allocatePort(data) {
        const used = new Set([
            data.settings.controllerPort,
            ...data.nodes.map(node => node.localPort).filter(Number.isInteger),
        ]);
        let port = data.settings.basePort;
        while (used.has(port) && port <= 65535) port++;
        if (port > 65535) throw Object.assign(new Error("No local proxy port available"), { status: 409 });
        return port;
    }

    _normalizeNode(input, data, existing = null) {
        if (existing && input.type && input.type !== existing.type)
            throw Object.assign(new Error("Node type cannot be changed; create a new node instead"), { status: 409 });
        const parsed = ProxyNodeParser.validate({
            ...existing,
            ...input,
            password: input.password || existing?.password || "",
        });
        const now = new Date().toISOString();
        if (parsed.type === "direct" && data.nodes.some(node => node.type === "direct" && node.id !== existing?.id))
            throw Object.assign(new Error("Only one direct node can be configured"), { status: 409 });
        return {
            ...parsed,
            createdAt: existing?.createdAt || now,
            egressGroup: parsed.type === "direct" ? "" : normalizeGroup(input.egressGroup ?? existing?.egressGroup),
            enabled: input.enabled !== false,
            id: existing?.id || `node-${crypto.randomBytes(6).toString("hex")}`,
            localPort:
                parsed.type === "direct"
                    ? null
                    : Number.isInteger(existing?.localPort)
                      ? existing.localPort
                      : this._allocatePort(data),
            source: existing?.source || input.source || "manual",
            updatedAt: now,
        };
    }

    async _commit(next) {
        const previous = this.store.snapshot();
        const wasRunning = this.manager.status.running;
        try {
            if (next.settings.enabled) await this.manager.reload(next);
            else if (wasRunning) await this.manager.stop();
            await this.store.replace(next);
        } catch (error) {
            try {
                if (wasRunning) await this.manager.reload(previous);
                else if (this.manager.status.running) await this.manager.stop();
            } catch (rollbackError) {
                throw Object.assign(new Error(`节点池保存或应用失败，Mihomo 恢复未完成：${rollbackError.message}`), {
                    status: 500,
                });
            }
            throw error;
        }
        return next;
    }

    updateSettings(input) {
        const operation = (this.settingsQueue || Promise.resolve())
            .catch(() => {})
            .then(() => this._updateSettings(input));
        this.settingsQueue = operation;
        return operation;
    }

    async _updateSettings(input) {
        if (input.revision !== undefined && input.revision !== this.settings().revision)
            throw Object.assign(new Error("节点池设置已被其他页面修改，请刷新并处理草稿差异"), { status: 409 });
        const next = this.store.snapshot();
        for (const key of ["enabled", "binaryPath", "basePort", "controllerPort"])
            if (
                Object.prototype.hasOwnProperty.call(input, key) &&
                !(key === "binaryPath" && input[key] === "(configured)")
            )
                next.settings[key] = input[key];
        for (const key of ["exitIpUrl", "healthTimeoutMs", "testUrl"])
            if (Object.prototype.hasOwnProperty.call(input, key)) next.automation[key] = input[key];
        next.settings.basePort = Number(next.settings.basePort);
        next.settings.controllerPort = Number(next.settings.controllerPort);
        next.automation.healthTimeoutMs = Number(next.automation.healthTimeoutMs);
        if (
            ![next.settings.basePort, next.settings.controllerPort].every(
                port => Number.isInteger(port) && port > 0 && port < 65536
            )
        )
            throw Object.assign(new Error("Invalid basePort or controllerPort"), { status: 400 });
        if (
            !Number.isInteger(next.automation.healthTimeoutMs) ||
            next.automation.healthTimeoutMs < 1000 ||
            next.automation.healthTimeoutMs > 120000
        )
            throw Object.assign(new Error("healthTimeoutMs must be between 1000 and 120000"), { status: 400 });
        for (const key of ["testUrl", "exitIpUrl"]) {
            if (!next.automation[key] && key === "exitIpUrl") continue;
            let parsed;
            try {
                parsed = new URL(next.automation[key]);
            } catch {
                throw Object.assign(new Error(`${key} must be a valid HTTP(S) URL`), { status: 400 });
            }
            if (!["http:", "https:"].includes(parsed.protocol))
                throw Object.assign(new Error(`${key} must use HTTP(S)`), { status: 400 });
        }
        await this._commit(next);
        return this.settings();
    }

    async addNode(input) {
        const next = this.store.snapshot();
        const node = this._normalizeNode(input, next);
        next.nodes.push(node);
        await this._commit(next);
        return this.sanitizeNode(node);
    }

    async updateNode(id, input) {
        const next = this.store.snapshot();
        const index = next.nodes.findIndex(node => node.id === id);
        if (index < 0) throw Object.assign(new Error("Node not found"), { status: 404 });
        next.nodes[index] = this._normalizeNode(input, next, next.nodes[index]);
        await this._commit(next);
        return this.sanitizeNode(next.nodes[index]);
    }

    async deleteNode(id) {
        await this.deleteNodes([id]);
    }

    async deleteNodes(ids) {
        const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
        if (!uniqueIds.length) throw Object.assign(new Error("At least one node id is required"), { status: 400 });
        const next = this.store.snapshot();
        const selected = next.nodes.filter(node => uniqueIds.includes(node.id));
        if (selected.length !== uniqueIds.length)
            throw Object.assign(new Error("One or more nodes were not found"), { status: 404 });
        const selectedIds = new Set(uniqueIds);
        const boundIds = new Set(
            Object.values(next.bindings)
                .map(binding => binding.desiredNodeId)
                .filter(id => selectedIds.has(id))
        );
        const runningIds = new Set(
            [...this.browserManager.contexts.values()]
                .map(data => data.proxyInfo?.appliedNodeId)
                .filter(id => selectedIds.has(id))
        );
        const blocked = selected.filter(node => boundIds.has(node.id) || runningIds.has(node.id));
        if (blocked.length)
            throw Object.assign(new Error(`Cannot delete in-use nodes: ${blocked.map(node => node.name).join(", ")}`), {
                status: 409,
            });
        next.nodes = next.nodes.filter(node => !selectedIds.has(node.id));
        await this._commit(next);
        for (const id of selectedIds) this.testResults.delete(id);
        return { deleted: selected.length };
    }

    previewImport(text, format = "links") {
        const result =
            format === "subscription" ? ProxyNodeParser.parseSubscription(text) : ProxyNodeParser.parseText(text);
        return { ...result, nodes: result.nodes.map(node => this.sanitizeNode(node)) };
    }

    async importNodes(text, format = "links") {
        const parsed =
            format === "subscription" ? ProxyNodeParser.parseSubscription(text) : ProxyNodeParser.parseText(text);
        const next = this.store.snapshot();
        const existing = new Set(next.nodes.map(node => `${node.type}|${node.host}|${node.port}|${node.name}`));
        const added = [];
        for (const value of parsed.nodes) {
            const key = `${value.type}|${value.host}|${value.port}|${value.name}`;
            if (existing.has(key)) continue;
            const node = this._normalizeNode(value, next);
            next.nodes.push(node);
            added.push(node);
            existing.add(key);
        }
        await this._commit(next);
        return {
            added: added.map(node => this.sanitizeNode(node)),
            errors: parsed.errors,
            skipped: parsed.nodes.length - added.length,
        };
    }

    subscriptions() {
        return this.store.snapshot().subscriptions.map(({ url, ...item }) => {
            try {
                const parsed = new URL(url);
                return { ...item, url: `${parsed.protocol}//${parsed.host}/***` };
            } catch {
                return { ...item, url: "(invalid URL)" };
            }
        });
    }

    async addSubscription(input) {
        let parsedUrl;
        try {
            parsedUrl = new URL(input.url);
        } catch {
            throw Object.assign(new Error("Valid subscription URL is required"), { status: 400 });
        }
        if (!["http:", "https:"].includes(parsedUrl.protocol))
            throw Object.assign(new Error("Only HTTP(S) subscriptions are supported"), { status: 400 });
        const next = this.store.snapshot();
        const subscription = {
            createdAt: new Date().toISOString(),
            enabled: input.enabled !== false,
            id: `sub-${crypto.randomBytes(6).toString("hex")}`,
            lastError: null,
            lastRefreshedAt: null,
            name: input.name || parsedUrl.hostname,
            url: input.url,
        };
        next.subscriptions.push(subscription);
        await this.store.replace(next);
        return { ...subscription, url: parsedUrl.origin };
    }

    async refreshSubscription(id) {
        const current = this.store.snapshot();
        const subscription = current.subscriptions.find(item => item.id === id);
        if (!subscription) throw Object.assign(new Error("Subscription not found"), { status: 404 });
        try {
            const response = await fetch(subscription.url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const parsed = ProxyNodeParser.parseSubscription(
                await response.text(),
                response.headers.get("content-type") || ""
            );
            const next = this.store.snapshot();
            const sub = next.subscriptions.find(item => item.id === id);
            const oldByStable = new Map(
                next.nodes.filter(node => node.subscriptionId === id).map(node => [node.stableKey, node])
            );
            const seen = new Set();
            for (const value of parsed.nodes) {
                const stableKey = `${value.type}|${value.host}|${value.port}|${value.name}`;
                seen.add(stableKey);
                const old = oldByStable.get(stableKey);
                if (old)
                    Object.assign(old, value, { enabled: true, status: "active", updatedAt: new Date().toISOString() });
                else
                    next.nodes.push({
                        ...this._normalizeNode(value, next),
                        id: ProxyNodeParser.stableId(value, id),
                        source: "subscription",
                        stableKey,
                        status: "active",
                        subscriptionId: id,
                    });
            }
            for (const node of next.nodes.filter(node => node.subscriptionId === id && !seen.has(node.stableKey)))
                node.status = "missing";
            sub.lastError = null;
            sub.lastRefreshedAt = new Date().toISOString();
            sub.nodeCount = parsed.nodes.length;
            await this._commit(next);
            return { errors: parsed.errors, nodeCount: parsed.nodes.length, refreshedAt: sub.lastRefreshedAt };
        } catch (error) {
            const failed = this.store.snapshot();
            const sub = failed.subscriptions.find(item => item.id === id);
            sub.lastError = error.message;
            await this.store.replace(failed);
            throw Object.assign(new Error(`Subscription refresh failed: ${error.message}`), { status: 502 });
        }
    }

    async deleteSubscriptions(ids) {
        const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
        if (!uniqueIds.length)
            throw Object.assign(new Error("At least one subscription id is required"), { status: 400 });
        const next = this.store.snapshot();
        const selected = next.subscriptions.filter(subscription => uniqueIds.includes(subscription.id));
        if (selected.length !== uniqueIds.length)
            throw Object.assign(new Error("One or more subscriptions were not found"), { status: 404 });
        const selectedIds = new Set(uniqueIds);
        const ownedNodes = next.nodes.filter(node => selectedIds.has(node.subscriptionId));
        const ownedNodeIds = new Set(ownedNodes.map(node => node.id));
        const boundIds = new Set(Object.values(next.bindings).map(binding => binding.desiredNodeId));
        const runningIds = new Set(
            [...this.browserManager.contexts.values()].map(data => data.proxyInfo?.appliedNodeId).filter(Boolean)
        );
        const blocked = ownedNodes.filter(node => boundIds.has(node.id) || runningIds.has(node.id));
        if (blocked.length)
            throw Object.assign(
                new Error(
                    `Cannot delete subscriptions with in-use nodes: ${blocked.map(node => node.name).join(", ")}`
                ),
                { status: 409 }
            );
        next.subscriptions = next.subscriptions.filter(subscription => !selectedIds.has(subscription.id));
        next.nodes = next.nodes.filter(node => !ownedNodeIds.has(node.id));
        await this._commit(next);
        for (const id of ownedNodeIds) this.testResults.delete(id);
        return { deletedNodes: ownedNodes.length, deletedSubscriptions: selected.length };
    }

    async setBinding(accountKey, desiredNodeId, egressGroup) {
        return this.setBindings([{ accountKey, desiredNodeId, egressGroup }]);
    }

    async setBindings(items) {
        const next = this.store.snapshot();
        const validAccounts = new Set(this.bindings.list().map(item => item.accountKey));
        for (const item of items) {
            const key = String(item.accountKey || "").toLowerCase();
            if (!validAccounts.has(key)) throw Object.assign(new Error(`Unknown account: ${key}`), { status: 404 });
            if (item.desiredNodeId && !next.nodes.some(node => node.id === item.desiredNodeId))
                throw Object.assign(new Error(`Unknown node: ${item.desiredNodeId}`), { status: 400 });
            const egressGroup = normalizeGroup(item.egressGroup ?? next.bindings[key]?.egressGroup);
            if (item.desiredNodeId || egressGroup)
                next.bindings[key] = {
                    desiredNodeId: item.desiredNodeId || null,
                    egressGroup,
                    updatedAt: new Date().toISOString(),
                };
            else delete next.bindings[key];
        }
        await this.store.replace(next);
        return this.bindings.list();
    }

    apply(accountKey, waitForIdle = true) {
        const account = this.bindings.list().find(item => item.accountKey === String(accountKey).toLowerCase());
        if (!account) throw Object.assign(new Error("Account not found"), { status: 404 });
        if (account.authIndex === null)
            throw Object.assign(new Error("Account is not logged in; saved binding applies on its next login"), {
                status: 409,
            });
        const id = `task-${crypto.randomBytes(8).toString("hex")}`;
        const task = { accountKey: account.accountKey, createdAt: new Date().toISOString(), id, state: "queued" };
        this.tasks.set(id, task);
        this._runApply(task, account.authIndex, waitForIdle).catch(() => {});
        return task;
    }

    async _runApply(task, authIndex, waitForIdle) {
        try {
            task.state = "draining";
            const data = this.browserManager.contexts.get(authIndex);
            if (data) {
                data.draining = true;
                data.proxyPoolState = "draining";
            }
            while (!this.browserManager.isAccountContextIdle(authIndex)) {
                if (!waitForIdle) {
                    task.state = "skipped_busy";
                    if (data) {
                        data.draining = false;
                        delete data.proxyPoolState;
                    }
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            task.state = "rebuilding";
            if (data) data.proxyPoolState = "rebuilding";
            await this.browserManager.rebuildAccountContext(authIndex);
            task.state = "completed";
            task.completedAt = new Date().toISOString();
        } catch (error) {
            task.state = "failed";
            task.error = error.message;
            task.completedAt = new Date().toISOString();
        }
    }

    task(id) {
        return this.tasks.get(id) || null;
    }

    async testNode(id) {
        const node = this.store.data.nodes.find(entry => entry.id === id);
        if (!node) throw Object.assign(new Error("Node not found"), { status: 404 });
        try {
            if (node.type === "direct") {
                const started = Date.now();
                const testUrl = this.store.data.automation.exitIpUrl || this.store.data.automation.testUrl;
                const response = await axios.get(testUrl, {
                    maxContentLength: 1024 * 1024,
                    proxy: false,
                    timeout: this.store.data.automation.healthTimeoutMs,
                    validateStatus: status => status >= 200 && status < 300,
                });
                let exitIp = null;
                if (this.store.data.automation.exitIpUrl) {
                    if (typeof response.data === "object")
                        exitIp = response.data.ip || response.data.query || response.data.address || null;
                    else
                        exitIp =
                            String(response.data).match(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f:]{3,}\b/i)?.[0] || null;
                }
                const result = {
                    exitIp,
                    latencyMs: Date.now() - started,
                    message: "ok",
                    success: true,
                    testedAt: new Date().toISOString(),
                };
                this.testResults.set(id, result);
                return result;
            }
            if (!this.manager.status.ready) throw Object.assign(new Error("Mihomo is not ready"), { status: 503 });
            const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${node.localPort}`);
            const started = Date.now();
            try {
                await axios.get(this.store.data.automation.testUrl, {
                    httpAgent: agent,
                    httpsAgent: agent,
                    maxContentLength: 1024 * 1024,
                    maxRedirects: 3,
                    proxy: false,
                    timeout: this.store.data.automation.healthTimeoutMs,
                    validateStatus: status => status >= 200 && status < 400,
                });
            } catch (cause) {
                const detail = cause.response?.status ? `HTTP ${cause.response.status}` : cause.code || cause.message;
                throw Object.assign(new Error(`SOCKS listener test failed: ${detail}`), { status: 502 });
            }
            const latencyMs = Date.now() - started;
            let exitIp = null;
            if (this.store.data.automation.exitIpUrl) {
                const response = await axios.get(this.store.data.automation.exitIpUrl, {
                    httpAgent: agent,
                    httpsAgent: agent,
                    maxContentLength: 1024 * 1024,
                    proxy: false,
                    timeout: this.store.data.automation.healthTimeoutMs,
                });
                if (typeof response.data === "object")
                    exitIp = response.data.ip || response.data.query || response.data.address || null;
                else
                    exitIp = String(response.data).match(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f:]{3,}\b/i)?.[0] || null;
            }
            const result = { exitIp, latencyMs, message: "ok", success: true, testedAt: new Date().toISOString() };
            this.testResults.set(id, result);
            return result;
        } catch (error) {
            this.testResults.set(id, {
                exitIp: null,
                latencyMs: null,
                message: error.message,
                success: false,
                testedAt: new Date().toISOString(),
            });
            throw error;
        }
    }

    async shutdown() {
        await this.manager.stop();
    }
}

module.exports = ProxyPoolService;
