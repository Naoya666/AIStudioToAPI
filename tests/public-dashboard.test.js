const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadSchedulerConfig = require("../src/core/SchedulerConfig");
const ConfigLoader = require("../src/utils/ConfigLoader");
const PublicDashboardServer = require("../src/public/PublicDashboardServer");
const PublicDashboardService = require("../src/public/PublicDashboardService");
const UsageStatsService = require("../src/core/UsageStatsService");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

test("public dashboard configuration is off by default and validates ports and origins", () => {
    const names = [
        "HOST",
        "PORT",
        "PUBLIC_DASHBOARD_CORS_ORIGINS",
        "PUBLIC_DASHBOARD_ENABLED",
        "PUBLIC_DASHBOARD_HOST",
        "PUBLIC_DASHBOARD_PORT",
    ];
    const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
    const restore = () => {
        for (const name of names) {
            if (original[name] === undefined) delete process.env[name];
            else process.env[name] = original[name];
        }
    };
    try {
        for (const name of names) delete process.env[name];
        process.env.HOST = "127.0.0.1";
        let config = new ConfigLoader(logger).loadConfiguration();
        assert.deepEqual(config.publicDashboard, {
            ...require("../src/public/DashboardConfig").defaults,
            corsOrigins: [],
            enabled: false,
            host: "127.0.0.1",
            port: 7861,
        });

        process.env.PUBLIC_DASHBOARD_ENABLED = "TRUE";
        process.env.PUBLIC_DASHBOARD_PORT = "7860";
        assert.throws(() => new ConfigLoader(logger).loadConfiguration(), /must differ/);
        process.env.PUBLIC_DASHBOARD_PORT = "7862";
        process.env.PUBLIC_DASHBOARD_CORS_ORIGINS = "https://status.example.org/path";
        assert.throws(() => new ConfigLoader(logger).loadConfiguration(), /Invalid PUBLIC_DASHBOARD_CORS_ORIGINS/);
        process.env.PUBLIC_DASHBOARD_CORS_ORIGINS = "https://status.example.org";
        config = new ConfigLoader(logger).loadConfiguration();
        assert.equal(config.publicDashboard.enabled, true);
        assert.deepEqual(config.publicDashboard.corsOrigins, ["https://status.example.org"]);
    } finally {
        restore();
    }
});

test("public scheduler snapshot is side-effect-free and distinguishes unknown quota", () => {
    const authSource = {
        accountNameMap: new Map([[0, "PUBLIC_MUST_NOT_SEE_ACCOUNT"]]),
        getRotationIndices: () => [0],
    };
    const config = loadSchedulerConfig({
        GLOBAL_MAX_CONCURRENCY: "2",
        MAX_BROWSER_WORKERS: "1",
        MODEL_WORKER_ALLOCATION: JSON.stringify({ "gemini-flash": 1, "unknown-model": 1 }),
    });
    const scheduler = new ModelScheduler({ ...config, statePath: null }, authSource, logger);
    assert.equal(scheduler.accounts.size, 0);
    const snapshot = scheduler.publicSummarySnapshot();
    assert.equal(scheduler.accounts.size, 0);
    assert.equal(snapshot.limit, 2);
    assert.equal(snapshot.models.find(item => item.model === "gemini-flash").estimatedRemaining, 100);
    assert.equal(snapshot.models.find(item => item.model === "unknown-model").estimatedRemaining, null);
    scheduler.close();
});

test("public capacity adds ready Build and PG channels without counting cold accounts or consuming state", t => {
    const auth = {
        accountNameMap: new Map(),
        getRotationIndices: () => [0, 1, 2],
    };
    const config = loadSchedulerConfig({
        BUILD_MAX_CONCURRENCY: "1",
        CONTEXT_MAX_CONCURRENCY: "11",
        GLOBAL_MAX_CONCURRENCY: "300",
        MAX_BROWSER_WORKERS: "3",
        MODEL_WORKER_ALLOCATION: JSON.stringify({ "build/gemini-3.8-flash": 1, "gemini-3.8-flash": 1 }),
        PG_MAX_CONCURRENCY: "10",
    });
    const scheduler = new ModelScheduler({ ...config, statePath: null }, auth, logger);
    t.after(() => scheduler.close());
    scheduler.browserManager = {
        contexts: new Map(),
        isContextReady: index => index < 2,
    };
    let snapshot = scheduler.publicSummarySnapshot();
    assert.equal(snapshot.limit, 22);
    assert.equal(scheduler.accounts.size, 0);
    assert.ok(snapshot.models.every(model => model.dispatchableAccounts === 2 && model.availableAccounts === 3));
    scheduler.browserManager.benefitCheckingIndices = new Set([1]);
    snapshot = scheduler.publicSummarySnapshot();
    assert.equal(snapshot.limit, 11);
    assert.ok(snapshot.models.every(model => model.dispatchableAccounts === 1 && model.availableAccounts === 3));
    const account = scheduler.account(0);
    account.inflight = 1;
    account.models["build/gemini-3.8-flash"] = { inflight: 1 };
    scheduler.workers[0].lease = { model: "build/gemini-3.8-flash" };
    snapshot = scheduler.publicSummarySnapshot();
    assert.equal(snapshot.limit, 11);
    assert.equal(snapshot.models.find(model => model.model.startsWith("build/")).dispatchableAccounts, 0);
    assert.equal(snapshot.models.find(model => model.model.startsWith("build/")).availableAccounts, 3);
    assert.equal(account.inflight, 1);
    scheduler.workers[0].lease = null;
    account.inflight = 0;
    account.models["build/gemini-3.8-flash"].inflight = 0;
    account.models["gemini-3.8-flash"] = { cooldown_until: Date.now() + 60000, inflight: 0 };
    scheduler.config.modelConcurrency["build/gemini-3.8-flash"] = 1;
    assert.equal(scheduler.publicSummarySnapshot().limit, 1);
});

test("public history projection whitelists visible models and merges failures", () => {
    const service = new UsageStatsService(null, logger, null, false);
    service.enabled = true;
    service.summary = { abortedCount: 1, errorCount: 1, successCount: 2, totalDurationMs: 1000, totalRequests: 4 };
    service.modelStats = new Map([
        [
            "visible",
            {
                abortedCount: 1,
                accountCounts: { leaked: "public-must-not-see@example.com" },
                errorCount: 0,
                successCount: 1,
                totalDurationMs: 500,
                totalRequests: 2,
            },
        ],
        ["hidden", { abortedCount: 0, errorCount: 0, successCount: 10, totalDurationMs: 10, totalRequests: 10 }],
    ]);
    const snapshot = service.getPublicSummarySnapshot(["visible", "empty"]);
    assert.equal(snapshot.summary.failedRequests, 2);
    assert.deepEqual(
        snapshot.models.map(item => item.modelKey),
        ["empty", "visible"]
    );
    assert.equal(snapshot.models[0].successRate, null);
    assert.doesNotMatch(JSON.stringify(snapshot), /hidden|public-must-not-see/);
});

test("dashboard DTO and isolated routes expose only public data", async () => {
    const scheduler = {
        publicSummarySnapshot: () => ({
            active: 1,
            limit: 2,
            models: [
                {
                    active: 1,
                    availableAccounts: 3,
                    estimatedRemaining: 99,
                    model: "gemini-flash",
                    queued: 0,
                    rateLimitedAccounts: 1,
                    secret: "PUBLIC_MUST_NOT_SEE_KEY",
                    todayRequests: 1,
                },
            ],
            queued: 0,
            usageWindow: { date: "2026-09-11", timezone: "America/Los_Angeles" },
        }),
    };
    const usageStatsService = {
        getPublicModelWindows: async (models, asOfMs) =>
            new UsageStatsService(null, logger, null, false).getPublicModelWindows(models, asOfMs),
        getPublicSummarySnapshot: () => ({
            enabled: true,
            models: [
                {
                    averageDurationMs: 50,
                    failedRequests: 0,
                    modelKey: "gemini-flash",
                    successRate: 100,
                    totalRequests: 1,
                },
            ],
            summary: { averageDurationMs: 50, failedRequests: 0, successRate: 100, totalRequests: 1 },
        }),
    };
    const projection = await new PublicDashboardService(scheduler, usageStatsService, { cacheTtlMs: 0 }).getSnapshot();
    assert.equal(projection.models[0].quota.estimated_remaining, 99);
    assert.doesNotMatch(JSON.stringify(projection), /PUBLIC_MUST_NOT_SEE_KEY|secret/);

    const publicServer = new PublicDashboardServer({
        config: { corsOrigins: ["https://status.example.org"], host: "127.0.0.1", port: 0 },
        logger,
        scheduler,
        usageStatsService,
    });
    const app = publicServer.createApp();
    const routes = app._router.stack.filter(layer => layer.route).map(layer => layer.route);
    const paths = routes.map(route => route.path);
    assert.deepEqual(paths.sort(), ["/", "/api/public/dashboard", "/api/public/dashboard", "/healthz"].sort());
    assert.equal(paths.includes("/api/status"), false);
    assert.equal(paths.includes("/v1/models"), false);
    const dashboardRoute = routes.find(route => route.path === "/api/public/dashboard" && route.methods.get);
    assert.equal(dashboardRoute.methods.post, undefined);

    const invokeDashboard = async headers => {
        const response = {
            body: null,
            end() {
                return this;
            },
            headers: {},
            json(body) {
                this.body = JSON.stringify(body);
                return this;
            },
            send(body) {
                this.body = body;
                return this;
            },
            set(name, value) {
                if (typeof name === "object") Object.assign(this.headers, name);
                else this.headers[name] = value;
                return this;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            statusCode: 200,
            type() {
                return this;
            },
        };
        await dashboardRoute.stack[0].handle(
            { get: name => headers?.[name.toLowerCase()], headers: headers || {} },
            response
        );
        return response;
    };
    const dashboard = await invokeDashboard();
    assert.equal(dashboard.statusCode, 200);
    assert.ok(dashboard.headers.ETag);
    const cached = await invokeDashboard({ "if-none-match": dashboard.headers.ETag });
    assert.equal(cached.statusCode, 304);
    publicServer.service.getSnapshot = async () => {
        throw new Error("PRIVATE_ERROR");
    };
    const failed = await invokeDashboard();
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(JSON.parse(failed.body), { error: "dashboard_temporarily_unavailable" });
});

const deferred = () => {
    let resolve;
    const promise = new Promise(done => {
        resolve = done;
    });
    return { promise, resolve };
};
const dashboardFixture = (cacheTtlMs = 1000) => {
    let visible = ["visible", "hidden-later"];
    const stats = new UsageStatsService(null, logger, null, false);
    let queries = 0;
    const service = new PublicDashboardService(
        {
            publicSummarySnapshot: () => ({
                active: 0,
                limit: 1,
                models: visible.map(model => ({ model })),
                queued: 0,
                usageWindow: { date: null, timezone: "America/Los_Angeles" },
            }),
        },
        {
            getPublicModelWindows: async (...args) => {
                queries++;
                return stats.getPublicModelWindows(...args);
            },
            getPublicSummarySnapshot: models => stats.getPublicSummarySnapshot(models),
        },
        { cacheTtlMs }
    );
    return {
        queries: () => queries,
        service,
        setVisible: models => {
            visible = models;
        },
    };
};

test("snapshot merges concurrent queries, preserves cached boundaries and expires", async () => {
    const fixture = dashboardFixture();
    const [first, concurrent] = await Promise.all([fixture.service.getSnapshot(), fixture.service.getSnapshot()]);
    assert.strictEqual(first, concurrent);
    assert.strictEqual(await fixture.service.getSnapshot(), first);
    assert.equal(fixture.queries(), 1);
    assert.equal(first.generated_at, first.model_stat_windows["24h"].to);
    assert.equal(first.generated_at, first.model_stat_windows["1h"].to);
    fixture.service.cachedAt -= 1000;
    assert.notStrictEqual(await fixture.service.getSnapshot(), first);
    assert.equal(fixture.queries(), 2);
    fixture.setVisible(["visible"]);
    assert.deepEqual(
        (await fixture.service.getSnapshot()).models.map(item => item.model),
        ["visible"]
    );
});

test("visibility changes discard both in-flight results and cached hidden models", async () => {
    const fixture = dashboardFixture();
    const gate = deferred();
    const original = fixture.service.usageStatsService.getPublicModelWindows;
    let calls = 0;
    fixture.service.usageStatsService.getPublicModelWindows = async (...args) => {
        if (++calls === 1) await gate.promise;
        return original(...args);
    };
    const oldRequest = fixture.service.getSnapshot();
    fixture.setVisible(["visible"]);
    const current = await fixture.service.getSnapshot();
    gate.resolve();
    const previous = await oldRequest;
    assert.deepEqual(
        previous.models.map(item => item.model),
        ["visible"]
    );
    assert.strictEqual(previous, current);
    assert.strictEqual(await fixture.service.getSnapshot(), current);
    assert.equal(calls, 2);
});

test("recent failure degrades safely and complete build failure releases pending promise", async () => {
    const fixture = dashboardFixture(0);
    const original = fixture.service.usageStatsService.getPublicModelWindows;
    fixture.service.usageStatsService.getPublicModelWindows = async () => {
        throw new Error("PRIVATE_DB");
    };
    const partial = await fixture.service.getSnapshot();
    assert.equal(partial.model_stat_windows["24h"].status, "unavailable");
    assert.equal(partial.models[0].recent_stats["24h"].total_requests, null);
    assert.doesNotMatch(JSON.stringify(partial), /PRIVATE_DB/);
    fixture.service.usageStatsService.getPublicModelWindows = original;
    assert.equal((await fixture.service.getSnapshot()).model_stat_windows["24h"].status, "disabled");
    const history = fixture.service.usageStatsService.getPublicSummarySnapshot;
    fixture.service.usageStatsService.getPublicSummarySnapshot = () => {
        throw new Error("failed build");
    };
    await assert.rejects(fixture.service.getSnapshot(), /failed build/);
    assert.equal(fixture.service.pending, null);
    fixture.service.usageStatsService.getPublicSummarySnapshot = history;
    assert.ok(await fixture.service.getSnapshot());
});

test("recent DTO whitelists aggregates, sanitizes values and preserves history", async () => {
    const fixture = dashboardFixture(0);
    fixture.service.usageStatsService.getPublicModelWindows = async () => ({
        models: [
            {
                clientIp: "203.0.113.99",
                modelKey: "visible",
                stats: {
                    "1h": {
                        averageDurationMs: -1,
                        failedRequests: Infinity,
                        successRate: 101,
                        totalRequests: Number.MAX_SAFE_INTEGER + 1,
                    },
                    "24h": {
                        averageDurationMs: 1234,
                        failedRequests: 1,
                        secret: "PRIVATE_VALUE",
                        successRate: 66.666,
                        totalRequests: 3,
                    },
                },
            },
        ],
        windows: {
            "1h": { status: "available" },
            "24h": { from: "PRIVATE_FROM", secret: "PRIVATE_META", status: "available" },
        },
    });
    const snapshot = await fixture.service.getSnapshot();
    assert.deepEqual(snapshot.models[0].recent_stats["24h"], {
        average_duration_ms: 1234,
        failed_requests: 1,
        success_rate: 66.7,
        total_requests: 3,
    });
    assert.deepEqual(snapshot.models[0].recent_stats["1h"], {
        average_duration_ms: 0,
        failed_requests: 0,
        success_rate: null,
        total_requests: 0,
    });
    assert.equal(snapshot.schema_version, 1);
    assert.equal(snapshot.history.enabled, false);
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|203.0.113.99|clientIp|secret/);
});
