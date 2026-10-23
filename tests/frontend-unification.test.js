/* eslint-env browser */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { createServer } = require("vite");
const { ConfigurationService } = require("../src/config/ConfigurationService");

// Synthetic data only: screenshots must never contain live account credentials.
test(
    "admin routes, editor guards, log following and responsive navigation",
    {
        skip: !fs.existsSync(chromium.executablePath()),
        timeout: 90000,
    },
    async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "admin-ui-"));
        t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
        const logger = { debug() {}, error() {}, info() {}, warn() {} };
        const service = new ConfigurationService(
            { logger, ready: true },
            { env: {}, file: path.join(directory, "config.json") }
        );
        service.system.scheduler = { hiddenModelsSnapshot: () => [] };
        const server = await createServer({
            configFile: path.resolve(__dirname, "../vite.config.js"),
            logLevel: "error",
            server: { host: "127.0.0.1", port: 0, strictPort: false },
        });
        await server.listen();
        t.after(() => server.close());
        const browser = await chromium.launch({ args: ["--no-sandbox"] });
        t.after(() => browser.close());
        const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
        page.setDefaultTimeout(6000);
        const errors = [];
        page.on("pageerror", error => {
            errors.push(error.message);
            t.diagnostic(error.message);
        });
        await page.addInitScript(() => localStorage.setItem("lang", "en"));
        await page.route("**/locales/*.json", route =>
            route.fulfill({
                json: JSON.parse(
                    fs.readFileSync(
                        path.resolve(
                            __dirname,
                            "../ui/locales/" + new URL(route.request().url()).pathname.split("/").at(-1)
                        )
                    )
                ),
            })
        );
        let failAccounts = false,
            failCore = false,
            cursor = 0;
        const logQueries = [];
        await page.route("**/api/**", route => {
            const url = new URL(route.request().url());
            let data = {},
                status = 200;
            if (url.pathname.startsWith("/api/status")) {
                data = { status: { accountDetails: [], currentAuthIndex: -1, schedulingMode: "legacy" } };
                if (failCore) status = 503;
            } else if (url.pathname === "/api/configuration") data = service.snapshot();
            else if (url.pathname.endsWith("/login-queue"))
                data = { attemptTimeout: 180000, autoRecovery: true, concurrency: 1, configurationVersion: 1 };
            else if (url.pathname.endsWith("/benefit-checks")) data = { tasks: [] };
            else if (url.pathname === "/api/account-management/accounts") {
                data = { accounts: [], total: 0 };
                if (failAccounts) status = 503;
            } else if (url.pathname.endsWith("/proxy-pool/status")) data = { enabled: false, mihomo: { ready: false } };
            else if (url.pathname.endsWith("/proxy-pool/settings"))
                data = {
                    basePort: 10801,
                    binaryPath: "",
                    controllerPort: 19090,
                    enabled: false,
                    exitIpUrl: "",
                    healthTimeoutMs: 5000,
                    revision: 1,
                    testUrl: "https://example.com",
                };
            else if (url.pathname.endsWith("/proxy-pool/nodes")) data = { nodes: [] };
            else if (url.pathname.endsWith("/proxy-pool/bindings")) data = { bindings: [] };
            else if (url.pathname.endsWith("/proxy-pool/subscriptions")) data = { subscriptions: [] };
            else if (url.pathname === "/api/logs") {
                logQueries.push(url.searchParams.get("after"));
                const start = cursor;
                cursor += 120;
                data = {
                    cursor,
                    lines: Array.from({ length: 120 }, (_, i) => `[INFO] synthetic log ${start + i} <safe>`),
                    reset: !url.searchParams.has("after"),
                };
            }
            return route.fulfill({ json: data, status });
        });
        const base = `http://127.0.0.1:${server.httpServer.address().port}`;
        const navigate = async label => {
            const menu = page.getByRole("button", { exact: true, name: /^(Navigation|导航)$/ });
            if (await menu.isVisible()) await menu.click();
            await page
                .getByRole("navigation")
                .filter({ visible: true })
                .getByRole("button", { exact: true, name: label })
                .click();
        };
        const answerDraft = async name => {
            const box = page.locator(".el-message-box").filter({ visible: true }).last();
            await box.getByRole("button", { exact: true, name }).click();
            await box.waitFor({ state: "hidden" });
        };
        const assertFits = async () =>
            assert.ok(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
                `overflow: ${page.url()} ${page.viewportSize().width}`
            );
        const screenshot = async name => {
            if (!process.env.FRONTEND_SCREENSHOT_DIR) return;
            fs.mkdirSync(process.env.FRONTEND_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({
                fullPage: true,
                path: path.join(process.env.FRONTEND_SCREENSHOT_DIR, `${name}.png`),
            });
        };
        const routes = [
            ["/", "Overview"],
            ["/accounts", "Account Management"],
            ["/proxy-pool", "Proxy pool"],
            ["/usage", "Usage Statistics"],
            ["/logs", "Real-time Logs"],
            ["/settings", "Settings"],
        ];
        for (const [url] of routes) {
            await page.goto(base + url);
            await page.getByRole("heading", { level: 1 }).waitFor();
            assert.equal(new URL(page.url()).pathname, url);
            await page.reload();
            await page.getByRole("heading", { level: 1 }).waitFor();
            assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
        }
        await navigate("Overview");
        await navigate("Settings");
        await page.waitForURL("**/settings");
        // Independently staged model visibility must participate in the same draft guard.
        await page.locator(".model-settings-collapse > summary").click();
        const visibility = page.getByRole("checkbox", { name: / 是否启用$/ }).first();
        await visibility.uncheck();
        const hasUnloadGuard = () =>
            page.evaluate(() => {
                const event = new Event("beforeunload", { cancelable: true });
                window.dispatchEvent(event);
                return event.defaultPrevented;
            });
        assert.equal(await hasUnloadGuard(), true);
        await navigate("Overview");
        await answerDraft("Continue editing");
        assert.equal(await visibility.isChecked(), false);
        await page.getByRole("button", { name: "放弃启用状态修改" }).click();
        assert.equal(await hasUnloadGuard(), false);
        await visibility.uncheck();
        await navigate("Overview");
        await answerDraft("Discard and leave");
        await page.waitForURL(base + "/");
        await navigate("Settings");
        await page.locator(".model-settings-collapse > summary").click();
        assert.equal(await visibility.isChecked(), true);
        const thinking = page.locator("#config-FORCE_THINKING");
        await thinking.locator("..").click();
        await navigate("Overview");
        await answerDraft("Continue editing");
        assert.equal(new URL(page.url()).pathname, "/settings");
        assert.equal(await thinking.getAttribute("aria-checked"), "true");
        await screenshot("settings-draft");
        const unloadPrevented = await page.evaluate(() => {
            const e = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(e);
            return e.defaultPrevented;
        });
        assert.equal(unloadPrevented, true);
        await page.goBack();
        await answerDraft("Continue editing");
        await page.waitForURL("**/settings");
        await navigate("Overview");
        await answerDraft("Discard and leave");
        await page.waitForURL(base + "/");
        await navigate("Account Management");
        await page.getByRole("button", { exact: true, name: "Save login settings" }).waitFor();
        await page.getByRole("spinbutton").first().fill("2");
        await navigate("Overview");
        await answerDraft("Continue editing");
        assert.equal(new URL(page.url()).pathname, "/accounts");
        await navigate("Overview");
        await answerDraft("Discard and leave");
        await navigate("Proxy pool");
        await page.locator(".pool-settings > summary").click();
        await page.getByRole("spinbutton").first().fill("10802");
        await navigate("Overview");
        await answerDraft("Continue editing");
        assert.equal(new URL(page.url()).pathname, "/proxy-pool");
        await navigate("Overview");
        await answerDraft("Discard and leave");
        failAccounts = true;
        await navigate("Account Management");
        await page.getByRole("alert").filter({ hasText: "Refresh failed" }).waitFor();
        assert.equal(await page.locator(".account-table-scroll").isVisible(), false);
        await screenshot("accounts-load-error");
        failAccounts = false;
        await page.getByRole("button", { exact: true, name: "Retry" }).click();
        await page.getByRole("button", { exact: true, name: "Save login settings" }).waitFor();
        // Same mounted controller handles route switches; logs must stop polling off-page.
        await navigate("Real-time Logs");
        const logs = page.locator("#log-container");
        await logs
            .getByText(/synthetic log/)
            .first()
            .waitFor();
        assert.ok((await logs.innerText()).includes("<safe>"));
        assert.equal(await logs.locator("safe").count(), 0);
        await logs.evaluate(el => (el.scrollTop = 0));
        await page.waitForFunction(() => !document.querySelector(".log-toolbar input").checked);
        const previousCursor = cursor;
        const previousText = await logs.innerText();
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await page.waitForFunction(value => {
            const el = document.querySelector("#log-container");
            return el && el.innerText !== value;
        }, previousText);
        assert.equal(await logs.evaluate(el => el.scrollTop), 0);
        await page.getByText("Follow logs", { exact: true }).click();
        await page.waitForFunction(() => {
            const el = document.querySelector("#log-container");
            return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        });
        assert.ok(logQueries.includes(String(previousCursor)));
        await navigate("Overview");
        const logCount = logQueries.length;
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await page.waitForResponse(response => response.url().endsWith("/api/status/core"));
        assert.equal(logQueries.length, logCount);
        failCore = true;
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await page.getByRole("alert").filter({ hasText: "Refresh failed" }).waitFor();
        failCore = false;
        await page.getByRole("button", { exact: true, name: "Retry" }).click();
        await page.waitForFunction(() => !document.querySelector(".refresh-error"));
        for (const width of [360, 390, 768, 1280, 1440]) {
            await page.setViewportSize({ height: 1000, width });
            for (const [url] of routes) {
                await page.goto(base + url);
                await page.getByRole("heading", { level: 1 }).waitFor();
                if (url === "/accounts")
                    await page.getByRole("button", { exact: true, name: "Save login settings" }).waitFor();
                if (url === "/proxy-pool") await page.getByRole("heading", { name: "代理节点" }).waitFor();
                if (url === "/settings") await page.locator("#config-FORCE_THINKING").locator("..").waitFor();
                await assertFits();
                if ([390, 1440].includes(width)) await screenshot(`after-${url.slice(1) || "overview"}-${width}`);
            }
        }
        // At 200% zoom, a 1440px display has a 720px CSS viewport.
        await page.setViewportSize({ height: 500, width: 720 });
        await navigate("Account Management");
        await page.getByRole("button", { exact: true, name: "Add account" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        await assertFits();
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        await page.getByRole("button", { exact: true, name: "Add account" }).focus();
        await page.keyboard.press("Enter");
        await dialog.waitFor();
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        assert.equal(
            await page
                .getByRole("button", { exact: true, name: "Add account" })
                .evaluate(el => el === document.activeElement),
            true
        );
        await page.setViewportSize({ height: 1000, width: 390 });
        await navigate("Overview");
        await page.getByRole("button", { exact: true, name: "Navigation" }).click();
        await page
            .getByRole("navigation")
            .filter({ visible: true })
            .getByRole("button", { exact: true, name: "Switch Language" })
            .click();
        await page
            .getByRole("navigation")
            .filter({ visible: true })
            .getByRole("button", { exact: true, name: "概览" })
            .click();
        await page.getByRole("heading", { exact: true, name: "概览" }).waitFor();
        await assertFits();
        await screenshot("after-overview-zh-390");
        await navigate("账号管理");
        await page.getByRole("heading", { exact: true, name: "账号管理" }).waitFor();
        await assertFits();
        await screenshot("after-accounts-zh-390");
        assert.deepEqual(errors, []);
    }
);

test("new admin entry paths serve the SPA through the existing authentication middleware", async t => {
    const express = require("express");
    const StatusRoutes = require("../src/routes/StatusRoutes");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "admin-routes-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const index = path.join(directory, "index.html");
    fs.writeFileSync(index, "<html>admin-shell-fixture</html>");
    const app = express();
    new StatusRoutes({
        config: {},
        distIndexPath: index,
        logger: { debug() {}, error() {}, info() {}, warn() {} },
    }).setupRoutes(app, (req, res, next) => {
        if (req.headers["x-test-session"] === "valid") return next();
        res.sendStatus(401);
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    for (const route of ["/usage", "/logs", "/settings"]) {
        const url = `http://127.0.0.1:${server.address().port}${route}`;
        const denied = await fetch(url);
        assert.equal(denied.status, 401);
        await denied.text();
        const accepted = await fetch(url, { headers: { "x-test-session": "valid" } });
        assert.equal(accepted.status, 200);
        assert.match(await accepted.text(), /admin-shell-fixture/);
    }
});

test(
    "service failures stay in the workspace; expired sessions retain native login submission",
    {
        skip: !fs.existsSync(chromium.executablePath()),
        timeout: 30000,
    },
    async t => {
        const server = await createServer({
            configFile: path.resolve(__dirname, "../vite.config.js"),
            logLevel: "error",
            server: { host: "127.0.0.1", port: 0, strictPort: false },
        });
        await server.listen();
        t.after(() => server.close());
        const browser = await chromium.launch({ args: ["--no-sandbox"] });
        t.after(() => browser.close());
        const base = `http://127.0.0.1:${server.httpServer.address().port}`;
        for (const [status, passwordMode] of [
            [503, true],
            [401, true],
            [401, false],
        ]) {
            const page = await browser.newPage();
            page.setDefaultTimeout(6000);
            page.setDefaultNavigationTimeout(6000);
            await page.addInitScript(() => localStorage.setItem("lang", "en"));
            await page.route("**/locales/*.json", route =>
                route.fulfill({ json: JSON.parse(fs.readFileSync(path.resolve(__dirname, "../ui/locales/en.json"))) })
            );
            await page.route("**/api/**", route => {
                if (route.request().url().endsWith("/api/auth/config"))
                    return route.fulfill({ json: { requirePassword: passwordMode, requireUsername: passwordMode } });
                return route.fulfill({ json: { error: "synthetic service failure" }, status });
            });
            await page.goto(base + "/logs");
            if (status === 503) {
                await page.getByRole("alert").filter({ hasText: "Refresh failed" }).waitFor();
                assert.equal(new URL(page.url()).pathname, "/logs");
            } else {
                await page.waitForURL("**/login");
                const username = page.locator('input[name="username"]');
                const password = page.locator(passwordMode ? 'input[name="password"]' : 'input[name="apiKey"]');
                if (passwordMode) await username.fill("synthetic-user");
                await password.fill("synthetic-password");
                await page.route("**/login", route =>
                    route.fulfill({ body: "<html>synthetic login response</html>", contentType: "text/html" })
                );
                const [request] = await Promise.all([
                    page.waitForRequest(
                        request => request.method() === "POST" && new URL(request.url()).pathname === "/login"
                    ),
                    page.locator('button[type="submit"]').click(),
                ]);
                const fields = new URLSearchParams(request.postData());
                assert.equal(fields.get("username"), passwordMode ? "synthetic-user" : null);
                assert.equal(fields.get(passwordMode ? "password" : "apiKey"), "synthetic-password");
                assert.equal(fields.has(passwordMode ? "apiKey" : "password"), false);
            }
            await page.close();
        }
    }
);
