/* eslint-env browser */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { chromium } = require("playwright");
const { createServer } = require("vite");

test(
    "public table switches windows locally, keeps selection and handles degraded snapshots",
    {
        skip: !fs.existsSync(chromium.executablePath()),
    },
    async t => {
        const server = await createServer({
            configFile: path.resolve(__dirname, "../vite.public.config.js"),
            logLevel: "error",
            server: { host: "127.0.0.1", port: 0 },
        });
        t.after(() => server.close());
        await server.listen();
        const browser = await chromium.launch({ args: ["--no-sandbox"] });
        t.after(() => browser.close());
        const page = await browser.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const metrics = total => ({
            average_duration_ms: total * 1000,
            failed_requests: 0,
            success_rate: 100,
            total_requests: total,
        });
        const snapshot = {
            generated_at: "2026-10-05T08:00:00.000Z",
            history: { enabled: true, ...metrics(100) },
            model_stat_windows: {
                "1h": { status: "available", to: "2026-10-05T08:00:00.000Z" },
                "24h": { status: "available", to: "2026-10-05T08:00:00.000Z" },
            },
            models: [
                {
                    history: metrics(100),
                    model: "flash",
                    quota: { estimable: true, estimated_remaining: 100 },
                    realtime: { active: 0, available_accounts: 1, queued: 0, rate_limited_accounts: 0 },
                    recent_stats: { "1h": metrics(3), "24h": metrics(20) },
                    today: { requests: 4 },
                },
            ],
            realtime: { active: 0, limit: 1, queued: 0 },
            usage_window: { date: "2026-10-05", timezone: "America/Los_Angeles" },
        };
        let calls = 0;
        let fail = false;
        await page.route("**/api/public/dashboard", route => {
            calls++;
            return route.fulfill({
                body: JSON.stringify(fail ? { error: "unavailable" } : snapshot),
                contentType: "application/json",
                status: fail ? 503 : 200,
            });
        });
        await page.goto(server.resolvedUrls.local[0]);
        await page.getByLabel("Mock 数据").uncheck();
        const requestCell = page.locator("tbody tr td").first();
        const waitText = expected =>
            page.waitForFunction(
                value => document.querySelector("tbody tr td")?.textContent.trim() === value,
                expected
            );
        await waitText("20");
        assert.equal(
            await page.getByRole("button", { exact: true, name: "近 24 小时" }).getAttribute("aria-pressed"),
            "true"
        );
        const beforeSwitch = calls;
        const hour = page.getByRole("button", { exact: true, name: "近 1 小时" });
        await hour.focus();
        await page.keyboard.press("Enter");
        await waitText("3");
        await page.getByRole("button", { exact: true, name: "历史" }).click();
        await waitText("100");
        assert.equal(calls, beforeSwitch);
        await hour.click();
        snapshot.models[0].recent_stats["1h"] = metrics(7);
        await page.getByRole("button", { name: "立即刷新数据" }).click();
        await waitText("7");
        assert.equal(await hour.getAttribute("aria-pressed"), "true");
        snapshot.models[0].recent_stats["1h"] = {
            average_duration_ms: null,
            failed_requests: 0,
            success_rate: null,
            total_requests: 0,
        };
        await page.getByRole("button", { name: "立即刷新数据" }).click();
        await waitText("0");
        assert.equal(await page.locator("tbody tr td").nth(1).textContent(), "—");
        snapshot.service_status = "unavailable";
        snapshot.quota_status = "exhausted";
        snapshot.models[0].realtime.available_accounts = 0;
        snapshot.models[0].realtime.rate_limited_accounts = 1;
        snapshot.models[0].quota.estimated_remaining = 0;
        await page.getByRole("button", { name: "立即刷新数据" }).click();
        await page.getByText("额度已耗尽，等待恢复", { exact: true }).waitFor();
        assert.match(await page.locator(".account-ring-detail").textContent(), /0 可用/);
        assert.ok(await page.getByText("0 次", { exact: true }).isVisible());
        snapshot.quota_status = "cooldown";
        await page.getByRole("button", { name: "立即刷新数据" }).click();
        await page.getByText("暂时限流，等待恢复", { exact: true }).waitFor();
        delete snapshot.quota_status;
        await page.getByRole("button", { name: "立即刷新数据" }).click();
        await page.getByText("服务暂时不可用", { exact: true }).waitFor();
        snapshot.service_status = "ready";
        snapshot.models[0].realtime.available_accounts = 1;
        snapshot.models[0].realtime.rate_limited_accounts = 0;
        snapshot.models[0].quota.estimated_remaining = 100;
        snapshot.model_stat_windows["1h"].status = "unavailable";
        snapshot.models[0].recent_stats["1h"] = {
            average_duration_ms: null,
            failed_requests: null,
            success_rate: null,
            total_requests: null,
        };
        await page.getByRole("button", { name: "立即刷新数据" }).click();
        await page.getByText("近期统计暂时不可用", { exact: true }).waitFor();
        assert.equal((await requestCell.textContent()).trim(), "—");
        assert.match(await page.locator(".status").textContent(), /部分统计不可用/);
        snapshot.model_stat_windows["1h"].status = "disabled";
        await page.getByRole("button", { name: "立即刷新数据" }).click();
        await page.getByText("请求统计未启用", { exact: true }).waitFor();
        delete snapshot.model_stat_windows;
        delete snapshot.models[0].recent_stats;
        await page.getByRole("button", { name: "立即刷新数据" }).click();
        await page.getByText("当前服务暂不支持近期统计", { exact: true }).waitFor();
        assert.equal(await hour.isDisabled(), true);
        assert.equal((await requestCell.textContent()).trim(), "100");
        const timestamp = await page.locator(".updated").textContent();
        fail = true;
        await page.getByRole("button", { name: "立即刷新数据" }).click();
        await page.getByText("数据暂时中断，显示上次结果", { exact: true }).waitFor();
        assert.equal(await page.locator(".updated").textContent(), timestamp);
        await page.setViewportSize({ height: 800, width: 375 });
        assert.ok(await page.locator(".range-buttons").isVisible());
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        fail = false;
        snapshot.cluster = {
            expected_nodes: 3,
            fresh_nodes: 2,
            newest_source_at: snapshot.generated_at,
            oldest_source_at: snapshot.generated_at,
            serving_nodes: 1,
            status: "partial",
        };
        const coverage = { expected_nodes: 3, included_nodes: 1, status: "partial" };
        snapshot.coverage = { history: coverage, realtime: coverage };
        snapshot.history.status = "available";
        snapshot.model_stat_windows = {
            "1h": { alignment: "approximate", status: "available" },
            "24h": { alignment: "approximate", status: "available" },
        };
        snapshot.models[0].coverage = {
            history: coverage,
            quota: coverage,
            realtime: coverage,
            recent_stats: { "1h": coverage, "24h": coverage },
            today: coverage,
        };
        snapshot.models[0].quota = { estimable: false, estimated_remaining: null, known_estimated_remaining: 150 };
        snapshot.models[0].realtime.available_accounts = null;
        await page.getByRole("button", { name: "立即刷新数据" }).click();
        await page.getByText("已知部分约 150 次", { exact: true }).waitFor();
        assert.match(await page.locator(".cluster-status").textContent(), /数据有效节点 2 \/ 3/);
        assert.match(await page.locator(".account-ring-detail").textContent(), /状态未知/);
        assert.match(await page.locator(".source-times").textContent(), /源数据时间/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        assert.deepEqual(errors, []);
    }
);
