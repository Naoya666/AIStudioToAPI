/* eslint-env browser */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { createServer } = require("vite");

test(
    "history loads every cursor page, pauses live records and resumes; detail actions remain accessible",
    {
        skip: !fs.existsSync(chromium.executablePath()),
        timeout: 60000,
    },
    async t => {
        const server = await createServer({
            configFile: path.resolve(__dirname, "../vite.config.js"),
            logLevel: "error",
            server: { host: "127.0.0.1", port: 0 },
        });
        await server.listen();
        t.after(() => server.close());
        const browser = await chromium.launch({ args: ["--no-sandbox"] });
        t.after(() => browser.close());
        const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
        page.setDefaultTimeout(6000);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript(() => localStorage.setItem("lang", "en"));
        await page.route("**/locales/*.json", route => route.fulfill({ json: require("../ui/locales/en.json") }));
        const now = Date.now();
        const makeRecord = sequence => ({
            accountKey: "0:fixture@example.com",
            apiFormat: "openai",
            attemptCount: 1,
            attempts: [],
            durationMs: 500,
            errorMessage: "synthetic error detail <safe>",
            finalAccountName: "fixture@example.com",
            finalAuthIndex: 0,
            finishedAt: new Date(now).toISOString(),
            model: "fixture-model",
            outcome: "error",
            requestId: `req_synthetic_full_identifier_${sequence}`,
            sequence,
            startedAt: new Date(now - 1000 - sequence).toISOString(),
            statusCode: 200,
        });
        const history = Array.from({ length: 125 }, (_, i) => makeRecord(125 - i));
        let liveQueries = 0;
        let historyQueries = 0;
        let failHistory = false;
        const historyRanges = [];
        await page.route("**/api/**", route => {
            const url = new URL(route.request().url());
            let data = {};
            if (url.pathname.startsWith("/api/status"))
                data = { status: { accountDetails: [], currentAuthIndex: -1, schedulingMode: "legacy" } };
            if (url.pathname === "/api/usage-stats/summary")
                data = { accounts: [], models: [], summary: { totalRequests: 125 } };
            if (url.pathname === "/api/usage-stats/storage") data = { enabled: true, retention_mode: "forever" };
            if (url.pathname === "/api/usage-stats/records") {
                if (url.searchParams.has("from")) {
                    historyQueries++;
                    historyRanges.push([url.searchParams.get("from"), url.searchParams.get("to")]);
                    if (failHistory) return route.fulfill({ json: { error: "synthetic failure" }, status: 500 });
                    const secondPage = url.searchParams.has("cursor");
                    data = {
                        dataset_revision: 1,
                        has_more: !secondPage,
                        latest_sequence: 125,
                        next_cursor: secondPage ? null : "history-page-2",
                        records: secondPage ? history.slice(100) : history.slice(0, 100),
                    };
                } else {
                    liveQueries++;
                    data = { dataset_revision: 1, has_more: false, latest_sequence: 1000, records: [makeRecord(1000)] };
                }
            }
            return route.fulfill({ json: data });
        });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/usage`);
        const records = page.locator(".records-card");
        await records.locator("tbody tr").waitFor();
        const id = records.getByRole("button", { name: "Full request ID" });
        assert.ok((await id.innerText()).length < "req_synthetic_full_identifier_1000".length);
        await id.click();
        await page.locator(".request-id-detail").filter({ visible: true }).waitFor();
        assert.equal(
            await page.locator(".request-id-detail").filter({ visible: true }).innerText(),
            "req_synthetic_full_identifier_1000"
        );
        await records.getByRole("button", { exact: true, name: "200" }).click();
        await page.getByText("synthetic error detail <safe>", { exact: true }).waitFor();
        await page.locator(".el-message-box").getByRole("button", { exact: true, name: "OK" }).click();
        const chooseCustom = async () => {
            await page.locator(".stats-time-range-select:visible").click();
            await page.getByRole("option", { exact: true, name: "Custom Range" }).click();
        };
        await chooseCustom();
        await records.getByText("History · Live updates paused", { exact: true }).waitFor();
        await records.getByText(/of 125/).waitFor();
        assert.equal(historyQueries, 2);
        assert.deepEqual(historyRanges[0], historyRanges[1]);
        const before = liveQueries;
        // Let at least one real workspace polling round run while history is frozen.
        await page.waitForTimeout(5500);
        assert.equal(liveQueries, before);
        assert.equal(historyQueries, 2);
        await records.getByRole("button", { exact: true, name: "Last" }).click();
        assert.equal(await records.locator("tbody tr").count(), 5);
        await records.getByRole("button", { exact: true, name: "Return to live" }).click();
        await records.getByRole("button", { name: "Full request ID" }).waitFor();
        assert.ok(liveQueries > before);
        failHistory = true;
        await chooseCustom();
        await records.getByText("Failed to load historical records. Please retry.", { exact: true }).waitFor();
        failHistory = false;
        await records.getByRole("button", { exact: true, name: "Retry" }).click();
        await records.getByText(/of 125/).waitFor();
        assert.deepEqual(errors, []);
    }
);

test(
    "token table queries filtered pages and stays usable on mobile",
    {
        skip: !fs.existsSync(chromium.executablePath()),
        timeout: 60000,
    },
    async t => {
        const server = await createServer({
            configFile: path.resolve(__dirname, "../vite.config.js"),
            logLevel: "error",
            server: { host: "127.0.0.1", port: 0 },
        });
        await server.listen();
        t.after(() => server.close());
        const browser = await chromium.launch({ args: ["--no-sandbox"] });
        t.after(() => browser.close());
        const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
        page.setDefaultTimeout(6000);
        const errors = [],
            queries = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/locales/*.json", route => route.fulfill({ json: require("../ui/locales/zh.json") }));
        let fail = false;
        await page.route("**/api/**", route => {
            const url = new URL(route.request().url());
            let data = {};
            if (url.pathname.startsWith("/api/status"))
                data = { status: { accountDetails: [], currentAuthIndex: -1, schedulingMode: "legacy" } };
            if (url.pathname === "/api/usage-stats/summary") data = { accounts: [], models: [], summary: {} };
            if (url.pathname === "/api/usage-stats/records") data = { records: [] };
            if (url.pathname === "/api/usage-stats/tokens") {
                queries.push(Object.fromEntries(url.searchParams));
                if (fail) return route.fulfill({ json: { error: "synthetic token failure" }, status: 500 });
                const number = Number(url.searchParams.get("page") || 1);
                const filtered = url.searchParams.get("email");
                const total = filtered === "empty" ? 0 : filtered ? 1 : 42;
                data = {
                    available_models: ["gemini-3.8-flash", "gemini-3.1-pro-preview"],
                    models: total
                        ? Array.from({ length: Math.min(20, total - (number - 1) * 20) }, (_, i) => ({
                              account_key: `fixture-${(number - 1) * 20 + i}@example.com`,
                              day: "2026-11-02",
                              input: 100,
                              input_observations: 1,
                              known_requests: 1,
                              model: "gemini-3.8-flash",
                              tier: "free",
                              total: 120,
                              unknown_requests: 1,
                          }))
                        : [],
                    page: number,
                    total,
                };
            }
            return route.fulfill({ json: data });
        });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/usage`);
        const panel = page.locator(".token-usage-panel");
        await panel.getByText("fixture-0@example.com", { exact: true }).waitFor();
        assert.equal(await panel.locator("tbody tr").count(), 20);
        assert.ok((await panel.innerText()).includes("未知"));
        await panel.locator(".btn-next").click();
        await panel.getByText("fixture-20@example.com", { exact: true }).waitFor();
        assert.equal(queries.at(-1).page, "2");
        await panel.getByRole("textbox", { name: "筛选邮箱" }).fill("fixture");
        await panel.getByText("共 1 条记录").waitFor();
        assert.equal(queries.at(-1).page, "1");
        assert.equal(queries.at(-1).email, "fixture");
        await panel.getByRole("combobox", { name: "筛选模型" }).click();
        await page.getByRole("option", { exact: true, name: "gemini-3.1-pro-preview" }).click();
        await page.waitForResponse(
            response =>
                response.url().includes("/api/usage-stats/tokens?") && response.url().includes("gemini-3.1-pro-preview")
        );
        assert.equal(queries.at(-1).model, "gemini-3.1-pro-preview");
        await panel.getByRole("textbox", { name: "筛选邮箱" }).fill("empty");
        await panel.getByText("暂无符合条件的 Token 统计").waitFor();
        fail = true;
        await panel.getByRole("button", { name: "读取统计" }).click();
        await panel.getByRole("alert").getByText("synthetic token failure").waitFor();
        fail = false;
        await panel.getByRole("textbox", { name: "筛选邮箱" }).fill("fixture");
        await panel.getByText("共 1 条记录").waitFor();
        await page.setViewportSize({ height: 844, width: 390 });
        assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
        assert.deepEqual(errors, []);
    }
);
