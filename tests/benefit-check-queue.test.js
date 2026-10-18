const { test } = require("node:test");
const assert = require("node:assert/strict");
const BenefitCheckQueue = require("../src/accounts/BenefitCheckQueue");
const AccountLoginService = require("../src/accounts/AccountLoginService");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("queue did not settle");
        await wait(5);
    }
}
function fixture(t, { temporary = false, full = false, query, create, close } = {}) {
    const events = [];
    let busy = false,
        live = 0,
        maxLive = 0;
    const accounts = [0, 1, 2].map(authIndex => ({
        accountId: `account-${authIndex}`,
        authIndex,
        sessionState: "valid",
        sessionVersion: 1,
    }));
    const service = Object.create(AccountLoginService.prototype);
    Object.assign(service, {
        chain: Promise.resolve(),
        invalidated: new Set(),
        logger: { error() {} },
        queue: { running: new Map() },
        readAuth: async index => ({ cookies: [{ name: "account", value: String(index) }], origins: [] }),
        resolveProxy: () => null,
        save: async () => {
            events.push("save");
        },
        state: { accounts, benefitTasks: [], tasks: [] },
        system: {},
    });
    const benefits = accounts.map(account => ({
        _evaluate: async () => true,
        ensure: async () => {
            events.push(`query:${account.authIndex}`);
            await query?.(account);
            Object.assign(benefits[account.authIndex], { rawTier: "TIER1", source: "query", state: "ready-paid" });
        },
        epoch: 0,
        isCurrent: () => true,
    }));
    const browser = {
        _contextCapacityIndices: () =>
            new Set(full ? [99] : [...browser.contexts.keys(), ...browser.contextCapacityReservations.keys()]),
        _createBrowserContext: async (options, index) => {
            events.push(`create:${index}:${options.storageState.cookies[0].value}`);
            await create?.(index);
            live++;
            maxLive = Math.max(maxLive, live);
            let closed = false;
            const page = {
                addInitScript: async () => {},
                evaluate: async fn => {
                    const source = String(fn);
                    if (source.includes("wrappedJSObject")) return false;
                    if (source.includes(".read(timeout")) {
                        events.push(`query:${index}`);
                        await query?.(accounts[index]);
                        return { rawTier: "TIER1", source: "query", state: "ready-paid" };
                    }
                    return true;
                },
                exposeBinding: async () => {},
                goto: async () => {
                    events.push(`navigate:${index}`);
                },
                mainFrame: () => page,
                off() {},
                on() {},
                route: async () => {},
                unroute: async () => {},
            };
            return {
                close: async () => {
                    await close?.(index);
                    if (!closed) {
                        live--;
                        closed = true;
                        events.push(`close:${index}`);
                    }
                },
                newPage: async () => page,
            };
        },
        _ensureBrowser: async () => {},
        _isContextIdle: () => !busy,
        _releaseContextCapacity: index => browser.contextCapacityReservations.delete(index),
        browserGeneration: 1,
        config: { maxContexts: 1 },
        contextCapacityReservations: new Map(),
        contexts: new Map(),
        initializingContexts: new Set(),
        isContextReady: () => true,
        targetUrl: "https://fixture.invalid",
    };
    if (!temporary)
        for (const account of accounts)
            browser.contexts.set(account.authIndex, {
                page: { accountSessionVersion: 1, buildBenefit: benefits[account.authIndex] },
            });
    service.system.browserManager = browser;
    const queue = new BenefitCheckQueue(service, { operationMs: 100, queryMs: 100, waitMs: 500 });
    service.benefitQueue = queue;
    t.after(() => queue.close());
    return {
        accounts,
        benefits,
        browser,
        events,
        queue,
        service,
        setBusy(value) {
            busy = value;
        },
        stats: () => ({ live, maxLive }),
        submit: ids => service.exclusive(() => queue.submit(ids)),
    };
}

test("deduplicates, reuses idle pages, serializes batches and keeps account operations responsive", async t => {
    let release;
    const f = fixture(t, {
        query: account =>
            account.authIndex === 0
                ? new Promise(resolve => {
                      release = resolve;
                  })
                : null,
    });
    const response = await f.submit(["account-0", "account-1"]);
    assert.equal(response.results[0].status, "queued");
    await until(() => !!release);
    assert.equal((await f.submit(["account-0"])).results[0].status, "duplicate");
    await f.service.exclusive(() => {
        f.accounts[0].manualTier = "ultra";
    });
    assert.deepEqual(
        f.events.filter(event => event.startsWith("query:")),
        ["query:0"]
    );
    release();
    await until(() => f.service.state.benefitTasks.every(task => task.finishedAt));
    assert.deepEqual(
        f.events.filter(event => event.startsWith("query:")),
        ["query:0", "query:1"]
    );
    assert.equal(
        f.events.some(event => event.startsWith("create:")),
        false
    );
    assert.equal(f.accounts[0].manualTier, "ultra");
    assert.equal(f.accounts[0].benefitObservation.rawTier, "TIER1");
    assert.equal(f.browser.contexts.size, 3);
    assert.equal(f.browser.benefitCheckingIndices.size, 0);
});

test("temporary contexts use independent storage and one overflow slot shared across batches", async t => {
    const f = fixture(t, { full: true, temporary: true });
    await f.submit(["account-0", "account-1"]);
    await f.submit(["account-1", "account-2"]);
    await until(
        () => f.service.state.benefitTasks.length === 3 && f.service.state.benefitTasks.every(task => task.finishedAt)
    );
    assert.deepEqual(
        f.events.filter(event => /^(create|query|close):/.test(event)),
        ["create:0:0", "query:0", "close:0", "create:1:1", "query:1", "close:1", "create:2:2", "query:2", "close:2"]
    );
    assert.deepEqual(f.stats(), { live: 0, maxLive: 1 });
    assert.equal(f.browser.contexts.size, 0);
    assert.equal(f.browser.contextCapacityReservations.size, 0);
    assert.equal(f.service.state.tasks.length, 0);
});

test("busy/login accounts wait with a deadline; waiting and running tasks can be cancelled", async t => {
    const f = fixture(t);
    f.setBusy(true);
    await f.submit(["account-0", "account-1"]);
    await until(() => f.service.state.benefitTasks[0].status === "waiting");
    await f.service.exclusive(() => f.queue.cancel(["account-0", "account-1"]));
    await until(() => !f.queue.running);
    assert.equal(
        f.events.some(event => event.startsWith("query:")),
        false
    );
    assert.ok(f.service.state.benefitTasks.every(task => task.status === "cancelled"));
    f.queue.waitMs = 20;
    await f.submit(["account-2"]);
    await until(() => f.queue.latest("account-2").finishedAt);
    assert.equal(f.queue.latest("account-2").reason, "resource_wait_timeout");
    f.setBusy(false);
    f.service.state.tasks.push({ accountId: "account-0", status: "running" });
    await f.submit(["account-0"]);
    await until(() => f.queue.latest("account-0").finishedAt);
    assert.equal(f.queue.latest("account-0").reason, "resource_wait_timeout");
});

test("cancellation and session replacement discard late results and release a temporary context", async t => {
    let release;
    const f = fixture(t, {
        query: () =>
            new Promise(resolve => {
                release = resolve;
            }),
        temporary: true,
    });
    await f.submit(["account-0"]);
    await until(() => !!release);
    await f.service.exclusive(() => f.queue.cancel(["account-0"]));
    await until(() => f.stats().live === 0 && !f.queue.running);
    release();
    await wait(10);
    assert.equal(f.accounts[0].benefitObservation, undefined);
    assert.equal(f.queue.latest("account-0").status, "cancelled");
    release = null;
    await f.submit(["account-1"]);
    await until(() => !!release);
    f.accounts[1].sessionVersion++;
    release();
    await until(() => !f.queue.running);
    assert.equal(f.accounts[1].benefitObservation, undefined);
    assert.equal(f.stats().live, 0);
});

test("a slow late context creation blocks the overflow slot until cleanup settles", async t => {
    let release;
    const f = fixture(t, {
        create: index =>
            index === 0
                ? new Promise(resolve => {
                      release = resolve;
                  })
                : null,
        full: true,
        temporary: true,
    });
    f.queue.operationMs = 20;
    await f.submit(["account-0", "account-1"]);
    await until(() => f.queue.latest("account-0").finishedAt);
    assert.equal(f.queue.latest("account-0").status, "failed");
    assert.equal(
        f.events.some(event => event.startsWith("create:1")),
        false
    );
    release();
    await until(() => f.queue.latest("account-1").finishedAt);
    assert.deepEqual(f.stats(), { live: 0, maxLive: 1 });
});

test("input bounds and missing authentication are enforced without automatic login", async t => {
    const f = fixture(t);
    await assert.rejects(f.submit([]), /1–500/);
    await assert.rejects(f.submit(Array(501).fill("account-0")), /1–500/);
    f.accounts[0].sessionState = "missing";
    const result = await f.submit(["account-0", "deleted"]);
    assert.deepEqual(
        result.results.map(item => item.reason),
        ["authentication_unavailable", "account_not_found"]
    );
    assert.equal(f.service.state.benefitTasks.length, 0);
    assert.equal(f.service.state.tasks.length, 0);
});

test("one failure preserves the previous success and allows the next account to finish", async t => {
    const f = fixture(t, {
        query: account => {
            if (account.authIndex === 0) throw new Error("fixture upstream failure");
        },
        temporary: true,
    });
    const previous = { rawTier: "TIER2", sessionVersion: 1, source: "native", state: "ready-paid" };
    f.accounts[0].benefitObservation = previous;
    await f.submit(["account-0", "account-1"]);
    await until(() => f.service.state.benefitTasks.every(task => task.finishedAt));
    assert.deepEqual(f.accounts[0].benefitObservation, previous);
    assert.equal(f.accounts[0].benefitLastCheck.status, "failed");
    assert.equal(f.queue.latest("account-0").status, "failed");
    assert.equal(f.queue.latest("account-1").status, "succeeded");
    assert.equal(f.stats().live, 0);
});

test("browser replacement cancels an old query and releases the executor for the next task", async t => {
    let release;
    const f = fixture(t, {
        query: account =>
            account.authIndex === 0
                ? new Promise(resolve => {
                      release = resolve;
                  })
                : null,
        temporary: true,
    });
    await f.submit(["account-0", "account-1"]);
    await until(() => !!release);
    f.browser.browserGeneration++;
    await until(() => f.service.state.benefitTasks.every(task => task.finishedAt));
    assert.equal(f.accounts[0].benefitObservation, undefined);
    assert.equal(f.queue.latest("account-0").status, "cancelled");
    assert.equal(f.queue.latest("account-1").status, "succeeded");
    assert.equal(f.stats().live, 0);
    release();
});

test("an existing recovering page waits for readiness before reuse", async t => {
    const f = fixture(t);
    let ready = false;
    f.browser.isContextReady = () => ready;
    await f.submit(["account-0"]);
    await until(() => f.queue.latest("account-0").status === "waiting");
    await wait(20);
    assert.equal(
        f.events.some(event => event.startsWith("query:")),
        false
    );
    assert.equal(
        f.events.some(event => event.startsWith("create:")),
        false
    );
    ready = true;
    await until(() => f.queue.latest("account-0").finishedAt);
    assert.equal(f.queue.latest("account-0").status, "succeeded");
});
