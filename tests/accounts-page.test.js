/* eslint-env browser */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { createServer } = require("vite");

test(
    "account page refreshes after upload and filter changes; unlogged accounts support proxy binding",
    { skip: !fs.existsSync(chromium.executablePath()) },
    async t => {
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
        await page.addInitScript(() => {
            window.__accountTestIntervals = [];
            const schedule = window.setInterval;
            window.setInterval = (...args) => {
                const id = schedule(...args);
                window.__accountTestIntervals.push(id);
                return id;
            };
        });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const account = (email, recoveryState = "idle") => ({
            accountId: email,
            authIndex: null,
            autoRecovery: true,
            credentialVersion: 1,
            email,
            hasPassword: true,
            hasTotpSecret: false,
            recoveryState,
            sessionState: "missing",
        });
        const accounts = [account("first@example.com"), account("manual@example.com", "manual_required")];
        accounts[1].lastFailure = { error: "manual_challenge" };
        const queries = [];
        const proxyNodes = [
            { enabled: true, id: "login-node", name: "Login node", type: "socks5" },
            { enabled: true, id: "direct-node", name: "VPS Direct", type: "direct" },
        ];
        const proxyBindings = new Map();
        const bindingWrites = [];
        let releaseOld;
        await page.route("**/locales/*.json", route =>
            route.fulfill({
                body: fs.readFileSync(path.resolve(__dirname, "../ui/locales/en.json"), "utf8"),
                contentType: "application/json",
            })
        );
        await page.route("**/api/**", async route => {
            const url = new URL(route.request().url());
            let result = {};
            if (url.pathname === "/api/status" || url.pathname === "/api/status/core") {
                result = { status: { accountDetails: [], currentAuthIndex: -1, schedulingMode: "legacy" } };
            } else if (url.pathname === "/api/account-management/login-queue") {
                result = { attemptTimeout: 180000, autoRecovery: false, concurrency: 1 };
            } else if (url.pathname === "/api/account-management/benefit-checks") {
                result = { tasks: [] };
            } else if (url.pathname === "/api/account-management/accounts") {
                queries.push(url.searchParams);
                const search = url.searchParams.get("search") || "";
                const state = url.searchParams.get("state") || "";
                const matches = accounts.filter(
                    row =>
                        row.email.includes(search) &&
                        (!state ||
                            (state === "not_logged_in"
                                ? row.sessionState === "missing" && row.hasPassword
                                : row.recoveryState === state || row.sessionState === state))
                );
                result = { accounts: matches, total: matches.length };
                if (search === "first") await new Promise(resolve => (releaseOld = resolve));
            } else if (
                url.pathname.startsWith("/api/account-management/accounts/") &&
                url.pathname.endsWith("/login")
            ) {
                const id = decodeURIComponent(url.pathname.split("/").at(-2));
                Object.assign(
                    accounts.find(row => row.accountId === id),
                    {
                        authIndex: 0,
                        lastFailure: null,
                        recoveryState: "idle",
                        sessionState: "valid",
                    }
                );
                result = { taskId: "synthetic-login-task" };
            } else if (url.pathname === "/api/files") {
                accounts.push(account("uploaded@example.com"));
                result = { filename: "auth-2.json" };
            } else if (url.pathname === "/api/proxy-pool/nodes") {
                result = { nodes: proxyNodes };
            } else if (url.pathname === "/api/proxy-pool/status") {
                result = { enabled: true, mihomo: { ready: true } };
            } else if (url.pathname === "/api/proxy-pool/subscriptions") {
                result = { subscriptions: [] };
            } else if (url.pathname === "/api/proxy-pool/bindings") {
                result = {
                    bindings: accounts.map(row => ({
                        accountKey: row.email,
                        accountName: row.email,
                        authIndex: null,
                        desiredNodeId: proxyBindings.get(row.email) || null,
                        inflight: 0,
                        state: proxyBindings.has(row.email) ? "offline" : "unbound",
                    })),
                };
            } else if (url.pathname.startsWith("/api/proxy-pool/bindings/")) {
                const body = route.request().postDataJSON();
                const entries = body.bindings || [
                    { accountKey: decodeURIComponent(url.pathname.split("/").at(-1)), ...body },
                ];
                bindingWrites.push(...entries);
                for (const entry of entries) proxyBindings.set(entry.accountKey, entry.desiredNodeId);
            }
            await route.fulfill({ json: result });
        });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/accounts`);
        const rows = page.locator(".accounts-panel .el-table__body-wrapper tbody tr");
        const waitRows = count =>
            page.waitForFunction(
                expected =>
                    document.querySelectorAll(".accounts-panel .el-table__body-wrapper tbody tr").length === expected,
                count
            );
        await waitRows(2);
        const search = page.getByPlaceholder("Search email / account index");
        await search.fill("manual");
        await waitRows(1);
        assert.match(await rows.innerText(), /manual@example.com/);
        await search.fill("");
        await waitRows(2);

        await search.fill("manual");
        await waitRows(1);
        await search.hover();
        await page.locator(".accounts-panel .el-input__clear").click();
        await waitRows(2);

        const filter = page.locator(".accounts-panel > .account-toolbar .el-select");
        await filter.click();
        await page.getByRole("option", { exact: true, name: "Manual required" }).click();
        await waitRows(1);
        await filter.hover();
        await filter.locator(".el-select__clear").click();
        await waitRows(2);
        assert.equal(queries.at(-1).get("state"), "");

        await filter.click();
        const notLoggedIn = page.waitForResponse(
            response => new URL(response.url()).searchParams.get("state") === "not_logged_in"
        );
        await page.getByRole("option", { exact: true, name: "Not logged in" }).click();
        await notLoggedIn;
        assert.equal(await rows.count(), 2);
        const manual = rows.filter({ hasText: "manual@example.com" });
        assert.match(await manual.innerText(), /manual_challenge/);
        await manual.getByRole("button", { exact: true, name: "Log in" }).click();
        await waitRows(1);
        assert.match(await rows.innerText(), /first@example.com/);
        await filter.hover();
        await filter.locator(".el-select__clear").click();
        await waitRows(2);
        assert.ok(!(await manual.innerText()).includes("manual_challenge"));
        assert.match(await manual.innerText(), /Valid/);

        // A slow search response must not overwrite the newer cleared query.
        const oldRequest = page.waitForRequest(
            request => new URL(request.url()).searchParams.get("search") === "first"
        );
        await search.fill("first");
        await oldRequest;
        await search.fill("");
        await waitRows(2);
        const oldResponse = page.waitForResponse(
            response => new URL(response.url()).searchParams.get("search") === "first"
        );
        releaseOld();
        await oldResponse;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await rows.count(), 2);

        // Disable the child's interval so the upload must trigger its own immediate refresh.
        await page.evaluate(() => {
            for (const id of window.__accountTestIntervals) clearInterval(id);
        });
        await page.locator('input[type="file"][accept=".json,.zip"]').setInputFiles({
            buffer: Buffer.from(JSON.stringify({ accountName: "uploaded@example.com", cookies: [], origins: [] })),
            mimeType: "application/json",
            name: "auth.json",
        });
        await waitRows(3);
        assert.ok((await rows.allTextContents()).some(text => text.includes("uploaded@example.com")));

        await page.locator('button[title="节点池"]').click();
        const proxySection = page
            .locator(".pool-card")
            .filter({ has: page.getByRole("heading", { name: "账号出口" }) });
        const uploaded = proxySection.locator("tbody tr").filter({ hasText: "uploaded@example.com" });
        await uploaded.waitFor();
        assert.match(await uploaded.innerText(), /未登录/);
        assert.equal(await uploaded.getByRole("button", { exact: true, name: "应用" }).isDisabled(), true);
        await uploaded.locator(".el-select").click();
        const saved = page.waitForResponse(
            response => response.request().method() === "PUT" && response.url().includes("/api/proxy-pool/bindings/")
        );
        const bindingsRefreshed = page.waitForResponse(
            response => response.request().method() === "GET" && response.url().endsWith("/api/proxy-pool/bindings")
        );
        await page.getByRole("option", { exact: true, name: "Login node" }).click();
        await saved;
        await bindingsRefreshed;
        assert.deepEqual(bindingWrites.at(-1), { accountKey: "uploaded@example.com", desiredNodeId: "login-node" });
        await page.waitForFunction(() => document.querySelector(".proxy-pool")?.textContent.includes("Login node"));

        await uploaded.locator(".el-checkbox").click();
        const first = proxySection.locator("tbody tr").filter({ hasText: "first@example.com" });
        await first.locator(".el-checkbox").click();
        const batchSelect = proxySection.locator(".actions .el-select").last();
        await batchSelect.click();
        const dropdownId = await batchSelect.getByRole("combobox").getAttribute("aria-controls");
        await page.locator(`#${dropdownId}`).getByRole("option", { exact: true, name: "VPS Direct" }).click();
        const batchSaved = page.waitForResponse(
            response => response.request().method() === "POST" && response.url().endsWith("/bindings/batch")
        );
        await proxySection.getByRole("button", { name: "保存选中绑定" }).click();
        await batchSaved;
        assert.deepEqual(
            bindingWrites.slice(-2).sort((a, b) => a.accountKey.localeCompare(b.accountKey)),
            [
                { accountKey: "first@example.com", desiredNodeId: "direct-node" },
                { accountKey: "uploaded@example.com", desiredNodeId: "direct-node" },
            ]
        );
        assert.deepEqual(errors, []);
    }
);

async function browserFixture(t) {
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
    await page.route("**/locales/*.json", route =>
        route.fulfill({
            body: fs.readFileSync(path.resolve(__dirname, "../ui/locales/en.json"), "utf8"),
            contentType: "application/json",
        })
    );
    return { page, url: `http://127.0.0.1:${server.httpServer.address().port}` };
}

test(
    "account selections span pages, preview choices stay constrained, and cancellation covers in-flight login",
    { skip: !fs.existsSync(chromium.executablePath()) },
    async t => {
        const { page, url } = await browserFixture(t);
        let accounts = Array.from({ length: 55 }, (_, i) => ({
            accountId: `id-${i}`,
            authIndex: null,
            autoRecovery: true,
            credentialVersion: 1,
            email: `user${i}@example.com`,
            hasPassword: true,
            recoveryState: "idle",
            sessionState: "missing",
        }));
        const queries = [],
            loginIds = [],
            cancelIds = [],
            importBodies = [];
        let releaseLogin, releaseImport;
        await page.route("**/api/**", async route => {
            const request = route.request(),
                u = new URL(request.url());
            let result = {};
            if (u.pathname === "/api/status" || u.pathname === "/api/status/core")
                result = { status: { accountDetails: [], currentAuthIndex: -1 } };
            else if (u.pathname.endsWith("/login-queue"))
                result = { autoRecovery: false, concurrency: 1, executions: [] };
            else if (u.pathname === "/api/account-management/accounts/selection") {
                const matches = accounts.filter(row => row.email.includes(u.searchParams.get("search") || ""));
                result = { accounts: matches, total: matches.length };
            } else if (u.pathname === "/api/account-management/accounts") {
                queries.push(Object.fromEntries(u.searchParams));
                const matches = accounts.filter(row => row.email.includes(u.searchParams.get("search") || ""));
                const size = Number(u.searchParams.get("pageSize")),
                    cursor = Number(u.searchParams.get("page"));
                result = { accounts: matches.slice((cursor - 1) * size, cursor * size), total: matches.length };
            } else if (u.pathname.endsWith("/batch/cancel-login")) {
                cancelIds.push(request.postDataJSON().accountIds);
                result = {
                    cancelled: cancelIds.at(-1).length,
                    failed: 0,
                    results: cancelIds.at(-1).map(accountId => ({ accountId, status: "cancelled" })),
                    stopping: 0,
                    unnecessary: 0,
                };
            } else if (u.pathname.endsWith("/login")) {
                loginIds.push(u.pathname.split("/").at(-2));
                await new Promise(resolve => {
                    releaseLogin = resolve;
                });
                result = { taskId: "dispatched-task" };
            } else if (u.pathname.endsWith("/import/preview"))
                result = {
                    complete: true,
                    previewId: "preview",
                    rows: [
                        { accountId: null, email: "new@example.com", index: 0 },
                        { accountId: "id-0", conflict: true, email: "user0@example.com", index: 1 },
                        { email: "bad", error: "Invalid email", index: 2 },
                        { accountId: "id-1", email: "user1@example.com", index: 3, unchanged: true },
                        { accountId: "id-2", email: "user2@example.com", index: 4 },
                    ],
                };
            else if (u.pathname.endsWith("/import/commit")) {
                importBodies.push(request.postDataJSON());
                await new Promise(resolve => {
                    releaseImport = resolve;
                });
                result = { created: 1, failed: 0, loginQueued: 0, loginWarnings: [], skipped: 2, updated: 2 };
            } else if (request.method() === "DELETE")
                accounts = accounts.filter(row => row.accountId !== u.pathname.split("/").at(-1));
            await route.fulfill({ json: result });
        });
        await page.goto(`${url}/accounts`);
        const rows = page.locator(".accounts-panel .el-table__body-wrapper tbody tr");
        await page.waitForFunction(
            () => document.querySelectorAll(".accounts-panel .el-table__body-wrapper tbody tr").length === 20
        );
        assert.equal(queries.at(-1).pageSize, "20");
        await page.getByRole("button", { exact: true, name: "Select all" }).click();
        await page.getByRole("button", { exact: true, name: "Select all" }).click();
        assert.match(await page.locator(".batch-toolbar").innerText(), /Selected 55/);
        const pagination = page.locator(".accounts-panel > .el-pagination");
        await pagination.getByLabel("Go to next page").click();
        await page.waitForFunction(() =>
            document
                .querySelector(".accounts-panel .el-table__body-wrapper")
                ?.textContent.includes("user20@example.com")
        );
        await rows.first().locator(".el-checkbox").click();
        assert.match(await page.locator(".batch-toolbar").innerText(), /Selected 54/);
        await page.getByRole("button", { exact: true, name: "Cancel selected logins" }).click();
        await page.waitForFunction(() =>
            document.querySelector(".cancel-result")?.textContent.includes("Cancelled 54")
        );
        assert.equal(cancelIds[0].length, 54);
        await page.getByRole("button", { exact: true, name: "Clear selection" }).click();
        assert.match(await page.locator(".batch-toolbar").innerText(), /Selected 0/);
        await rows.first().locator(".el-checkbox").click();
        await page.getByPlaceholder("Search email / account index").fill("user1@");
        await page.waitForFunction(
            () => document.querySelectorAll(".accounts-panel .el-table__body-wrapper tbody tr").length === 1
        );
        assert.match(await page.locator(".batch-toolbar").innerText(), /Selected 0/);
        await page.getByPlaceholder("Search email / account index").fill("");
        await page.waitForFunction(
            () => document.querySelectorAll(".accounts-panel .el-table__body-wrapper tbody tr").length === 20
        );
        await pagination.locator(".el-select").click();
        await page.getByRole("option", { exact: true, name: "50/page" }).click();
        await page.waitForFunction(
            () => document.querySelectorAll(".accounts-panel .el-table__body-wrapper tbody tr").length === 50
        );
        assert.equal(queries.at(-1).page, "1");
        assert.equal(queries.at(-1).pageSize, "50");
        await pagination.locator(".el-select").click();
        await page.getByRole("option", { exact: true, name: "100/page" }).click();
        await page.waitForFunction(
            () => document.querySelectorAll(".accounts-panel .el-table__body-wrapper tbody tr").length === 55
        );
        assert.equal(queries.at(-1).pageSize, "100");
        await page.getByRole("button", { exact: true, name: "Select all" }).click();
        await page.getByRole("button", { exact: true, name: "Log in selected" }).click();
        await page
            .waitForRequest(request => request.url().endsWith("/batch/cancel-login"), { timeout: 100 })
            .catch(() => {});
        assert.equal(loginIds.length, 1);
        await page.getByRole("button", { exact: true, name: "Cancel selected logins" }).click();
        assert.equal(cancelIds.length, 1);
        releaseLogin();
        await page.waitForFunction(() =>
            document.querySelector(".cancel-result")?.textContent.includes("Cancelled 55")
        );
        assert.equal(loginIds.length, 1);
        assert.equal(cancelIds[1].length, 55);
        assert.match(await page.locator(".batch-toolbar").innerText(), /Selected 55/);
        await page.getByRole("button", { exact: true, name: "Import credentials / authenticator" }).click();
        const dialog = page.getByRole("dialog", { exact: true, name: "Import preview" });
        await dialog.getByRole("button", { exact: true, name: "Preview" }).click();
        await dialog
            .locator(".import-preview-table")
            .getByText("New account will be created", { exact: true })
            .first()
            .waitFor();
        assert.equal(await dialog.getByText("Create record without login", { exact: true }).count(), 0);
        await dialog.getByText("Skip existing accounts", { exact: true }).click();
        await dialog.getByText("Skip all", { exact: true }).click();
        await dialog.getByText("Skip all", { exact: true }).click();
        const previewRows = dialog.locator(".el-table__body-wrapper tbody tr");
        assert.equal(await previewRows.nth(2).getByRole("checkbox", { exact: true, name: "Skip" }).isChecked(), true);
        assert.equal(await previewRows.nth(2).getByRole("checkbox", { exact: true, name: "Skip" }).isDisabled(), true);
        await previewRows.nth(0).getByText("Skip", { exact: true }).click();
        assert.equal(
            await dialog.getByText("Skip all", { exact: true }).locator("..").locator(".is-indeterminate").count(),
            1
        );
        await previewRows.nth(0).getByText("Skip", { exact: true }).click();
        await dialog.getByText("Overwrite all", { exact: true }).click();
        await previewRows.nth(4).getByText("Overwrite", { exact: true }).click();
        assert.equal(
            await dialog.getByText("Overwrite all", { exact: true }).locator("..").locator(".is-indeterminate").count(),
            1
        );
        await dialog.getByText("Overwrite all", { exact: true }).click();
        await dialog.getByRole("button", { exact: true, name: "Commit import" }).click();
        await page.waitForFunction(() => document.querySelector(".el-dialog button.is-loading"));
        assert.equal(await dialog.getByRole("checkbox", { exact: true, name: "Skip all" }).isDisabled(), true);
        assert.deepEqual(
            importBodies[0].rows.map(row => row.skip),
            [false, false, true, true, false]
        );
        releaseImport();
        await dialog
            .locator(".import-result")
            .getByText(/Created 1/)
            .waitFor();
        assert.equal(await dialog.getByRole("button", { exact: true, name: "Commit import" }).isDisabled(), true);
        await dialog.locator(".el-dialog__headerbtn").click();
        await dialog.waitFor({ state: "hidden" });
        await pagination.locator(".el-select").click();
        await page.getByRole("option", { exact: true, name: "20/page" }).click();
        await page.waitForFunction(
            () => document.querySelectorAll(".accounts-panel .el-table__body-wrapper tbody tr").length === 20
        );
        await pagination.getByLabel("Go to next page").click();
        await page.waitForFunction(() =>
            document
                .querySelector(".accounts-panel .el-table__body-wrapper")
                ?.textContent.includes("user20@example.com")
        );
        await pagination.getByLabel("Go to next page").click();
        await page.waitForFunction(
            () => document.querySelectorAll(".accounts-panel .el-table__body-wrapper tbody tr").length === 15
        );
        assert.match(await page.locator(".batch-toolbar").innerText(), /Selected 55/);
        const emptyPage = page.waitForResponse(response => {
            const requestUrl = new URL(response.url());
            return (
                requestUrl.pathname === "/api/account-management/accounts" &&
                requestUrl.searchParams.get("page") === "1"
            );
        });
        await page.getByRole("button", { exact: true, name: "Delete selected" }).click();
        await page.locator(".el-message-box__btns button").last().click();
        await page.waitForFunction(() => document.querySelector(".batch-toolbar")?.textContent.includes("Selected 0"));
        await emptyPage;
        assert.equal(queries.at(-1).page, "1");
        assert.equal(accounts.length, 0);
    }
);

test(
    "proxy pool keeps all mobile actions and contains long text and dialogs at supported widths",
    { skip: !fs.existsSync(chromium.executablePath()) },
    async t => {
        const { page, url } = await browserFixture(t);
        const writes = [],
            errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const long = "Very-long-name-".repeat(10);
        const node = {
            boundAccounts: 0,
            enabled: true,
            exitIp: "2001:db8::1234",
            host: "2001:db8:1234:5678:9abc:def0:1234:5678",
            id: "node",
            latencyMs: 42,
            localPort: 10801,
            name: long,
            port: 1080,
            status: "ready",
            type: "socks5",
        };
        await page.route("**/api/**", async route => {
            const request = route.request(),
                u = new URL(request.url());
            let result = {};
            if (request.method() !== "GET")
                writes.push({ body: request.postDataJSON(), method: request.method(), path: u.pathname });
            if (u.pathname === "/api/status" || u.pathname === "/api/status/core")
                result = { status: { accountDetails: [], currentAuthIndex: -1 } };
            else if (u.pathname === "/api/account-management/accounts") result = { accounts: [], total: 0 };
            else if (u.pathname.endsWith("/proxy-pool/status"))
                result = {
                    bindingCount: 1,
                    enabled: true,
                    mihomo: { lastError: long, ready: true, version: long },
                    nodeCount: 1,
                };
            else if (u.pathname.endsWith("/nodes")) result = { nodes: [node] };
            else if (u.pathname.endsWith("/subscriptions"))
                result = {
                    subscriptions: [
                        {
                            id: "sub",
                            lastRefreshedAt: "2026-10-03T10:00:00Z",
                            name: long,
                            nodeCount: 1,
                            url: `https://example.com/${"x".repeat(120)}?token=***`,
                        },
                    ],
                };
            else if (u.pathname.endsWith("/bindings"))
                result = {
                    bindings: [
                        {
                            accountKey: "account",
                            accountName: `${long}@example.com`,
                            authIndex: 0,
                            desiredNodeId: "node",
                            inflight: 2,
                            proxySource: long,
                            state: "pending",
                        },
                    ],
                };
            else if (u.pathname.endsWith("/test")) result = { latencyMs: 42 };
            else if (u.pathname.endsWith("/refresh")) result = { nodeCount: 1 };
            else if (u.pathname.endsWith("/import")) result = { added: [node], errors: [], nodes: [node], skipped: 0 };
            else if (u.pathname.endsWith("/delete")) result = { deleted: 1, deletedNodes: 1, deletedSubscriptions: 1 };
            await route.fulfill({ json: result });
        });
        await page.goto(`${url}/proxy-pool`);
        const pool = page.locator(".proxy-pool");
        await pool.getByText("42 ms", { exact: false }).first().waitFor({ state: "attached" });
        const assertFits = async () => {
            const widths = await page.evaluate(() => ({
                body: document.documentElement.scrollWidth,
                viewport: innerWidth,
            }));
            assert.ok(widths.body <= widths.viewport + 1, JSON.stringify(widths));
        };
        const assertDialogFits = async dialog => {
            const box = await dialog.boundingBox();
            assert.ok(box.x >= 0 && box.x + box.width <= page.viewportSize().width + 1, JSON.stringify(box));
            assert.ok(await dialog.getByRole("button", { exact: true, name: "保存" }).isVisible());
            await assertFits();
        };
        for (const width of [320, 375, 390, 414, 768, 1280, 844]) {
            await page.setViewportSize({ height: width === 844 ? 390 : 900, width });
            await assertFits();
            assert.equal(
                await pool.locator(".desktop-list").first().isVisible(),
                (await pool.boundingBox()).width >= 768
            );
            await pool.getByRole("button", { exact: true, name: "添加节点" }).click();
            const dialog = page.getByRole("dialog", { exact: true, name: "添加节点" });
            await assertDialogFits(dialog);
            await dialog.getByRole("button", { exact: true, name: "取消" }).click();
        }
        await page.setViewportSize({ height: 812, width: 375 });
        const nodes = pool
            .locator(".pool-card")
            .filter({ has: page.getByRole("heading", { exact: true, name: "代理节点" }) });
        const subscriptions = pool
            .locator(".pool-card")
            .filter({ has: page.getByRole("heading", { exact: true, name: "订阅（手动刷新）" }) });
        const bindings = pool
            .locator(".pool-card")
            .filter({ has: page.getByRole("heading", { exact: true, name: "账号出口" }) });
        await nodes.locator(".mobile-item .el-checkbox").click();
        assert.equal(await nodes.getByRole("button", { exact: true, name: "删除选中" }).isEnabled(), true);
        await nodes.locator(".mobile-item").getByRole("button", { exact: true, name: "测试" }).click();
        await nodes.locator(".mobile-item").getByRole("button", { exact: true, name: "编辑" }).click();
        await assertDialogFits(page.getByRole("dialog", { exact: true, name: "编辑节点" }));
        await page.getByRole("dialog").getByRole("button", { exact: true, name: "保存" }).click();
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        await nodes.getByRole("button", { exact: true, name: "批量导入" }).click();
        const importing = page.getByRole("dialog", { exact: true, name: "批量导入分享链接 / Clash / Base64" });
        await importing.getByRole("textbox").fill("socks5://example.com:1080");
        await assertFits();
        await importing.getByRole("button", { exact: true, name: "预览" }).click();
        await importing.getByRole("button", { exact: true, name: "导入" }).click();
        await importing.waitFor({ state: "hidden" });
        await subscriptions.getByRole("button", { exact: true, name: "添加订阅" }).click();
        const subscription = page.getByRole("dialog", { exact: true, name: "添加订阅" });
        await assertDialogFits(subscription);
        await subscription.getByPlaceholder("名称").fill("Subscription");
        await subscription.getByPlaceholder("https://...").fill("https://example.com/masked");
        await subscription.getByRole("button", { exact: true, name: "保存" }).click();
        await subscription.waitFor({ state: "hidden" });
        await subscriptions.locator(".mobile-item .el-checkbox").click();
        await subscriptions.locator(".mobile-item").getByRole("button", { exact: true, name: "刷新" }).click();
        await bindings.locator(".mobile-item .el-checkbox").click();
        assert.equal(await bindings.getByRole("button", { exact: true, name: "保存选中绑定" }).isEnabled(), true);
        await bindings.locator(".mobile-item").getByRole("button", { exact: true, name: "保存绑定" }).click();
        await bindings.locator(".mobile-item").getByRole("button", { exact: true, name: "应用" }).click();
        await pool.getByRole("button", { exact: true, name: "保存节点池设置" }).click();
        await nodes.locator(".mobile-item .el-checkbox").click();
        await nodes.getByRole("button", { exact: true, name: "删除选中" }).click();
        await page.locator(".el-message-box__btns button").last().click();
        await subscriptions.locator(".mobile-item .el-checkbox").click();
        await subscriptions.getByRole("button", { exact: true, name: "删除选中" }).click();
        await page.locator(".el-message-box__btns button").last().click();
        // Also check the account-page parent container used by the existing sidebar flow.
        await page.goto(`${url}/accounts`);
        await page.locator('button[title="节点池"]').click();
        await pool.waitFor();
        await assertFits();
        await page.screenshot({ fullPage: true, path: "/tmp/proxy-pool-mobile.png" });
        assert.ok(writes.some(write => write.path.endsWith("/test")));
        assert.ok(writes.some(write => write.method === "PUT" && write.path.endsWith("/nodes/node")));
        assert.ok(writes.some(write => write.path.endsWith("/subscriptions/sub/refresh")));
        assert.ok(writes.some(write => write.path.endsWith("/bindings/account/apply")));
        assert.deepEqual(errors, []);
    }
);

test(
    "filtered all-selection exports every matching page, survives layouts, and protects existing imports",
    { skip: !fs.existsSync(chromium.executablePath()) },
    async t => {
        const { page, url } = await browserFixture(t);
        const accounts = Array.from({ length: 250 }, (_, index) => ({
            accountId: `matching-${index}`,
            authIndex: index,
            autoRecovery: false,
            credentialVersion: 1,
            email: `selection${index}@example.com`,
            hasPassword: true,
            hasRecoveryEmail: true,
            hasTotpSecret: true,
            recoveryState: "idle",
            sessionState: index % 2 ? "expired" : "valid",
        }));
        const downloads = [],
            imports = [],
            errors = [];
        await page.addInitScript(() => {
            window.__selectionTestIntervals = [];
            const schedule = window.setInterval;
            window.setInterval = (...args) => {
                const id = schedule(...args);
                window.__selectionTestIntervals.push(id);
                return id;
            };
        });
        let releaseSelection;
        let delaySelection = false;
        let failSelection = false;
        page.on("pageerror", cause => errors.push(cause.message));
        await page.route("**/api/**", async route => {
            const request = route.request();
            const u = new URL(request.url());
            const search = u.searchParams.get("search") || "";
            const state = u.searchParams.get("state") || "";
            const matches = accounts.filter(
                row => row.email.includes(search) && (!state || row.sessionState === state)
            );
            let result = {};
            if (u.pathname === "/api/status" || u.pathname === "/api/status/core")
                result = { status: { accountDetails: [], currentAuthIndex: -1 } };
            else if (u.pathname.endsWith("/login-queue"))
                result = {
                    autoRecovery: false,
                    concurrency: 1,
                    executions: [],
                    source: "long-queue-source-".repeat(20),
                };
            else if (u.pathname.endsWith("/accounts/selection")) {
                if (delaySelection)
                    await new Promise(resolve => {
                        releaseSelection = resolve;
                    });
                if (failSelection)
                    return route.fulfill({ json: { error: "Selection temporarily unavailable" }, status: 503 });
                result = { accounts: matches, total: matches.length };
            } else if (u.pathname === "/api/account-management/accounts") {
                const cursor = Number(u.searchParams.get("page"));
                const size = Number(u.searchParams.get("pageSize"));
                result = { accounts: matches.slice((cursor - 1) * size, cursor * size), total: matches.length };
            } else if (u.pathname.endsWith("/export/bundle")) {
                downloads.push(request.postDataJSON().accountIds);
                return route.fulfill({ body: Buffer.from("synthetic-download"), contentType: "application/zip" });
            } else if (u.pathname.endsWith("/credentials")) result = { credentialVersion: 1 };
            else if (u.pathname.endsWith("/import/preview"))
                result = {
                    complete: true,
                    previewId: "protected-preview",
                    rows: [
                        { accountId: null, email: "new@example.com", index: 0 },
                        {
                            accountId: "matching-0",
                            conflict: true,
                            email: "selection0@example.com",
                            hasRecoveryEmail: true,
                            index: 1,
                        },
                    ],
                };
            else if (u.pathname.endsWith("/import/commit")) {
                imports.push(request.postDataJSON());
                result = { created: 1, failed: 0, skipped: 1, updated: 0 };
            }
            await route.fulfill({ json: result });
        });
        await page.goto(`${url}/accounts`);
        const toolbar = page.locator(".batch-toolbar");
        const selectAll = page.getByRole("button", { exact: true, name: "Select all" });
        const waitSelected = count =>
            page.waitForFunction(
                expected => document.querySelector(".batch-toolbar")?.textContent.includes(`Selected ${expected} `),
                count
            );
        await selectAll.click();
        await waitSelected(250);
        await page.evaluate(() => {
            for (const id of window.__selectionTestIntervals) clearInterval(id);
        });
        await Promise.all([
            page.waitForResponse(response => response.url().endsWith("/export/bundle")),
            page.getByRole("button", { exact: true, name: "Download selected" }).click(),
        ]);
        assert.equal(downloads[0].length, 250);
        assert.equal(new Set(downloads[0]).size, 250);
        const headerCheckbox = page.locator(".account-table-scroll .el-table__header-wrapper .el-checkbox");
        await headerCheckbox.click();
        await waitSelected(230);
        await page.locator(".accounts-panel > .el-pagination").getByLabel("Go to next page").click();
        await page.waitForFunction(() =>
            document.querySelector(".account-table-scroll tbody")?.textContent.includes("selection20@example.com")
        );
        assert.equal(
            await page.locator(".account-table-scroll tbody tr").first().getByRole("checkbox").isChecked(),
            true
        );
        const searchInput = page.getByPlaceholder("Search email / account index");
        await searchInput.fill("selection1");
        await waitSelected(0);
        await selectAll.click();
        await waitSelected(111);
        const filter = page.locator(".accounts-panel > .account-toolbar .el-select");
        await filter.click();
        await page.getByRole("option", { exact: true, name: "Valid" }).click();
        await waitSelected(0);
        await selectAll.click();
        const expected = accounts.filter(row => row.email.includes("selection1") && row.sessionState === "valid");
        await waitSelected(expected.length);
        await Promise.all([
            page.waitForResponse(response => response.url().endsWith("/export/bundle")),
            page.getByRole("button", { exact: true, name: "Download selected" }).click(),
        ]);
        assert.deepEqual(
            downloads[1],
            expected.map(row => row.accountId)
        );
        failSelection = true;
        await selectAll.click();
        await page.getByText("Selection temporarily unavailable", { exact: true }).waitFor();
        assert.match(await toolbar.innerText(), new RegExp(`Selected ${expected.length}`));
        // Let the expected error notification close before hovering controls beneath it;
        // hovering the floating message pauses its close timer.
        await page.getByText("Selection temporarily unavailable", { exact: true }).waitFor({ state: "hidden" });
        failSelection = false;
        delaySelection = true;
        await Promise.all([
            page.waitForRequest(request => request.url().includes("/accounts/selection")),
            selectAll.click(),
        ]);
        await page.getByRole("button", { exact: true, name: "Clear selection" }).click();
        releaseSelection();
        delaySelection = false;
        await selectAll.waitFor({ state: "visible" });
        await waitSelected(0);
        // Clear filters and select again before exercising the mobile views.
        await searchInput.fill("");
        await filter.hover();
        await filter.locator(".el-select__clear").click();
        await selectAll.click();
        await waitSelected(250);
        for (const width of [320, 375, 390, 430, 768, 1280]) {
            await page.setViewportSize({ height: 850, width });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
            assert.equal(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
                true,
                `page overflow at ${width}`
            );
            assert.match(await toolbar.innerText(), /Selected 250/);
            if (width <= 768) {
                const card = page.locator(".account-mobile-card").first();
                await card.waitFor({ state: "visible" });
                for (const name of ["Edit credentials", "Log in", "Download", "Tasks / logs", "Delete"])
                    assert.equal(await card.getByRole("button", { exact: true, name }).isVisible(), true);
                assert.equal(await card.getByRole("checkbox").first().isChecked(), true);
            }
        }
        await page.setViewportSize({ height: 850, width: 390 });
        const card = page.locator(".account-mobile-card").first();
        await card.locator(".el-checkbox").first().click();
        await waitSelected(249);
        await card.getByRole("button", { exact: true, name: "Edit credentials" }).click();
        const edit = page.getByRole("dialog", { exact: true, name: "Edit credentials" });
        await edit.waitFor();
        const editBox = await edit.boundingBox();
        assert.ok(editBox.x >= 0 && editBox.x + editBox.width <= 390);
        await edit.locator(".el-dialog__headerbtn").click();
        await page.getByRole("button", { exact: true, name: "Import credentials / authenticator" }).click();
        const dialog = page.getByRole("dialog", { exact: true, name: "Import preview" });
        const protection = dialog.getByRole("checkbox", { exact: true, name: "Skip existing accounts" });
        assert.equal(await protection.isChecked(), true);
        await dialog.getByRole("button", { exact: true, name: "Preview" }).click();
        const existingRow = dialog.locator(".import-mobile-list .account-mobile-card").nth(1);
        await existingRow.getByText("Existing account skipped", { exact: true }).waitFor();
        assert.equal(await existingRow.getByRole("checkbox", { exact: true, name: "Skip" }).isChecked(), true);
        assert.equal(await existingRow.getByRole("checkbox", { exact: true, name: "Overwrite" }).isDisabled(), true);
        assert.equal(await dialog.getByRole("checkbox", { exact: true, name: "Overwrite all" }).isDisabled(), true);
        await dialog.getByText("Skip existing accounts", { exact: true }).click();
        assert.equal(await existingRow.getByRole("checkbox", { exact: true, name: "Skip" }).isChecked(), false);
        await existingRow.getByText("Overwrite", { exact: true }).click();
        await dialog.getByText("Skip existing accounts", { exact: true }).click();
        await existingRow.getByText("Import includes recovery email", { exact: true }).waitFor();
        const notesBox = await existingRow.locator(".import-row-notes").boundingBox();
        const actionsBox = await existingRow.locator(".import-row-actions").boundingBox();
        assert.ok(notesBox.y >= actionsBox.y + actionsBox.height);
        await page.screenshot({ path: "/tmp/accounts-mobile-import-preview.png" });
        await dialog.getByRole("button", { exact: true, name: "Commit import" }).click();
        await dialog.locator(".import-result").waitFor();
        assert.equal(imports[0].skipExisting, true);
        assert.deepEqual(
            imports[0].rows.map(row => row.skip),
            [false, true]
        );
        assert.deepEqual(errors, []);
    }
);

test(
    "account tier editing and single/batch benefit checks work on desktop and mobile",
    { skip: !fs.existsSync(chromium.executablePath()) },
    async t => {
        const { resolveTier } = require("../src/accounts/AccountTierPolicy");
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
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const account = {
            accountId: "tier-account",
            authIndex: 0,
            autoRecovery: false,
            benefitLastCheck: { checkedAt: Date.now(), status: "succeeded" },
            benefitObservation: {
                observedAt: Date.now(),
                rawTier: null,
                sessionVersion: 2,
                source: "query",
                state: "ready-free",
            },
            credentialVersion: 1,
            displayName: "Cookie account",
            email: null,
            manualTier: "pro",
            sessionState: "valid",
            sessionVersion: 2,
        };
        const tasks = [],
            edits = [],
            submissions = [];
        await page.route("**/locales/*.json", route =>
            route.fulfill({
                body: fs.readFileSync(path.resolve(__dirname, "../ui/locales/en.json"), "utf8"),
                contentType: "application/json",
            })
        );
        await page.route("**/api/**", async route => {
            const req = route.request();
            const url = new URL(req.url());
            let result = {};
            if (url.pathname.startsWith("/api/status"))
                result = { status: { accountDetails: [], currentAuthIndex: -1, schedulingMode: "legacy" } };
            if (url.pathname === "/api/account-management/login-queue")
                result = { attemptTimeout: 180000, autoRecovery: false, concurrency: 1 };
            if (
                ["/api/account-management/accounts", "/api/account-management/accounts/selection"].includes(
                    url.pathname
                )
            )
                result = {
                    accounts: [{ ...account, benefitTask: tasks.at(-1), tier: resolveTier(account) }],
                    total: 1,
                };
            if (url.pathname.endsWith("/credentials") && req.method() === "PATCH") {
                const input = req.postDataJSON();
                edits.push(input);
                account.manualTier = input.manualTier;
                result = { ...account, tier: resolveTier(account) };
            }
            if (url.pathname === "/api/account-management/benefit-checks") {
                if (req.method() === "POST") {
                    const input = req.postDataJSON();
                    submissions.push(input);
                    if (!tasks.length)
                        tasks.push({ accountId: account.accountId, authIndex: 0, status: "queued", taskId: "check-1" });
                    result = { results: [{ accountId: account.accountId, status: "queued", taskId: "check-1" }] };
                } else result = { tasks };
            }
            if (url.pathname === "/api/account-management/benefit-checks/cancel") {
                tasks[0].status = "cancelled";
                result = { cancelled: true };
            }
            await route.fulfill({ body: JSON.stringify(result), contentType: "application/json" });
        });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/accounts`);
        await page.getByRole("button", { exact: true, name: "Edit credentials" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByText("Raw benefits (read-only): Free", { exact: true }).waitFor();
        await dialog.locator(".el-select__wrapper").click();
        await page.getByRole("option", { exact: true, name: "Free" }).click();
        await dialog.getByText("Effective tier: Free", { exact: true }).waitFor();
        await dialog.getByRole("button", { exact: true, name: "Save" }).click();
        await dialog.waitFor({ state: "hidden" });
        assert.equal(edits[0].manualTier, "free");
        assert.equal(edits[0].email, undefined);
        assert.equal(edits[0].password, undefined);
        assert.equal(edits[0].benefitObservation, undefined);
        await page.getByRole("button", { exact: true, name: "Edit credentials" }).click();
        await dialog.locator(".el-select__wrapper").click();
        await page.getByRole("option", { exact: true, name: "Unset (follow detected benefits)" }).click();
        await dialog.getByRole("button", { exact: true, name: "Save" }).click();
        await page.getByRole("button", { exact: true, name: "Check paid benefits" }).click();
        assert.deepEqual(submissions[0].accountIds, ["tier-account"]);
        await page.getByRole("button", { exact: true, name: "Select all" }).click();
        await page.getByRole("button", { exact: true, name: "Check selected benefits" }).click();
        await page.getByRole("button", { exact: true, name: "Cancel selected checks" }).click();
        assert.equal(edits[1].manualTier, null);
        assert.equal(submissions.length, 2);
        assert.equal(tasks[0].status, "cancelled");
        await page.setViewportSize({ height: 800, width: 375 });
        await page.getByRole("button", { exact: true, name: "Check paid benefits" }).waitFor();
        await page.getByRole("button", { exact: true, name: "Edit credentials" }).waitFor();
        assert.deepEqual(errors, []);
    }
);
