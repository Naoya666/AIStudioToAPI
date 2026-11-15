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
        const cleanupMode = { message: "历史自动恢复已停用；历史项目删除状态未重新核实", mode: "best_effort" };
        route("post", "/api/build/recover/:index", (req, res) =>
            res.status(410).json({ ...cleanupMode, scheduled: false })
        );
        route("get", "/api/build/status", (req, res) =>
            res.json({
                accounts: [...(this.system.browserManager?.contexts || [])].map(([index, c]) => ({
                    index,
                    pageReady: !!c.page?.playgroundTransport?.ready,
                })),
                anti: { status: "pending_verification", verified: [] },
                channels: this.system.scheduler?.snapshot().channels || [],
                cleanup: cleanupMode,
                enabled: this.system.config.buildEnabled,
                quota: { remaining: null, reset: null },
            })
        );
        route("get", "/api/model-catalog", (req, res) => {
            const catalog = require("../core/ModelCatalog");
            const identity = require("../core/codeAssistant/ModelIdentity");
            const hidden = this.system.scheduler?.hiddenModels || new Set();
            const rows = service.running.modelList
                .filter(row => {
                    const id = row.name.replace(/^models\//, "");
                    return !identity.isBuild(id) || identity.parse(id).canonical === id;
                })
                .map(row => ({
                    ...row,
                    enabled: row.enabled !== false && !hidden.has(row.name.replace(/^models\//, "")),
                }));
            res.json({
                antiDefault: service.running.antiTruncationDefault,
                antiEnabled: service.running.antiTruncationEnabled,
                estimates: Object.fromEntries(
                    rows.map(row => [
                        row.name,
                        Object.fromEntries(
                            catalog.TIERS.map(tier => {
                                const budget = require("../accounts/QuotaPolicy").dailyBudgets(
                                    row.name.replace(/^models\//, ""),
                                    tier,
                                    {
                                        freeBuildEstimate: service.running.scheduler.buildFreeDailyTokenEstimate,
                                    }
                                );
                                return [
                                    tier,
                                    {
                                        ...budget,
                                        requests: require("../accounts/AccountTierPolicy").modelQuota(
                                            row.name.replace(/^models\//, ""),
                                            { manualTier: tier }
                                        ),
                                    },
                                ];
                            })
                        ),
                    ])
                ),
                features: catalog.FEATURES,
                permissions: service.running.scheduler.modelAllowlist,
                rows,
                version: service.document.version,
            });
        });
        route("patch", "/api/model-catalog", (req, res) => {
            const result = service.save({
                changes: {
                    ANTI_TRUNCATION_DEFAULT: req.body?.antiDefault,
                    ANTI_TRUNCATION_ENABLED: req.body?.antiEnabled,
                    MODEL_CATALOG: req.body?.rows,
                    MODEL_TIER_ALLOWLIST: req.body?.permissions,
                },
                version: req.body?.version,
            });
            res.json({ applied: result.applied, version: result.version });
        });
        route("get", "/api/configuration", (req, res) => res.json(service.snapshot()));
        route("post", "/api/configuration/browser-restart/retry", (req, res) => {
            this.system.browserRestartSchedule.retry();
            res.status(202).json(service.snapshot());
        });
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
