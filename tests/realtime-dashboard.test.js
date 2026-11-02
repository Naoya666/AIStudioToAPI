/* eslint-env browser */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const UsageStatsService = require("../src/core/UsageStatsService");
const LoggingService = require("../src/utils/LoggingService");
const StatusRoutes = require("../src/routes/StatusRoutes");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

test("usage summary is bounded and records use stable opaque cursors", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-page-"));
    const service = new UsageStatsService({ accountNameMap: new Map() }, logger, directory);
    for (let index = 1; index <= 25; index++) {
        service.startRequest(`request-${index}`, { model: index % 2 ? "flash" : "pro" });
        service.finishRequest(`request-${index}`, { outcome: index % 3 ? "success" : "error", statusCode: 200 });
    }
    const summary = service.getSummarySnapshot();
    assert.equal(Object.hasOwn(summary, "records"), false);
    assert.equal(summary.summary.totalRequests, 25);
    assert.equal(summary.summary.successCount + summary.summary.errorCount, 25);
    assert.equal(
        summary.models.reduce((total, model) => total + model.totalRequests, 0),
        25
    );

    const first = service.queryRecords({ limit: 10 });
    const second = service.queryRecords({ cursor: first.next_cursor, limit: 10 });
    assert.equal(first.records.length, 10);
    assert.equal(second.records.length, 10);
    assert.equal(new Set([...first.records, ...second.records].map(record => record.requestId)).size, 20);
    assert.ok(first.records[0].sequence > first.records.at(-1).sequence);

    const deltaOne = service.queryRecords({ after_sequence: 0, dataset_revision: first.dataset_revision, limit: 10 });
    const deltaTwo = service.queryRecords({
        after_sequence: deltaOne.latest_sequence,
        dataset_revision: first.dataset_revision,
        limit: 10,
    });
    assert.equal(deltaOne.has_more, true);
    assert.equal(new Set([...deltaOne.records, ...deltaTwo.records].map(record => record.sequence)).size, 20);

    await service.importJsonl(service.records.map(record => JSON.stringify(record)).join("\n"));
    const stale = service.queryRecords({ cursor: first.next_cursor, limit: 10 });
    assert.equal(stale.reset, true);
    fs.rmSync(directory, { recursive: true });
});

test("log polling returns a recent window followed by cursor deltas", () => {
    const service = new LoggingService("test");
    service.info("one");
    const initial = service.getLogsAfter();
    assert.equal(initial.reset, true);
    assert.equal(initial.lines.length, 1);
    service.warn("two");
    const delta = service.getLogsAfter(initial.cursor);
    assert.equal(delta.reset, false);
    assert.equal(delta.lines.length, 1);
    assert.match(delta.lines[0], /two/);
    assert.throws(() => service.getLogsAfter("invalid"), /Invalid log cursor/);
});

test("dashboard and scheduler detail routes keep heavy fields out of realtime responses", async () => {
    const routes = new Map();
    const app = {};
    for (const method of ["delete", "get", "post", "put", "use"]) {
        app[method] = (route, ...handlers) => {
            if (method === "get") routes.set(route, handlers);
        };
    }
    const logService = new LoggingService("route-test");
    const scheduler = {
        account: index => ({ healthy: true, index, inflight: 0, key: `auth-${index}` }),
        accountsOverviewSnapshot: () => ({
            accounts: [
                {
                    continuous_403_duration_ms: 172800000,
                    continuous_403_since: 1,
                    healthy: true,
                    index: 0,
                    inflight: 0,
                    key: "auth-0",
                    persistent_403: true,
                },
            ],
            revision: "accounts:1",
            summary: {
                disabled: 0,
                healthy: 1,
                persistent_403: 1,
                rate_limited: 0,
                risk_controlled: 0,
                total: 1,
                unhealthy: 0,
            },
        }),
        accountsSnapshot: ids => ({
            accounts: ids.map(index => ({
                continuous_403_duration_ms: 172800000,
                continuous_403_since: 1,
                index,
                models: [],
                persistent_403: true,
            })),
            revision: "accounts:1",
        }),
        config: { maxRetries: 2, maxWorkers: 12 },
        contextsSnapshot: () => ({ contexts: [], revision: "contexts:1" }),
        sequence: 1,
        summarySnapshot: () => ({
            accounts_summary: {
                disabled: 0,
                healthy: 1,
                persistent_403: 1,
                rate_limited: 0,
                risk_controlled: 0,
                total: 1,
                unhealthy: 0,
            },
            active_workers: 0,
            contexts_summary: { busy: 0, initializing: 0, max: 1, ready: 0, reconnecting: 0, unavailable: 0 },
            idle_workers: 1,
            models: [],
            queued_requests: 0,
            quota_by_model: [],
            usage_window: { date: "2026-09-11", timezone: "America/Los_Angeles" },
        }),
        workers: [],
    };
    const authSource = {
        accountNameMap: new Map([[0, "one@example.com"]]),
        availableIndices: [0],
        duplicateIndices: [],
        expiredIndices: [],
        getCanonicalIndex: index => index,
        getRotationIndices: () => [0],
        initialIndices: [0],
    };
    const serverSystem = {
        authSource,
        browserManager: { contexts: new Map() },
        config: {
            apiKeySource: "test",
            checkUpdate: false,
            enableAuthUpdate: false,
            failureThreshold: 0,
            forceCodeExecution: false,
            forceThinking: false,
            forceUrlContext: false,
            forceWebSearch: false,
            immediateSwitchStatusCodes: [],
            maxContexts: 3,
            maxRetries: 5,
            safetySettingsThreshold: "OFF",
            streamingMode: "real",
            switchOnUses: 0,
        },
        connectionRegistry: { connectionsByAuth: new Map(), getConnectionByAuth: () => null },
        distIndexPath: "",
        logger: logService,
        requestHandler: { currentAuthIndex: 0, failureCount: 0, isSystemBusy: false, usageCount: 0 },
        scheduler,
    };
    new StatusRoutes(serverSystem).setupRoutes(app, (req, res, next) => next());

    const invoke = (route, query = {}, headers = {}) => {
        const response = {
            body: null,
            end() {
                return this;
            },
            headers: {},
            json(body) {
                this.body = body;
                return this;
            },
            setHeader(name, value) {
                this.headers[name] = value;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            statusCode: 200,
        };
        const handlers = routes.get(route);
        let index = 0;
        const next = () => handlers[++index]({ headers, query }, response, next);
        handlers[0]({ headers, query }, response, next);
        return response;
    };

    // Display limits come from the live scheduler, while legacy fields retain their meaning.
    const core = invoke("/api/status/core");
    assert.equal(core.body.status.schedulingMode, "model-aware");
    assert.equal(core.body.status.schedulerMaxBrowserWorkers, 12);
    assert.equal(core.body.status.schedulerMaxRetriesPerRequest, 2);
    assert.equal(core.body.status.maxContexts, 3);
    assert.equal(core.body.status.maxRetries, 5);
    assert.equal(core.body.status.currentAuthIndex, 0);

    scheduler.paused = true;
    scheduler.config.maxRetries = 0;
    serverSystem.requestHandler.currentAuthIndex = -1;
    const paused = invoke("/api/status/core");
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.body.status.schedulingMode, "model-aware");
    assert.equal(paused.body.status.schedulerMaxRetriesPerRequest, 0);
    scheduler.paused = false;

    serverSystem.scheduler = null;
    const legacy = invoke("/api/status/core");
    assert.equal(legacy.statusCode, 200);
    assert.equal(legacy.body.status.schedulingMode, "legacy");
    assert.equal(legacy.body.status.schedulerMaxBrowserWorkers, null);
    assert.equal(legacy.body.status.schedulerMaxRetriesPerRequest, null);
    assert.equal(legacy.body.status.maxContexts, 3);
    assert.equal(legacy.body.status.maxRetries, 5);
    assert.equal(legacy.body.status.currentAuthIndex, -1);
    assert.deepEqual(invoke("/api/dashboard/realtime").body.scheduler, { enabled: false });
    serverSystem.scheduler = scheduler;

    const dashboard = invoke("/api/dashboard/realtime");
    assert.equal(dashboard.statusCode, 200);
    assert.equal(typeof dashboard.body.generated_at, "string");
    for (const field of ["accounts", "contexts", "logs", "records", "workers"])
        assert.equal(Object.hasOwn(dashboard.body.scheduler, field), false);
    assert.equal(dashboard.body.scheduler.accounts_summary.total, 1);
    assert.equal(dashboard.body.scheduler.accounts_summary.persistent_403, 1);
    const cached = invoke("/api/dashboard/realtime", {}, { "if-none-match": dashboard.headers.ETag });
    assert.equal(cached.statusCode, 304);
    const detail = invoke("/api/scheduler/accounts", { ids: "0" }).body.accounts[0];
    assert.deepEqual(detail.models, []);
    assert.equal(detail.persistent_403, true);
    const overview = invoke("/api/scheduler/accounts").body;
    assert.equal(overview.summary.total, 1);
    assert.equal(overview.accounts[0].continuous_403_since, 1);
    assert.equal(invoke("/api/scheduler/accounts", { ids: "bad" }).statusCode, 400);
});

test("account recovery invalidates the scheduler accounts ETag", async () => {
    const routes = new Map();
    const app = {};
    for (const method of ["delete", "get", "post", "put", "use"])
        app[method] = (route, ...handlers) => routes.set(`${method}:${route}`, handlers);

    let disabled = true;
    const scheduler = {
        accountsOverviewSnapshot: () => ({
            accounts: [{ disabled, healthy: !disabled, index: 0, inflight: 0, key: "auth-0" }],
            revision: `accounts:${scheduler.sequence}`,
            summary: {
                disabled: disabled ? 1 : 0,
                healthy: disabled ? 0 : 1,
                persistent_403: 0,
                rate_limited: 0,
                risk_controlled: 0,
                total: 1,
                unhealthy: 0,
            },
        }),
        reset(index, model) {
            assert.equal(index, 0);
            assert.equal(model, undefined);
            disabled = false;
            this.sequence++;
            return { account_id: index, changed: true, scope: "account" };
        },
        sequence: 1,
        workers: [],
    };
    const serverSystem = {
        authSource: { availableIndices: [0] },
        config: {},
        distIndexPath: "",
        logger,
        requestHandler: {},
        scheduler,
    };
    new StatusRoutes(serverSystem).setupRoutes(app, (req, res, next) => next());

    const invoke = async (method, route, { body, headers = {}, query = {} } = {}) => {
        const response = {
            end() {
                return this;
            },
            headers: {},
            json(value) {
                this.body = value;
                return this;
            },
            setHeader(name, value) {
                this.headers[name] = value;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            statusCode: 200,
        };
        const handlers = routes.get(`${method}:${route}`);
        const request = { body, headers, query };
        let index = 0;
        const next = () => handlers[++index](request, response, next);
        await handlers[0](request, response, next);
        return response;
    };

    const initial = await invoke("get", "/api/scheduler/accounts");
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.body.accounts[0].disabled, true);
    const unchanged = await invoke("get", "/api/scheduler/accounts", {
        headers: { "if-none-match": initial.headers.ETag },
    });
    assert.equal(unchanged.statusCode, 304);

    const recovered = await invoke("post", "/api/scheduler/reset", { body: { account_id: 0 } });
    assert.deepEqual(recovered.body, { account_id: 0, changed: true, scope: "account", success: true });
    const refreshed = await invoke("get", "/api/scheduler/accounts", {
        headers: { "if-none-match": initial.headers.ETag },
    });
    assert.equal(refreshed.statusCode, 200);
    assert.equal(refreshed.body.accounts[0].disabled, false);
    assert.notEqual(refreshed.headers.ETag, initial.headers.ETag);
});

test("scheduler model visibility routes authenticate and return stable results", async () => {
    const routes = new Map();
    const app = {};
    for (const method of ["delete", "get", "post", "put", "use"])
        app[method] = (route, ...handlers) => routes.set(`${method}:${route}`, handlers);
    const hidden = new Set(["z-model", "a-model"]);
    const scheduler = {
        hiddenModelsSnapshot: () => [...hidden].sort(),
        hideModel(model) {
            if (model === "missing") throw Object.assign(new Error("Unknown scheduler model missing"), { status: 404 });
            const changed = !hidden.has(model);
            hidden.add(model);
            return { changed, hidden: true, model };
        },
        showModel(model) {
            const changed = hidden.delete(model);
            return { changed, hidden: false, model };
        },
        workers: [],
    };
    const serverSystem = { config: {}, distIndexPath: "", logger, requestHandler: {}, scheduler };
    const isAuthenticated = (req, res, next) =>
        req.authenticated ? next() : res.status(401).json({ error: "Unauthorized" });
    new StatusRoutes(serverSystem).setupRoutes(app, isAuthenticated);

    const invoke = async (method, route, { authenticated = true, body } = {}) => {
        const response = {
            json(value) {
                this.body = value;
                return this;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            statusCode: 200,
        };
        const handlers = routes.get(`${method}:${route}`);
        let index = 0;
        const request = { authenticated, body };
        const next = () => handlers[++index](request, response, next);
        await handlers[0](request, response, next);
        return response;
    };

    assert.equal((await invoke("post", "/api/scheduler/models/hide", { authenticated: false })).statusCode, 401);
    assert.deepEqual((await invoke("get", "/api/scheduler/models/hidden")).body.models, ["a-model", "z-model"]);
    assert.deepEqual((await invoke("post", "/api/scheduler/models/hide", { body: { model: "new-model" } })).body, {
        changed: true,
        hidden: true,
        model: "new-model",
        success: true,
    });
    assert.equal((await invoke("post", "/api/scheduler/models/hide", { body: { model: "missing" } })).statusCode, 404);
    assert.deepEqual((await invoke("post", "/api/scheduler/models/show", { body: { model: "new-model" } })).body, {
        changed: true,
        hidden: false,
        model: "new-model",
        success: true,
    });
});

const { chromium } = require("playwright");
const { createServer } = require("vite");

test(
    "context panel counts draining capacity and explains states in matrix and table",
    {
        skip: !fs.existsSync(chromium.executablePath()),
    },
    async t => {
        const server = await createServer({
            configFile: path.resolve(__dirname, "../vite.config.js"),
            logLevel: "error",
            server: { host: "127.0.0.1", port: 0, strictPort: false },
        });
        t.after(() => server.close());
        await server.listen();
        const component = await server.transformRequest("/components/SchedulerStatus.vue");
        const vueImport = component.code.match(/from ["']([^"']*vue[^"']*)["']/)[1];
        const browser = await chromium.launch({ args: ["--no-sandbox"] });
        t.after(() => browser.close());
        const page = await browser.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const contexts = Array.from({ length: 9 }, (_, index) => ({
            auth_index: index,
            inflight: 3,
            state: "BUSY",
        }));
        contexts.push({
            auth_index: 95,
            drain_reason: "context_capacity",
            draining: true,
            inflight: 1,
            state: "DRAINING",
        });
        const data = {
            contexts_summary: { busy: 9, draining: 1, max: 10, occupied: 10, ready: 0 },
            models: [],
            token_quota_by_model: [
                {
                    estimated_remaining: 750,
                    limit: 1000,
                    model: "gemini-3.8-flash",
                    observed_tokens: { total_tokens: 250 },
                    scope: "pg/model",
                    unknown_limit_accounts: 0,
                    unknown_usage_requests: 0,
                    window: { date: "2026-11-02" },
                },
                {
                    estimated_remaining: null,
                    known_limit: 0,
                    limit: null,
                    model: "build/gemini-3.8-flash",
                    observed_tokens: { total_tokens: 50 },
                    scope: "build/account",
                    unknown_limit_accounts: 1,
                    unknown_usage_requests: 1,
                    window: { date: "2026-11-02" },
                },
            ],
        };
        const messages = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../ui/locales/zh.json"), "utf8"));
        await page.route("**/api/**", route =>
            route.fulfill({
                body: JSON.stringify({ contexts, models: [] }),
                contentType: "application/json",
            })
        );
        await page.route("**/__context_display_test", route =>
            route.fulfill({
                body: `<meta charset="utf-8"><div id="app"></div><script type="module">
            import { createApp, h, reactive } from '${vueImport}';
            import Panel from '/components/SchedulerStatus.vue';
            const data = reactive(${JSON.stringify(data)});
            const messages = ${JSON.stringify(messages)};
            window.panelData = data;
            createApp({ render: () => h(Panel, { data, t: key => messages[key] || key }) }).mount('#app');
        </script>`,
                contentType: "text/html",
            })
        );
        await page.goto(`${server.resolvedUrls.local[0]}__context_display_test`);
        await page.waitForSelector(".capacity-pill");
        const budget = page.getByRole("region", { exact: true, name: "每日 Token 预算" });
        assert.equal(await budget.locator("progress").count(), 1);
        assert.equal(await budget.locator("progress").evaluate(el => el.position), 0.25);
        assert.match(await budget.innerText(), /750/);
        assert.match(await budget.locator(".token-budget-unknown").innerText(), /额度未知/);
        assert.equal((await budget.innerText()).includes("用户提供的估算口径"), false);
        assert.match(await page.locator(".context-pool-card .capacity-pill").innerText(), /10\s*\/\s*10/);
        assert.match(await page.locator(".pill-draining").innerText(), /排空中\s*1/);
        await page.locator(".context-pool-card .collapsible-header").click();
        await page.waitForSelector(".node-draining");
        assert.match(await page.locator(".node-draining").innerText(), /#95[\s\S]*排空中[\s\S]*等待腾位[\s\S]*在途: 1/);
        assert.match(await page.locator(".node-busy").first().innerText(), /正在处理请求/);
        await page.getByRole("button", { exact: true, name: messages.schedulerViewTable }).click();
        assert.match(
            await page.locator(".context-pool-card tbody tr").last().innerText(),
            /#95[\s\S]*排空中[\s\S]*等待腾位/
        );
        await page.evaluate(() => {
            Object.assign(window.panelData.contexts_summary, { busy: 8, closing: 1, draining: 0, ready: 1 });
        });
        assert.match(await page.locator(".context-pool-card .capacity-pill").innerText(), /10\s*\/\s*10/);
        assert.match(await page.locator(".pill-closing").innerText(), /关闭中\s*1/);
        assert.deepEqual(errors, []);
    }
);
