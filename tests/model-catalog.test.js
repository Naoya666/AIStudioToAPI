const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const Catalog = require("../src/core/ModelCatalog");
const Anti = require("../src/core/AntiTruncation");
const { ConfigurationService } = require("../src/config/ConfigurationService");
const ConfigurationRoutes = require("../src/config/ConfigurationRoutes");
const { ModelScheduler, getModelDailyQuota } = require("../src/core/ModelScheduler");
const { dailyBudgets } = require("../src/accounts/QuotaPolicy");
const logger = { debug() {}, error() {}, info() {}, setDisplayLimit() {}, warn() {} };
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-catalog-"));
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
    const system = { logger, ready: true };
    const file = path.join(dir, "managed-config.json");
    const service = new ConfigurationService(system, { env: {}, file });
    system.configurationService = service;
    return { dir, file, service, system };
}
test("new models inherit every generic feature, aliases share overrides, boundaries are effective", () => {
    const row = { features: {}, name: "models/new-model" };
    const config = { modelList: [row] };
    assert.ok(Object.values(Catalog.features(config.modelList, row.name)).every(Boolean));
    for (const protocol of ["openai", "responses", "claude", "gemini"])
        assert.doesNotThrow(() =>
            Catalog.assertRequest(config, row.name, protocol, { stream: true, tools: [{ type: "function" }] })
        );
    assert.equal(Anti.resolve({ model: "anti-new-model" }, config).enabled, true);
    const samples = {
        claude: {},
        gemini: {},
        hostedTools: { tools: [{ googleSearch: {} }] },
        multimodal: { messages: [{ content: [{ source: {}, type: "image" }] }] },
        openai: {},
        responses: {},
        streaming: { stream: true },
        structuredOutput: { response_format: { type: "json_object" } },
        thinking: { reasoning_effort: "high" },
        tools: { tools: [{ type: "function" }] },
    };
    for (const [feature, body] of Object.entries(samples)) {
        row.features = { [feature]: false };
        const protocol = ["openai", "responses", "claude", "gemini"].includes(feature) ? feature : "openai";
        assert.throws(() => Catalog.assertRequest(config, "anti-new-model-high-real", protocol, body), { status: 400 });
    }
    row.features = { antiTruncation: false };
    assert.throws(() => Anti.resolve({ model: "anti-new-model" }, config), {
        code: "anti_truncation_unsupported_model",
    });
    assert.equal(Anti.resolve({ model: "new-model" }, { ...config, antiTruncationDefault: "prefer" }).enabled, false);
    row.features = { antiCombinations: false };
    assert.throws(() => Anti.resolve({ model: "anti-new-model", response_format: {} }, config), { status: 400 });
    row.features = {};
    assert.equal(Anti.resolve({ model: "anti-new-model", response_format: {} }, config).enabled, true);
});
test("dynamic Build entries retain discoverable ST, thinking, and anti aliases", () => {
    const names = Catalog.advertisedModels([{ name: "models/build/new-model" }]).map(row => row.name);
    assert.ok(names.includes("models/build-st/new-model-high"));
    assert.ok(names.includes("models/anti-build/new-model"));
    assert.equal(new Set(names).size, names.length);
    assert.ok(
        !Catalog.advertisedModels([{ features: { antiTruncation: false }, name: "models/build/new-model" }]).some(row =>
            row.name.includes("anti-")
        )
    );
});
test("catalog validation rejects ambiguous IDs, duplicate rows, invalid features and quotas", () => {
    for (const rows of [
        [],
        [{ name: "models/new-model" }, { name: "new-model" }],
        [{ name: "anti-new-model" }],
        [{ features: { tools: "false" }, name: "new-model" }],
        [{ features: { unknown: true }, name: "new-model" }],
        [{ name: "new-model", quotas: { free: { requests: -1 } } }],
        [{ name: "new-model", quotas: { free: { tokens: 0.1 } } }],
    ])
        assert.throws(() => Catalog.validate(rows), { status: 400 });
    assert.doesNotThrow(() =>
        Catalog.validate([{ name: "build/new-model", quotas: { free: { requests: null, tokens: 0 } } }])
    );
});
test("adding and deleting models updates runtime registration, permissions, quotas and restart state atomically", t => {
    const { service, system, file } = fixture(t);
    const row = { features: {}, name: "models/new-model", quotas: { pro: { requests: 27, tokens: 999 } } };
    const permissions = structuredClone(service.running.scheduler.modelAllowlist);
    permissions.tiers.pro.push("new-model");
    const version = service.document.version;
    const rows = [...service.running.modelList, row];
    const oldCatalog = service.running.modelList;
    service.save({ changes: { MODEL_CATALOG: rows, MODEL_TIER_ALLOWLIST: permissions }, version });
    assert.ok(system.config.scheduler.registeredModels.includes("new-model"));
    assert.equal(
        oldCatalog.some(item => item.name === row.name),
        false
    );
    assert.equal(getModelDailyQuota("new-model", { manualTier: "pro" }, system.config.scheduler.modelCatalog), 27);
    assert.equal(dailyBudgets("new-model", "pro", { catalog: rows }).tokens, 999);
    assert.throws(() => service.save({ changes: { MODEL_CATALOG: rows }, version }), { status: 409 });
    const restarted = new ConfigurationService({ logger }, { env: {}, file });
    assert.deepEqual(restarted.running.modelList, rows);
    assert.ok(restarted.running.scheduler.modelAllowlist.tiers.pro.includes("new-model"));
    service.save({ changes: { MODEL_CATALOG: rows.filter(item => item !== row) }, version: service.document.version });
    assert.equal(system.config.scheduler.registeredModels.includes("new-model"), false);
    assert.equal(system.config.scheduler.modelAllowlist.tiers.pro.includes("new-model"), false);
});
test("unknown and zero quota values remain distinct, token-only overrides preserve request estimates", () => {
    const row = { name: "gemini-3.8-flash", quotas: { pro: { tokens: 0 } } };
    assert.equal(getModelDailyQuota(row.name, { manualTier: "pro" }, [row]), 150);
    row.quotas.pro.requests = null;
    assert.equal(getModelDailyQuota(row.name, { manualTier: "pro" }, [row]), null);
    row.quotas.pro.requests = 0;
    assert.equal(getModelDailyQuota(row.name, { manualTier: "pro" }, [row]), 0);
    assert.equal(dailyBudgets(row.name, "pro", { catalog: [row] }).tokens, 0);
    assert.equal(
        getModelDailyQuota("New-Model", { manualTier: "pro" }, [
            { name: "New-Model", quotas: { pro: { requests: 7 } } },
        ]),
        7
    );
});
test("scheduler hot registration and visibility share the managed catalog", t => {
    const { service, system, dir } = fixture(t);
    service.running.scheduler.statePath = path.join(dir, "scheduler.json");
    const scheduler = new ModelScheduler(
        service.running.scheduler,
        { accountNameMap: new Map(), getRotationIndices: () => [] },
        logger
    );
    system.scheduler = scheduler;
    t.after(() => scheduler.close());
    const rows = [...service.running.modelList, { enabled: false, name: "new-model" }];
    service.save({ changes: { MODEL_CATALOG: rows }, version: service.document.version });
    assert.throws(() => scheduler.assertModelAccessible("new-model"), { code: "MODEL_DISABLED" });
    rows.at(-1).enabled = true;
    service.save({ changes: { MODEL_CATALOG: rows }, version: service.document.version });
    assert.equal(scheduler.assertModelAccessible("new-model"), "new-model");
    scheduler.hideModel("new-model");
    assert.throws(() => scheduler.assertModelAccessible("new-model"), { code: "MODEL_DISABLED" });
});
test("legacy dashboard visibility writes the same managed model policy", t => {
    const { service, system, dir } = fixture(t);
    service.running.scheduler.statePath = path.join(dir, "scheduler.json");
    system.scheduler = new ModelScheduler(
        service.running.scheduler,
        {
            accountNameMap: new Map(),
            getRotationIndices: () => [],
        },
        logger
    );
    t.after(() => system.scheduler.close());
    service.save({
        changes: {
            MODEL_CATALOG: [...service.running.modelList, { enabled: false, name: "new-model" }],
        },
        version: service.document.version,
    });
    const routes = Object.create(require("../src/routes/StatusRoutes").prototype);
    routes.serverSystem = system;
    routes._setModelVisibility("new-model", true);
    assert.equal(system.scheduler.assertModelAccessible("new-model"), "new-model");
    assert.equal(service.running.modelList.at(-1).enabled, true);
    routes._setModelVisibility("new-model", false);
    assert.throws(() => system.scheduler.assertModelAccessible("new-model"), { code: "MODEL_DISABLED" });
    assert.equal(service.running.modelList.at(-1).enabled, false);
});
test("managed visibility wins over stale scheduler-state after restart", t => {
    const { service, dir } = fixture(t);
    service.save({
        changes: { MODEL_CATALOG: [{ enabled: true, name: "new-model" }] },
        version: service.document.version,
    });
    service.running.scheduler.statePath = path.join(dir, "scheduler.json");
    fs.writeFileSync(
        service.running.scheduler.statePath,
        JSON.stringify({ accounts: [], fileAffinities: [], hiddenModels: ["new-model"], version: 8 })
    );
    const scheduler = new ModelScheduler(
        service.running.scheduler,
        { accountNameMap: new Map(), getRotationIndices: () => [] },
        logger
    );
    t.after(() => scheduler.close());
    assert.equal(scheduler.assertModelAccessible("new-model"), "new-model");
});
test("failed model hot apply rolls back catalog, visibility, policy and persisted version", t => {
    const { service, system, file } = fixture(t);
    const previous = structuredClone(service.running.modelList),
        version = service.document.version;
    const hiddenModels = new Set(["gemini-2.5-pro"]);
    let fail = true;
    system.scheduler = {
        hiddenModels,
        permissionsChanged() {
            if (fail) {
                fail = false;
                throw new Error("apply failed");
            }
        },
    };
    assert.throws(
        () => service.save({ changes: { MODEL_CATALOG: [...previous, { name: "new-model" }] }, version }),
        /已恢复配置/
    );
    assert.deepEqual(service.running.modelList, previous);
    assert.deepEqual(system.scheduler.hiddenModels, new Set(["gemini-2.5-pro"]));
    assert.equal(service.running.scheduler.registeredModels.includes("new-model"), false);
    assert.equal(JSON.parse(fs.readFileSync(file)).version, version);
});

test("model management HTTP endpoints require authentication and reject stale or malformed writes", async t => {
    const { service, system } = fixture(t);
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    new ConfigurationRoutes(system).setupRoutes(app, (req, res, next) =>
        req.headers.authorization === "test" ? next() : res.sendStatus(401)
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/model-catalog`;
    assert.equal((await fetch(url)).status, 401);
    const snapshot = await (await fetch(url, { headers: { authorization: "test" } })).json();
    snapshot.rows.push({ enabled: true, name: "models/new-model" });
    snapshot.permissions.tiers.free.push("new-model");
    const patch = body =>
        fetch(url, {
            body: JSON.stringify(body),
            headers: { authorization: "test", "content-type": "application/json" },
            method: "PATCH",
        });
    assert.equal((await patch(snapshot)).status, 200);
    assert.ok(service.running.scheduler.registeredModels.includes("new-model"));
    assert.equal((await patch(snapshot)).status, 409);
    snapshot.version = service.document.version;
    snapshot.rows.at(-1).features = { tools: 1 };
    assert.equal((await patch(snapshot)).status, 400);
    assert.equal(service.running.modelList.at(-1).features, undefined);
});
