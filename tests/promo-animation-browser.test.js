/* eslint-env browser, node */
// Real Firefox, synthetic responses only; no Google traffic or credentials.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { firefox } = require("playwright");
const { installPromoAnimationPause } = require("../src/core/PromoAnimationPause");
const card =
    '<button class="promo-card-wrapper ng-star-inserted xap-tour-element-active" onclick="this.dataset.clicked = 1">Promo</button>';
const fixture = `<!doctype html><html><head><style>
    @keyframes rotate-promo-card-border { to { transform: rotate(360deg); } }
    .promo-card-wrapper { display: block; position: relative; width: 160px; height: 80px;
        background: lightblue; border: 2px solid blue;
        animation: rotate-promo-card-border 40s linear infinite; }
    .promo-card-wrapper::before, .promo-card-wrapper::after {
        content: ''; position: absolute; width: 10px; height: 10px; background: red;
        animation: rotate-promo-card-border 40s linear infinite; }
    #unrelated { animation: rotate-promo-card-border 40s linear infinite; }
    </style></head><body><div id="unrelated">Other animation</div>
    <script>window.timerTicks = 0; setInterval(() => window.timerTicks++, 20);</script></body></html>`;

async function inspect(page) {
    return page.evaluate(() => {
        const card = document.querySelector(".promo-card-wrapper");
        const rect = card?.getBoundingClientRect();
        return {
            animations: card?.getAnimations({ subtree: true }).map(a => ({ state: a.playState, time: a.currentTime })),
            background: card && getComputedStyle(card).backgroundColor,
            border: card && getComputedStyle(card).borderTopWidth,
            height: rect?.height,
            styles: document.querySelectorAll("#aistudio-promo-animation-pause").length,
            unrelated: document
                .querySelector("#unrelated")
                .getAnimations()
                .map(a => a.playState),
            width: rect?.width,
        };
    });
}

async function checkCard(page) {
    await page.locator(".promo-card-wrapper").waitFor();
    const before = await inspect(page);
    assert.equal(before.styles, 1);
    assert.equal(before.animations.length, 3, "card and both pseudo-elements animate");
    assert.ok(before.animations.every(a => a.state === "paused"));
    assert.deepEqual(before.unrelated, ["running"]);
    assert.equal(before.background, "rgb(173, 216, 230)");
    assert.equal(before.border, "2px");
    const ticks = await page.evaluate(() => window.timerTicks);
    await page.waitForFunction(previous => window.timerTicks > previous + 5, ticks);
    const after = await inspect(page);
    assert.deepEqual(after.animations, before.animations, "paused timelines do not advance");
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);
    await page.locator(".promo-card-wrapper").click();
    assert.equal(await page.locator(".promo-card-wrapper").getAttribute("data-clicked"), "1");
}

test(
    "Firefox pauses only promo decorations across SPA insertion, navigation and contexts",
    { timeout: 30000 },
    async t => {
        const browser = await firefox.launch({ headless: true });
        t.after(() => browser.close());
        const createContext = async () => {
            const context = await browser.newContext();
            await context.route("**/*", route => {
                const url = new URL(route.request().url());
                const body = fixture.replace("</body>", `${url.pathname === "/delayed" ? "" : card}</body>`);
                return route.fulfill({ body, contentType: "text/html" });
            });
            await context.addInitScript(installPromoAnimationPause);
            return context;
        };
        const context = await createContext();
        const page = await context.newPage();
        await page.goto("https://aistudio.google.com/initial");
        await checkCard(page);
        await page.evaluate(installPromoAnimationPause); // Already-ready document, idempotent.
        assert.equal((await inspect(page)).styles, 1);
        await page.reload();
        await checkCard(page);
        await page.goto("https://aistudio.google.com/delayed");
        assert.equal((await inspect(page)).animations, undefined);
        await page.evaluate(html => setTimeout(() => document.body.insertAdjacentHTML("beforeend", html), 30), card);
        await checkCard(page);

        // Both same-origin and cross-origin child frames remain untouched.
        await page.evaluate(() => {
            for (const host of ["aistudio.google.com", "example.com"]) {
                const frame = document.createElement("iframe");
                frame.src = `https://${host}/frame`;
                document.body.appendChild(frame);
            }
        });
        await page.waitForFunction(() => [...document.querySelectorAll("iframe")].every(f => f.contentWindow));
        for (const frame of page.frames().filter(f => f !== page.mainFrame())) {
            await frame.waitForSelector(".promo-card-wrapper");
            const state = await inspect(frame);
            assert.equal(state.styles, 0);
            assert.ok(state.animations.every(a => a.state === "running"));
        }
        assert.equal(page.frames().length, 3);
        await page.goto("https://example.com/other");
        assert.equal((await inspect(page)).styles, 0);
        assert.ok((await inspect(page)).animations.every(a => a.state === "running"));
        await page.goto("https://aistudio.google.com/return");
        await checkCard(page);
        await context.close();
        const replacement = await createContext();
        const replacementPage = await replacement.newPage();
        await replacementPage.goto("https://aistudio.google.com/recreated");
        await checkCard(replacementPage);
        await replacement.close();
    }
);
