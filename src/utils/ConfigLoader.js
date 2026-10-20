/**
 * File: src/utils/ConfigLoader.js
 * Description: Configuration loader that reads and validates system settings from environment variables
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const fs = require("fs");
const path = require("path");
const { DEFAULT_MAKERSUITE_TIMEOUT_MS, MAX_GENERATION_TIMEOUT_MS } = require("../config/TransportConfig");
const { getProxySummaryFromEnv } = require("./ProxyUtils");

/**
 * Configuration Loader Module
 * Responsible for loading system configuration from environment variables
 */
class ConfigLoader {
    constructor(logger) {
        this.logger = logger;
    }

    loadConfiguration(env = process.env) {
        const config = {
            antiTruncationDefault: "off",
            antiTruncationEnabled: true,
            apiKeys: [],
            apiKeySource: "Not set",
            browserExecutablePath: null,
            checkUpdate: true,
            enableAuthUpdate: true,
            enableUsageStats: true,
            failureThreshold: 3,
            fakeStreamTimeoutMs: 300000,
            forceCodeExecution: false,
            forceThinking: false,
            forceUrlContext: false,
            forceWebSearch: false,
            host: "0.0.0.0",
            httpPort: 7860,
            immediateSwitchStatusCodes: [429, 503],
            makerSuiteTimeoutMs: DEFAULT_MAKERSUITE_TIMEOUT_MS,
            maxContexts: 1,
            maxRetries: 3,
            publicDashboard: {
                corsOrigins: [],
                enabled: false,
                host: "0.0.0.0",
                port: 7861,
            },
            retryDelay: 2000,
            safetySettingsThreshold: "OFF",
            streamingMode: "real",
            streamTimeoutMs: 60000,
            switchOnUses: 40,
            usageStorage: {
                cleanupBatchSize: 1000,
                cleanupIntervalMinutes: 60,
                dbPath: path.join(process.cwd(), "data", "usage-stats.sqlite"),
                retentionDays: 30,
            },
            wsPort: 9998,
        };

        config.modelTransportPolicy = require("../core/ModelTransportPolicy").parsePolicy(env.MODEL_TRANSPORT_POLICY);

        config.scheduler = require("../core/SchedulerConfig")(env);

        // Environment variable overrides
        if (env.PORT) {
            const parsed = parseInt(env.PORT, 10);
            config.httpPort = Number.isFinite(parsed) ? parsed : config.httpPort;
        }
        if (env.HOST) config.host = env.HOST;
        config.publicDashboard.host = env.PUBLIC_DASHBOARD_HOST || config.host;
        config.publicDashboard.enabled = env.PUBLIC_DASHBOARD_ENABLED?.toLowerCase() === "true";
        if (env.PUBLIC_DASHBOARD_PORT !== undefined) {
            const rawPort = String(env.PUBLIC_DASHBOARD_PORT).trim();
            const parsed = Number(rawPort);
            if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
                throw new Error("Invalid PUBLIC_DASHBOARD_PORT: expected an integer between 1 and 65535");
            }
            config.publicDashboard.port = parsed;
        }
        if (env.PUBLIC_DASHBOARD_CORS_ORIGINS) {
            config.publicDashboard.corsOrigins = env.PUBLIC_DASHBOARD_CORS_ORIGINS.split(",").map(value => {
                const origin = value.trim();
                let parsed;
                try {
                    parsed = new URL(origin);
                } catch {
                    throw new Error(`Invalid PUBLIC_DASHBOARD_CORS_ORIGINS origin: ${origin}`);
                }
                if (
                    !["http:", "https:"].includes(parsed.protocol) ||
                    parsed.origin !== origin ||
                    parsed.username ||
                    parsed.password
                ) {
                    throw new Error(`Invalid PUBLIC_DASHBOARD_CORS_ORIGINS origin: ${origin}`);
                }
                return origin;
            });
        }
        require("../public/DashboardConfig").load(config.publicDashboard, env);
        if (env.ANTI_TRUNCATION_ENABLED !== undefined) {
            if (!["true", "false"].includes(String(env.ANTI_TRUNCATION_ENABLED).toLowerCase()))
                throw new Error("Invalid ANTI_TRUNCATION_ENABLED: expected true or false");
            config.antiTruncationEnabled = String(env.ANTI_TRUNCATION_ENABLED).toLowerCase() === "true";
        }
        if (env.ANTI_TRUNCATION_DEFAULT !== undefined) {
            if (!["off", "prefer"].includes(env.ANTI_TRUNCATION_DEFAULT))
                throw new Error("Invalid ANTI_TRUNCATION_DEFAULT: expected off or prefer");
            config.antiTruncationDefault = env.ANTI_TRUNCATION_DEFAULT;
        }
        if (env.STREAMING_MODE) config.streamingMode = env.STREAMING_MODE;
        if (env.FAILURE_THRESHOLD) {
            const parsed = parseInt(env.FAILURE_THRESHOLD, 10);
            config.failureThreshold = Number.isFinite(parsed) ? Math.max(0, parsed) : config.failureThreshold;
        }
        if (env.SWITCH_ON_USES) {
            const parsed = parseInt(env.SWITCH_ON_USES, 10);
            config.switchOnUses = Number.isFinite(parsed) ? Math.max(0, parsed) : config.switchOnUses;
        }
        if (env.MAX_RETRIES) {
            const parsed = parseInt(env.MAX_RETRIES, 10);
            config.maxRetries = Number.isFinite(parsed) ? Math.max(1, parsed) : config.maxRetries;
        }
        if (env.RETRY_DELAY) {
            const parsed = parseInt(env.RETRY_DELAY, 10);
            config.retryDelay = Number.isFinite(parsed) ? Math.max(50, parsed) : config.retryDelay;
        }
        if (env.STREAM_TIMEOUT_MS) {
            const parsed = parseInt(env.STREAM_TIMEOUT_MS, 10);
            config.streamTimeoutMs = Number.isFinite(parsed)
                ? Math.min(300000, Math.max(1, parsed))
                : config.streamTimeoutMs;
        }
        for (const [name, key] of [
            ["MAKERSUITE_TIMEOUT_MS", "makerSuiteTimeoutMs"],
            ["FAKE_STREAM_TIMEOUT_MS", "fakeStreamTimeoutMs"],
        ]) {
            if (env[name] === undefined) continue;
            const parsed = Number(env[name]);
            if (
                !String(env[name]).trim() ||
                !Number.isSafeInteger(parsed) ||
                parsed < 1 ||
                parsed > MAX_GENERATION_TIMEOUT_MS
            )
                throw new Error(`Invalid ${name}: expected an integer between 1 and ${MAX_GENERATION_TIMEOUT_MS}`);
            config[key] = parsed;
        }
        if (env.WS_PORT) {
            // WS_PORT environment variable is no longer supported
            this.logger.error(
                `[Config] ❌ WS_PORT environment variable is deprecated and no longer supported. ` +
                    `The WebSocket port is now fixed at 9998. Please remove WS_PORT from your .env file.`
            );
            // Do not modify config.wsPort - keep it at default 9998
        }
        if (env.MAX_CONTEXTS) {
            const parsed = parseInt(env.MAX_CONTEXTS, 10);
            config.maxContexts = Number.isFinite(parsed) ? Math.max(0, parsed) : config.maxContexts;
        }
        if (env.CAMOUFOX_EXECUTABLE_PATH) config.browserExecutablePath = env.CAMOUFOX_EXECUTABLE_PATH;
        if (env.API_KEYS) {
            config.apiKeys = env.API_KEYS.split(",");
        }
        if (env.CHECK_UPDATE) config.checkUpdate = env.CHECK_UPDATE.toLowerCase() !== "false";
        if (env.FORCE_THINKING) config.forceThinking = env.FORCE_THINKING.toLowerCase() === "true";
        if (env.FORCE_CODE_EXECUTION) config.forceCodeExecution = env.FORCE_CODE_EXECUTION.toLowerCase() === "true";
        if (env.FORCE_WEB_SEARCH) config.forceWebSearch = env.FORCE_WEB_SEARCH.toLowerCase() === "true";
        if (env.FORCE_URL_CONTEXT) config.forceUrlContext = env.FORCE_URL_CONTEXT.toLowerCase() === "true";
        if (env.SAFETY_SETTINGS_THRESHOLD) {
            const rawThreshold = String(env.SAFETY_SETTINGS_THRESHOLD).trim().toUpperCase();
            const allowedThresholds = new Set([
                "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
                "BLOCK_LOW_AND_ABOVE",
                "BLOCK_MEDIUM_AND_ABOVE",
                "BLOCK_ONLY_HIGH",
                "BLOCK_NONE",
                "OFF",
            ]);
            if (allowedThresholds.has(rawThreshold)) {
                config.safetySettingsThreshold = rawThreshold;
            } else {
                this.logger.warn(
                    `[Config] Invalid SAFETY_SETTINGS_THRESHOLD "${env.SAFETY_SETTINGS_THRESHOLD}", falling back to ${config.safetySettingsThreshold}.`
                );
            }
        }
        if (env.ENABLE_AUTH_UPDATE) config.enableAuthUpdate = env.ENABLE_AUTH_UPDATE.toLowerCase() !== "false";
        if (env.ENABLE_USAGE_STATS) config.enableUsageStats = env.ENABLE_USAGE_STATS.toLowerCase() !== "false";
        const strictInteger = (name, defaultValue, { allowZero = false, max = Number.MAX_SAFE_INTEGER } = {}) => {
            if (env[name] === undefined) return defaultValue;
            const raw = String(env[name]).trim();
            const value = Number(raw);
            if (
                !/^\d+$/.test(raw) ||
                !Number.isSafeInteger(value) ||
                value > max ||
                (allowZero ? value < 0 : value < 1)
            ) {
                throw new Error(`Invalid ${name}: expected ${allowZero ? "a non-negative" : "a positive"} integer`);
            }
            return value;
        };
        config.usageStorage.retentionDays = strictInteger("USAGE_LOG_RETENTION_DAYS", 30, {
            allowZero: true,
            max: Math.floor(Number.MAX_SAFE_INTEGER / 86400000),
        });
        config.usageStorage.cleanupIntervalMinutes = strictInteger("USAGE_LOG_CLEANUP_INTERVAL_MINUTES", 60, {
            max: Math.floor(2147483647 / 60000),
        });
        config.usageStorage.cleanupBatchSize = strictInteger("USAGE_LOG_CLEANUP_BATCH_SIZE", 1000);
        if (env.USAGE_DB_PATH !== undefined) {
            const rawPath = String(env.USAGE_DB_PATH).trim();
            if (!rawPath) throw new Error("Invalid USAGE_DB_PATH: expected a non-empty path");
            config.usageStorage.dbPath = path.resolve(process.cwd(), rawPath);
        }

        if (config.publicDashboard.enabled && [config.httpPort, config.wsPort].includes(config.publicDashboard.port)) {
            throw new Error("PUBLIC_DASHBOARD_PORT must differ from PORT and the internal WebSocket port");
        }

        let rawCodes = env.IMMEDIATE_SWITCH_STATUS_CODES;
        let codesSource = "environment variable";

        if (
            rawCodes === undefined &&
            config.immediateSwitchStatusCodes &&
            Array.isArray(config.immediateSwitchStatusCodes)
        ) {
            rawCodes = config.immediateSwitchStatusCodes.join(",");
            codesSource = "default value";
        }

        if (rawCodes && typeof rawCodes === "string") {
            config.immediateSwitchStatusCodes = rawCodes
                .split(",")
                .map(code => parseInt(String(code).trim(), 10))
                .filter(code => !isNaN(code) && code >= 400 && code <= 599);
        } else {
            config.immediateSwitchStatusCodes = [];
        }
        if (config.immediateSwitchStatusCodes.length > 0) {
            this.logger.info(`[System] Loaded "immediate switch status codes" from ${codesSource}.`);
        }
        if (Array.isArray(config.apiKeys)) {
            config.apiKeys = config.apiKeys.map(k => String(k).trim()).filter(k => k);
        } else {
            config.apiKeys = [];
        }

        if (config.apiKeys.length > 0) {
            config.apiKeySource = "Custom";
        } else {
            config.apiKeys = ["123456"];
            config.apiKeySource = "Default";
            this.logger.info("[System] No API key set, using default password: 123456");
        }

        // Load model list
        const modelsPath = path.join(process.cwd(), "configs", "models.json");
        try {
            if (fs.existsSync(modelsPath)) {
                const modelsFileContent = fs.readFileSync(modelsPath, "utf-8");
                const modelsData = JSON.parse(modelsFileContent);
                if (modelsData && modelsData.models) {
                    config.modelList = modelsData.models;
                    this.logger.info(
                        `[System] Successfully loaded ${config.modelList.length} models from models.json.`
                    );
                } else {
                    this.logger.warn(`[System] models.json is not in the expected format, using default model list.`);
                    config.modelList = [{ name: "models/gemini-2.5-flash-lite" }];
                }
            } else {
                this.logger.warn(`[System] models.json file not found, using default model list.`);
                config.modelList = [{ name: "models/gemini-2.5-flash-lite" }];
            }
        } catch (error) {
            this.logger.error(
                `[System] Failed to read or parse models.json: ${error.message}, using default model list.`
            );
            config.modelList = [{ name: "models/gemini-2.5-flash-lite" }];
        }

        const { catalogModels, initialPolicy, parsePolicy } = require("../accounts/ModelAllowlistPolicy");
        config.scheduler.modelAllowlist =
            env.MODEL_TIER_ALLOWLIST === undefined
                ? initialPolicy(config.modelList)
                : parsePolicy(env.MODEL_TIER_ALLOWLIST);
        config.scheduler.registeredModels = catalogModels(config.modelList);
        this._printConfiguration(config);
        return config;
    }

    _printConfiguration(config) {
        this.logger.info("================ [ Active Configuration ] ================");
        this.logger.info(`  HTTP Server Port: ${config.httpPort}`);
        this.logger.info(`  Listening Address: ${config.host}`);
        this.logger.info(`  Streaming Mode: ${config.streamingMode}`);
        this.logger.info(`  Stream Timeout: ${config.streamTimeoutMs}ms`);
        this.logger.info(`  Fake/Non-Stream Timeout: ${config.fakeStreamTimeoutMs}ms`);
        this.logger.info(`  Force Thinking: ${config.forceThinking}`);
        this.logger.info(`  Force Code Execution: ${config.forceCodeExecution}`);
        this.logger.info(`  Force Web Search: ${config.forceWebSearch}`);
        this.logger.info(`  Force URL Context: ${config.forceUrlContext}`);
        this.logger.info(`  Check Update: ${config.checkUpdate}`);
        this.logger.info(`  Default Safety Threshold: ${config.safetySettingsThreshold}`);
        this.logger.info(`  Auto Update Auth: ${config.enableAuthUpdate}`);
        this.logger.info(`  Usage Stats: ${config.enableUsageStats}`);
        if (config.enableUsageStats) {
            this.logger.info(`  Usage Detail Retention: ${config.usageStorage.retentionDays || "Forever"}`);
            this.logger.info(`  Usage Cleanup Interval: ${config.usageStorage.cleanupIntervalMinutes} minutes`);
        }
        this.logger.info(
            `  Public Dashboard: ${
                config.publicDashboard.enabled
                    ? `Enabled (${config.publicDashboard.host}:${config.publicDashboard.port})`
                    : "Disabled"
            }`
        );
        this.logger.info(`  Max Contexts: ${config.maxContexts === 0 ? "Unlimited" : config.maxContexts}`);
        this.logger.info(
            `  Usage-based Switch Threshold: ${
                config.switchOnUses > 0 ? `Switch after every ${config.switchOnUses} requests` : "Disabled"
            }`
        );
        this.logger.info(
            `  Failure-based Switch: ${
                config.failureThreshold > 0 ? `Switch after ${config.failureThreshold} failures` : "Disabled"
            }`
        );
        this.logger.info(
            `  Immediate Switch Status Codes: ${
                config.immediateSwitchStatusCodes.length > 0 ? config.immediateSwitchStatusCodes.join(", ") : "Disabled"
            }`
        );
        this.logger.info(`  Max Retries per Request: ${config.maxRetries} times`);
        this.logger.info(`  Retry Delay: ${config.retryDelay}ms`);
        this.logger.info(`  API Key Source: ${config.apiKeySource}`);

        const proxySummary = getProxySummaryFromEnv();
        if (!proxySummary.enabled) {
            this.logger.info("  Proxy: Disabled");
        } else {
            this.logger.info(`  Proxy: Enabled (${proxySummary.envKey})`);
            this.logger.info(`  Proxy Server: ${proxySummary.server}`);
        }
        this.logger.info("=============================================================");
    }
}

module.exports = ConfigLoader;
