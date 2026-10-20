/* eslint-env browser */
// Optional DOM integration against the deployed browser; every HTTP request is
// fulfilled locally, and only synthetic credentials are used.
const test = require("node:test");
const assert = require("node:assert/strict");
const { firefox } = require("playwright");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const Totp = require("../src/accounts/TotpService");
const workerPath = path.join(__dirname, "../src/accounts/AccountLoginWorker.js");
const workerRequire = createRequire(workerPath);
const executablePath = process.env.ACCOUNT_LOGIN_BROWSER_TEST_EXECUTABLE;

async function run(options = {}) {
    let browser,
        contextsCreated = 0;
    const processMock = new EventEmitter();
    processMock.connected = true;
    let resolveResult, pendingResult;
    const results = [],
        phases = [];
    const result = new Promise(resolve => {
        resolveResult = resolve;
    });
    processMock.send = message => {
        if (message.phase) phases.push(message.phase);
        if (message.result) pendingResult = message.result;
        if (message.cleaned || message.cleanupFailed) {
            results.push(pendingResult);
            resolveResult(pendingResult);
        }
    };
    const mockPlaywright = {
        firefox: {
            launch: async launchOptions => {
                browser = await firefox.launch({ ...launchOptions, executablePath });
                const original = browser.newContext.bind(browser);
                browser.newContext = async contextOptions => {
                    assert.equal(browser.contexts().length, 0, "previous context must close before creating the next");
                    const validationContext = contextsCreated++ % 2 === 1;
                    const context = await original(contextOptions);
                    if (!validationContext) {
                        assert.equal((await context.cookies()).length, 0, "each login starts without previous cookies");
                        await context.addCookies([
                            {
                                domain: "accounts.google.com",
                                name: "previous-attempt",
                                path: "/",
                                value: String(contextsCreated),
                            },
                        ]);
                    }
                    const htmlFor = address => {
                        const url = new URL(address);
                        let html;
                        if (url.pathname.includes("ServiceLogin"))
                            html =
                                "<input id=\"identifierId\" type=\"text\"><button onclick=\"if(document.querySelector('input').value==='user@example.com')location.href='/password'\">Next</button>";
                        else if (url.pathname === "/password")
                            html = `<input type="password"><button onclick="if(document.querySelector('input').value==='synthetic')location.href='${options.directAfterEmail ? "/totp" : options.recovery ? "/recovery" : options.noTotp ? "https://aistudio.google.com/prompts/new" : options.directTotp ? "/totp" : "/security"}'">Next</button>`;
                        else if (url.pathname === "/choice")
                            html = `<p>Choose how to sign in: Google Authenticator</p><input type="text" oninput="location.href='https://untrusted.example/'"><button role="link" data-challengetype="6" onclick="location.href='/totp'">Authenticator</button>`;
                        else if (url.pathname === "/recovery")
                            html = `<p>Confirm your recovery email</p><input name="knowledgePreregisteredEmailResponse"><button onclick="${options.wrongRecovery ? "document.querySelector('p').textContent='Incorrect recovery email'" : "if(document.querySelector('input').value==='recover@example.com')location.href='https://aistudio.google.com/prompts/new'"}">Next</button>`;
                        else if (url.pathname === "/security")
                            html =
                                '<p>Get your security code at g.co/sc</p><p>Google Authenticator is another option</p><div data-challengetype="13" role="link"><input id="securityKeyOtpInputId" type="tel"></div><button onclick="setTimeout(()=>location.href=\'/totp\',100)">Try another way</button>';
                        else if (url.pathname === "/totp" && options.split)
                            html = `<p>Google Authenticator</p>${Array.from({ length: options.split }, (_, index) => `<input type="tel" maxlength="1" ${options.autoSubmit && index === 5 ? `oninput="if([...document.querySelectorAll('input')].every(n=>n.value))location.href='https://aistudio.google.com/prompts/new'"` : ""}>`).join("")}<button onclick="if([...document.querySelectorAll('input')].every(n=>/^\\d$/.test(n.value)))location.href='https://aistudio.google.com/prompts/new'">Next</button>`;
                        else if (url.pathname === "/totp")
                            html = `<p>Get a verification code from the Google Authenticator app</p><input type="hidden" name="totpPin"><input id="newAuthenticatorCode" type="${options.codeType || "text"}" autocomplete="off"><button onclick="if(/^\\d{6}$/.test(document.getElementById('newAuthenticatorCode').value))location.href='https://aistudio.google.com/prompts/new'">Next</button>`;
                        else if (url.hostname === "aistudio.google.com" && !url.pathname.startsWith("/apps/"))
                            html =
                                options.terms || (options.finalTerms && validationContext)
                                    ? `<button aria-label="Google Account: user@example.com">Account</button><label><input id="unrelated" type="checkbox">Optional unrelated</label><button onclick="throw Error('unrelated clicked')">Continue</button><div role="dialog"><h2>AI Studio ${options.chinese ? "服务条款" : "Terms of service"}</h2>${options.aria ? `<div style="width:20px;height:20px" role="checkbox" aria-required="true" aria-checked="false" aria-label="I agree to the terms of service" onclick="this.setAttribute('aria-checked','true');document.getElementById('accept').disabled=false"></div>` : `<label><input type="checkbox" ${options.checked ? "checked" : ""} onchange="document.getElementById('accept').disabled=false">I agree to the terms of service</label>`}<label><input id="marketing" type="checkbox">Email newsletter updates</label><button aria-label="Continue to Google AI Studio after accepting terms" id="accept" ${options.checked ? "" : "disabled"} onclick="if(document.getElementById('marketing').checked || document.getElementById('unrelated').checked)throw Error('optional selected');document.cookie='termsAccepted=1;path=/';this.parentNode.remove();document.body.insertAdjacentHTML('beforeend','<textarea></textarea>')">${options.chinese ? "同意" : "I agree"}</button></div>`
                                    : options.permissionRequired
                                      ? "<p>Allow Drive access</p><button>Allow access</button>"
                                      : options.bootstrapIdentity
                                        ? '<script>var WIZ_global_data={"oPEP7c":"user@example.com"};</script><textarea placeholder="Prompt"></textarea>'
                                        : `<button aria-label="Google Account: ${options.mismatch ? "other@example.com" : "user@example.com"}">Account</button><textarea aria-label="Prompt"></textarea>`;
                        else if (url.hostname === "ai.studio" || url.pathname.startsWith("/apps/")) {
                            if (options.frameKind) {
                                const child =
                                    '<!doctype html><script>window.addEventListener("message", e=>{if(e.data?.type==="authIndexResponse" && e.data.authIndex===0)new WebSocket("ws://127.0.0.1:9998?authIndex=0")});parent.postMessage({type:"requestAuthIndex"},"*");<' +
                                    "/script>";
                                const encoded = JSON.stringify(child).replaceAll("</script>", "<\\/script>");
                                html = `<script>const frame=document.createElement('iframe');document.body.append(frame);${options.frameKind === "blob" ? `frame.src=URL.createObjectURL(new Blob([${encoded}],{type:'text/html'}))` : options.frameKind === "attribute" ? `frame.setAttribute('srcdoc',${encoded})` : `frame.srcdoc=${encoded}`};</script>`;
                            } else
                                html = options.consoleOnly
                                    ? '<script>console.log("[ProxyClient] Connection successful")</script>'
                                    : options.appFailure
                                      ? "<p>Failed to initialize applet</p>"
                                      : '<script>new WebSocket("ws://127.0.0.1:9998?authIndex=0")</script>';
                        } else html = "Unexpected request";
                        if (
                            options.delayedTerms &&
                            url.hostname === "aistudio.google.com" &&
                            !url.pathname.startsWith("/apps/")
                        )
                            html =
                                "<textarea></textarea>" +
                                html.replace(
                                    '<div role="dialog">',
                                    '<div role="dialog" style="display:none" id="late-terms">'
                                ) +
                                '<script>setTimeout(()=>document.getElementById("late-terms").style.display="block",700)</script>';
                        if (url.pathname === "/address")
                            html = `<main><h1>${options.addressTitle || "Set your home address"}</h1><input aria-label="Home address"><button onclick="${options.addressStuck ? "void 0" : `setTimeout(()=>location.href='${options.profilePhoto ? "/profile-photo" : "https://aistudio.google.com/prompts/new"}',200)`}">${options.addressChinese ? "跳过" : "Skip"}</button><button onclick="location.href='https://untrusted.example/'">Save</button></main>`;
                        if (url.pathname === "/profile-photo")
                            html = `<main><h1>${options.photoChinese ? "添加个人资料照片" : "Add a profile picture"}</h1><button onclick="${options.photoStuck ? "void 0" : "setTimeout(()=>location.href='https://aistudio.google.com/prompts/new',200)"}">${options.photoChinese ? "跳过" : "Skip"}</button><button onclick="location.href='https://untrusted.example/'">Add profile picture</button></main>`;
                        if (url.pathname === "/totp" && (options.bounceSubmit || options.bounceInput)) {
                            const bounce =
                                "if(!document.cookie.includes('bounced=1')){document.cookie='bounced=1;path=/';location.href='/choice'}";
                            if (options.bounceSubmit) html = html.replace('onclick="if(', `onclick="${bounce}else if(`);
                            else
                                html = html.replace(
                                    'id="newAuthenticatorCode"',
                                    `id="newAuthenticatorCode" oninput="${bounce}"`
                                );
                        }
                        if (url.pathname === "/totp" && options.autoSubmitDelayed)
                            html = html.replace(
                                'id="newAuthenticatorCode"',
                                'id="newAuthenticatorCode" oninput="if(this.value.length===6)setTimeout(()=>location.href=\'https://aistudio.google.com/prompts/new\',300)"'
                            );
                        if (options.directAfterEmail && url.pathname.includes("ServiceLogin"))
                            html = html.replace("/password", "/totp");
                        if (options.upgrade && url.hostname === "aistudio.google.com")
                            html = html.replace(
                                '<textarea aria-label="Prompt"></textarea>',
                                "<p>Upgrade to unlock Gemini 3 Flash Preview</p>"
                            );
                        if (options.studioDialog && url.hostname === "aistudio.google.com")
                            html += options.studioDialog;
                        if (
                            options.finalDialog &&
                            validationContext &&
                            url.hostname === "aistudio.google.com" &&
                            !url.pathname.startsWith("/apps/")
                        )
                            html += options.finalDialog;
                        if (options.address && ["/password", "/totp"].includes(url.pathname))
                            html = html.replaceAll("https://aistudio.google.com/prompts/new", "/address");
                        return `<!doctype html><html><head><meta charset="utf-8"></head><body><main>${html}</main></body></html>`;
                    };
                    const originalRoute = context.route.bind(context);
                    await originalRoute("**/*", async route => {
                        await route.fulfill({
                            body: htmlFor(route.request().url()),
                            contentType: "text/html",
                        });
                    });
                    return context;
                };
                return browser;
            },
        },
    };
    const vm = require("node:vm");
    vm.runInNewContext(
        fs.readFileSync(workerPath, "utf8"),
        {
            Date,
            process: processMock,
            require: name =>
                name === "playwright"
                    ? mockPlaywright
                    : name === "./LoginPageHandlers" && (options.lateStudioDialog || options.onStudioObservation)
                      ? class extends workerRequire(name) {
                            async terms(...args) {
                                const result = await super.terms(...args);
                                if (options.lateStudioDialog && !this.inserted) {
                                    // The legacy hint scan sees no dialogs. Insert
                                    // at a fixed boundary before business classification.
                                    assert.equal(await super.transition(...args), false);
                                    this.inserted = true;
                                    await this.page.evaluate(
                                        html => document.body.insertAdjacentHTML("beforeend", html),
                                        options.lateStudioDialog
                                    );
                                }
                                return result;
                            }
                            async observeStudioDialogs(...args) {
                                if (this.observationPage !== this.page) {
                                    this.observationPage = this.page;
                                    this.observations = 0;
                                }
                                this.observations++;
                                await options.onStudioObservation?.(this.page, this.observations);
                                return super.observeStudioDialogs(...args);
                            }
                        }
                      : workerRequire(name),
            setTimeout,
            URL,
        },
        { filename: workerPath }
    );
    const input = {
        config: {
            attemptTimeout: options.attemptTimeout || 90000,
            humanize: options.fast !== true,
            screenshotTimeout: 1000,
            stepTimeout: options.stepTimeout || 10000,
        },
        credentials: {
            email: "user@example.com",
            password: "synthetic",
            recoveryEmail: options.missingRecovery ? null : "recover@example.com",
            totp: Totp.normalize("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"),
        },
        executablePath,
        executorId: "browser-fixture",
        targetUrl: "https://ai.studio/apps/synthetic",
        taskId: "browser-task",
        token: "synthetic",
    };
    processMock.emit("message", input);
    try {
        let last = await result;
        for (let index = 1; index < (options.repetitions || 1); index++) {
            const next = new Promise(resolve => {
                resolveResult = resolve;
            });
            processMock.emit("message", { ...input, taskId: `browser-task-${index}`, token: `browser-token-${index}` });
            last = await next;
        }
        assert.equal(browser.contexts().length, 0, "cleanup acknowledgement leaves no browser contexts");
        if (options.repetitions) {
            assert.equal(contextsCreated, options.repetitions * 2);
            assert.ok(
                results.every(result => result.storageState && result.targetInitialized),
                JSON.stringify(results)
            );
        }
        if (options.address && last.storageState) assert.ok(phases.includes("google_address"));
        if (options.profilePhoto && last.storageState) {
            assert.ok(phases.indexOf("google_address") >= 0);
            assert.ok(phases.indexOf("google_profile_photo") > phases.indexOf("google_address"));
        }
        return last;
    } finally {
        await browser?.close();
    }
}
test(
    "real browser: asynchronous alternative verification, hidden old controls and changed PIN types",
    { skip: !executablePath },
    async () => {
        for (const codeType of ["text", "number", "tel"]) {
            const result = await run({ codeType });
            assert.ok(result.storageState, JSON.stringify(result));
            assert.equal(result.targetInitialized, true);
        }
    }
);
test("real browser: no-two-step success and account/app verification failures", { skip: !executablePath }, async () => {
    assert.ok((await run({ noTotp: true })).storageState);
    assert.ok((await run({ bootstrapIdentity: true, noTotp: true })).storageState);
    assert.equal((await run({ noTotp: true, permissionRequired: true })).error, "service_permission_required");
    assert.equal((await run({ mismatch: true })).error, "account_mismatch");
    assert.equal((await run({ appFailure: true })).error, "service_initialization_failed");
});
test(
    "real browser: dynamically created srcdoc and blob previews stay outside the request pool",
    { skip: !executablePath },
    async () => {
        for (const frameKind of ["srcdoc", "attribute", "blob"]) {
            const result = await run({ frameKind, noTotp: true });
            assert.ok(result.storageState, JSON.stringify(result));
            assert.equal(result.targetInitialized, true);
        }
    }
);

test(
    "real browser: a success console message cannot replace a native connection",
    { skip: !executablePath },
    async () => {
        const result = await run({ consoleOnly: true, noTotp: true });
        assert.equal(result.error, "service_initialization_unverified");
        assert.ok(!result.storageState);
    }
);

test("real browser: first terms leave optional controls untouched", { skip: !executablePath }, async () => {
    for (const options of [{}, { chinese: true }, { aria: true }, { checked: true }]) {
        const result = await run({ ...options, fast: true, noTotp: true, terms: true });
        assert.ok(result.storageState, JSON.stringify({ options, result }));
    }
});
test(
    "real browser: age and business confirmation enables Continue without required metadata",
    { skip: !executablePath },
    async t => {
        for (const label of [
            "I acknowledge that I am at least 18 years old, and that I am a developer using the service for professional or business purposes to build products for users 18+.",
            "我确认我已年满 18 岁，并将服务用于专业或商业用途。",
        ]) {
            const { handler, page } = await handlerFixture(
                t,
                `<div role="dialog">Google AI Studio Terms of Service
            <label><input id="age" type="checkbox" onchange="document.querySelector('button').disabled=!this.checked">${label}</label>
            <label><input id="updates" type="checkbox">Email newsletter updates</label>
            <label><input id="unrelated" type="checkbox">I acknowledge another request</label>
            <button disabled onclick="this.parentNode.hidden=true">Continue</button></div>`
            );
            assert.equal(await handler.terms(), true);
            assert.equal(handler.termsOutcome, "completed");
            assert.equal(await page.locator("#age").isChecked(), true);
            assert.equal(await page.locator("#updates").isChecked(), false);
            assert.equal(await page.locator("#unrelated").isChecked(), false);
        }
    }
);
test("real browser: recovery confirmation and manual failure boundaries", { skip: !executablePath }, async () => {
    assert.ok((await run({ fast: true, recovery: true })).storageState);
    assert.equal((await run({ fast: true, missingRecovery: true, recovery: true })).error, "recovery_email_missing");
    assert.equal((await run({ fast: true, recovery: true, wrongRecovery: true })).error, "recovery_email_rejected");
});
test(
    "real browser: full-page welcome consent is scoped and must contain the age/business gate",
    { skip: !executablePath },
    async t => {
        const { handler, page } = await handlerFixture(
            t,
            `<button onclick="throw Error('outside clicked')">Continue</button>
        <main><div><h1>欢迎使用 Google AI Studio！</h1>
        <label><input id="age" type="checkbox" onchange="document.getElementById('continue').disabled=!this.checked">I acknowledge that I am at least 18 years old, using the service for professional or business purposes.</label>
        <label><input id="marketing" type="checkbox">Email newsletter updates</label>
        <p>Gemini API Additional Terms of Service</p>
        </div><button id="continue" disabled onclick="this.closest('main').remove()">继续<mat-icon>arrow_forward</mat-icon></button></main>`
        );
        assert.equal(await handler.terms(), true);
        assert.equal(handler.termsOutcome, "completed");
        await page.setContent(
            '<main><h1>Welcome to Google AI Studio</h1><p>Terms of Service</p><label><input type="checkbox">Allow other access</label><button>Continue</button></main>'
        );
        assert.equal(await handler.terms(), false);
        assert.equal(await page.locator("input").isChecked(), false);
    }
);
test("real browser: six digit code, automatic submission and ambiguous counts", { skip: !executablePath }, async () => {
    assert.ok((await run({ fast: true, split: 6 })).storageState);
    assert.ok((await run({ autoSubmit: true, fast: true, split: 6 })).storageState);
    assert.equal((await run({ fast: true, split: 5 })).error, "manual_challenge");
});

async function handlerFixture(t, html, child = html) {
    const browser = await firefox.launch({ executablePath, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route("**/*", route =>
        route.fulfill({
            body: `<meta charset="utf-8">${route.request().url().includes("/child") ? child : html}`,
            contentType: "text/html; charset=utf-8",
        })
    );
    await page.goto("https://aistudio.google.com/test");
    const guard = () => {};
    const interaction = new (require("../src/accounts/LoginInteraction"))({
        config: { humanize: false, stepTimeout: 3000 },
        guard,
    });
    const handler = new (require("../src/accounts/LoginPageHandlers"))({
        deadline: performance.now() + 10000,
        guard,
        interaction,
        page,
        phase() {},
        stepTimeout: 3000,
    });
    return { handler, interaction, page };
}
test("real browser: same-service iframe, delayed button and multi-step consent", { skip: !executablePath }, async t => {
    const child = `<div role="dialog"><h2>AI Studio Terms of service</h2><label><input type="checkbox" required checked>Accept terms</label><button disabled onclick="this.parentNode.remove()">Accept</button></div><script>setTimeout(()=>document.querySelector('button').disabled=false,150)</script>`;
    const { handler, page } = await handlerFixture(
        t,
        '<iframe src="https://aistudio.google.com/child"></iframe>',
        child
    );
    await page.frames()[1].waitForLoadState();
    assert.equal(await handler.terms(), true);
    const frame = page.frames()[1];
    assert.equal(await frame.locator('[role="dialog"]').count(), 0);
    await page.route("**/*", route =>
        route.fulfill({
            body: `<div role="dialog"><h2>AI Studio Terms of service</h2><button onclick="if(this.textContent==='Accept'){this.textContent='Continue';this.previousSibling.textContent='Gemini additional terms'}else this.parentNode.remove()">Accept</button></div>`,
            contentType: "text/html; charset=utf-8",
        })
    );
    await page.goto("https://aistudio.google.com/steps");
    assert.equal(await handler.terms(), true);
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
});
test(
    "real browser: unknown and foreign consent stay untouched; summaries use enums",
    { skip: !executablePath },
    async t => {
        const html = `<div role="dialog">Unknown Drive authorization<input type="checkbox"><button>Continue</button></div><iframe src="https://untrusted.example/child"></iframe><input name="private@example.com" id="password-secret" value="recovery@example.com"><button>private@example.com 123456 cookie-secret</button>`;
        const { handler, page } = await handlerFixture(
            t,
            html,
            '<div role="dialog">AI Studio Terms of service<input type="checkbox"><button>I agree</button></div>'
        );
        await page.frames()[1].waitForLoadState();
        assert.equal(await handler.terms(), false);
        assert.equal(await page.locator('input[type="checkbox"]').isChecked(), false);
        const summary = JSON.stringify(await handler.structure());
        for (const secret of [
            "private@example.com",
            "password-secret",
            "recovery@example.com",
            "123456",
            "cookie-secret",
        ])
            assert.equal(summary.includes(secret), false);
    }
);
test(
    "real browser: cancellation and deadlines prevent subsequent consent clicks",
    { skip: !executablePath },
    async t => {
        const html = `<div role="dialog">AI Studio Terms of service<label><input type="checkbox" required>Accept terms</label><button>Accept</button></div>`;
        const { handler, interaction, page } = await handlerFixture(t, html);
        let cancelled = false;
        handler.guard = interaction.guard = () => {
            if (cancelled) throw Object.assign(new Error("cancelled"), { reason: "cancelled" });
        };
        const click = interaction.click.bind(interaction);
        interaction.click = async (...args) => {
            await click(...args);
            cancelled = true;
        };
        await assert.rejects(handler.terms(), { reason: "cancelled" });
        assert.equal(await page.locator('[role="dialog"]').isVisible(), true);
        cancelled = false;
        handler.deadline = performance.now() - 1;
        await assert.rejects(handler.terms(), { reason: "terms_or_consent_required" });
    }
);
test(
    "real browser: known optional onboarding uses Skip and leaves unknown questions untouched",
    { skip: !executablePath },
    async t => {
        const { handler, page } = await handlerFixture(
            t,
            '<main><h1>您为何选择使用 Google AI Studio？</h1><label><input type="checkbox">Use Gemini API</label><button onclick="this.closest(\'main\').remove()">跳过</button><button disabled>继续</button></main>'
        );
        assert.equal(await handler.skipOnboarding(), true);
        assert.equal(await page.locator("main").count(), 0);
        await page.setContent(
            '<main><h1>Unknown authorization</h1><button onclick="this.remove()">Skip</button></main>'
        );
        assert.equal(await handler.skipOnboarding(), false);
        assert.equal(await page.locator("button").count(), 1);
    }
);

test(
    "real browser: delayed terms and final-context consent must finish before commit",
    { skip: !executablePath },
    async () => {
        for (const options of [{ delayedTerms: true, terms: true }, { finalTerms: true }]) {
            const result = await run({ ...options, fast: true, noTotp: true });
            assert.ok(result.storageState, JSON.stringify(result));
            assert.ok(result.storageState.cookies.some(cookie => cookie.name === "termsAccepted"));
        }
    }
);
test(
    "real browser: onboarding waits for delayed navigation and clicks only once",
    { skip: !executablePath },
    async t => {
        const { handler, page } = await handlerFixture(
            t,
            "<main><h1>您为何选择使用 Google AI Studio？</h1><button onclick=\"document.body.dataset.clicks=Number(document.body.dataset.clicks||0)+1;setTimeout(()=>this.closest('main').remove(),350)\">跳过</button></main>"
        );
        assert.equal(await handler.skipOnboarding(), true);
        assert.equal(await page.locator("body").getAttribute("data-clicks"), "1");
        assert.equal(handler.onboardingSkips, 1);
        assert.equal(await handler.skipOnboarding(), false);
    }
);
test(
    "real browser: unchanged onboarding times out with diagnostics and cannot renew its budget",
    { skip: !executablePath },
    async t => {
        const { handler, page } = await handlerFixture(
            t,
            '<main><h1>您为何选择使用 Google AI Studio？</h1><button onclick="document.body.dataset.clicks=Number(document.body.dataset.clicks||0)+1">跳过</button></main>'
        );
        handler.stepTimeout = 250;
        await assert.rejects(handler.skipOnboarding(), error => {
            assert.equal(error.reason, "onboarding_timeout");
            assert.equal(error.retryable, true);
            assert.equal(error.loginOperation, "onboarding_wait");
            assert.equal(error.operationPart, "wait");
            assert.equal(error.onboardingDiagnostics.stepRemainingMs, 0);
            assert.ok(error.onboardingDiagnostics.remainingMs > 0);
            assert.equal(error.onboardingDiagnostics.onboardingClickCount, 1);
            return true;
        });
        const deadline = handler.onboardingDeadline;
        await assert.rejects(handler.skipOnboarding(), { reason: "onboarding_timeout" });
        assert.equal(handler.onboardingDeadline, deadline);
        assert.equal(await page.locator("body").getAttribute("data-clicks"), "1");
    }
);
test(
    "real browser: budget expiry during survey reading does not count as a click",
    { skip: !executablePath },
    async t => {
        const { handler } = await handlerFixture(
            t,
            "<main><h1>您为何选择使用 Google AI Studio？</h1><button>跳过</button></main>"
        );
        handler.stepTimeout = 100;
        const snapshot = handler.snapshot.bind(handler);
        handler.snapshot = async (...args) => {
            await new Promise(resolve => setTimeout(resolve, 150));
            return snapshot(...args);
        };
        await assert.rejects(handler.skipOnboarding(), error => {
            assert.equal(error.reason, "onboarding_timeout");
            assert.equal(error.loginOperation, "onboarding_read");
            assert.equal(error.operationPart, "budget_check");
            assert.equal(error.onboardingDiagnostics.onboardingClickCount, 0);
            return true;
        });
    }
);
test(
    "real browser: attempt deadline takes precedence during onboarding navigation",
    { skip: !executablePath },
    async t => {
        const { handler, interaction } = await handlerFixture(
            t,
            "<main><h1>您为何选择使用 Google AI Studio？</h1><button>跳过</button></main>"
        );
        handler.deadline = performance.now() + 200;
        handler.guard = interaction.guard = () => {
            if (performance.now() >= handler.deadline)
                throw Object.assign(new Error("attempt_timeout"), { reason: "attempt_timeout", retryable: true });
        };
        await assert.rejects(handler.skipOnboarding(), { reason: "attempt_timeout" });
    }
);

test("real browser: observed optional cost hint never opens spending settings", { skip: !executablePath }, async t => {
    const html = `<div role="dialog" style="width:230px;height:120px"><p>新功能：控制 API 费用</p><p>设置每月支出上限，以防止意外超支</p><button onclick="throw Error('settings action')">创建支出上限</button><button aria-label="Close" onclick="this.parentNode.remove()">X</button></div><textarea></textarea>`;
    const { handler, page } = await handlerFixture(t, html);
    assert.equal(await handler.transition(), true);
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
    assert.equal(handler.transitionClicks, 1);
});

test(
    "real browser: direct TOTP after email/password and signed-in upgrade panel",
    { skip: !executablePath },
    async () => {
        for (const options of [{ directAfterEmail: true }, { directTotp: true }, { noTotp: true, upgrade: true }]) {
            const result = await run({ ...options, fast: true });
            assert.ok(result.storageState, JSON.stringify(result));
            assert.equal(result.targetInitialized, true);
        }
    }
);
test(
    "real browser: consent observation is atomic and click timeout needs a changed container",
    { skip: !executablePath },
    async t => {
        const html =
            '<div role="dialog"><h2>AI Studio Terms of service</h2><button onclick="this.parentNode.remove()">Accept</button></div>';
        const { handler, interaction, page } = await handlerFixture(t, html);
        const original = interaction.click.bind(interaction);
        interaction.click = async (...args) => {
            await original(...args);
            throw Object.assign(new Error("synthetic timeout"), { name: "TimeoutError" });
        };
        assert.equal(await handler.terms(), true);
        assert.equal(handler.termsOutcome, "completed");
        assert.equal(await handler.snapshot(page.locator('[role="dialog"]')), null);
        await page.goto("https://aistudio.google.com/again");
        interaction.click = async () => {
            throw Object.assign(new Error("synthetic timeout"), { name: "TimeoutError" });
        };
        await assert.rejects(handler.terms(), error => error.name === "TimeoutError");
        assert.equal(await page.locator('[role="dialog"]').count(), 1);
        // Container disappears after it was identified, before control lookup.
        const snapshot = handler.snapshot.bind(handler);
        let removed = false;
        handler.snapshot = async locator => {
            const text = await snapshot(locator);
            if (text !== null && !removed) {
                removed = true;
                await page.locator('[role="dialog"]').evaluate(node => node.remove());
            }
            return text;
        };
        assert.equal(await handler.terms(), true);
        assert.equal(handler.termsOutcome, "completed");
    }
);

test(
    "real browser: challenge reentry and delayed auto-submit never type into choice inputs",
    { skip: !executablePath },
    async () => {
        for (const options of [{ bounceSubmit: true }, { bounceInput: true }, { autoSubmitDelayed: true }]) {
            const result = await run({ ...options, directTotp: true, fast: true });
            assert.ok(result.storageState, JSON.stringify(result));
        }
    }
);

test(
    "real browser: rejected Studio dialogs preserve classification and expose only safe evidence",
    { skip: !executablePath },
    async () => {
        const hint =
            '<h3>新功能：控制 API 费用</h3><p>设置每月支出上限，以防止意外超支</p><button>创建支出上限</button><button aria-label="Close">X</button><input value="password-secret">';
        for (const studioDialog of [
            `<div role="dialog" aria-modal="true" style="width:230px;height:150px">${hint}</div>`,

            `<div role="dialog" style="width:230px;height:150px">${hint.replace("API 费用", "API&nbsp;费用")}</div>`,
        ]) {
            const result = await run({ fast: true, noTotp: true, studioDialog, upgrade: true });
            assert.equal(result.error, "manual_challenge");
            assert.ok(!result.storageState);
            assert.equal(result.diagnostics.failureSource, "studio_unrecognized_dialog");
            const evidence = result.diagnostics.studioDialogs;
            assert.equal(evidence.failureSnapshot.status, "captured");
            assert.equal(evidence.failureSnapshot.count, 1);
            const dialog = evidence.failureSnapshot.dialogs[0];
            assert.equal(dialog.closeButtonCandidate, true);
            assert.equal(dialog.width, 230);
            assert.equal(dialog.height, 150);
            assert.equal(evidence.businessSnapshot.scanCount, 1);
            assert.equal(evidence.businessSnapshot.dialogs[0].classification, "unknown");
            assert.equal(evidence.sameSnapshot, false);
            assert.equal(result.diagnostics.unknownRecheckCount, 2);
            assert.ok(!JSON.stringify(evidence).includes("password-secret"));
            assert.ok(!JSON.stringify(evidence).includes("新功能"));
        }
    }
);
test(
    "real browser: failure snapshot records dialogs appearing after transition scan",
    { skip: !executablePath },
    async () => {
        const result = await run({ fast: true, lateStudioDialog: '<div role="dialog">Late hint</div>', noTotp: true });
        assert.equal(result.error, "manual_challenge");
        const evidence = result.diagnostics.studioDialogs;
        assert.equal(evidence.businessSnapshot.scanCount, 1);
        assert.equal(evidence.businessSnapshot.dialogState, "unknown_present");
        assert.equal(evidence.failureSnapshot.count, 1);
    }
);
test(
    "real browser: dialog evidence is bounded and arbitrary attributes are redacted",
    { skip: !executablePath },
    async t => {
        const html = Array.from(
            { length: 12 },
            () =>
                '<aside aria-modal="private@example.com" role="dialog"><button aria-label="private@example.com">123456</button><p>password-secret</p></aside>'
        ).join("");
        const { handler } = await handlerFixture(t, html);
        const evidence = await handler.studioDialogDiagnostics();
        assert.equal(evidence.failureSnapshot.count, 12);
        assert.equal(evidence.failureSnapshot.dialogs.length, 10);
        assert.equal(evidence.failureSnapshot.truncated, true);
        assert.equal(evidence.failureSnapshot.dialogs[0].ariaModal, "other");
        for (const secret of ["private@example.com", "123456", "password-secret"])
            assert.ok(!JSON.stringify(evidence).includes(secret));
    }
);

const costHint = `<div role="dialog" style="width:241px;height:129px"><p>新功能：控制 API 费用</p><p>设置每月支出上限</p><button onclick="throw Error('settings clicked')">创建支出上限</button></div>`;
const unknownAuthorization = `<div role="dialog">Unknown authorization<button onclick="throw Error('authorization clicked')">Allow</button></div>`;
test(
    "real browser: fixed-boundary late cost hint passes full Worker identity and native target gates",
    { skip: !executablePath },
    async () => {
        const options = { fast: true, lateStudioDialog: costHint, noTotp: true, upgrade: true };
        const success = await run(options);
        assert.ok(success.storageState, JSON.stringify(success));
        assert.equal(success.targetInitialized, true);
        assert.equal(success.diagnostics.dialogState, "clear");
        assert.equal((await run({ ...options, mismatch: true })).error, "account_mismatch");
        assert.equal((await run({ ...options, appFailure: true })).error, "service_initialization_failed");
    }
);
test(
    "real browser: safe hints never mask unknown authorizations in either DOM order or final context",
    { skip: !executablePath },
    async () => {
        for (const studioDialog of [costHint + unknownAuthorization, unknownAuthorization + costHint]) {
            const result = await run({ fast: true, noTotp: true, studioDialog });
            assert.equal(result.error, "manual_challenge");
            assert.equal(result.diagnostics.knownHintCount, 1);
            assert.equal(result.diagnostics.unknownCount, 1);
            assert.equal(result.diagnostics.unknownRecheckCount, 2);
            assert.ok(!result.storageState);
        }
        const final = await run({
            fast: true,
            finalDialog: unknownAuthorization,
            noTotp: true,
            studioDialog: costHint,
        });
        assert.equal(final.error, "manual_challenge");
        assert.ok(!final.storageState);
    }
);
test(
    "real browser: transient hint shells recover, persistent/replaced shells remain bounded",
    { skip: !executablePath },
    async () => {
        const recovered = await run({
            fast: true,
            noTotp: true,
            onStudioObservation: async (page, count) => {
                if (count === 2)
                    await page.locator("#shell").evaluate((node, html) => {
                        node.outerHTML = html;
                    }, costHint);
            },
            studioDialog: '<div role="dialog" id="shell" style="width:241px;height:129px"></div>',
        });
        assert.ok(recovered.storageState, JSON.stringify(recovered));
        for (const replacement of [false, true]) {
            const result = await run({
                fast: true,
                noTotp: true,
                onStudioObservation: async (page, count) => {
                    if (replacement && count > 1)
                        await page.locator("#shell").evaluate(node => {
                            node.replaceWith(node.cloneNode(true));
                        });
                },
                studioDialog: '<div role="dialog" id="shell" style="width:241px;height:129px"></div>',
            });
            assert.equal(result.error, "manual_challenge");
            assert.equal(result.diagnostics.unknownRecheckCount, 2);
        }
    }
);
test(
    "real browser: business scope, candidate cap and conservative nested classification",
    { skip: !executablePath },
    async t => {
        const { handler, page } = await handlerFixture(
            t,
            '<div class="cdk-overlay-pane" style="width:128px;height:34px">overlay</div>'
        );
        assert.equal((await handler.observeStudioDialogs()).dialogState, "clear");
        assert.equal((await handler.studioDialogDiagnostics()).failureSnapshot.count, 1);
        for (const html of [
            costHint
                .replace('div role="dialog"', 'mat-dialog-container role="dialog"')
                .replace("</div>", "</mat-dialog-container>"),
            costHint,
        ]) {
            await page.setContent(html);
            assert.equal((await handler.observeStudioDialogs()).dialogState, "known_hint_only");
            assert.equal(handler.transitionClicks, undefined);
        }
        await page.setContent(
            `<mat-dialog-container style="display:block">${costHint}${unknownAuthorization}</mat-dialog-container>`
        );
        const nested = await handler.observeStudioDialogs();
        assert.equal(nested.dialogState, "unknown_present");
        assert.equal(nested.knownHintCount, 1);
        assert.equal(nested.unknownCount, 2);
        await page.setContent(costHint.repeat(21));
        const capped = await handler.observeStudioDialogs();
        assert.equal(capped.dialogState, "incomplete");
        assert.equal(capped.truncated, true);
        const evidence = await handler.studioDialogDiagnostics();
        assert.equal(evidence.businessSnapshot.dialogs.length, 10);
        assert.equal(evidence.businessSnapshot.diagnosticTruncated, true);
        assert.equal(evidence.failureSnapshot.dialogs.length, 10);
    }
);
test(
    "real browser: close timeout recovers only through a complete current classification",
    { skip: !executablePath },
    async t => {
        const html = costHint.replace("</div>", '<button aria-label="Close">X</button></div>');
        const { handler, interaction, page } = await handlerFixture(t, html);
        interaction.click = async () => {
            await page.locator('[role="dialog"]').evaluate(node => node.remove());
            throw Object.assign(new Error("private timeout"), { name: "TimeoutError" });
        };
        assert.equal(await handler.transition(), true);
        assert.equal(handler.dialogObservation.dialogState, "clear");
        await page.setContent(html);
        interaction.click = async () => {
            await page.locator('[role="dialog"]').evaluate(node => {
                node.innerText = "Unknown authorization";
            });
            throw Object.assign(new Error("private timeout"), { name: "TimeoutError" });
        };
        assert.equal(await handler.transition(), false);
        assert.equal(handler.dialogObservation.dialogState, "unknown_present");
    }
);

test(
    "real browser: hint whitelist stays strict across mutations, modal flags and oversized candidates",
    { skip: !executablePath },
    async t => {
        const { handler, page } = await handlerFixture(t, costHint);
        assert.equal((await handler.observeStudioDialogs()).dialogState, "known_hint_only");
        for (const html of [
            costHint.replace("控制 API 费用", "控制 API&nbsp;费用"),
            costHint.replace('role="dialog"', 'role="dialog" aria-modal="true"'),
            costHint.replace("width:241px;height:129px", "width:1400px;height:900px"),
            unknownAuthorization,
            costHint + unknownAuthorization,
        ]) {
            await page.setContent(html);
            assert.equal((await handler.observeStudioDialogs()).dialogState, "unknown_present");
        }
        await page.setContent(
            costHint + unknownAuthorization.replace('role="dialog"', 'role="dialog" style="display:none"')
        );
        assert.equal((await handler.observeStudioDialogs()).dialogState, "known_hint_only");
        await page
            .locator('[role="dialog"]')
            .first()
            .evaluate(node => node.remove());
        assert.equal((await handler.observeStudioDialogs()).dialogState, "clear");
    }
);
test(
    "real browser: failed/expired diagnostic collection is sanitized and cannot classify the page as clear",
    { skip: !executablePath },
    async t => {
        const { handler, page } = await handlerFixture(t, costHint);
        const original = page.locator.bind(page);
        page.locator = () => ({
            evaluateAll: async () => {
                throw new Error("private@example.com password-secret");
            },
        });
        assert.equal((await handler.observeStudioDialogs()).dialogState, "incomplete");
        const evidence = await handler.studioDialogDiagnostics();
        assert.equal(evidence.failureSnapshot.status, "capture_failed");
        assert.ok(!JSON.stringify(evidence).includes("password-secret"));
        page.locator = () => ({ evaluateAll: () => new Promise(() => {}) });
        const timed = await handler.studioDialogDiagnostics();
        assert.equal(timed.failureSnapshot.status, "capture_timeout");
        page.locator = original;
        await page.close();
        assert.equal((await handler.observeStudioDialogs()).dialogState, "incomplete");
    }
);

test(
    "real browser: sequential attempts share a browser and leave no cookies or contexts",
    { skip: !executablePath },
    async () => {
        const result = await run({ fast: true, noTotp: true, repetitions: 2 });
        assert.ok(result.storageState, JSON.stringify(result));
    }
);

test("real browser: optional Google address setup after password or TOTP", { skip: !executablePath }, async () => {
    for (const options of [
        { noTotp: true },
        { addressChinese: true, addressTitle: "设置住址", directTotp: true },
        { autoSubmitDelayed: true, directTotp: true },
    ]) {
        const result = await run({ ...options, address: true, fast: true });
        assert.ok(result.storageState, JSON.stringify(result));
        assert.equal(result.targetInitialized, true);
    }
});
test("real browser: address skip requires recognized heading and Google origin", { skip: !executablePath }, async t => {
    for (const [origin, heading] of [
        ["https://accounts.google.com", "Unknown optional setup"],
        ["https://untrusted.example", "Set your home address"],
        ["https://aistudio.google.com", "Set your home address"],
    ]) {
        const { handler, page } = await handlerFixture(
            t,
            `<main><h1>${heading}</h1><button onclick="window.clicked=true">Skip</button></main>`
        );
        await page.goto(`${origin}/test`);
        assert.equal(await handler.skipAddressSetup(), false);
        assert.equal(await page.evaluate(() => !!window.clicked), false);
    }
});
test(
    "real browser: address setup that does not advance cannot commit a session",
    { skip: !executablePath },
    async () => {
        const result = await run({ address: true, addressStuck: true, fast: true, noTotp: true, stepTimeout: 1500 });
        assert.equal(result.error, "page_transition_timeout");
        assert.ok(!result.storageState);
    }
);

test("real browser: address then profile photo can both be skipped", { skip: !executablePath }, async () => {
    for (const options of [
        { noTotp: true },
        { addressChinese: true, addressTitle: "设置住址", directTotp: true, photoChinese: true },
    ]) {
        const result = await run({ ...options, address: true, fast: true, profilePhoto: true });
        assert.ok(result.storageState, JSON.stringify(result));
        assert.equal(result.targetInitialized, true);
    }
});
test(
    "real browser: profile photo skip requires prior address handling, known title and Google origin",
    { skip: !executablePath },
    async t => {
        for (const [priorAddress, origin, title] of [
            [false, "https://accounts.google.com", "Add a profile picture"],
            [true, "https://accounts.google.com", "Unknown setup"],
            [true, "https://untrusted.example", "Add a profile picture"],
            [true, "https://aistudio.google.com", "Add a profile picture"],
        ]) {
            const { handler, page } = await handlerFixture(
                t,
                `<main><h1>${title}</h1><button onclick="window.clicked=true">Skip</button></main>`
            );
            handler.addressSkips = priorAddress ? 1 : 0;
            await page.goto(`${origin}/test`);
            assert.equal(await handler.skipProfilePhotoSetup(), false);
            assert.equal(await page.evaluate(() => !!window.clicked), false);
        }
    }
);
test("real browser: stalled profile photo cannot commit a session", { skip: !executablePath }, async () => {
    const result = await run({
        address: true,
        fast: true,
        noTotp: true,
        photoStuck: true,
        profilePhoto: true,
        stepTimeout: 1500,
    });
    assert.equal(result.error, "page_transition_timeout");
    assert.ok(!result.storageState);
});
