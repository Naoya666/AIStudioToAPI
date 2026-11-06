const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { BrowserRestartSchedule, firstOccurrence, nextOccurrence } = require("../src/core/BrowserRestartSchedule");
const { ConfigurationService } = require("../src/config/ConfigurationService");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const BrowserManager = require("../src/core/BrowserManager");
const loadConfig = require("../src/core/SchedulerConfig");
const logger = { debug() {}, error() {}, info() {}, setDisplayLimit() {}, warn() {} };
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve;
    const promise = new Promise(r => {
        resolve = r;
    });
    return { promise, resolve };
};

function setup(t, overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-restart-"));
    let now = Date.parse("2026-11-06T19:59:00Z");
    let restarts = 0;
    const system = {
        accountLoginService: { benefitQueue: { pump() {} }, queue: { running: true } },
        browserManager: {
            restartForSchedule: async () => {
                restarts++;
            },
        },
        config: {
            browserRestart: { enabled: true, intervalDays: 2, time: "04:00", timeZone: "Asia/Shanghai", ...overrides },
            callBackend: "browser",
        },
        logger,
        ready: true,
    };
    const options = { file: path.join(directory, "schedule.json"), now: () => now };
    const schedule = (system.browserRestartSchedule = new BrowserRestartSchedule(system, options));
    schedule.start();
    t.after(async () => {
        await schedule.close();
        fs.rmSync(directory, { force: true, recursive: true });
    });
    return {
        directory,
        options,
        restarts: () => restarts,
        schedule,
        setNow: at => {
            now = typeof at === "string" ? Date.parse(at) : at;
        },
        system,
    };
}
function response() {
    const res = new EventEmitter();
    res.headers = {};
    res.setHeader = (key, value) => {
        res.headers[key] = value;
    };
    res.status = code => {
        res.code = code;
        return res;
    };
    res.json = body => {
        res.body = body;
        res.emit("finish");
        return res;
    };
    return res;
}

test("calendar intervals stay anchored across delays, restarts and DST", () => {
    const config = { intervalDays: 2, time: "04:00", timeZone: "Asia/Shanghai" };
    const first = firstOccurrence(Date.parse("2026-11-06T19:59:00Z"), config);
    assert.equal(new Date(first).toISOString(), "2026-11-06T20:00:00.000Z");
    assert.equal(new Date(nextOccurrence(first, first + 15 * 60000, config)).toISOString(), "2026-11-08T20:00:00.000Z");
    assert.equal(
        new Date(nextOccurrence(first, Date.parse("2026-11-20T21:00:00Z"), config)).toISOString(),
        "2026-11-22T20:00:00.000Z"
    );
    const dst = { intervalDays: 1, time: "02:30", timeZone: "America/Los_Angeles" };
    assert.equal(
        new Date(firstOccurrence(Date.parse("2026-03-08T08:00:00Z"), dst)).toISOString(),
        "2026-03-08T10:00:00.000Z"
    );
    const fall = { ...dst, time: "01:30" };
    const repeated = firstOccurrence(Date.parse("2026-11-01T07:00:00Z"), fall);
    assert.equal(new Date(repeated).toISOString(), "2026-11-01T08:30:00.000Z");
    assert.equal(
        new Date(nextOccurrence(repeated, repeated + 3600000, fall)).toISOString(),
        "2026-11-02T09:30:00.000Z"
    );
});

test("drains logical requests through retries and response-close cleanup; rejects new requests", async t => {
    const { schedule, system, setNow, restarts } = setup(t);
    const cleanup = deferred();
    const res = response();
    let token;
    const request = schedule.middleware({}, res, () =>
        schedule.track(async () => {
            token = schedule.queued();
            schedule.dispatched(token);
            await cleanup.promise;
        })
    );
    setNow(schedule.record.nextAt);
    await schedule.tick();
    assert.equal(schedule.status, "draining");
    assert.equal(restarts(), 0);
    const rejected = response();
    schedule.middleware({}, rejected, () => assert.fail("must reject admission"));
    assert.equal(rejected.code, 503);
    assert.equal(rejected.headers["Retry-After"], "30");
    assert.equal(system.accountLoginService.queue.running, true);
    assert.equal(schedule.canDispatch(token), true); // retry of the active logical request
    res.emit("close");
    await schedule.tick();
    assert.equal(restarts(), 0); // closed socket still has async cleanup
    cleanup.resolve();
    await request;
    await schedule.tick();
    assert.equal(restarts(), 1);
    assert.equal(schedule.status, "idle");
    assert.equal(schedule.requests.size, 0);
    const admitted = response();
    schedule.middleware({}, admitted, () => admitted.json({ ok: true }));
    assert.deepEqual(admitted.body, { ok: true });
});

test("real scheduler preserves queued requests and resumes them after browser readiness", async t => {
    const { schedule, system, setNow } = setup(t);
    const scheduler = (system.scheduler = new ModelScheduler(
        {
            ...loadConfig({ GLOBAL_MAX_CONCURRENCY: "1", MAX_BROWSER_WORKERS: "1" }),
            registeredModels: ["gemini-2.5-flash"],
            statePath: null,
        },
        { accountNameMap: new Map(), getRotationIndices: () => [0] },
        logger
    ));
    scheduler.browserRestartSchedule = schedule;
    t.after(() => scheduler.close());
    const activeDone = deferred();
    const browserReady = deferred();
    system.browserManager.restartForSchedule = () => browserReady.promise;
    const a = response(),
        b = response();
    let activeLease;
    const first = schedule.middleware({}, a, () =>
        schedule.track(async () => {
            activeLease = await scheduler.acquire("gemini-2.5-flash");
            await activeDone.promise;
            scheduler.release(activeLease);
            a.json({ ok: true });
        })
    );
    await turn();
    assert.ok(activeLease);
    let dispatched = false;
    const second = schedule.middleware({}, b, () =>
        schedule.track(async () => {
            const lease = await scheduler.acquire("gemini-2.5-flash");
            dispatched = true;
            scheduler.release(lease);
            b.json({ ok: true });
        })
    );
    assert.equal(scheduler.pending.length, 1);
    setNow(schedule.record.nextAt);
    await schedule.tick();
    activeDone.resolve();
    await first;
    assert.equal(dispatched, false);
    const restart = schedule.tick();
    await turn();
    assert.equal(schedule.status, "restarting");
    assert.equal(scheduler.pending.length, 1);
    await schedule.tick(); // duplicate timer cannot start another restart
    browserReady.resolve();
    await restart;
    await second;
    assert.equal(dispatched, true);
    assert.equal(schedule.status, "idle");
});

test("failed maintenance retries finitely and stays isolated until manual retry succeeds", async t => {
    const { schedule, system, setNow } = setup(t);
    system.browserManager.restartForSchedule = async () => {
        throw new Error("launch failed");
    };
    setNow(schedule.record.nextAt);
    await schedule.tick();
    assert.equal(schedule.attempts, 1);
    await schedule.tick();
    assert.equal(schedule.attempts, 1);
    setNow(schedule.retryAt);
    await schedule.tick();
    setNow(schedule.retryAt);
    await schedule.tick();
    assert.equal(schedule.status, "failed");
    assert.equal(schedule.attempts, 3);
    assert.equal(schedule.blocked, true);
    assert.equal(system.accountLoginService.queue.running, true);
    schedule.retry();
    system.browserManager.restartForSchedule = async () => {};
    await schedule.tick();
    assert.equal(schedule.blocked, false);
});

test("schedule is persisted, skips replay on process restart and applies hot changes", async t => {
    const { schedule, system, options, setNow } = setup(t);
    const first = schedule.record.nextAt;
    setNow(first);
    await schedule.tick();
    await schedule.close();
    const restored = new BrowserRestartSchedule(system, options);
    t.after(() => restored.close());
    restored.start();
    assert.equal(restored.record.nextAt, first + 2 * 86400000);
    assert.equal(restored.record.lastCompletedAt, first);
    system.config.browserRestart.intervalDays = 3;
    restored.configure();
    assert.match(restored.record.signature, /"intervalDays":3/);
    system.config.browserRestart.enabled = false;
    restored.configure();
    assert.equal(restored.status, "disabled");
    assert.equal(restored.snapshot().nextAt, null);
});

test("local backend never starts maintenance", async t => {
    const { schedule, system, setNow, restarts } = setup(t);
    system.config.callBackend = "local";
    schedule.configure();
    setNow("2027-01-01T00:00:00Z");
    await schedule.tick();
    assert.equal(schedule.blocked, false);
    assert.equal(restarts(), 0);
});

test("settings validate and hot-apply the complete schedule", t => {
    const { system, directory } = setup(t);
    const service = new ConfigurationService(system, { env: {}, file: path.join(directory, "managed-config.json") });
    service.system.browserRestartSchedule.configure();
    const saved = service.save({
        changes: {
            BROWSER_RESTART_ENABLED: true,
            BROWSER_RESTART_INTERVAL_DAYS: 3,
            BROWSER_RESTART_TIME: "05:15",
            BROWSER_RESTART_TIMEZONE: "UTC",
        },
        version: service.document.version,
    });
    assert.equal(saved.browserRestart.status, "idle");
    assert.equal(system.config.browserRestart.time, "05:15");
    assert.equal(saved.pending.length, 0);
    for (const changes of [
        { BROWSER_RESTART_TIME: "25:00" },
        { BROWSER_RESTART_INTERVAL_DAYS: 0 },
        { BROWSER_RESTART_INTERVAL_DAYS: 1.5 },
        { BROWSER_RESTART_TIMEZONE: "Mars" },
    ])
        assert.throws(() => service.save({ changes, version: service.document.version }));
});

test("browser close timeout during scheduled restart never requests application recovery", async t => {
    const manager = new BrowserManager(
        logger,
        { browserExecutablePath: __filename, scheduler: loadConfig({ CONTEXT_CLEANUP_TIMEOUT_MS: "10" }) },
        { getRotationIndices: () => [] }
    );
    const browser = new EventEmitter();
    browser.close = () => new Promise(() => {});
    manager.browser = browser;
    const messages = [];
    const originalSend = process.send;
    process.send = message => messages.push(message);
    t.after(() => {
        if (originalSend) process.send = originalSend;
        else delete process.send;
    });
    await assert.rejects(manager.restartForSchedule(), /timed out|timeout/i);
    assert.equal(manager._scheduledMaintenance, true);
    assert.equal(manager.browserState, "MAINTENANCE_FAILED");
    assert.equal(messages.length, 0);
});

test("successful browser maintenance closes only request browser and checks context readiness", async () => {
    const manager = new BrowserManager(
        logger,
        { browserExecutablePath: __filename, scheduler: loadConfig({}) },
        { getRotationIndices: () => [0] }
    );
    const calls = [];
    manager.abortBackgroundPreload = async () => {
        calls.push("preload");
    };
    manager.closeBrowser = async () => {
        calls.push("close");
    };
    manager._ensureBrowser = async options => {
        assert.equal(options.recovery, true);
        calls.push("launch");
        manager.browser = { isConnected: () => true };
    };
    manager._getOrStartContextInit = async index => {
        assert.equal(index, 0);
        calls.push("context");
    };
    manager.isContextReady = () => true;
    await manager.restartForSchedule();
    assert.deepEqual(calls, ["preload", "close", "launch", "context"]);
    assert.equal(manager._recovering, false);
    assert.equal(manager._scheduledMaintenance, false);
});

test("HTTP maintenance rejects inference while login management routes remain available", async t => {
    const { schedule, system, setNow } = setup(t);
    const ProxyServerSystem = require("../src/core/ProxyServerSystem");
    const ConfigLoader = require("../src/utils/ConfigLoader");
    Object.setPrototypeOf(system, ProxyServerSystem.prototype);
    system.config = {
        ...new ConfigLoader(logger).loadConfiguration({ API_KEYS: "maintenance-test-key" }),
        browserRestart: system.config.browserRestart,
    };
    const inFlight = deferred();
    const entered = deferred();
    system.requestHandler = {
        async processOpenAIRequest(req, res) {
            entered.resolve();
            await inFlight.promise;
            res.json({ ok: true });
        },
        withConfigurationSnapshot: next => next(),
    };
    system.webRoutes = {
        authRoutes: { getClientIP: () => "fixture" },
        setupSession(app) {
            app.get("/api/account-management/login-queue", (req, res) => res.json(system.accountLoginService.queue));
        },
    };
    const app = system._createExpressApp();
    const server = await new Promise(resolve => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const invoke = () =>
        fetch(base + "/v1/chat/completions", {
            body: JSON.stringify({ messages: [], model: "gemini-2.5-flash" }),
            headers: { Authorization: "Bearer maintenance-test-key", "Content-Type": "application/json" },
            method: "POST",
        });
    const pending = invoke();
    await entered.promise;
    setNow(schedule.record.nextAt);
    await schedule.tick();
    const rejected = await invoke();
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get("retry-after"), "30");
    const login = await fetch(base + "/api/account-management/login-queue");
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { running: true });
    assert.equal(schedule.status, "draining");
    inFlight.resolve();
    assert.equal((await pending).status, 200);
    await turn();
    await schedule.tick();
    assert.equal((await invoke()).status, 200);
});

test("maintenance delayed for multiple intervals skips catch-up restarts", async t => {
    const { schedule, system, setNow } = setup(t);
    const ready = deferred();
    system.browserManager.restartForSchedule = async () => ready.promise;
    setNow(schedule.record.nextAt);
    const job = schedule.tick();
    setNow("2026-11-13T21:00:00Z");
    ready.resolve();
    await job;
    assert.equal(new Date(schedule.record.nextAt).toISOString(), "2026-11-14T20:00:00.000Z");
    assert.equal(schedule.attempts, 1);
    await schedule.tick();
    assert.equal(schedule.status, "idle");
});
