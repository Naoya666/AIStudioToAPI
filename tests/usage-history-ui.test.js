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
            server: { host: "127.0.0.1", port: 0, strictPort: false },
        });
        await server.listen();
        let browser;
        t.after(async () => {
            await browser?.close();
            await server.close();
        });
        browser = await chromium.launch({ args: ["--no-sandbox"] });
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
            modelVersion: sequence === 1000 ? "gemini-3.8-flash" : null,
            outcome: "error",
            requestId: `req_synthetic_full_identifier_${sequence}`,
            sequence,
            startedAt: new Date(now - 1000 - sequence).toISOString(),
            statusCode: 200,
            upstreamMetadata:
                sequence === 1000
                    ? [{ modelVersion: "gemini-3.8-flash", requestAttemptId: "fixture_attempt_1", transport: "legacy" }]
                    : [],
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
        await records.getByRole("button", { exact: true, name: "gemini-3.8-flash" }).click();
        await page.getByText("fixture_attempt_1 · legacy", { exact: true }).waitFor();
        await records.locator(".card-title-usage").click();
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
