class ConfigurationRoutes {
    constructor(system) {
        this.system = system;
    }
    setupRoutes(app, authenticated) {
        const service = this.system.configurationService;
        const route = (method, url, handler) =>
            app[method](url, authenticated, async (req, res) => {
                res.setHeader("Cache-Control", "no-store");
                try {
                    await handler(req, res);
                } catch (error) {
                    res.status(error.status || 500).json({ error: error.message });
                }
            });
        const presets = () => require("../core/codeAssistant/BuildRequestHandler").presetStore(this.system);
        route("get", "/api/build/presets", (req, res) => res.json(presets().list()));
        route("post", "/api/build/presets", (req, res) => {
            if (Buffer.byteLength(JSON.stringify(req.body || {})) > 1024 * 1024)
                throw Object.assign(new Error("预设超过 1 MiB"), { status: 413 });
            res.json(presets().add(req.body?.name, req.body?.preset));
        });
        route("delete", "/api/build/presets/:id", (req, res) => res.json(presets().remove(req.params.id)));
        route("patch", "/api/build/presets/:id", (req, res) => {
            if (typeof req.body?.enabled !== "boolean")
                throw Object.assign(new Error("enabled 必须为布尔值"), { status: 400 });
            res.json(presets().setEnabled(req.params.id, req.body.enabled));
        });
        route("post", "/api/build/recover/:index", async (req, res) => {
            const index = Number(req.params.index);
            if (!Number.isSafeInteger(index) || index < 0)
                throw Object.assign(new Error("无效账号编号"), { status: 400 });
            const manager = this.system.buildRecoveryManager;
            if (!manager || manager.fault) throw Object.assign(new Error("清理恢复管理器不可用"), { status: 503 });
            manager.retryAccount(index);
            res.json({ ok: true, recovery: manager.snapshot(), scheduled: true });
        });
        route("get", "/api/build/status", (req, res) => {
            const manager = this.system.buildRecoveryManager;
            const journal = manager?.store && !manager.fault ? manager.store.read() : {};
            res.json({
                accounts: [...(this.system.browserManager?.contexts || [])].map(([index, c]) => ({
                    active: manager
                        ? Object.entries(journal).filter(
                              ([id, entry]) =>
                                  entry.account === this.system.scheduler.account(index).key &&
                                  manager.store.active.has(id)
                          ).length
                        : c.page?.codeAssistantRuntime?.active.size || 0,
                    cleanupPending: manager
                        ? !!manager.fault ||
                          Object.entries(journal).some(
                              ([id, entry]) =>
                                  entry.account === this.system.scheduler.account(index).key &&
                                  !entry.deleteConfirmedAt &&
                                  !manager.store.active.has(id)
                          )
                        : !!c.page?.codeAssistantRuntime?.cleanupPending,
                    index,
                    pageReady: !!c.page?.playgroundTransport?.ready,
                    projectsReady: manager
                        ? Object.entries(journal).filter(
                              ([id, entry]) =>
                                  entry.account === this.system.scheduler.account(index).key &&
                                  entry.app &&
                                  manager.store.active.has(id)
                          ).length
                        : c.page?.codeAssistantRuntime?.readyProjects || 0,
                })),
                anti: { status: "pending_verification", verified: [] },
                channels: this.system.scheduler?.snapshot().channels || [],
                enabled: this.system.config.buildEnabled,
                quota: { remaining: null, reset: null },
                recovery: this.system.buildRecoveryManager?.snapshot() || null,
            });
        });
        route("get", "/api/configuration", (req, res) => res.json(service.snapshot()));
        route("post", "/api/configuration/secrets", (req, res) =>
            res.json({
                apiKeys: [...this.system.config.apiKeys],
                defaultApiKeys: [...service.baseline.apiKeys],
                savedApiKeys: [...service.saved.apiKeys],
            })
        );
        route("patch", "/api/configuration", (req, res) => res.json(service.save(req.body)));
        route("post", "/api/configuration/undo-pending", (req, res) => res.json(service.undo(req.body?.version)));
        route("post", "/api/configuration/restart", (req, res) => {
            if (req.body?.version !== service.document.version)
                throw Object.assign(new Error("配置版本已变化，请刷新"), { status: 409 });
            if (!process.send)
                throw Object.assign(new Error("当前入口没有运行进程监督器，请使用 node main.js 启动"), { status: 503 });
            if (this.system.restarting) throw Object.assign(new Error("重启已在进行中"), { status: 409 });
            service.load(service.document.overrides);
            this.system.restarting = true;
            res.once("finish", () => process.send({ configuration: service.runningDocument(), type: "restart" }));
            res.status(202).json({ accepted: true, instanceId: service.instanceId, version: service.document.version });
        });
        // Older endpoints require explicit values and the same version check; toggles are never inferred.
        const aliases = {
            "debug-mode": "DEBUG_MODE",
            "enable-auth-update": "ENABLE_AUTH_UPDATE",
            "force-code-execution": "FORCE_CODE_EXECUTION",
            "force-thinking": "FORCE_THINKING",
            "force-url-context": "FORCE_URL_CONTEXT",
            "force-web-search": "FORCE_WEB_SEARCH",
            "log-max-count": "LOG_DISPLAY_LIMIT",
            "safety-settings-threshold": "SAFETY_SETTINGS_THRESHOLD",
            "streaming-mode": "STREAMING_MODE",
        };
        for (const [suffix, name] of Object.entries(aliases))
            route("put", `/api/settings/${suffix}`, (req, res) => {
                const value = req.body?.value ?? req.body?.mode ?? req.body?.count;
                res.json(service.save({ changes: { [name]: value }, version: req.body?.version }));
            });
    }
}
module.exports = ConfigurationRoutes;
