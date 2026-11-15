/* eslint-env browser */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { createServer } = require("vite");
const express = require("express");
const { ConfigurationService } = require("../src/config/ConfigurationService");
const ConfigurationRoutes = require("../src/config/ConfigurationRoutes");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
test(
    "model page adds and configures models, saves once, reloads and retains conflicted drafts",
    {
        skip: !fs.existsSync(executablePath),
        timeout: 60000,
    },
    async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-page-"));
        t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
        const logger = { debug() {}, error() {}, info() {}, setDisplayLimit() {}, warn() {} };
        const system = { logger, ready: true };
        const service = new ConfigurationService(system, { env: {}, file: path.join(directory, "managed.json") });
        system.configurationService = service;
        const app = express();
        app.use(express.json({ limit: "1mb" }));
        new ConfigurationRoutes(system).setupRoutes(app, (req, res, next) => next());
        const backend = app.listen(0, "127.0.0.1");
        await new Promise(resolve => backend.once("listening", resolve));
        t.after(() => new Promise(resolve => backend.close(resolve)));
        const vite = await createServer({
            configFile: path.resolve(__dirname, "../vite.config.js"),
            logLevel: "error",
            server: { host: "127.0.0.1", port: 0 },
        });
        await vite.listen();
        t.after(() => vite.close());
        const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath });
        t.after(() => browser.close());
        const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript(() => localStorage.setItem("lang", "zh"));
        await page.route("**/api/**", async route => {
            const request = route.request(),
                url = new URL(request.url());
            if (url.pathname.startsWith("/api/model-catalog")) {
                const response = await fetch(`http://127.0.0.1:${backend.address().port}${url.pathname}`, {
                    headers: { "content-type": "application/json" },
                    method: request.method(),
                    ...(request.method() !== "GET" ? { body: request.postData() } : {}),
                });
                return route.fulfill({ json: await response.json(), status: response.status });
            }
            let result = {};
            if (url.pathname.startsWith("/api/status"))
                result = { status: { accountDetails: [], currentAuthIndex: -1, schedulingMode: "model-aware" } };
            else if (url.pathname === "/api/scheduler") result = { enabled: false };
            else if (url.pathname.endsWith("/accounts")) result = { accounts: [], total: 0 };
            else if (url.pathname.endsWith("/login-queue")) result = { autoRecovery: true, concurrency: 1 };
            return route.fulfill({ json: result });
        });
        await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/models`);
        const panel = page.locator(".models-page");
        await panel.getByRole("button", { exact: true, name: "添加模型" }).click();
        await page.locator(".el-message-box input").fill("new-model");
        await page
            .locator(".el-message-box")
            .getByRole("button", { name: /确定|OK/ })
            .click();
        const drawer = page.locator(".el-drawer");
        await drawer.getByRole("tab", { name: "功能边界" }).click();
        assert.equal(await drawer.getByRole("checkbox", { exact: true, name: "函数工具调用" }).isChecked(), true);
        await drawer.getByRole("checkbox", { exact: true, name: "函数工具调用" }).uncheck();
        await drawer.getByRole("tab", { name: "权限与额度" }).click();
        const free = drawer.locator(".quota-row").first();
        await free.getByRole("checkbox", { name: "允许调用" }).check();
        await free.getByLabel("每日次数", { exact: true }).fill("12");
        await free.getByLabel("每日 Token", { exact: true }).fill("0");
        await drawer.getByRole("button", { name: /close|关闭/i }).click();
        assert.equal(service.running.scheduler.registeredModels.includes("new-model"), false);
        await panel.getByRole("button", { name: "保存全部修改" }).click();
        await panel.getByText("模型目录与策略已保存，对新请求生效。").waitFor();
        assert.ok(service.running.scheduler.registeredModels.includes("new-model"));
        const row = service.running.modelList.find(row => row.name === "models/new-model");
        assert.equal(row.features.tools, false);
        assert.equal(row.quotas.free.requests, 12);
        assert.equal(row.quotas.free.tokens, 0);
        assert.ok(service.running.scheduler.modelAllowlist.tiers.free.includes("new-model"));
        await page.reload();
        await panel.getByRole("textbox", { name: "搜索模型" }).fill("new-model");
        assert.equal(await panel.locator("tbody tr").count(), 1);
        await panel.getByRole("checkbox", { exact: true, name: "new-model 抗截断准入" }).uncheck();
        service.save({ changes: { ANTI_TRUNCATION_DEFAULT: "prefer" }, version: service.document.version });
        await panel.getByRole("button", { name: "保存全部修改" }).click();
        await panel.getByRole("alert").filter({ hasText: "配置已被其他页面修改" }).waitFor();
        assert.equal(
            await panel.getByRole("checkbox", { exact: true, name: "new-model 抗截断准入" }).isChecked(),
            false
        );
        assert.equal(
            service.running.modelList.find(row => row.name === "models/new-model").features.antiTruncation,
            undefined
        );
        const { compareModels } = require("../src/core/ModelDiscovery");
        const discovered = Array.from({ length: 20 }, (_, i) => ({
            displayName: `Discovered ${i}`,
            name: `models/discovered-${i}`,
        }));
        system.browserManager = {
            contexts: new Map([[0, {}]]),
            getBenefit: () => ({
                _evaluate: async () => ({
                    status: 200,
                    text: JSON.stringify([discovered.map(row => [row.name, null, null, row.displayName])]),
                }),
            }),
        };
        assert.equal(compareModels(discovered, service.running.modelList).rows.length, 20);
        await panel.getByRole("button", { name: "主动探测上游模型" }).click();
        const discoveryDrawer = page.getByRole("dialog", { name: "上游模型探测与本地对照" });
        await discoveryDrawer.getByText("新增 20 个", { exact: false }).waitFor();
        assert.equal(await discoveryDrawer.locator("tbody tr").count(), 15);
        await discoveryDrawer.getByLabel("选择 discovered-0", { exact: true }).check();
        await discoveryDrawer.getByRole("button", { name: /next page|下一页/i }).click();
        assert.equal(await discoveryDrawer.locator("tbody tr").count(), 5);
        await discoveryDrawer.getByLabel("选择 discovered-19", { exact: true }).check();
        await discoveryDrawer.getByRole("button", { name: "将选中模型加入草稿" }).click();
        assert.equal(
            service.running.modelList.some(row => row.name === "models/discovered-0"),
            false
        );
        await panel.getByRole("textbox", { name: "搜索模型" }).fill("discovered-");
        assert.equal(await panel.locator(".table-scroll").first().locator("tbody tr").count(), 2);
        assert.equal(await panel.getByLabel("discovered-0 Free 权限", { exact: true }).isChecked(), false);
        await panel.getByRole("button", { name: "查看探测结果" }).click();
        await discoveryDrawer.getByText("新增 18 个", { exact: false }).waitFor();
        await discoveryDrawer.getByRole("button", { name: /close|关闭/i }).click();
        await page.screenshot({ fullPage: true, path: "/tmp/model-management-page.png" });
        assert.deepEqual(errors, []);
    }
);
