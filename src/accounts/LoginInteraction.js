const { performance } = require("node:perf_hooks");

// Ordinary browser input events with bounded pacing; no fingerprint changes or
// CAPTCHA handling. Dependencies can be replaced by a deterministic test clock.
class LoginInteraction {
    constructor({
        config,
        guard,
        sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
        random = Math.random,
        now = () => performance.now(),
        deadline = Infinity,
    }) {
        this.config = config;
        this.deadline = deadline;
        this.guard = guard;
        this.sleep = sleep;
        this.random = random;
        this.now = now;
    }
    number(min, max) {
        return Math.floor(min + this.random() * (max - min + 1));
    }
    async pause(min = 250, max = 700) {
        this.guard();
        if (this.config.humanize !== false) await this.sleep(this.number(min, max));
        this.guard();
    }
    timeout(budget = this.config.stepTimeout) {
        this.guard();
        if (typeof budget === "function") budget = budget();
        return Math.max(1, Math.floor(Math.min(budget, this.config.stepTimeout, this.deadline - this.now())));
    }
    async operation(part, action) {
        this.diagnostics = { operationPart: part, remainingMs: Math.max(0, Math.floor(this.deadline - this.now())) };
        const started = this.now();
        try {
            return await action();
        } catch (cause) {
            cause.operationPart = part;
            cause.operationDiagnostics = {
                ...this.diagnostics,
                operationElapsedMs: Math.max(0, Math.floor(this.now() - started)),
            };
            throw cause;
        } finally {
            this.diagnostics.operationElapsedMs = Math.max(0, Math.floor(this.now() - started));
        }
    }
    async click(locator, { timeout = this.config.stepTimeout, check = async () => {} } = {}) {
        try {
            await this.pause(180, 450);
            await check();
            const options = { timeout: this.timeout(timeout) };
            if (this.config.humanize !== false) {
                const box = await this.operation("bounding_box", () => locator.boundingBox(options));
                this.guard();
                if (box && box.width > 0 && box.height > 0)
                    options.position = {
                        x: (box.width * this.number(35, 65)) / 100,
                        y: (box.height * this.number(35, 65)) / 100,
                    };
                options.delay = this.number(60, 140);
                options.steps = this.number(4, 10);
            }
            await check();
            options.timeout = this.timeout(timeout);
            await this.operation("click", () => locator.click(options));
        } catch (cause) {
            if (cause.name === "TimeoutError") {
                cause.reason = "ui_click_timeout";
                cause.retryable = true;
            }
            throw cause;
        }
        this.guard();
    }
    async setChecked(locator, checked, { timeout = this.config.stepTimeout, check = async () => {} } = {}) {
        await this.pause(180, 450);
        await check();
        try {
            // Playwright verifies the resulting state and does not toggle an
            // already checked control. Use its default click point for this
            // stateful action rather than a randomized position.
            await this.operation("checkbox_check", () =>
                locator.setChecked(checked, { timeout: this.timeout(timeout) })
            );
        } catch (cause) {
            this.guard();
            throw cause;
        }
        this.guard();
    }
    async type(locator, value, check = async () => {}) {
        this.guard();
        await check();
        if (this.config.humanize === false) {
            const text = typeof value === "function" ? await value() : value;
            this.guard();
            await check();
            await this.operation("fill", () => locator.fill(text, { timeout: this.timeout() }));
            this.guard();
            return;
        }
        await this.click(locator, { check });
        await check();
        await this.operation("keypress", () => locator.press("ControlOrMeta+A", { timeout: this.timeout() }));
        this.guard();
        await check();
        await this.operation("keypress", () => locator.press("Backspace", { timeout: this.timeout() }));
        await this.pause(100, 280);
        // Generate short-lived codes after focusing/clearing the field, not before.
        const text = typeof value === "function" ? await value() : value;
        const deadline = Math.min(this.deadline, this.now() + this.config.stepTimeout);
        for (const character of text) {
            this.guard();
            const remaining = deadline - this.now();
            if (remaining <= 0)
                throw Object.assign(new Error("input_timeout"), { reason: "input_timeout", retryable: true });
            await check();
            await this.operation("keypress", () =>
                locator.pressSequentially(character, {
                    delay: this.number(45, 125),
                    timeout: Math.max(1, Math.floor(remaining)),
                })
            );
        }
        this.guard();
    }
}
module.exports = LoginInteraction;
