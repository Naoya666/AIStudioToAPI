/* eslint-env browser, node */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");

// Synthetic runtime and restart responses; no application restart or external requests.
test("runtime panel handles mobile layout, stale data and verified restarts", { timeout: 30000 }, async t => {
    const { createServer } = await import("vite");
    const vue = require("@vitejs/plugin-vue");
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="app"></div>
<script type="module">
import {createApp, reactive, h} from 'vue';
import RuntimeStatus from '/ui/app/components/RuntimeStatus.vue';
import zh from '/ui/locales/zh.json';
import '/node_modules/element-plus/dist/index.css';
import '/ui/app/styles/variables.less';
window.fixture = reactive({unavailable:false, data:{application:{pid:123,restartAvailable:true,restarting:false,rssBytes:123456789,state:'running',uptimeSeconds:3661},backend:{kind:'local',recoveryAttempts:0,restarts:2,state:'running'},scheduler:{active:2,queued:3,state:'running'},contextPool:{ready:2,initializing:1,staleInitializing:0},memory:{usedBytes:200000000,limitBytes:1000000000,limitKnown:true}}});
createApp({setup:()=>()=>h(RuntimeStatus,{data:window.fixture.data,unavailable:window.fixture.unavailable,t:key=>zh[key]||key})}).mount('#app');
</script></body></html>`;
    const server = await createServer({
        configFile: false,
        plugins: [
            vue(),
            {
                configureServer(server) {
                    server.middlewares.use(async (req, res, next) => {
                        if (req.url !== "/runtime-fixture.html") return next();
                        res.setHeader("Content-Type", "text/html");
                        res.end(await server.transformIndexHtml(req.url, html));
                    });
                },
                name: "runtime-fixture",
            },
        ],
        root: path.resolve(__dirname, ".."),
        server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { height: 900, width: 390 } });
    page.setDefaultTimeout(6000);
    const errors = [];
    t.after(() => {
        if (errors.length) t.diagnostic(errors.join("\n"));
    });
    page.on("pageerror", error => errors.push(error.message));
    let posted = 0;
    let failed = false;
    await page.route("**/api/configuration**", async route => {
        if (route.request().method() === "POST") {
            posted++;
            assert.equal(route.request().postDataJSON().version, 7);
            return route.fulfill({ json: { instanceId: "old", version: 7 } });
        }
        return route.fulfill({
            json: {
                instanceId: posted ? "new" : "old",
                operational: true,
                pending: [],
                ready: true,
                restartError: failed ? "fixture recovery failure" : null,
                version: 7,
            },
        });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/runtime-fixture.html`);
    await page.getByRole("heading", { name: "服务运行情况" }).waitFor();
    assert.match(await page.locator(".runtime-list").innerText(), /117.7 MiB/);
    assert.equal(await page.getByRole("progressbar").count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.evaluate(() => {
        window.fixture.unavailable = true;
    });
    await page.getByRole("alert").waitFor();
    assert.equal(await page.locator(".runtime-list").count(), 0);
    assert.equal(await page.locator(".runtime-status").getByRole("button", { name: "重启应用" }).isDisabled(), true);
    await page.evaluate(() => {
        window.fixture.unavailable = false;
    });
    await page.locator(".runtime-status").getByRole("button", { exact: true, name: "重启应用" }).click();
    await page.getByRole("button", { exact: true, name: "取消" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(posted, 0);
    await page.locator(".runtime-status").getByRole("button", { exact: true, name: "重启应用" }).click();
    await page.getByRole("dialog").getByRole("button", { exact: true, name: "重启应用" }).click();
    await page.getByText("应用重启成功，已确认新实例就绪且保存配置已生效。", { exact: true }).waitFor();
    assert.equal(posted, 1);
    failed = true;
    await page.locator(".runtime-status").getByRole("button", { exact: true, name: "重启应用" }).click();
    await page.getByRole("dialog").getByRole("button", { exact: true, name: "重启应用" }).click();
    await page.getByRole("alert").filter({ hasText: "fixture recovery failure" }).waitFor();
    await page.evaluate(() => {
        window.fixture.data.application.restartAvailable = false;
    });
    assert.equal(
        await page.locator(".runtime-status").getByRole("button", { exact: true, name: "重启应用" }).isDisabled(),
        true
    );
    assert.deepEqual(errors, []);
});
