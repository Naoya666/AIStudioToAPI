const definitions = {
    attemptTimeout: ["ACCOUNT_LOGIN_ATTEMPT_TIMEOUT_MS", 180000, 1800000],
    browserIdleTimeout: ["ACCOUNT_LOGIN_BROWSER_IDLE_TIMEOUT_MS", 60000, 3600000],
    browserMaxAge: ["ACCOUNT_LOGIN_BROWSER_MAX_AGE_MS", 1800000, 86400000],
    browserMaxAttempts: ["ACCOUNT_LOGIN_BROWSER_MAX_ATTEMPTS", 20, 1000],
    cleanupTimeout: ["ACCOUNT_LOGIN_CLEANUP_TIMEOUT_MS", 10000, 60000],
    concurrency: ["ACCOUNT_LOGIN_CONCURRENCY", 1, 32],
    logDays: ["ACCOUNT_LOGIN_LOG_RETENTION_DAYS", 30, 365],
    maxAttempts: ["ACCOUNT_LOGIN_MAX_ATTEMPTS", 3, 10],
    queueLimit: ["ACCOUNT_LOGIN_QUEUE_LIMIT", 1000, 10000],
    recoveryTimeout: ["ACCOUNT_LOGIN_RECOVERY_TIMEOUT_MS", 900000, 86400000],
    screenshotDays: ["ACCOUNT_LOGIN_SCREENSHOT_RETENTION_DAYS", 7, 365],
    screenshotsPerAccount: ["ACCOUNT_LOGIN_SCREENSHOTS_PER_ACCOUNT", 10, 100],
    screenshotTimeout: ["ACCOUNT_LOGIN_SCREENSHOT_TIMEOUT_MS", 5000, 30000],
    stepTimeout: ["ACCOUNT_LOGIN_STEP_TIMEOUT_MS", 30000, 300000],
};
function config(env = process.env) {
    const result = {};
    for (const [key, [name, fallback, maximum]] of Object.entries(definitions)) {
        const value = env[name] === undefined ? fallback : Number(env[name]);
        if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`Invalid ${name}`);
        result[key] = value;
    }
    result.autoRecovery = env.ACCOUNT_AUTO_RELOGIN_ENABLED !== "false";
    if (env.ACCOUNT_LOGIN_HUMANIZE !== undefined && !["true", "false"].includes(env.ACCOUNT_LOGIN_HUMANIZE))
        throw new Error("Invalid ACCOUNT_LOGIN_HUMANIZE");
    result.humanize = env.ACCOUNT_LOGIN_HUMANIZE !== "false";
    if (env.ACCOUNT_LOGIN_BROWSER_REUSE !== undefined && !["true", "false"].includes(env.ACCOUNT_LOGIN_BROWSER_REUSE))
        throw new Error("Invalid ACCOUNT_LOGIN_BROWSER_REUSE");
    result.browserReuse = env.ACCOUNT_LOGIN_BROWSER_REUSE === "true";
    result.paused = false;
    return result;
}
module.exports = { config };
