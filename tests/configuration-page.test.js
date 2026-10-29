/* eslint-env browser */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { createServer } = require("vite");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const { ConfigurationService } = require("../src/config/ConfigurationService");

test(
    "configuration form stages drafts, preserves hidden fields, saves structured rows and detects concurrent pages",
    { skip: !fs.existsSync(chromium.executablePath()), timeout: 45000 },
    async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "configuration-ui-"));
        t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
        const logger = { debug() {}, error() {}, info() {}, setDisplayLimit() {}, warn() {} };
        const system = { logger, ready: true };
        let service = new ConfigurationService(system, {
            env: {},
            file: path.join(directory, "managed-config.json"),
        });
        service.running.scheduler.statePath = path.join(directory, "scheduler-state.json");
        const scheduler = new ModelScheduler(
            service.running.scheduler,
            { accountNameMap: new Map(), getRotationIndices: () => [] },
            logger
        );
        system.scheduler = scheduler;
        t.after(() => scheduler.close());
        let visibilityFailure = "";
        const visibilityWrites = [];
        const server = await createServer({
            configFile: path.resolve(__dirname, "../vite.config.js"),
            logLevel: "error",
            server: { host: "127.0.0.1", port: 0, strictPort: false },
        });
        t.after(() => server.close());
        await server.listen();
        const browser = await chromium.launch({ args: ["--no-sandbox"] });
        t.after(() => browser.close());
        const page = await browser.newPage();
        page.setDefaultTimeout(8000);
        const errors = [],
            writes = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/locales/*.json", route =>
            route.fulfill({
                body: fs.readFileSync(path.resolve(__dirname, "../ui/locales/zh.json"), "utf8"),
                contentType: "application/json",
            })
        );
        await page.route("**/api/**", async route => {
            const request = route.request(),
                url = new URL(request.url());
            let result = {},
                status = 200;
            try {
                if (url.pathname === "/api/configuration") {
                    if (request.method() === "PATCH") {
                        writes.push(request.postDataJSON());
                        result = service.save(request.postDataJSON());
                    } else result = service.snapshot();
                } else if (["/api/scheduler/models/hide", "/api/scheduler/models/show"].includes(url.pathname)) {
                    const { model } = request.postDataJSON();
                    visibilityWrites.push({ hidden: url.pathname.endsWith("/hide"), model });
                    if (model === visibilityFailure) throw new Error("模拟保存失败");
                    result = {
                        success: true,
                        ...scheduler[url.pathname.endsWith("/hide") ? "hideModel" : "showModel"](model),
                    };
                } else if (url.pathname === "/api/configuration/restart") {
                    result = { accepted: true, instanceId: service.instanceId, version: service.document.version };
                    status = 202;
                    setTimeout(() => {
                        service = new ConfigurationService(system, {
                            env: {},
                            file: path.join(directory, "managed-config.json"),
                        });
                    }, 100);
                } else if (url.pathname === "/api/configuration/undo-pending")
                    result = service.undo(request.postDataJSON().version);
                else if (url.pathname === "/api/configuration/secrets")
                    result = { defaultApiKeys: service.baseline.apiKeys, savedApiKeys: service.saved.apiKeys };
                else if (url.pathname.startsWith("/api/status"))
                    result = { status: { accountDetails: [], currentAuthIndex: -1, schedulingMode: "model-aware" } };
                else if (url.pathname === "/api/scheduler") result = { enabled: false };
                else if (url.pathname.endsWith("/accounts")) result = { accounts: [], total: 0 };
                else if (url.pathname.endsWith("/login-queue")) result = { autoRecovery: true, concurrency: 1 };
            } catch (error) {
                status = error.status || 500;
                result = { error: error.message };
            }
            await route.fulfill({ json: result, status });
        });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
        await page.getByRole("navigation").getByRole("button", { exact: true, name: "设置" }).click();
        const panel = page.locator(".configuration-panel");
        await panel.getByRole("button", { exact: true, name: "保存" }).waitFor();
        await panel.locator("#config-FORCE_THINKING").locator("..").click();
        assert.equal(service.running.forceThinking, false);
        assert.equal(writes.length, 0);
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await page.waitForFunction(() =>
            document.querySelector(".configuration-panel")?.textContent.includes("已保存。立即生效：强制启用思考")
        );
        assert.equal(service.running.forceThinking, true);
        assert.deepEqual(Object.keys(writes.at(-1).changes), ["FORCE_THINKING"]);
        const permissions = panel.locator(".allowlist-editor");
        const collapse = panel.locator(".model-settings-collapse");
        assert.equal(await collapse.getAttribute("open"), null);
        assert.equal(await permissions.isVisible(), false);
        await collapse.locator("summary").click();
        assert.equal(await permissions.isVisible(), true);
        const freeArgon = permissions.getByRole("checkbox", { exact: true, name: "gemini-4-argon Free" });
        assert.equal(await freeArgon.isChecked(), false);
        assert.equal(
            await permissions.getByRole("checkbox", { exact: true, name: "gemini-4-argon Pro" }).isChecked(),
            true
        );
        assert.equal(
            await permissions.getByRole("checkbox", { exact: true, name: "gemini-4-argon Ultra 5x" }).isChecked(),
            true
        );
        await permissions.getByRole("textbox", { name: "搜索权限模型" }).fill("gemini-4-argon");
        assert.equal(await permissions.locator("tbody tr").count(), 1);
        await freeArgon.check();
        assert.equal(service.running.scheduler.modelAllowlist.tiers.free.includes("gemini-4-argon"), false);
        await panel.getByRole("button", { exact: true, name: "放弃草稿" }).click();
        assert.equal(await freeArgon.isChecked(), false);
        await freeArgon.check();
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await page.waitForFunction(() =>
            document.querySelector(".configuration-panel")?.textContent.includes("立即生效：账号层级模型白名单")
        );
        assert.equal(service.running.scheduler.modelAllowlist.tiers.free.includes("gemini-4-argon"), true);
        await freeArgon.uncheck();
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await page.waitForFunction(() =>
            document.querySelector('.configuration-panel [role="status"]')?.textContent.includes("0 项修改")
        );
        assert.equal(service.running.scheduler.modelAllowlist.tiers.free.includes("gemini-4-argon"), false);
        await permissions.getByRole("textbox", { name: "搜索权限模型" }).fill("");
        // Visibility is independently staged, uses the existing scheduler operations and persists there.
        const policyBeforeVisibility = structuredClone(service.running.scheduler.modelAllowlist);
        await permissions.getByRole("textbox", { name: "搜索权限模型" }).fill("gemini-3.");
        const matchedModels = service.running.scheduler.registeredModels.filter(model => model.includes("gemini-3."));
        assert.ok(matchedModels.length > 1);
        await permissions.getByRole("button", { exact: true, name: "全部禁用" }).click();
        assert.deepEqual(scheduler.hiddenModelsSnapshot(), []);
        assert.equal(
            await permissions.getByRole("checkbox", { exact: true, name: "gemini-3.6-flash 是否启用" }).isChecked(),
            false
        );
        await permissions.getByRole("button", { name: "放弃启用状态修改" }).click();
        assert.equal(
            await permissions.getByRole("checkbox", { exact: true, name: "gemini-3.6-flash 是否启用" }).isChecked(),
            true
        );
        await permissions.getByRole("button", { exact: true, name: "全部禁用" }).click();
        visibilityFailure = "gemini-3.6-flash";
        await permissions.getByRole("button", { name: /^应用启用状态/ }).click();
        await permissions
            .getByRole("alert")
            .getByText(/模拟保存失败/)
            .waitFor();
        assert.equal(
            await permissions.getByRole("button", { exact: true, name: "应用启用状态（1）" }).isEnabled(),
            true
        );
        assert.deepEqual(
            scheduler.hiddenModelsSnapshot(),
            matchedModels.filter(model => model !== visibilityFailure).sort()
        );
        visibilityFailure = "";
        await permissions.getByRole("button", { exact: true, name: "应用启用状态（1）" }).click();
        await permissions.getByRole("button", { exact: true, name: "应用启用状态（0）" }).waitFor();
        assert.deepEqual(scheduler.hiddenModelsSnapshot(), [...matchedModels].sort());
        assert.deepEqual(
            JSON.parse(fs.readFileSync(scheduler.config.statePath, "utf8")).hiddenModels,
            [...matchedModels].sort()
        );
        assert.equal(visibilityWrites.filter(item => item.model === "gemini-3.6-flash").length, 2);
        // An external panel restore must reach this table even while a permission draft exists.
        await permissions.getByRole("checkbox", { exact: true, name: "gemini-3.6-flash Free" }).check();
        scheduler.showModel("gemini-3.6-flash");
        await page.waitForFunction(
            () => document.querySelector('input[aria-label="gemini-3.6-flash 是否启用"]')?.checked === true
        );
        assert.equal(
            await permissions.getByRole("checkbox", { exact: true, name: "gemini-3.6-flash Free" }).isChecked(),
            true
        );
        await panel.getByRole("button", { exact: true, name: "放弃草稿" }).click();
        await permissions.getByRole("button", { exact: true, name: "全部启用" }).click();
        await permissions.getByRole("button", { name: /^应用启用状态/ }).click();
        await permissions.getByRole("button", { exact: true, name: "应用启用状态（0）" }).waitFor();
        assert.deepEqual(scheduler.hiddenModelsSnapshot(), []);
        assert.deepEqual(service.running.scheduler.modelAllowlist, policyBeforeVisibility);
        await collapse.locator("summary").click();
        assert.equal(await permissions.isVisible(), false);
        const initialKeepalive = service.saved.scheduler.streamKeepaliveIntervalMs;
        await panel.locator("#config-STREAM_EARLY_HEADERS").locator("..").click();
        assert.equal(await panel.locator("#config-STREAM_KEEPALIVE_INTERVAL_MS").count(), 0);
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await page.waitForFunction(() =>
            document.querySelector(".configuration-panel")?.textContent.includes("立即生效：提前发送流式响应头")
        );
        assert.equal(service.saved.scheduler.streamKeepaliveIntervalMs, initialKeepalive);
        const field = panel
            .locator(".configuration-field")
            .filter({ has: page.locator('label[for="config-ACCOUNT_MODEL_MAX_CONCURRENCY"]') });
        await field.getByRole("button", { name: "增加模型" }).click();
        await field.getByPlaceholder("可手动输入上游模型 ID").fill("unknown-upstream-id");
        await field.locator(".el-input-number input").fill("0");
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await page.waitForFunction(() =>
            document.querySelector(".configuration-panel")?.textContent.includes("立即生效：单账号各模型并发上限")
        );
        assert.equal(service.saved.scheduler.accountModelConcurrency["unknown-upstream-id"], 0);
        assert.equal(await panel.locator("#config-MODEL_TRANSPORT_POLICY").count(), 0);
        await panel.locator("#config-MAKERSUITE_TIMEOUT_MS").fill("600000");
        await panel.locator("#config-MAKERSUITE_TIMEOUT_MS").blur();
        assert.equal(service.running.makerSuiteTimeoutMs, 295000);
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await page.waitForFunction(() =>
            document.querySelector(".configuration-panel")?.textContent.includes("立即生效：Playground 生成超时")
        );
        assert.equal(service.running.makerSuiteTimeoutMs, 600000);
        await panel.locator("#config-FAKE_STREAM_TIMEOUT_MS").fill("900000");
        await panel.locator("#config-FAKE_STREAM_TIMEOUT_MS").blur();
        await panel
            .locator(".el-select")
            .filter({ has: page.locator("#config-STREAMING_MODE") })
            .click();
        await page.getByRole("option", { exact: true, name: "提前发送空首块" }).click();
        await Promise.all([
            page.waitForResponse(
                response => response.url().endsWith("/api/configuration") && response.request().method() === "PATCH"
            ),
            panel.getByRole("button", { exact: true, name: "保存" }).click(),
        ]);
        assert.equal(service.running.streamingMode, "early");
        assert.equal(service.running.fakeStreamTimeoutMs, 900000);
        await panel
            .locator(".el-select")
            .filter({ has: page.locator("#config-STREAMING_MODE") })
            .click();
        await page.getByRole("option", { exact: true, name: "真实流式" }).click();
        await Promise.all([
            page.waitForResponse(
                response => response.url().endsWith("/api/configuration") && response.request().method() === "PATCH"
            ),
            panel.getByRole("button", { exact: true, name: "保存" }).click(),
        ]);
        assert.equal(service.running.streamingMode, "real");
        assert.ok(Number(await panel.locator("#config-MAKERSUITE_TIMEOUT_MS").getAttribute("max")) > 300000);
        await panel.locator("#config-FORCE_WEB_SEARCH").locator("..").click();
        service.save({ changes: { FORCE_CODE_EXECUTION: true }, version: service.document.version });
        // Polling may detect the version conflict before a save can be clicked.

        await panel.getByText("配置已被其他页面修改。草稿已保留，请刷新并处理差异后再保存。").waitFor();
        assert.equal(service.running.forceWebSearch, false);
        assert.equal(await panel.locator("#config-FORCE_WEB_SEARCH").getAttribute("aria-checked"), "true");
        await panel.getByRole("button", { exact: true, name: "刷新配置" }).click();
        await page.getByRole("button", { name: "保留草稿并更新版本" }).click();
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await page.waitForFunction(() =>
            document.querySelector(".configuration-panel")?.textContent.includes("立即生效：强制启用联网搜索")
        );
        assert.equal(service.running.forceCodeExecution, true);
        assert.equal(service.running.forceWebSearch, true);
        assert.deepEqual(Object.keys(writes.at(-1).changes), ["FORCE_WEB_SEARCH"]);
        await panel.locator("#config-PUBLIC_DASHBOARD_ENABLED").locator("..").click();
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await panel.getByText("查看待重启变更").waitFor();
        assert.equal(service.running.publicDashboard.enabled, false);
        await page.reload();
        await page.getByRole("navigation").getByRole("button", { exact: true, name: "设置" }).click();
        await panel.getByText("查看待重启变更").waitFor();
        await panel.locator("#config-FORCE_URL_CONTEXT").locator("..").click();
        const writesBeforeRestart = writes.length;
        await panel.getByRole("button", { exact: true, name: "重启" }).click();
        await page.locator(".el-message-box").getByRole("button", { exact: true, name: "重启" }).click();
        await panel.getByText("新实例启动成功，已确认保存配置实际生效。").waitFor();
        assert.equal(writes.length, writesBeforeRestart);
        assert.equal(service.running.publicDashboard.enabled, true);
        assert.equal(service.saved.forceUrlContext, false);
        assert.equal(await panel.locator("#config-FORCE_URL_CONTEXT").getAttribute("aria-checked"), "true");
        await panel.getByRole("button", { exact: true, name: "放弃草稿" }).click();
        await panel.locator("#config-PUBLIC_DASHBOARD_ENABLED").locator("..").click();
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await panel.getByText("查看待重启变更").waitFor();
        await panel.getByRole("button", { exact: true, name: "撤销待重启变更" }).click();
        await page.waitForFunction(
            () => !document.querySelector(".configuration-panel details:not(.model-settings-collapse)")
        );
        assert.equal(service.snapshot().pending.length, 0);
        assert.equal(await panel.getByText("MODEL_QUEUE_TIMEOUT_MS", { exact: true }).count(), 0);
        await panel
            .locator(".configuration-field")
            .filter({ has: page.locator('label[for="config-PUBLIC_DASHBOARD_ROLE"]') })
            .locator(".el-select")
            .click();
        await page.getByRole("option", { exact: true, name: "主控端" }).click();
        await panel.getByRole("button", { exact: true, name: "增加节点" }).click();
        const agentRow = panel.locator(".agent-row");
        await agentRow.getByPlaceholder("节点名称（仅管理端）").fill("节点 A");
        await agentRow.getByPlaceholder("节点 ID", { exact: true }).fill("agent-a");
        await agentRow.getByPlaceholder("https://agent.example.org").fill("https://agent.example.org");
        await agentRow.getByPlaceholder("Token；原节点留空保留").fill("AGENT_TEST_SECRET");
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await panel.getByText("查看待重启变更").waitFor();
        assert.equal(service.saved.publicDashboard.agents[0].token, "AGENT_TEST_SECRET");
        assert.equal(await agentRow.getByPlaceholder("Token；原节点留空保留").inputValue(), "");
        assert.doesNotMatch(JSON.stringify(service.snapshot()), /AGENT_TEST_SECRET/);
        await agentRow.getByPlaceholder("节点名称（仅管理端）").fill("节点 A 改名");
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await page.waitForFunction(
            () =>
                document.querySelector(".agent-row input")?.value === "节点 A 改名" &&
                document.querySelector('.configuration-panel [role="status"]')?.textContent.includes("0 项修改")
        );
        assert.equal(service.saved.publicDashboard.agents[0].token, "AGENT_TEST_SECRET");
        assert.deepEqual(errors, []);
    }
);
