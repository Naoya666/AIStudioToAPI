const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConfigurationService, atomicWrite } = require("../src/config/ConfigurationService");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const RequestHandler = require("../src/core/RequestHandler");
const { ScheduledRequestHandler } = require("../src/core/ScheduledRequestHandler");
const BrowserManager = require("../src/core/BrowserManager");
const { canUseModel, resolveTier } = require("../src/accounts/AccountTierPolicy");
const {
    catalogModels,
    initialPolicy,
    LEVELS,
    PAID_MODELS,
    parsePolicy,
} = require("../src/accounts/ModelAllowlistPolicy");
const logger = { debug() {}, error() {}, info() {}, setDisplayLimit() {}, warn() {} };
const basicModels = [
    ...PAID_MODELS,
    "gemini-3.5-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-3.1-pro-preview",
    "text-embedding-004",
    "imagen-4",
];
function fixture(t, env = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-allowlist-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    fs.mkdirSync(path.join(directory, "configs"));
    const setModels = names =>
        fs.writeFileSync(
            path.join(directory, "configs/models.json"),
            JSON.stringify({ models: names.map(name => ({ name: `models/${name}` })) })
        );
    setModels(basicModels);
    const inDirectory = fn => {
        const previous = process.cwd();
        try {
            process.chdir(directory);
            return fn();
        } finally {
            process.chdir(previous);
        }
    };
    const file = path.join(directory, "data/managed-config.json");
    const system = { logger, ready: true };
    const create = (target = system, options = {}) =>
        inDirectory(() => new ConfigurationService(target, { env, file, ...options }));
    const service = create();
    system.configurationService = service;
    const save = policy =>
        inDirectory(() =>
            service.save({ changes: { MODEL_TIER_ALLOWLIST: policy }, version: service.document.version })
        );
    return { create, directory, file, inDirectory, save, service, setModels, system };
}
function schedulerFor(t, fixture, tiers = ["free", "pro", "ultra", "ultra20", null]) {
    const metadata = tiers.map((manualTier, authIndex) => ({ authIndex, manualTier }));
    const auth = {
        accountLoginService: { state: { accounts: metadata } },
        accountNameMap: new Map(),
        getRotationIndices: () => metadata.map(account => account.authIndex),
    };
    const config = fixture.service.running.scheduler;
    config.statePath = null;
    config.readyContextOnly = false;
    config.contextPoolMinReady = 0;
    const scheduler = new ModelScheduler(config, auth, logger);
    fixture.system.scheduler = scheduler;
    fixture.system.authSource = auth;
    t.after(() => scheduler.close());
    return { auth, metadata, scheduler };
}
const clone = value => structuredClone(value);

test("initial policy opens every existing model except the three Free restrictions, including untested models", () => {
    const policy = initialPolicy([...basicModels, "untested-model", "__files__", "anti-gemini-3.5-flash"]);
    assert.deepEqual(catalogModels(["models/gemini-3.5-flash", "__files__", "anti-gemini-3.5-flash"]), [
        "gemini-3.5-flash",
    ]);
    for (const tier of [null, ...LEVELS]) {
        for (const model of [...basicModels, "untested-model"]) {
            assert.equal(
                canUseModel({ manualTier: tier }, `models/${model}`, policy),
                !PAID_MODELS.includes(model) || (tier !== null && tier !== "free")
            );
        }
    }
    assert.equal(resolveTier({}).effectiveTier, null);
    for (const tier of [null, "free"]) {
        for (const model of PAID_MODELS) {
            assert.equal(canUseModel({ manualTier: tier }, `models/anti-${model}-high-real-search`, policy), false);
        }
    }
    assert.equal(canUseModel({}, "__files__", policy), true);
    assert.equal(canUseModel({ manualTier: "pro" }, "new-model", policy), false);
});

test("policy validation rejects malformed input and normalizes equivalent model IDs", () => {
    const policy = initialPolicy(basicModels);
    policy.tiers.free.push("models/gemini-3.5-flash", "anti-gemini-3.5-flash-real");
    assert.equal(parsePolicy(policy).tiers.free.filter(model => model === "gemini-3.5-flash").length, 1);
    for (const value of [
        null,
        "{",
        {},
        { ...policy, version: 2 },
        { ...policy, tiers: { ...policy.tiers, extra: [] } },
        { ...policy, tiers: { free: [] } },
    ])
        assert.throws(() => parsePolicy(value));
    for (const model of ["*", "gemini-*", "__files__", "", null, 1]) {
        const invalid = clone(policy);
        invalid.tiers.free.push(model);
        assert.throws(() => parsePolicy(invalid));
    }
});

test("migration persists once, model additions require explicit authorization, empty policies survive restart", t => {
    const f = fixture(t);
    const saved = clone(f.service.saved.scheduler.modelAllowlist);
    const version = f.service.document.version;
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).overrides.MODEL_TIER_ALLOWLIST, saved);
    f.setModels([...basicModels, "new-untested"]);
    const restarted = f.create({ logger });
    assert.equal(restarted.document.version, version);
    assert.deepEqual(restarted.saved.scheduler.modelAllowlist, saved);
    assert.equal(canUseModel({ manualTier: "pro" }, "new-untested", restarted.running.scheduler.modelAllowlist), false);
    const empty = { tiers: Object.fromEntries(LEVELS.map(tier => [tier, []])), version: 1 };
    f.save(empty);
    assert.deepEqual(f.create({ logger }).running.scheduler.modelAllowlist, empty);
    assert.throws(
        () =>
            f.inDirectory(() =>
                f.service.save({ reset: ["MODEL_TIER_ALLOWLIST"], version: f.service.document.version })
            ),
        /不支持重置/
    );
});

test("saved permissions are independent across tiers, reject unregistered additions and preserve stale entries until cleanup", t => {
    const f = fixture(t);
    const policy = clone(f.service.running.scheduler.modelAllowlist);
    policy.tiers.pro = [];
    f.save(policy);
    assert.equal(
        canUseModel({ manualTier: "pro" }, "gemini-3.6-flash", f.service.running.scheduler.modelAllowlist),
        false
    );
    assert.equal(
        canUseModel({ manualTier: "ultra" }, "gemini-3.6-flash", f.service.running.scheduler.modelAllowlist),
        true
    );
    policy.tiers.free.push("never-registered");
    assert.throws(() => f.save(policy), /未登记的模型/);
    assert.equal(f.service.running.scheduler.modelAllowlist.tiers.free.includes("never-registered"), false);
    f.setModels(basicModels.filter(model => model !== "gemini-3.5-flash"));
    const restarted = f.create({ logger });
    const retained = clone(restarted.running.scheduler.modelAllowlist);
    assert.ok(retained.tiers.free.includes("gemini-3.5-flash"));
    f.inDirectory(() =>
        restarted.save({ changes: { MODEL_TIER_ALLOWLIST: retained }, version: restarted.document.version })
    );
    assert.throws(
        () =>
            f.inDirectory(() =>
                restarted.save({
                    changes: { MODEL_TIER_ALLOWLIST: { ...retained, version: 9 } },
                    version: restarted.document.version,
                })
            ),
        /version/
    );
});

test("invalid persisted policy fails closed and recovery retains the latest explicit permissions", t => {
    const f = fixture(t);
    atomicWrite(path.join(f.directory, "data/managed-config.last-good.json"), f.service.runningDocument());
    const policy = clone(f.service.running.scheduler.modelAllowlist);
    policy.tiers.free = [];
    f.save(policy);
    const recovered = f.create({ logger }, { env: { AISTUDIO_CONFIG_RECOVERY: "1" } });
    assert.deepEqual(recovered.running.scheduler.modelAllowlist, policy);
    const corrupt = JSON.parse(fs.readFileSync(f.file));
    corrupt.overrides.MODEL_TIER_ALLOWLIST.version = 2;
    atomicWrite(f.file, corrupt);
    assert.throws(() => f.create({ logger }), /version/);
});

test("tier policy filters selection and unknown models, while hot revocation rejects queued requests without ending active leases", async t => {
    const f = fixture(t);
    const { scheduler } = schedulerFor(t, f, ["free", "pro"]);
    const paid = await scheduler.acquire("models/anti-gemini-3.6-flash-high-real-search");
    assert.equal(paid.account.index, 1);
    scheduler.release(paid);
    await assert.rejects(scheduler.acquire("not-in-directory"), { code: "UNKNOWN_MODEL", status: 404 });
    const active = await scheduler.acquire("gemini-3.5-flash");
    const queued = scheduler.acquire("gemini-3.5-flash");
    const rejected = assert.rejects(queued, { code: "MODEL_TIER_DENIED", status: 403 });
    const policy = clone(f.service.running.scheduler.modelAllowlist);
    for (const tier of LEVELS) policy.tiers[tier] = policy.tiers[tier].filter(model => model !== "gemini-3.5-flash");
    f.save(policy);
    await rejected;
    assert.equal(active.released, false);
    assert.equal(scheduler.pending.length, 0);
    scheduler.release(active);
    const denied = clone(f.service.running.scheduler.modelAllowlist);
    denied.tiers.pro = [];
    f.save(denied);
    await assert.rejects(scheduler.acquire("gemini-3.6-flash"), { code: "MODEL_TIER_DENIED" });
});

test("legacy and scheduled final sends recheck live permissions before writing or counting an attempt", async t => {
    const f = fixture(t);
    const { scheduler, auth } = schedulerFor(t, f, ["free"]);
    let sends = 0;
    const registry = { getConnectionByAuth: () => ({ send: () => sends++ }) };
    const legacy = new RequestHandler(f.system, registry, logger, {}, f.system.config, auth);
    const proxy = { body: "{}", path: "/v1beta/models/gemini-3.5-flash:generateContent", request_id: "test" };
    legacy.authSwitcher.currentAuthIndex = 0;
    const lease = await scheduler.acquire("gemini-3.5-flash");
    const scheduled = Object.create(ScheduledRequestHandler.prototype);
    Object.assign(scheduled, {
        _config: f.system.config,
        authSource: auth,
        browserManager: {},
        connectionRegistry: registry,
        controller: new AbortController(),
        lease,
        logger,
        scheduler,
        serverSystem: f.system,
    });
    await legacy.withConfigurationSnapshot(async () => {
        const policy = clone(f.service.running.scheduler.modelAllowlist);
        policy.tiers.free = [];
        f.save(policy);
        assert.throws(() => legacy._forwardRequest(proxy, 0), { code: "MODEL_TIER_DENIED" });
        assert.throws(() => scheduled._forwardRequest(proxy, 0), { code: "MODEL_TIER_DENIED" });
        await assert.rejects(legacy._ensureLegacyBenefit(proxy), { code: "MODEL_TIER_DENIED" });
    });
    assert.equal(sends, 0);
    assert.equal(lease.attempted, false);
    assert.equal(lease.slot.daily_request_count, 0);
    assert.equal(scheduler.account(0).healthy, true);
    scheduler.release(lease);
});

test("quota totals agree across projections, retain historical usage and exclude unqualified accounts", t => {
    const f = fixture(t);
    const { scheduler } = schedulerFor(t, f);
    const model = "gemini-3.6-flash";
    for (const index of f.system.authSource.getRotationIndices()) {
        Object.assign(scheduler.slot(scheduler.account(index), model), {
            daily_request_count: 3,
            daily_request_date: scheduler.getPacificDateKey(Date.now()),
        });
    }
    const admin = scheduler.summarySnapshot();
    const quota = admin.quota_by_model.find(row => row.model === model);
    const publicModel = scheduler.publicSummarySnapshot().models.find(row => row.model === model);
    assert.equal(quota.total_quota, 1100);
    assert.equal(quota.tracked_accounts, 3);
    assert.equal(quota.daily_requests, 15);
    assert.equal(publicModel.estimatedRemaining, quota.estimated_remaining_quota);
    assert.equal(publicModel.tierAllowedAccounts, 3);
    assert.equal(admin.models.find(row => row.model === model).tier_allowed_accounts, 3);
    const policy = clone(f.service.running.scheduler.modelAllowlist);
    policy.tiers.pro = [];
    f.save(policy);
    const next = scheduler.summarySnapshot().quota_by_model.find(row => row.model === model);
    assert.equal(next.total_quota, 1000);
    assert.equal(next.daily_requests, 15);
    assert.equal(
        scheduler.publicSummarySnapshot().models.find(row => row.model === "text-embedding-004").estimatedRemaining,
        null
    );
});

test("pool eligibility ignores unauthorized models and drains empty permissions using a distinct reason", async t => {
    const f = fixture(t);
    const { scheduler } = schedulerFor(t, f, ["free"]);
    const policy = clone(f.service.running.scheduler.modelAllowlist);
    policy.tiers.free = ["gemini-3.5-flash"];
    f.save(policy);
    const account = scheduler.account(0);
    Object.assign(scheduler.slot(account, "gemini-3.5-flash"), {
        cooldown_until: Date.now() + 60000,
        rate_limited: true,
    });
    assert.equal(scheduler.isAccountQuotaExhausted(account), true);
    assert.equal(scheduler.isAccountPoolResident(0), false);
    policy.tiers.free = [];
    f.save(policy);
    assert.equal(scheduler.isAccountQuotaExhausted(account), false);
    assert.equal(scheduler.accountPoolRestriction(account), "model_permissions_empty");
    const drains = [];
    const manager = Object.create(BrowserManager.prototype);
    const data = {};
    Object.assign(manager, {
        _canKeepPooledContext: () => false,
        _pumpContextPool() {},
        beginAccountDrain: (index, reason) => {
            data.draining = true;
            drains.push({ index, reason });
        },
        contextDemand: new Map(),
        contexts: new Map([[0, data]]),
        handleAccountLeaseReleased() {},
        initializingContexts: new Set(),
        logger,
        pendingContextClosures: new Map(),
        scheduler,
    });
    manager.reconcileContextPool();
    assert.deepEqual(drains, [{ index: 0, reason: "model_permissions_empty" }]);
    assert.equal(account.models["gemini-3.5-flash"].rate_limited, true);
    policy.tiers.free = ["gemini-3.5-flash", "gemini-3.7-flash"];
    f.save(policy);
    scheduler.slot(account, "gemini-3.7-flash").unsupported = true;
    assert.equal(scheduler.accountPoolRestriction(account), "models_unavailable");
});

test("permission persistence failures leave live policy unchanged and snapshots do not apply saved targets", t => {
    const f = fixture(t);
    const before = clone(f.service.running.scheduler.modelAllowlist);
    const target = clone(before);
    target.tiers.free = [];
    const blocker = path.join(f.directory, "blocked");
    fs.writeFileSync(blocker, "file");
    f.service.file = path.join(blocker, "managed-config.json");
    assert.throws(() => f.save(target));
    assert.deepEqual(f.service.running.scheduler.modelAllowlist, before);
    f.service.file = f.file;
    f.service.saved.scheduler.modelAllowlist = target;
    f.service.snapshot();
    assert.deepEqual(f.service.running.scheduler.modelAllowlist, before);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).overrides.MODEL_TIER_ALLOWLIST, before);
});

test("environment bootstrap is persisted once and later environment changes do not overwrite managed permissions", t => {
    const policy = initialPolicy(basicModels);
    policy.tiers.free = [];
    const f = fixture(t, { MODEL_TIER_ALLOWLIST: JSON.stringify(policy) });
    assert.deepEqual(f.service.running.scheduler.modelAllowlist, policy);
    const changedEnv = initialPolicy(basicModels);
    const restarted = f.create({ logger }, { env: { MODEL_TIER_ALLOWLIST: JSON.stringify(changedEnv) } });
    assert.deepEqual(restarted.running.scheduler.modelAllowlist, policy);
});
