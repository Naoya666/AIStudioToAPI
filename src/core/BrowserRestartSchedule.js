const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWrite } = require("../config/ConfigurationService");

const DAY = 86400000;
const formatters = new Map();
function parts(timestamp, timeZone) {
    if (!formatters.has(timeZone))
        formatters.set(
            timeZone,
            new Intl.DateTimeFormat("en-CA", {
                day: "2-digit",
                hour: "2-digit",
                hourCycle: "h23",
                minute: "2-digit",
                month: "2-digit",
                timeZone,
                year: "numeric",
            })
        );
    return Object.fromEntries(
        formatters
            .get(timeZone)
            .formatToParts(timestamp)
            .filter(p => p.type !== "literal")
            .map(p => [p.type, p.value])
    );
}
function dateKey(timestamp, timeZone) {
    const p = parts(timestamp, timeZone);
    return `${p.year}-${p.month}-${p.day}`;
}
function addDays(date, days) {
    return new Date(Date.parse(date + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10);
}
// Search real minutes on one calendar date: missing DST times use the first valid
// minute afterwards; repeated times execute only once. Never depend on host TZ.
function occurrence(date, config) {
    const [hour, minute] = config.time.split(":").map(Number);
    const start = Date.parse(date + "T00:00:00Z") - 14 * 3600000;
    for (let at = start; at < start + 50 * 3600000; at += 60000) {
        const p = parts(at, config.timeZone);
        if (`${p.year}-${p.month}-${p.day}` === date && Number(p.hour) * 60 + Number(p.minute) >= hour * 60 + minute)
            return at;
    }
    throw new Error("Cannot calculate browser restart time");
}
function firstOccurrence(now, config) {
    const date = dateKey(now, config.timeZone);
    const at = occurrence(date, config);
    return at > now ? at : occurrence(addDays(date, 1), config);
}
function nextOccurrence(previous, now, config) {
    let date = addDays(dateKey(previous, config.timeZone), config.intervalDays);
    const today = dateKey(now, config.timeZone);
    if (date < today) {
        const days = Math.floor((Date.parse(today) - Date.parse(date)) / DAY);
        date = addDays(date, Math.floor(days / config.intervalDays) * config.intervalDays);
    }
    let at = occurrence(date, config);
    if (at <= now) at = occurrence(addDays(date, config.intervalDays), config);
    return at;
}

class BrowserRestartSchedule {
    constructor(
        system,
        { file = path.join(process.cwd(), "data", "browser-restart-schedule.json"), now = Date.now } = {}
    ) {
        Object.assign(this, { file, now, system });
        this.context = new AsyncLocalStorage();
        this.requests = new Set();
        this.status = "disabled";
        this.stopped = true;
        this.record = {};
        try {
            const record = JSON.parse(fs.readFileSync(file, "utf8"));
            if (!record || typeof record !== "object" || Array.isArray(record))
                throw new Error("Invalid schedule record");
            this.record = record;
        } catch (error) {
            if (error.code !== "ENOENT")
                system.logger.warn(`[BrowserRestart] Ignoring invalid schedule record: ${error.message}`);
        }
    }
    get blocked() {
        return ["draining", "restarting", "failed"].includes(this.status);
    }
    start() {
        this.stopped = false;
        this.configure();
        this.timer = setInterval(() => this.tick().catch(error => this.fail(error)), 1000);
        this.timer.unref();
    }
    configure() {
        this.config = { ...this.system.config.browserRestart };
        if (this.blocked) return; // An already-started maintenance finishes under its original plan.
        if (this.stopped) return;
        if (this.system.config.callBackend !== "browser" || !this.config.enabled) {
            if (!this.config.enabled && this.record.nextAt != null) {
                const record = { ...this.record, nextAt: null, signature: JSON.stringify(this.config) };
                atomicWrite(this.file, record);
                this.record = record;
            }
            this.status = "disabled";
            return;
        }
        const signature = JSON.stringify(this.config);
        if (this.record.signature !== signature || !Number.isFinite(this.record.nextAt)) {
            this.record = { ...this.record, nextAt: firstOccurrence(this.now(), this.config), signature };
            atomicWrite(this.file, this.record);
        }
        this.status = "idle";
    }
    snapshot() {
        return {
            activeRequests: this.activeRequests(),
            attempts: this.attempts || 0,
            error: this.error || null,
            lastCompletedAt: this.record.lastCompletedAt || null,
            lastStartedAt: this.record.lastStartedAt || null,
            nextAt: this.status === "disabled" ? null : this.record.nextAt || null,
            status: this.status,
            timeZone: this.config?.timeZone || this.system.config.browserRestart.timeZone,
        };
    }
    activeRequests() {
        return [...this.requests].filter(token => !token.waiting || token.started).length;
    }
    middleware(req, res, next) {
        if (this.blocked) {
            res.setHeader("Retry-After", "30");
            return res.status(503).json({
                error: {
                    message: "Request browser undergoing scheduled maintenance; please retry later.",
                    type: "browser_maintenance",
                },
            });
        }
        const token = { started: false, tasks: 0, waiting: false };
        this.requests.add(token);
        const finish = () => {
            token.httpDone = true;
            if (!token.tasks) this.requests.delete(token);
        };
        res.once("finish", finish);
        res.once("close", finish);
        return this.context.run(token, next);
    }
    async track(callback) {
        const token = this.context.getStore();
        if (!token) return callback();
        token.tasks++;
        try {
            return await callback();
        } finally {
            token.tasks--;
            if (!token.tasks && token.httpDone) this.requests.delete(token);
        }
    }
    queued() {
        const token = this.context.getStore();
        if (token) token.waiting = true;
        return token;
    }
    canDispatch(token) {
        return !this.blocked || (this.status === "draining" && token?.started);
    }
    dispatched(token) {
        if (token) Object.assign(token, { started: true, waiting: false });
    }
    fail(error) {
        this.error = error.message;
        this.status = "failed";
        this.system.logger.error(`[BrowserRestart] ${error.message}`);
    }
    async tick() {
        if (this.stopped || this.task || this.status === "disabled" || this.status === "failed") return;
        if (this.status === "idle") {
            if (this.now() < this.record.nextAt || this.system.restarting || !this.system.ready) return;
            // Persist consumption before browser work. A process restart already supplies
            // a fresh browser and must not replay this occurrence.
            const config = (this.executingConfig = { ...this.config });
            const record = {
                ...this.record,
                lastStartedAt: this.now(),
                nextAt: nextOccurrence(this.record.nextAt, this.now(), config),
            };
            atomicWrite(this.file, record);
            this.record = record;
            this.status = "draining";
            this.error = null;
            this.attempts = 0;
            this.system.logger.info("[BrowserRestart] Admission stopped; waiting for active requests");
        }
        const manager = this.system.browserManager;
        if (
            this.status !== "draining" ||
            this.activeRequests() ||
            this.system.scheduler?.workers.some(worker => worker.lease) ||
            manager.benefitCheckingIndices?.size ||
            manager._browserRecoveryTask ||
            (this.retryAt && this.now() < this.retryAt)
        )
            return;
        this.status = "restarting";
        this.task = (async () => {
            this.attempts++;
            try {
                await manager.restartForSchedule();
                if (this.stopped) return;
                const record = {
                    ...this.record,
                    lastCompletedAt: this.now(),
                    nextAt:
                        this.record.nextAt <= this.now()
                            ? nextOccurrence(this.record.nextAt, this.now(), this.executingConfig || this.config)
                            : this.record.nextAt,
                };
                atomicWrite(this.file, record);
                this.record = record;
                this.error = null;
                this.retryAt = null;
                this.status = "idle";
                this.configure();
                this.system.scheduler?.drain();
                this.system.accountLoginService?.benefitQueue?.pump();
                this.system.logger.info("[BrowserRestart] Request browser ready; admission resumed");
            } catch (error) {
                if (this.stopped) return;
                this.error = error.message;
                if (this.attempts >= 3) this.fail(error);
                else {
                    this.status = "draining";
                    this.retryAt = this.now() + 30000 * this.attempts;
                    this.system.logger.warn(`[BrowserRestart] Retry pending: ${error.message}`);
                }
            }
        })().finally(() => {
            this.task = null;
        });
        return this.task;
    }
    retry() {
        if (this.status !== "failed") throw Object.assign(new Error("当前没有失败的浏览器维护任务"), { status: 409 });
        this.status = "draining";
        this.attempts = 0;
        this.retryAt = null;
        this.error = null;
    }
    async close() {
        this.stopped = true;
        clearInterval(this.timer);
        await this.task;
    }
}
module.exports = { BrowserRestartSchedule, firstOccurrence, nextOccurrence };
