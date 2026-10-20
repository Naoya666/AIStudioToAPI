const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const definitions = require("./definitions");
const ConfigLoader = require("../utils/ConfigLoader");
const AccountConfig = require("../accounts/AccountConfig");
const LoggingService = require("../utils/LoggingService");
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b))
        return false;
    const keys = Object.keys(a);
    return (
        keys.length === Object.keys(b).length &&
        keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]))
    );
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const read = (config, key) => key.split(".").reduce((value, part) => value?.[part], config);
const write = (config, key, value) => {
    const parts = key.split(".");
    const leaf = parts.pop();
    parts.reduce((obj, part) => obj[part], config)[leaf] = clone(value);
};

// This path is deliberately independent of managed configuration and environment overrides.
const storagePath = () => path.join(process.cwd(), "data", "managed-config.json");
function atomicWrite(file, value) {
    fs.mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify(value, null, 4));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temporary, file);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}
class ConfigurationService {
    constructor(system, options = {}) {
        this.system = system;
        this.file = options.file || storagePath();
        this.env = { ...(options.env || process.env) };
        this.instanceId = crypto.randomUUID();
        this.document = fs.existsSync(this.file)
            ? JSON.parse(fs.readFileSync(this.file, "utf8"))
            : { migratedAccounts: false, overrides: {}, version: 0 };
        if (
            !Number.isSafeInteger(this.document.version) ||
            this.document.version < 0 ||
            !this.document.overrides ||
            typeof this.document.overrides !== "object" ||
            Array.isArray(this.document.overrides)
        )
            throw fail("Invalid managed configuration storage");
        for (const [name, value] of Object.entries(this.document.overrides)) this.validateField(name, value);
        this.defaults = this.load({}, {});
        try {
            this.baseline = this.load({});
        } catch (error) {
            this.baseline = this.defaults;
            this.baselineError = error.message;
        }
        this.saved = this.load(this.document.overrides);
        if (!Object.hasOwn(this.document.overrides, "MODEL_TIER_ALLOWLIST")) {
            this.document = {
                ...this.document,
                overrides: {
                    ...this.document.overrides,
                    MODEL_TIER_ALLOWLIST: clone(this.saved.scheduler.modelAllowlist),
                },
                version: this.document.version + 1,
            };
            atomicWrite(this.file, this.document);
        }
        const goodPath = path.join(path.dirname(this.file), "managed-config.last-good.json");
        this.running =
            this.env.AISTUDIO_CONFIG_RECOVERY === "1" && fs.existsSync(goodPath)
                ? this.load(JSON.parse(fs.readFileSync(goodPath, "utf8")).overrides)
                : clone(this.saved);
        // Recovery must not replace the explicit saved permissions with an older generated default.
        this.running.scheduler.modelAllowlist = clone(this.saved.scheduler.modelAllowlist);
        const errorPath = path.join(path.dirname(this.file), "restart-status.json");
        this.restartError = fs.existsSync(errorPath) ? JSON.parse(fs.readFileSync(errorPath, "utf8")).error : null;
        system.config = this.running;
    }
    load(overrides, baseEnv = this.env) {
        const env = { ...baseEnv };
        for (const [name, value] of Object.entries(overrides)) {
            if (["LOG_DISPLAY_LIMIT", "DEBUG_MODE"].includes(name)) continue;
            env[name] =
                typeof value === "object"
                    ? ["API_KEYS", "IMMEDIATE_SWITCH_STATUS_CODES"].includes(name)
                        ? value.join(",")
                        : JSON.stringify(value)
                    : String(value);
        }
        const logger = { error() {}, info() {}, warn() {} };
        const result = new ConfigLoader(logger).loadConfiguration(env);
        result.login = AccountConfig.config(env);
        result.displayLimit = overrides.LOG_DISPLAY_LIMIT ?? 100;
        result.debugMode = overrides.DEBUG_MODE ?? env.LOG_LEVEL?.toUpperCase() === "DEBUG";
        return result;
    }
    value(config, definition) {
        const value = read(config, definition.path);
        if (
            [
                "RATE_LIMIT_COOLDOWN",
                "RISK_CONTROL_COOLDOWN",
                "RISK_CONTROL_MAX_COOLDOWN",
                "TEMP_ERROR_COOLDOWN",
            ].includes(definition.name)
        )
            return value / 1000;
        if (definition.name === "MODEL_WORKER_ALLOCATION")
            return Object.fromEntries(
                Object.entries(value).map(([model, row]) => [
                    model,
                    { min_workers: row.min, preferred_workers: row.preferred },
                ])
            );
        return clone(value);
    }
    validateField(name, value) {
        const d = definitions.find(item => item.name === name);
        if (!d) throw fail(`不允许修改配置：${name}`);
        if (
            d.type === "secret" &&
            (typeof value !== "string" || (value && !require("../public/DashboardConfig").validToken(value)))
        )
            throw fail(`${name}: 无效凭证`);
        if (d.type === "agents") {
            try {
                require("../public/DashboardConfig").normalizeAgents(value);
            } catch {
                throw fail(`${name}: 无效节点列表，请检查 ID、URL 和 Token`);
            }
        }
        if (d.type === "boolean" && typeof value !== "boolean") throw fail(`${name}: 必须为布尔值`);
        if (
            d.type === "integer" &&
            (!Number.isSafeInteger(value) || value < d.minimum || value > (d.maximum ?? Number.MAX_SAFE_INTEGER))
        )
            throw fail(`${name}: 整数超出范围`);
        if (d.type === "enum" && !d.choices.includes(value)) throw fail(`${name}: 无效选项`);
        if (d.type === "time" && (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)))
            throw fail(`${name}: 使用 HH:mm`);
        if (
            d.type === "keys" &&
            (!Array.isArray(value) ||
                !value.length ||
                value.some(key => typeof key !== "string" || !key.trim() || key !== key.trim() || key.includes(",")))
        )
            throw fail("API_KEYS: 至少提供一个非空密钥，密钥不能包含逗号");
        if (
            d.type === "codes" &&
            (!Array.isArray(value) || value.some(code => !Number.isInteger(code) || code < 400 || code > 599))
        )
            throw fail(`${name}: 使用 400–599 错误码`);
        if (d.type === "modelAllowlist") {
            try {
                require("../accounts/ModelAllowlistPolicy").parsePolicy(value);
            } catch (error) {
                throw fail(error.message);
            }
        }
        if (d.type === "transport") {
            try {
                require("../core/ModelTransportPolicy").parsePolicy(value);
            } catch (error) {
                throw fail(error.message);
            }
        }
        if (d.type === "models") {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(`${name}: 必须为模型映射`);
            for (const [model, limit] of Object.entries(value)) {
                const { normalizeModelName } = require("../core/ModelScheduler");
                if (normalizeModelName(model) !== model)
                    throw fail(`${name}: 使用无别名后缀、无 models/ 前缀的真实上游模型 ID`);
                if (name === "MODEL_WORKER_ALLOCATION") {
                    if (
                        !limit ||
                        typeof limit !== "object" ||
                        !Number.isSafeInteger(limit.min_workers) ||
                        !Number.isSafeInteger(limit.preferred_workers) ||
                        limit.min_workers < 0 ||
                        limit.preferred_workers < 1 ||
                        limit.min_workers > limit.preferred_workers
                    )
                        throw fail(`${name}: 无效资源分配`);
                } else if (!Number.isSafeInteger(limit) || limit < (name === "ACCOUNT_MODEL_MAX_CONCURRENCY" ? 0 : 1))
                    throw fail(`${name}: 无效并发上限`);
            }
        }
    }
    operational() {
        if (!this.system.ready) return false;
        if (!this.system.authSource?.availableIndices?.length) return true; // Account binding mode is healthy.
        const health = this.system.browserManager?.getContextInitHealth?.();
        if (health?.recovering) return false;
        if (this.system.scheduler && this.running.scheduler.contextPoolMinReady === 0) return true; // Intentional lazy initialization.
        return (health?.ready || 0) > 0 && !(health?.staleInitializing > 0);
    }
    snapshot(reveal = false) {
        const errorPath = path.join(path.dirname(this.file), "restart-status.json");
        if (fs.existsSync(errorPath)) this.restartError = JSON.parse(fs.readFileSync(errorPath, "utf8")).error;
        const publicValue = (config, d) => {
            if (d.secret || (d.name === "API_KEYS" && !reveal)) return null;
            const value = this.value(config, d);
            return d.type === "agents" ? value.map(row => ({ ...row, token: null })) : value;
        };
        const values = config => Object.fromEntries(definitions.map(d => [d.name, publicValue(config, d)]));
        const pending = definitions
            .filter(d => !equal(this.value(this.running, d), this.value(this.saved, d)))
            .map(d => ({
                name: d.name,
                reason: d.application === "restart" ? "资源配置需要重启" : "关联的运行模式或资源配置尚未生效",
            }));
        return {
            defaults: values(this.baseline),
            definitions: definitions.map(d => ({
                ...d,
                default: d.name === "API_KEYS" ? null : publicValue(this.defaults, d),
            })),
            environmentError: this.baselineError || null,
            hiddenModels: this.system.scheduler?.hiddenModelsSnapshot?.() || [],
            instanceId: this.instanceId,
            models: [...this.running.scheduler.registeredModels],
            modelVisibilityAvailable: !!this.system.scheduler,
            operational: this.operational(),
            overridden: Object.keys(this.document.overrides),
            pending,
            ready: this.system.ready === true,
            restartError: this.restartError || null,
            restarting: this.system.restarting === true,
            running: values(this.running),
            saved: values(this.saved),
            usageEnabled: this.running.enableUsageStats,
            version: this.document.version,
        };
    }
    initializeAccounts(state) {
        if (!this.document.migratedAccounts) {
            const overrides = { ...this.document.overrides };
            for (const [name, key] of [
                ["ACCOUNT_AUTO_RELOGIN_ENABLED", "autoRecovery"],
                ["ACCOUNT_LOGIN_CONCURRENCY", "concurrency"],
            ]) {
                if (!(name in overrides) && state.config[key] !== undefined) overrides[name] = state.config[key];
            }
            const next = this.load(overrides);
            this.document = { migratedAccounts: true, overrides, version: this.document.version + 1 };
            atomicWrite(this.file, this.document);
            this.saved = next;
            Object.assign(this.running.login, next.login);
        }
        Object.assign(state.config, this.running.login, { paused: state.config.paused ?? false });
        state.configSource = "统一服务端配置（暂停状态保留在账号数据库）";
        this.apply(this.running, true);
    }
    apply(config, force = false) {
        const { system } = this;
        const policyChanged = force || !equal(this.running.scheduler.modelAllowlist, config.scheduler.modelAllowlist);
        const debugChanged = force || this.running.debugMode !== config.debugMode;
        const dailyChanged =
            force ||
            this.running.scheduler.dailyResetEnabled !== config.scheduler.dailyResetEnabled ||
            this.running.scheduler.dailyResetTime !== config.scheduler.dailyResetTime;
        for (const d of definitions) {
            if (d.application === "hot") write(this.running, d.path, read(config, d.path));
        }

        if (system.scheduler && policyChanged) system.scheduler.permissionsChanged();
        this.running.apiKeySource = config.apiKeySource;
        if (system.accountLoginService?.state) {
            for (const d of definitions.filter(item => item.path.startsWith("login.")))
                system.accountLoginService.state.config[d.path.slice(6)] = read(this.running, d.path);
        }
        system.logger.setDisplayLimit?.(this.running.displayLimit);
        LoggingService.setLevel(this.running.debugMode ? "DEBUG" : "INFO");
        if (debugChanged) system.requestHandler?.setBrowserLogLevel?.(this.running.debugMode ? "DEBUG" : "INFO");
        if (system.scheduler && dailyChanged) {
            system.scheduler.clearTimer(system.scheduler.dailyResetTimer);
            system.scheduler.dailyResetTimer = null;
            system.scheduler._scheduleDailyReset();
        }
    }
    save({ version, changes = {}, reset = [] }) {
        if (this.system.restarting) throw fail("正在重启，暂时不能保存", 409);
        if (version !== this.document.version) throw fail("配置已被其他页面修改，请刷新并处理草稿差异", 409);
        if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Array.isArray(reset))
            throw fail("无效配置提交");
        const overrides = { ...this.document.overrides };
        for (const [name, submitted] of Object.entries(changes)) {
            let value = submitted;
            if (["PUBLIC_DASHBOARD_AGENT_TOKEN", "PUBLIC_DASHBOARD_HEALTH_TOKEN"].includes(name) && value === null)
                continue;
            if (name === "PUBLIC_DASHBOARD_AGENTS" && Array.isArray(value)) {
                value = value.map(row => ({
                    ...row,
                    token:
                        row?.token == null
                            ? this.saved.publicDashboard.agents.find(agent => agent.nodeId === row?.nodeId)?.token
                            : row.token,
                }));
            }
            this.validateField(name, value);
            if (name === "MODEL_TIER_ALLOWLIST") {
                const { parsePolicy } = require("../accounts/ModelAllowlistPolicy");
                value = parsePolicy(value);
                const registered = new Set(this.running.scheduler.registeredModels);
                const previous = this.saved.scheduler.modelAllowlist;
                for (const [tier, models] of Object.entries(value.tiers)) {
                    for (const model of models) {
                        if (!registered.has(model) && !previous.tiers[tier].includes(model))
                            throw fail(`未登记的模型：${model}`);
                    }
                }
            }
            overrides[name] = clone(value);
        }
        for (const name of reset) {
            if (!definitions.some(d => d.name === name)) throw fail(`不允许重置：${name}`);
            if (name === "MODEL_TIER_ALLOWLIST") throw fail("模型白名单不支持重置，请在权限矩阵中显式修改");
            delete overrides[name];
        }
        let target;
        try {
            target = this.load(overrides);
        } catch (error) {
            throw fail(error.message);
        }
        const active = clone(this.running);
        active.apiKeySource = target.apiKeySource;
        const applied = [],
            deferred = [];
        const modeChanged = target.scheduler.strategy !== this.running.scheduler.strategy;
        const concurrencyDependencies = new Set([
            "GLOBAL_MAX_CONCURRENCY",
            "MODEL_WORKER_ALLOCATION",
            "MAX_BROWSER_WORKERS",
            "ENABLE_DYNAMIC_WORKER_ALLOCATION",
            "SCHEDULER_READY_CONTEXT_ONLY",
        ]);
        const resourcesChanged = definitions.some(
            d => concurrencyDependencies.has(d.name) && !equal(read(target, d.path), read(this.running, d.path))
        );
        const concurrencyFields = new Set([
            "CONTEXT_MAX_CONCURRENCY",
            "ACCOUNT_MAX_CONCURRENCY",
            "ACCOUNT_MODEL_MAX_CONCURRENCY",
            "MODEL_MAX_CONCURRENCY",
        ]);
        for (const d of definitions) {
            if (equal(read(target, d.path), read(active, d.path))) continue;
            const dependent = d.mode !== "all" && (modeChanged || (concurrencyFields.has(d.name) && resourcesChanged));
            if (d.application === "hot" && !dependent) {
                write(active, d.path, read(target, d.path));
                applied.push(d.name);
            } else deferred.push(d.name);
        }
        // Validate the complete actual post-apply configuration, including unchanged file-only dependencies.
        const activeOverrides = Object.fromEntries(definitions.map(d => [d.name, this.value(active, d)]));
        try {
            this.load(activeOverrides);
        } catch (error) {
            throw fail(error.message);
        }
        const previous = clone(this.document),
            previousRunning = clone(this.running);
        const document = { ...previous, overrides, version: previous.version + 1 };
        atomicWrite(this.file, document);
        try {
            this.apply(active);
        } catch (error) {
            let rollbackError;
            try {
                this.apply(previousRunning);
                atomicWrite(this.file, previous);
            } catch (cause) {
                rollbackError = cause;
            }
            if (rollbackError) {
                this.document = JSON.parse(fs.readFileSync(this.file, "utf8"));
                this.saved = this.load(this.document.overrides);
                throw fail(`保存或应用失败，回滚未完成：${rollbackError.message}；请重新读取实际状态`, 500);
            }
            throw fail(`热应用失败，已恢复配置：${error.message}`, 500);
        }
        this.document = document;
        this.saved = target;
        if (this.system.scheduler)
            queueMicrotask(() => {
                try {
                    this.system.scheduler.drain();
                } catch (error) {
                    this.system.logger.error("[Config] Scheduler dispatch after configuration update failed");
                }
            });
        return { ...this.snapshot(), applied, deferred };
    }
    runningDocument() {
        return {
            migratedAccounts: true,
            overrides: Object.fromEntries(definitions.map(d => [d.name, this.value(this.running, d)])),
            version: this.document.version,
        };
    }
    undo(version) {
        return this.save({
            changes: Object.fromEntries(
                definitions
                    .filter(d => !equal(read(this.saved, d.path), read(this.running, d.path)))
                    .map(d => [d.name, this.value(this.running, d)])
            ),
            version,
        });
    }
}
module.exports = { atomicWrite, ConfigurationService, definitions, storagePath };
