const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { aggregate } = require("../src/public/PublicDashboardAggregator");
const Collector = require("../src/public/PublicDashboardCollector");
const { defaults, nodeId, normalizeAgents } = require("../src/public/DashboardConfig");
const {
    counters,
    publicStats,
    ranges,
    timezone,
    usageDate,
    validateEnvelope,
} = require("../src/public/DashboardProtocol");
const { ConfigurationService } = require("../src/config/ConfigurationService");
const ConfigLoader = require("../src/utils/ConfigLoader");
const PublicDashboardService = require("../src/public/PublicDashboardService");
const UsageStatsService = require("../src/core/UsageStatsService");
const logger = { error() {}, info() {}, setDisplayLimit() {}, warn() {} };
const clone = value => JSON.parse(JSON.stringify(value));
function envelope(id, now = Date.now(), options = {}) {
    const raw = counters(
        options.statsStatus || "available",
        options.total ?? 100,
        options.success ?? 90,
        (options.total ?? 100) - (options.success ?? 90),
        options.duration ?? 10000
    );
    const models = (options.models || ["flash"]).map(model => ({
        history: publicStats(raw),
        model,
        quota: { estimable: !options.unknownQuota, estimated_remaining: options.unknownQuota ? null : 100 },
        realtime: { active: 1, available_accounts: 2, queued: 3, rate_limited_accounts: 1 },
        recent_stats: Object.fromEntries(ranges.map(range => [range, publicStats(raw)])),
        today: { requests: 7 },
    }));
    return {
        agent_schema_version: 1,
        aggregation: {
            history: raw,
            models: models.map(model => ({
                history: raw,
                model: model.model,
                recent_stats: Object.fromEntries(ranges.map(range => [range, raw])),
            })),
        },
        generated_at: new Date(now).toISOString(),
        node_id: id,
        service_status: options.serviceStatus || "ready",
        snapshot: {
            generated_at: new Date(now).toISOString(),
            history: { enabled: options.statsStatus !== "disabled", ...publicStats(raw) },
            model_stat_windows: Object.fromEntries(
                ranges.map(range => [
                    range,
                    {
                        from: new Date(now - (range === "24h" ? 86400000 : 3600000)).toISOString(),
                        status: options.statsStatus || "available",
                        to: new Date(now).toISOString(),
                    },
                ])
            ),
            models,
            realtime: { active: 1, limit: 4, queued: 3 },
            schema_version: 1,
            usage_window: { date: usageDate(now), timezone },
        },
        snapshot_sequence: 1,
    };
}
const entries = (...bodies) => bodies.map(body => ({ body, failed: false }));

test("cluster aggregates raw counters, whitelists output and weights request durations", () => {
    const now = Date.now();
    const a = envelope("a", now, { duration: 2000, success: 0, total: 1 });
    const b = envelope("b", now - 500, { duration: 99000, models: ["flash", "pro"], success: 99, total: 99 });
    a.snapshot.models[0].secret = "DO_NOT_EXPOSE";
    a.snapshot.secret = "DO_NOT_EXPOSE";
    const result = aggregate(entries(a, b), now);
    assert.equal(result.history.total_requests, 100);
    assert.equal(result.history.success_rate, 99);
    assert.equal(result.history.average_duration_ms, 1010);
    assert.equal(result.models[0].recent_stats["1h"].average_duration_ms, 1010);
    assert.equal(result.models[0].quota.estimated_remaining, 200);
    assert.equal(result.models[1].quota.estimated_remaining, 100);
    assert.equal(result.models[0].today.requests, 14);
    assert.deepEqual(result.realtime, { active: 2, limit: 8, queued: 6 });
    assert.equal(result.cluster.status, "complete");
    assert.equal(result.cluster.oldest_source_at, b.generated_at);
    assert.equal(result.model_stat_windows["1h"].alignment, "approximate");
    assert.equal(result.model_stat_windows["1h"].from, undefined);
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE|node_id|snapshot_sequence|total_duration_ms/);
});

test("cluster excludes expired and recovering capacity, retaining model names and fresh history", () => {
    const now = Date.now();
    const active = envelope("active", now);
    const expired = envelope("old", now - 20001, { models: ["pro"] });
    const recovering = envelope("recovering", now, { serviceStatus: "unavailable" });
    const result = aggregate(entries(active, expired, recovering), now);
    assert.equal(result.cluster.fresh_nodes, 2);
    assert.equal(result.cluster.serving_nodes, 1);
    assert.equal(result.cluster.status, "partial");
    assert.equal(result.history.total_requests, 200);
    assert.equal(result.realtime.limit, 4);
    assert.equal(result.models[0].quota.estimable, false);
    assert.equal(result.models[0].quota.known_estimated_remaining, 100);
    assert.equal(result.models[1].quota.estimated_remaining, null);
    assert.equal(result.models[1].realtime.available_accounts, null);
    assert.equal(result.models[1].history.total_requests, null);
    assert.equal(aggregate(entries(expired), now), null);
    const partialFailure = aggregate([{ body: active, failed: true }], now);
    assert.equal(partialFailure.history.total_requests, 100);
    assert.equal(partialFailure.cluster.status, "partial");
    const unknown = aggregate(entries(active, null), now);
    assert.equal(unknown.models[0].quota.estimable, false);
});

test("cluster distinguishes zero, disabled, unknown quota, date rollover and overflow", () => {
    const now = Date.parse("2026-10-15T07:00:01Z");
    const today = envelope("today", now, { duration: 0, success: 0, total: 0, unknownQuota: true });
    const yesterday = envelope("yesterday", now - 2000);
    const result = aggregate(entries(today, yesterday), now);
    assert.equal(result.models[0].today.requests, 7);
    assert.equal(result.models[0].quota.known_estimated_remaining, null);
    assert.equal(result.coverage.today.status, "partial");
    const empty = aggregate(entries(today), now);
    assert.equal(empty.history.total_requests, 0);
    assert.equal(empty.history.success_rate, null);
    assert.equal(empty.history.average_duration_ms, null);
    const disabled = envelope("disabled", now, { statsStatus: "disabled" });
    const closed = aggregate(entries(disabled), now);
    assert.equal(closed.history.enabled, false);
    assert.equal(closed.history.status, "disabled");
    assert.equal(closed.model_stat_windows["1h"].status, "disabled");
    const missing = aggregate(entries(disabled, null), now);
    assert.equal(missing.history.status, "unavailable");
    const enormous = envelope("large", now, {
        duration: Number.MAX_SAFE_INTEGER,
        success: Number.MAX_SAFE_INTEGER,
        total: Number.MAX_SAFE_INTEGER,
    });
    const overflow = aggregate(entries(enormous, enormous), now);
    assert.equal(overflow.history.total_requests, null);
    assert.equal(overflow.coverage.history.status, "unavailable");
});

test("agent protocol rejects invalid identities, unsupported versions, future times and malformed counters", () => {
    const now = Date.now(),
        original = envelope("a", now);
    assert.equal(validateEnvelope(original, "a", now), original);
    const mutations = [
        body => (body.node_id = "other"),
        body => (body.agent_schema_version = 2),
        body => (body.generated_at = new Date(now + 6000).toISOString()),
        body => (body.snapshot.history = null),
        body => (body.aggregation.history.failed_requests = -1),
        body => body.snapshot.models.push(body.snapshot.models[0]),
        body => (body.aggregation.models = []),
        body => (body.snapshot.realtime.limit = 1.5),
        body => (body.snapshot.usage_window.timezone = "UTC"),
        body => (body.snapshot.model_stat_windows["1h"].from = new Date(now).toISOString()),
    ];
    for (const mutate of mutations) {
        const body = clone(original);
        mutate(body);
        assert.throws(() => validateEnvelope(body, "a", now));
    }
});

test("configuration validates roles, URLs and periods, persists IDs, and preserves masked tokens", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-config-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    assert.equal(nodeId(directory), nodeId(directory));
    const load = env => new ConfigLoader(logger).loadConfiguration(env).publicDashboard;
    assert.equal(load({}).role, "standalone");
    assert.throws(() => load({ PUBLIC_DASHBOARD_ENABLED: "true", PUBLIC_DASHBOARD_ROLE: "agent" }), /TOKEN/);
    assert.throws(() => load({ PUBLIC_DASHBOARD_STALE_AFTER_MS: "12000" }), /STALE/);
    assert.throws(() => load({ PUBLIC_DASHBOARD_POLL_INTERVAL_MS: "NaN" }), /POLL/);
    const agent = { name: "A", nodeId: "a", token: "SENSITIVE_AGENT_KEY", url: "https://example.org/prefix/" };
    assert.equal(normalizeAgents([agent])[0].url, "https://example.org/prefix");
    for (const url of [
        "file:///etc/passwd",
        "https://user:pass@example.org",
        "https://example.org/?token=secret",
        "https://example.org/#x",
        "https://example.org/?",
        "https://example.org/#",
    ])
        assert.throws(() => normalizeAgents([{ ...agent, url }]));
    assert.throws(() => normalizeAgents([agent, { ...agent, nodeId: "b" }]));
    const file = path.join(directory, "managed-config.json");
    const service = new ConfigurationService({ logger }, { env: {}, file });
    const save = changes => service.save({ changes, version: service.document.version });
    const snapshot = save({
        PUBLIC_DASHBOARD_AGENT_TOKEN: "LOCAL_AGENT_SECRET",
        PUBLIC_DASHBOARD_AGENTS: [agent],
        PUBLIC_DASHBOARD_HEALTH_TOKEN: "LOCAL_HEALTH_SECRET",
        PUBLIC_DASHBOARD_ROLE: "master",
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /SENSITIVE_AGENT_KEY|LOCAL_AGENT_SECRET|LOCAL_HEALTH_SECRET/);
    assert.equal(service.running.publicDashboard.role, "standalone");
    save({ PUBLIC_DASHBOARD_AGENTS: [{ ...snapshot.saved.PUBLIC_DASHBOARD_AGENTS[0], name: "renamed" }] });
    assert.equal(service.saved.publicDashboard.agents[0].token, agent.token);
    save({ PUBLIC_DASHBOARD_HEALTH_TOKEN: null });
    assert.equal(service.saved.publicDashboard.healthToken, "LOCAL_HEALTH_SECRET");
    assert.throws(() => save({ PUBLIC_DASHBOARD_HEALTH_TOKEN: "bad\nvalue" }), /凭证|Token/);
    const reloaded = new ConfigurationService({ logger }, { env: {}, file });
    assert.equal(reloaded.running.publicDashboard.role, "master");
    assert.equal(reloaded.running.publicDashboard.agents[0].token, agent.token);
    assert.throws(() => save({ PUBLIC_DASHBOARD_AGENTS: [{ ...agent, nodeId: "new", token: null }] }), /Token|列表/);
    service.undo(service.document.version);
    assert.deepEqual(service.saved.publicDashboard.agents, []);
    assert.equal(service.saved.publicDashboard.role, "standalone");
});

test("safe snapshot projection shares one window query and carries precise aggregate totals", async () => {
    const stats = new UsageStatsService(null, logger, null, false);
    stats.enabled = true;
    stats.summary = { abortedCount: 0, errorCount: 1, successCount: 2, totalDurationMs: 10.4, totalRequests: 3 };
    stats.modelStats = new Map([
        ["flash", { ...stats.summary, accountCounts: { PRIVATE: 1 } }],
        ["hidden", stats.summary],
    ]);
    let queries = 0;
    stats.ready = Promise.resolve();
    stats.appendPromise = Promise.resolve();
    stats.storage = {
        call: async () => {
            queries++;
            return [
                {
                    duration_1h: 10.4,
                    duration_24h: 10.4,
                    failed_1h: 1,
                    failed_24h: 1,
                    model: "flash",
                    success_1h: 2,
                    success_24h: 2,
                    total_1h: 3,
                    total_24h: 3,
                },
            ];
        },
    };
    const service = new PublicDashboardService(
        {
            publicSummarySnapshot: () => ({
                active: 1,
                limit: 4,
                models: [{ estimatedRemaining: 100, model: "flash" }],
                queued: 0,
                usageWindow: { date: usageDate(Date.now()), timezone },
            }),
        },
        stats,
        { cacheTtlMs: 0, includeAggregation: true }
    );
    const result = await service.getSnapshot();
    assert.equal(queries, 1);
    assert.equal(result.aggregation.history.total_duration_ms, 10);
    assert.equal(result.aggregation.models[0].recent_stats["1h"].total_duration_ms, 10);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|accountCounts|hidden/);
    validateEnvelope(
        {
            ...result,
            agent_schema_version: 1,
            generated_at: result.snapshot.generated_at,
            node_id: "a",
            service_status: "ready",
            snapshot_sequence: 1,
        },
        "a"
    );
});

async function childDashboard(t, config) {
    const child = fork(path.resolve(__dirname, "../src/public/dashboard-process.js"), [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    t.after(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const done = once(child, "exit");
        child.send({ type: "shutdown" });
        const fallback = setTimeout(() => child.kill("SIGKILL"), 3000);
        await done;
        clearTimeout(fallback);
    });
    const ready = once(child, "message");
    child.send({ config: { ...defaults, corsOrigins: [], host: "127.0.0.1", port: 0, ...config }, type: "configure" });
    const [message] = await ready;
    assert.equal(message.type, "ready");
    return { child, url: `http://127.0.0.1:${message.address.port}` };
}
async function waitFor(read, predicate) {
    const deadline = Date.now() + 5000;
    do {
        const value = await read();
        if (predicate(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 30));
    } while (Date.now() < deadline);
    throw new Error("Timed out waiting for dashboard state");
}

test(
    "two agents and master expose cached data with auth, ETags, recovery and expiration",
    { timeout: 20000 },
    async t => {
        const a = await childDashboard(t, { agentToken: "token-a", nodeId: "a", role: "agent" });
        const b = await childDashboard(t, { agentToken: "token-b", nodeId: "b", role: "agent" });
        const headers = { Authorization: "Bearer token-a" };
        assert.equal((await fetch(a.url + "/api/agent/dashboard")).status, 401);
        assert.equal((await fetch(a.url + "/api/agent/dashboard", { headers })).status, 503);
        for (const route of ["/", "/api/public/dashboard", "/assets/test.js", "/api/configuration"])
            assert.equal((await fetch(a.url + route)).status, 404);
        const started = Date.now();
        a.child.send({ body: envelope("a", started), type: "snapshot" });
        b.child.send({ body: envelope("b", started, { duration: 1000, success: 10, total: 10 }), type: "snapshot" });
        await waitFor(
            () => fetch(a.url + "/api/agent/dashboard", { headers }),
            response => response.status === 200
        );
        const cached = await fetch(a.url + "/api/agent/dashboard", { headers });
        assert.match(cached.headers.get("cache-control"), /private, no-store/);
        assert.equal(
            (
                await fetch(a.url + "/api/agent/dashboard", {
                    headers: { ...headers, "If-None-Match": cached.headers.get("etag") },
                })
            ).status,
            304
        );
        const master = await childDashboard(t, {
            agents: [
                { nodeId: "a", token: "token-a", url: a.url },
                { nodeId: "b", token: "token-b", url: b.url },
            ],
            fetchTimeoutMs: 100,
            healthToken: "health-secret",
            nodeId: "master",
            pollIntervalMs: 100,
            role: "master",
            staleAfterMs: 1000,
        });
        master.child.send({ body: envelope("master", started), type: "snapshot" });
        const read = async () => {
            const response = await fetch(master.url + "/api/public/dashboard");
            return response.ok ? response.json() : null;
        };
        const result = await waitFor(read, value => value?.cluster.fresh_nodes === 3);
        assert.equal(result.history.total_requests, 210);
        const local = await (
            await fetch(master.url + "/api/internal/model-health", {
                headers: { Authorization: "Bearer health-secret" },
            })
        ).json();
        assert.equal(local.node_id, "master");
        assert.equal(local.models[0].realtime.available_accounts, 2);
        assert.equal(result.models[0].realtime.available_accounts, 6);
        assert.equal(result.models[0].quota.estimated_remaining, 300);
        assert.equal((await fetch(master.url + "/api/agent/dashboard", { headers })).status, 404);
        await Promise.all(Array.from({ length: 30 }, () => fetch(master.url + "/api/public/dashboard")));
        // HTTP queries continue to succeed (304) while source snapshots expire.
        await waitFor(
            () => fetch(master.url + "/api/public/dashboard"),
            response => response.status === 503
        );
        a.child.send({ body: envelope("a"), type: "snapshot" });
        const recovered = await waitFor(read, value => value?.cluster.fresh_nodes === 1);
        assert.equal(recovered.cluster.expected_nodes, 3);
        assert.equal(recovered.models[0].quota.estimable, false);
        assert.equal(recovered.models[0].quota.known_estimated_remaining, 100);
    }
);

test("collector is periodic, bounded, isolates invalid nodes and never refreshes time on 304", async () => {
    const now = Date.now();
    let calls = 0,
        active = 0,
        peak = 0,
        updates = 0,
        mode = "good";
    const agents = Array.from({ length: 7 }, (_, index) => ({
        nodeId: `n${index}`,
        token: "private",
        url: `https://node${index}.example.org/prefix`,
    }));
    const collector = new Collector({
        config: { ...defaults, agents },
        fetchImpl: async (url, options) => {
            calls++;
            active++;
            peak = Math.max(peak, active);
            assert.equal(options.redirect, "error");
            assert.equal(options.headers.Authorization, "Bearer private");
            assert.ok(url.endsWith("/prefix/api/agent/dashboard"));
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
            if (mode === "304") return new Response(null, { status: 304 });
            if (mode === "large") return new Response("x".repeat(1024 * 1024 + 1));
            const index = Number(new URL(url).hostname.match(/node(\d+)/)[1]);
            return new Response(JSON.stringify(envelope(mode === "bad" ? "wrong" : `n${index}`, now)), {
                headers: { etag: '"original"' },
            });
        },
        nodeId: "master",
        onUpdate: () => updates++,
    });
    await Promise.all([collector.poll(), collector.poll()]);
    assert.equal(calls, 7);
    assert.equal(peak, 4);
    assert.equal(updates, 7);
    mode = "304";
    await collector.poll();
    assert.equal([...collector.entries.values()][0].body.generated_at, new Date(now).toISOString());
    mode = "bad";
    await collector.poll();
    assert.equal(
        [...collector.entries.values()].every(entry => entry.failed),
        true
    );
    mode = "large";
    await collector.poll();
    assert.equal(
        [...collector.entries.values()].every(entry => entry.failed),
        true
    );
    const beforeClose = calls;
    collector.close();
    await collector.poll();
    assert.equal(calls, beforeClose);
    assert.throws(() => new Collector({ config: { agents: [agents[0]] }, nodeId: "n0" }));
});

test("collector aborts slow HTTP bodies and shutdown cancels requests without late updates", async () => {
    let updated = 0;
    const collector = new Collector({
        config: {
            ...defaults,
            agents: [{ nodeId: "slow", token: "secret", url: "https://slow.example.org" }],
            fetchTimeoutMs: 20,
        },
        fetchImpl: (_url, { signal }) =>
            new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
            ),
        nodeId: "master",
        onUpdate: () => updated++,
    });
    await collector.poll();
    assert.equal([...collector.entries.values()][0].failed, true);
    assert.equal(updated, 1);
    const pending = collector.poll();
    collector.close();
    await pending;
    assert.equal(updated, 1);
    assert.equal(collector.controllers.size, 0);
});

test("agent and machine HTTP reads reuse cached statistics", { timeout: 15000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-isolation-"));
    const modulePath = JSON.stringify(path.resolve(__dirname, "../src/public/IsolatedPublicDashboard.js"));
    const statsPath = JSON.stringify(path.resolve(__dirname, "../src/core/UsageStatsService.js"));
    const entry = path.join(directory, "owner.cjs");
    fs.writeFileSync(
        entry,
        `
const Dashboard=require(${modulePath}); const Stats=require(${statsPath});
let queries=0; const logger={warn(){}}; const stats=new Stats(null,logger,null,false);
const original=stats.getPublicModelWindows.bind(stats);stats.getPublicModelWindows=(...args)=>{queries++;return original(...args)};
const dashboard=new Dashboard({config:{role:'agent',agentToken:'test',healthToken:'test',host:'127.0.0.1',port:0,corsOrigins:[],snapshotIntervalMs:60000},logger,usageStatsService:stats,browserManager:{getContextInitHealth:()=>({ready:1})}});
dashboard.start().then(()=>process.send({port:dashboard.address.port,queries}));
process.on('message',async message=>{if(message==='queries')process.send({queries});if(message==='close'){await dashboard.close();process.exit(0)}});
`
    );
    const owner = fork(entry, [], { cwd: directory, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(async () => {
        if (owner.exitCode === null && owner.signalCode === null) {
            const done = once(owner, "exit");
            owner.send("close");
            const fallback = setTimeout(() => owner.kill("SIGKILL"), 3000);
            await done;
            clearTimeout(fallback);
        }
        fs.rmSync(directory, { force: true, recursive: true });
    });
    const [ready] = await once(owner, "message");
    assert.equal(ready.queries, 1);
    const url = `http://127.0.0.1:${ready.port}/api/internal/model-health`;
    await waitFor(
        () => fetch(url, { headers: { Authorization: "Bearer test" } }),
        response => response.status === 200
    );
    await Promise.all(
        Array.from({ length: 100 }, async (_, index) => {
            const target = index % 2 ? url : url.replace("/api/internal/model-health", "/api/agent/dashboard");
            const response = await fetch(target, { headers: { Authorization: "Bearer test" } });
            assert.equal(response.status, 200);
            await response.arrayBuffer();
        })
    );
    const inspected = once(owner, "message");
    owner.send("queries");
    assert.equal((await inspected)[0].queries, 1);
});

test("public readers do not cause extra master-to-agent requests", { timeout: 15000 }, async t => {
    const http = require("node:http");
    let requests = 0;
    const agent = http.createServer((_req, res) => {
        requests++;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(envelope("remote")));
    });
    agent.listen(0, "127.0.0.1");
    await once(agent, "listening");
    t.after(() => new Promise(resolve => agent.close(resolve)));
    const master = await childDashboard(t, {
        agents: [{ nodeId: "remote", token: "test", url: `http://127.0.0.1:${agent.address().port}` }],
        nodeId: "master",
        pollIntervalMs: 60000,
        role: "master",
    });
    const url = master.url + "/api/public/dashboard";
    await waitFor(
        () => fetch(url),
        response => response.status === 200
    );
    assert.equal(requests, 1);
    await Promise.all(
        Array.from({ length: 80 }, async () => {
            const response = await fetch(url);
            assert.equal(response.status, 200);
            await response.arrayBuffer();
        })
    );
    assert.equal(requests, 1);
});

test("collector timeout covers an HTTP response that never finishes its body", { timeout: 5000 }, async t => {
    const http = require("node:http");
    const agent = http.createServer((_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.write('{"unfinished":');
    });
    agent.listen(0, "127.0.0.1");
    await once(agent, "listening");
    t.after(() => {
        agent.closeAllConnections();
        return new Promise(resolve => agent.close(resolve));
    });
    let updates = 0;
    const collector = new Collector({
        config: {
            ...defaults,
            agents: [{ nodeId: "slow", token: "test", url: `http://127.0.0.1:${agent.address().port}` }],
            fetchTimeoutMs: 50,
        },
        nodeId: "master",
        onUpdate: () => updates++,
    });
    t.after(() => collector.close());
    await collector.poll();
    assert.equal([...collector.entries.values()][0].failed, true);
    assert.equal(updates, 1);
    assert.equal(collector.controllers.size, 0);
});

for (const role of ["master", "agent"]) {
    test(`${role} machine health authenticates, projects only local cached counts and retains expired source identity`, async t => {
        const node = await childDashboard(t, {
            agentToken: "agent-secret",
            healthToken: "health-secret",
            nodeId: "local",
            role,
            staleAfterMs: 60000,
        });
        const url = node.url + "/api/internal/model-health";
        const headers = { Authorization: "Bearer health-secret", Origin: "https://untrusted.example" };
        for (const token of [null, "agent-secret", "wrong"]) {
            assert.equal(
                (await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).status,
                401
            );
        }
        assert.equal((await fetch(url, { headers })).status, 503);
        const source = envelope("local");
        source.snapshot.secret = "PRIVATE_ACCOUNT";
        source.snapshot.models[0].accounts = ["PRIVATE_ACCOUNT"];
        node.child.send({ body: source, type: "snapshot" });
        const response = await waitFor(
            () => fetch(url, { headers }),
            value => value.status === 200
        );
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.equal(response.headers.get("access-control-allow-origin"), null);
        const original = await response.text();
        assert.deepEqual(JSON.parse(original), {
            generated_at: source.generated_at,
            models: [{ model: "flash", realtime: { available_accounts: 2 } }],
            node_id: "local",
            schema_version: 1,
            service_status: "ready",
            snapshot_sequence: 1,
            usage_window: source.snapshot.usage_window,
        });
        assert.doesNotMatch(original, /PRIVATE_ACCOUNT|aggregation|quota|accounts":\[/);
        const reads = await Promise.all(Array.from({ length: 30 }, () => fetch(url, { headers })));
        for (const read of reads) assert.equal(await read.text(), original);
        const expired = envelope("local", Date.now() - 61000);
        expired.snapshot_sequence = 2;
        node.child.send({ body: expired, type: "snapshot" });
        const stale = await waitFor(
            () => fetch(url, { headers }),
            value => value.status === 503
        );
        const staleBody = await stale.json();
        assert.equal(staleBody.generated_at, expired.generated_at);
        assert.equal(staleBody.node_id, "local");
        assert.equal(staleBody.snapshot_sequence, 2);
        node.child.send({ body: envelope("local", Date.now(), { serviceStatus: "unavailable" }), type: "snapshot" });
        await waitFor(
            async () => (await fetch(url, { headers })).json(),
            value => value.service_status === "unavailable"
        );
        assert.equal((await fetch(url, { headers })).status, 503);
    });
}

test("machine health denies access without a configured token", async t => {
    const node = await childDashboard(t, { nodeId: "local", role: "master" });
    assert.equal(
        (await fetch(node.url + "/api/internal/model-health", { headers: { Authorization: "Bearer undefined" } }))
            .status,
        401
    );
});
