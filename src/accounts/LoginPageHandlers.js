/* eslint-env browser */
// Compatibility rules informed by iBUHub/AIStudioToAPI saveAuth.js
// (Ellinav, iBenzene, bbbugg), CC BY-NC 4.0; see integration acceptance record.
const { performance } = require("node:perf_hooks");
const snapshotDialogs = require("./LoginDialogDiagnostics");
const failure = reason => Object.assign(new Error(reason), { reason });
const termsText =
    /terms of service|terms of use|Google APIs? terms|additional terms|服务条款|使用条款|服務條款|附加条款/i;
const optionalText = /newsletter|updates|marketing|offers|optional|订阅|訂閱|最新消息|電子郵件.*接收|接收.*邮件/i;
const acceptName = /^(I agree|I accept|Agree|Accept|同意|我同意|接受|Continue|继续|繼續)$/i;
// This confirmation gates Continue even when the checkbox has no required attribute.
const ageAndPurposeText = text =>
    (/at least 18 years old/i.test(text) && /professional or business purposes/i.test(text)) ||
    (/年满\s*18|年滿\s*18|至少\s*18\s*[岁歲]/i.test(text) && /专业|專業|商业|商業/i.test(text));
class LoginPageHandlers {
    constructor({ page, interaction, guard, stepTimeout, deadline, phase }) {
        Object.assign(this, { deadline, guard, interaction, page, phase, stepTimeout });
    }
    addressHeading() {
        return this.page.getByRole("heading", {
            name: /^(Set (?:your |a )?(?:home |work )?address|设置住址|設定住址|设置家庭住址|設定住家地址)$/i,
        });
    }
    async addressSetupVisible() {
        return (
            new URL(this.page.url()).hostname === "accounts.google.com" &&
            (await this.addressHeading().filter({ visible: true }).first().isVisible())
        );
    }
    profilePhotoHeading() {
        return this.page.getByRole("heading", {
            name: /^(Add (?:a |your )?profile (?:photo|picture)|添加个人资料照片|新增個人資料相片|新增個人資料照片)$/i,
        });
    }
    async profilePhotoSetupVisible() {
        return (
            new URL(this.page.url()).hostname === "accounts.google.com" &&
            (await this.profilePhotoHeading().filter({ visible: true }).first().isVisible())
        );
    }
    skipAddressSetup() {
        return this.skipGoogleSetup("address", this.addressHeading(), () => this.addressSetupVisible());
    }
    async skipProfilePhotoSetup() {
        this.guard();
        // This optional step is only authorized in the flow following address setup.
        if (!this.addressSkips) return false;
        return this.skipGoogleSetup("profile_photo", this.profilePhotoHeading(), () => this.profilePhotoSetupVisible());
    }
    async skipGoogleSetup(kind, heading, visible) {
        this.guard();
        if (!(await visible())) return false;
        const end = Math.min(this.deadline, performance.now() + this.stepTimeout);
        const check = () => {
            this.guard();
            if (performance.now() >= end) throw Object.assign(failure("page_transition_timeout"), { retryable: true });
        };
        const counter = `${kind}Skips`;
        if ((this[counter] || 0) >= 2) throw failure("unknown_page");
        this.phase(`google_${kind}`);
        const scope = this.page
            .locator('main, [role="main"], form, section, div')
            .filter({ has: heading.filter({ visible: true }) })
            .filter({ has: this.page.getByRole("button", { name: /^(Skip|跳过|跳過)$/i }) })
            .filter({ visible: true })
            .last();
        try {
            this.operation = `${kind}_skip`;
            await this.interaction.click(scope.getByRole("button", { name: /^(Skip|跳过|跳過)$/i }).first(), {
                check,
                timeout: Math.max(1, Math.floor(end - performance.now())),
            });
            this[counter] = (this[counter] || 0) + 1;
            this.operation = `${kind}_wait`;
            while (await visible()) {
                check();
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            check();
            return true;
        } catch (cause) {
            this.guard();
            cause.loginOperation = this.operation;
            throw cause;
        }
    }
    async snapshot(locator, operation = "terms_read") {
        this.operation = operation;
        // One DOM snapshot: missing containers never enter Playwright's locator retry.
        return this.interaction.operation("text_read", () =>
            locator.evaluateAll(nodes => {
                const node = nodes.find(node => node.isConnected && node.getClientRects().length);
                return node ? node.innerText : null;
            })
        );
    }
    async terms(limit = this.deadline) {
        this.guard();
        if (new URL(this.page.url()).hostname !== "aistudio.google.com") return false;
        const end = Math.min(limit, this.deadline, performance.now() + this.stepTimeout);
        let handled = false;
        for (let attempt = 0; attempt <= 3; attempt++) {
            this.guard();
            let found, foundFrame;
            for (const frame of this.page.frames().slice(0, 10)) {
                this.guard();
                // Never follow third-party consent frames or unclassified about:blank frames.
                let host;
                try {
                    host = new URL(frame.url()).hostname;
                } catch {
                    continue;
                }
                if (host !== "aistudio.google.com") continue;
                const dialogs = frame
                    .locator(
                        '[role="dialog"], [aria-modal="true"], dialog, mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane, .mdc-dialog'
                    )
                    .filter({ visible: true });
                for (let index = 0; index < Math.min(await dialogs.count(), 5); index++) {
                    const dialog = dialogs.nth(index);
                    let text;
                    try {
                        text = await this.snapshot(dialog);
                    } catch (cause) {
                        this.guard();
                        if (frame.isDetached()) break;
                        throw cause;
                    }
                    if (text !== null && termsText.test(text) && /AI Studio|Gemini/i.test(text)) {
                        found = dialog;
                        foundFrame = frame;
                        break;
                    }
                }
                if (!found) {
                    // First-run consent also has a full-page welcome variant.
                    // Require its welcome title, terms and age/business gate;
                    // choose the smallest matching content scope, never the body.
                    const welcome = frame
                        .locator("main, section, article, div")
                        .filter({
                            hasText:
                                /Welcome to (?:Google )?AI Studio|欢迎使用\s*(?:Google )?AI Studio|歡迎使用\s*(?:Google )?AI Studio/i,
                        })
                        .filter({ hasText: termsText })
                        .filter({ has: frame.locator('input[type="checkbox"], [role="checkbox"]') })
                        .filter({
                            has: frame.locator('button, [role="button"], input[type="button"], input[type="submit"]'),
                        })
                        .filter({ visible: true })
                        .last();
                    const text = await this.snapshot(welcome);
                    if (text !== null && ageAndPurposeText(text)) {
                        found = welcome;
                        foundFrame = frame;
                    }
                }
                if (found) break;
            }
            if (!found) {
                if (handled) this.termsOutcome = "completed";
                this.phase("aistudio_ready_wait");
                return handled;
            }
            if (attempt === 3) throw failure("terms_or_consent_required");
            this.phase("aistudio_terms");
            this.termsOutcome = "identified";
            handled = true;
            try {
                const boxes = found.locator('input[type="checkbox"], [role="checkbox"]').filter({ visible: true });
                for (let index = 0; index < Math.min(await boxes.count(), 10); index++) {
                    this.guard();
                    const box = boxes.nth(index);
                    const info = await box.evaluate(node => ({
                        checked: node.checked === true || node.getAttribute("aria-checked") === "true",
                        label:
                            node.labels?.[0]?.innerText ||
                            document.getElementById(node.getAttribute("aria-labelledby"))?.innerText ||
                            node.closest("label, mat-checkbox, .mdc-form-field")?.innerText ||
                            node.getAttribute("aria-label") ||
                            "",
                        required: node.required || node.getAttribute("aria-required") === "true",
                    }));
                    if (optionalText.test(info.label)) continue;
                    if (
                        !info.checked &&
                        (info.required ||
                            ageAndPurposeText(info.label) ||
                            (/agree|accept|同意|接受/i.test(info.label) && /terms|条款|條款/i.test(info.label)))
                    ) {
                        this.operation = "terms_checkbox";
                        await this.interaction.click(box, { timeout: this.remaining(end) });
                    }
                }
                let button = found
                    .getByRole("button", { name: /^(I agree|I accept|Agree|Accept|同意|我同意|接受)$/i })
                    .first();
                if (!(await button.isVisible())) button = found.getByRole("button", { name: acceptName }).first();
                if (!(await button.isVisible())) {
                    // AI Studio can expose a longer aria-label than its visible
                    // confirmation caption. Use exact approved text only inside
                    // the already identified consent container.
                    const controls = found
                        .locator('button, [role="button"], input[type="button"], input[type="submit"]')
                        .filter({ visible: true });
                    const matches = [];
                    for (let index = 0; index < Math.min(await controls.count(), 30); index++) {
                        this.guard();
                        const control = controls.nth(index);
                        const caption = await control.evaluate(node => {
                            const copy = node.cloneNode(true);
                            copy.querySelectorAll('mat-icon, svg, [aria-hidden="true"]').forEach(icon => icon.remove());
                            return (copy.textContent || node.value || "").replace(/\s+/g, " ").trim();
                        });
                        if (acceptName.test(caption))
                            matches.push({ control, explicit: !/^(Continue|继续|繼續)$/i.test(caption) });
                    }
                    button = matches.find(match => match.explicit)?.control || matches[0]?.control || button;
                }
                if (!(await button.isVisible())) {
                    if ((await this.snapshot(found)) === null) continue;
                    this.termsOutcome = "confirmation_missing";
                    throw failure("terms_or_consent_required");
                }
                const before = await this.snapshot(found);
                if (before === null) continue;
                this.operation = "terms_confirm";
                try {
                    await this.interaction.click(button, { timeout: this.remaining(end) });
                    this.termsOutcome = "clicked";
                } catch (cause) {
                    cause.loginOperation ||= this.operation;
                    this.guard();
                    if (cause.name !== "TimeoutError" || (await this.snapshot(found)) === before) throw cause;
                    // Rescan and validate the current page; disappearance alone is not success.
                    continue;
                }
                let changed = false;
                const observeUntil = Math.min(end, performance.now() + 2000);
                while (performance.now() < observeUntil) {
                    this.guard();
                    if ((await this.snapshot(found)) !== before) {
                        changed = true;
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (!changed && attempt === 2) {
                    this.termsOutcome = "unchanged";
                    throw failure("terms_or_consent_required");
                }
            } catch (cause) {
                cause.loginOperation ||= this.operation;
                this.guard();
                if (foundFrame.isDetached()) continue;
                if (cause.name !== "TimeoutError" || (await this.snapshot(found)) !== null) throw cause;
                // A known consent container disappeared during control preparation.
                // The next scan and Studio validation still have to succeed.
            }
        }
        throw failure("terms_or_consent_required");
    }
    async skipOnboarding(limit = this.deadline) {
        this.guard();
        if (this.onboardingPage !== this.page) {
            this.onboardingPage = this.page;
            this.onboardingDeadline = null;
        }
        const title =
            /^(Why (?:are you using|did you choose to use) Google AI Studio\s*\?|您为何选择使用 Google AI Studio\s*[？?])$/i;
        for (const frame of this.page.frames().slice(0, 10)) {
            this.guard();
            let host;
            try {
                host = new URL(frame.url()).hostname;
            } catch {
                continue;
            }
            if (host !== "aistudio.google.com") continue;
            const heading = frame.getByRole("heading", { name: title }).first();
            if (!(await heading.isVisible())) continue;
            // Start once for this page. Polls and repeated clicks cannot renew it.
            this.onboardingDeadline ??= Math.min(this.deadline, performance.now() + this.stepTimeout);
            const end = Math.min(limit, this.deadline, this.onboardingDeadline);
            const check = () => {
                this.guard();
                if (performance.now() >= end) throw Object.assign(failure("onboarding_timeout"), { retryable: true });
            };
            try {
                this.phase("aistudio_onboarding");
                this.operation = "onboarding_read";
                check();
                const skip = frame.getByRole("button", { name: /^(Skip|跳过|跳過)$/i });
                const scope = frame
                    .locator("main, section, article, div")
                    .filter({ has: heading })
                    .filter({ has: skip })
                    .last();
                const text = await this.snapshot(scope, "onboarding_read");
                check();
                if (text === null || termsText.test(text)) continue;
                const button = scope.getByRole("button", { name: /^(Skip|跳过|跳過)$/i }).first();
                if (!(await button.isVisible())) continue;
                check();
                if ((this.onboardingSkips || 0) >= 2)
                    throw Object.assign(failure("onboarding_timeout"), { retryable: true });
                this.operation = "onboarding_skip";
                await this.interaction.click(button, {
                    check,
                    timeout: Math.max(1, Math.floor(end - performance.now())),
                });
                this.onboardingSkips = (this.onboardingSkips || 0) + 1;
                this.operation = "onboarding_wait";
                await this.interaction.operation("wait", async () => {
                    while (performance.now() < end) {
                        check();
                        const visible = await heading.isVisible();
                        check();
                        if (!visible) return;
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    check();
                });
                return true;
            } catch (cause) {
                this.guard();
                if (cause.name === "TimeoutError") {
                    cause.reason = "onboarding_timeout";
                    cause.retryable = true;
                }
                cause.loginOperation = this.operation;
                cause.operationPart ||= "budget_check";
                cause.onboardingDiagnostics = {
                    onboardingClickCount: this.onboardingSkips || 0,
                    remainingMs: Math.max(0, Math.floor(this.deadline - performance.now())),
                    stepRemainingMs: Math.max(0, Math.floor(end - performance.now())),
                };
                throw cause;
            }
        }
        return false;
    }
    async observeStudioDialogs(limit = this.deadline) {
        this.guard();
        let observed, timer;
        try {
            if (new URL(this.page.url()).hostname !== "aistudio.google.com") throw failure("observation_unavailable");
            const budget = Math.max(
                1,
                Math.min(limit, this.deadline, performance.now() + this.stepTimeout) - performance.now()
            );
            observed = await this.interaction.operation("text_read", () =>
                Promise.race([
                    this.page
                        .locator('[role="dialog"], dialog, mat-dialog-container')
                        .evaluateAll(snapshotDialogs, "business"),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(failure("observation_timeout")), budget);
                    }),
                ])
            );
        } catch {
            this.guard();
            observed = { dialogs: [], dialogState: "incomplete", knownHintCount: 0, termsCount: 0, unknownCount: 0 };
        } finally {
            clearTimeout(timer);
        }
        this.guard();
        // Business evidence is a projection of this exact decision snapshot.
        // The later, wider failure snapshot is explicitly separate evidence.
        this.dialogObservation = {
            ...observed,
            diagnosticTruncated: observed.dialogs.length > 10,
            dialogs: observed.dialogs.slice(0, 10),
        };
        return observed;
    }
    async transition(limit = this.deadline) {
        const observed = await this.observeStudioDialogs(limit);
        if (!["clear", "known_hint_only"].includes(observed.dialogState)) return false;
        const hint = observed.dialogs.find(dialog => dialog.classification === "known_hint");
        if (!hint) return false;
        this.phase("aistudio_transition");
        this.transitionClicks ||= 0;
        if (!hint.closeButtonCandidate || this.transitionClicks >= 2) return true;
        const end = Math.min(limit, this.deadline, performance.now() + this.stepTimeout);
        // Pin the original node so a reordered/replaced candidate cannot receive
        // a close action intended for the hint.
        const handle = await this.page.evaluateHandle(
            index => document.querySelectorAll('[role="dialog"], dialog, mat-dialog-container')[index] || null,
            hint.index
        );
        const dialog = handle.asElement();
        if (!dialog) {
            await handle.dispose();
            return true;
        }
        let close,
            buttons = [];
        try {
            buttons = await dialog.$$('button, [role="button"]');
            close = null;
            for (const button of buttons) {
                const isClose = await button.evaluate(node => {
                    const name =
                        (node.getAttribute("aria-labelledby") || "")
                            .split(/\s+/)
                            .map(id => document.getElementById(id)?.textContent || "")
                            .join(" ")
                            .trim() ||
                        node.getAttribute("aria-label") ||
                        node.innerText ||
                        "";
                    return node.getClientRects().length > 0 && /^(Close|Dismiss|关闭|關閉)$/i.test(name.trim());
                });
                if (isClose) {
                    close = button;
                    break;
                }
            }
            if (!close) return true;
            this.transitionClicks++;
            await this.interaction.click(close, {
                check: async () => {
                    this.guard();
                    if (performance.now() >= end) throw failure("page_transition_timeout");
                    if (new URL(this.page.url()).hostname !== "aistudio.google.com") throw failure("challenge_changed");
                    const classification = await dialog.evaluate(node => {
                        const text = node.innerText || "";
                        const box = node.getBoundingClientRect();
                        return (
                            node.isConnected &&
                            !/terms of service|terms of use|Google APIs? terms|additional terms|服务条款|使用条款|服務條款|附加条款/i.test(
                                text
                            ) &&
                            !node.querySelector('[role="dialog"], dialog, mat-dialog-container') &&
                            node.getAttribute("aria-modal") !== "true" &&
                            box.width > 0 &&
                            box.height > 0 &&
                            box.width * box.height < (innerWidth * innerHeight) / 4 &&
                            /New.*control API costs|新功能[：:].*控制 API 费用/i.test(text) &&
                            /Set a monthly spending cap|设置每月支出上限/i.test(text) &&
                            /Create spending cap|创建支出上限/i.test(text)
                        );
                    });
                    if (!classification) throw failure("challenge_changed");
                },
                timeout: Math.max(1, Math.floor(end - performance.now())),
            });
        } catch (cause) {
            this.guard();
            if (cause.name !== "TimeoutError" && cause.reason !== "challenge_changed") throw cause;
            const after = await this.observeStudioDialogs(limit);
            // A click timeout is recoverable only with a complete safe state.
            if (!["clear", "known_hint_only"].includes(after.dialogState)) return false;
        } finally {
            await Promise.all(buttons.map(button => button.dispose()));
            await dialog.dispose();
        }
        await this.observeStudioDialogs(limit);
        return true;
    }
    async studioDialogDiagnostics() {
        // Failure was already decided. Bound best-effort collection so it cannot
        // replace that failure or consume a full UI operation timeout.
        const budget = Math.max(1, Math.min(500, this.deadline - performance.now()));
        let timer;
        let failureSnapshot;
        try {
            failureSnapshot = await Promise.race([
                this.page
                    .locator(
                        '[role="dialog"], [aria-modal="true"], dialog, mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane, .mdc-dialog'
                    )
                    .evaluateAll(snapshotDialogs)
                    .then(snapshot => ({ status: "captured", ...snapshot })),
                new Promise(resolve => {
                    timer = setTimeout(() => resolve({ status: "capture_timeout" }), budget);
                }),
            ]);
        } catch {
            failureSnapshot = { status: "capture_failed" };
        } finally {
            clearTimeout(timer);
        }
        return { businessSnapshot: this.dialogObservation, failureSnapshot, sameSnapshot: false };
    }
    remaining(end) {
        this.guard();
        const remaining = end - performance.now();
        if (remaining <= 0) throw failure("terms_or_consent_required");
        return Math.max(1, Math.floor(remaining));
    }
    async pin(input) {
        const handle = await input.elementHandle();
        if (!handle) throw failure("challenge_changed");
        // ElementHandle keeps the original node through redraws. Its per-character
        // typing API is named type(), while Locator exposes pressSequentially().
        return {
            boundingBox: options => handle.boundingBox(options),
            click: options => handle.click(options),
            evaluate: (...args) => handle.evaluate(...args),
            fill: (...args) => handle.fill(...args),
            locator: selector => input.locator(selector),
            press: (...args) => handle.press(...args),
            pressSequentially: (text, options) => handle.type(text, options),
        };
    }
    async totpInputs(selector) {
        this.guard();
        const inputs = (typeof selector === "string" ? this.page.locator(selector) : selector).filter({
            visible: true,
        });
        const editable = [];
        for (let index = 0; index < Math.min(await inputs.count(), 12); index++) {
            const input = inputs.nth(index);
            if ((await input.isEnabled()) && (await input.isEditable())) editable.push(input);
        }
        this.editableCount = editable.length;
        if (editable.length === 1) return Promise.all(editable.map(input => this.pin(input)));
        if (
            editable.length === 6 &&
            (await Promise.all(editable.map(input => input.getAttribute("maxlength")))).every(length => length === "1")
        )
            return Promise.all(editable.map(input => this.pin(input)));
        throw failure("manual_challenge");
    }
    async structure() {
        // No arbitrary attributes, body text, labels, URLs or values leave the DOM.
        return this.page.evaluate(() => {
            const types = new Set(["email", "password", "text", "tel", "number", "checkbox", "submit", "button"]);
            const names = new Set([
                "Next",
                "Continue",
                "Verify",
                "I agree",
                "Accept",
                "Try another way",
                "下一步",
                "继续",
                "验证",
                "同意",
                "接受",
            ]);
            return [...document.querySelectorAll('input, button, [role="checkbox"], iframe')]
                .slice(0, 100)
                .filter(node => node.getClientRects().length)
                .map(node => ({
                    type:
                        node.tagName === "INPUT"
                            ? types.has(node.type)
                                ? node.type
                                : "other"
                            : node.tagName === "IFRAME"
                              ? "iframe"
                              : node.getAttribute("role") === "checkbox"
                                ? "checkbox"
                                : "button",
                    ...(node.tagName === "BUTTON" && names.has(node.textContent.trim())
                        ? { label: node.textContent.trim() }
                        : {}),
                }));
        });
    }
}
module.exports = LoginPageHandlers;
