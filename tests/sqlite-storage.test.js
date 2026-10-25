const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const UsageStatsService = require("../src/core/UsageStatsService");

const logger = { error() {}, info() {}, warn() {} };
const DAY_MS = 86400000;

const record = (requestId, finishedAtMs) => ({
    accountKey: "0:test@example.com",
    apiFormat: "openai",
    attemptCount: 1,
    attempts: [{ accountKey: "0:test@example.com" }],
    durationMs: 10,
    finalAccountName: "test@example.com",
    finalAuthIndex: 0,
    finishedAt: new Date(finishedAtMs).toISOString(),
    model: "flash",
    outcome: "success",
    requestCategory: "generation",
    requestId,
    startedAt: new Date(finishedAtMs - 10).toISOString(),
    streamMode: "real",
});

test("JSONL migration, cleanup watermark and cumulative aggregates survive restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sqlite-"));
    const now = Date.now();
    const expired = record("expired", now - 40 * DAY_MS);
    const current = record("current", now - 1000);
    fs.writeFileSync(
        path.join(directory, "usage-stats.jsonl"),
        `${JSON.stringify(expired)}\n${JSON.stringify(current)}\n`
    );
    const options = {
        cleanupBatchSize: 1,
        cleanupIntervalMinutes: 60,
        dbPath: path.join(directory, "usage-stats.sqlite"),
        retentionDays: 30,
    };

    let service = new UsageStatsService(null, logger, directory, true, options);
    await service.ready;
    assert.equal((await service.getSummarySnapshotAsync()).summary.totalRequests, 2);
    assert.deepEqual(
        (await service.queryRecordsAsync({ limit: 10 })).records.map(item => item.requestId),
        ["current"]
    );
    const imported = await service.importJsonl(JSON.stringify(expired));
    assert.equal(imported.purgedHistorySkipped, 1);
    await service.close();

    service = new UsageStatsService(null, logger, directory, true, options);
    await service.ready;
    assert.equal((await service.getSummarySnapshotAsync()).summary.totalRequests, 2);
    assert.equal((await service.getStorageSnapshot()).retained_records, 1);
    const recent = await service.getPublicModelWindows(["flash"], now);
    assert.equal(recent.models[0].stats["24h"].totalRequests, 1);
    assert.equal(service.getPublicSummarySnapshot(["flash"]).models[0].totalRequests, 2);
    await service.close();
    fs.rmSync(directory, { force: true, recursive: true });
});

test("forever retention returns null expiry and disables cleanup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-forever-"));
    const service = new UsageStatsService(null, logger, directory, true, {
        cleanupBatchSize: 10,
        cleanupIntervalMinutes: 60,
        dbPath: path.join(directory, "usage-stats.sqlite"),
        retentionDays: 0,
    });
    await service.ready;
    service.startRequest("forever");
    service.finishRequest("forever", { outcome: "success" });
    const result = await service.queryRecordsAsync({ limit: 10 });
    assert.equal(result.records[0].expires_at, null);
    assert.equal((await service.getStorageSnapshot()).cleanup_status, "disabled");
    await service.close();
    fs.rmSync(directory, { force: true, recursive: true });
});

test("public rolling windows use completed requests, exact boundaries and persisted details", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-windows-"));
    const asOfMs = Date.now();
    const options = { retentionDays: 0 };
    let service = new UsageStatsService(null, logger, directory, true, options);
    t.after(async () => {
        await service.close();
        fs.rmSync(directory, { force: true, recursive: true });
    });
    await service.ready;
    const entries = [
        ["day-edge", asOfMs - DAY_MS, "success", 10],
        ["hour-edge", asOfMs - 3600000, "error", 20],
        ["aborted", asOfMs - 1000, "aborted", 30],
        ["retried-success", asOfMs - 500, "success", 40],
        ["upper-edge", asOfMs, "success", 90],
        ["future", asOfMs + 1, "success", 90],
        ["too-old", asOfMs - DAY_MS - 1, "success", 90],
    ].map(([id, time, outcome, durationMs]) => ({ ...record(id, time), durationMs, outcome }));
    entries[3].startedAt = new Date(asOfMs - 2 * DAY_MS).toISOString();
    entries[3].attemptCount = 3;
    entries.push({ ...record("hidden", asOfMs - 100), errorMessage: "PRIVATE_ERROR", model: "hidden" });
    entries.push({ ...record("empty-model", asOfMs - 100), model: null });
    await service.importJsonl(entries.map(entry => JSON.stringify(entry)).join("\n"));
    service.startRequest("still-active", { model: "flash" });
    const bound = await service.getPublicModelWindows(["flash' OR 1=1 --"], asOfMs);
    assert.equal(bound.models[0].stats["24h"].totalRequests, 0);
    const result = await service.getPublicModelWindows(["flash", "empty", "", null], asOfMs);
    assert.equal(result.windows["24h"].status, "available");
    assert.equal(result.windows["1h"].to, new Date(asOfMs).toISOString());
    assert.deepEqual(result.models[0].stats, {
        "1h": { averageDurationMs: 30, failedRequests: 2, successRate: 33.3, totalRequests: 3 },
        "24h": { averageDurationMs: 25, failedRequests: 2, successRate: 50, totalRequests: 4 },
    });
    assert.deepEqual(result.models[1].stats["1h"], {
        averageDurationMs: null,
        failedRequests: 0,
        successRate: null,
        totalRequests: 0,
    });
    assert.doesNotMatch(JSON.stringify(result), /hidden|PRIVATE_ERROR|test@example.com|accountKey|requestId/);
    await service.close();
    service = new UsageStatsService(null, logger, directory, true, options);
    assert.deepEqual(await service.getPublicModelWindows(["flash", "empty"], asOfMs), result);
    const originalCall = service.storage.call.bind(service.storage);
    service.storage.call = async command => {
        if (command === "public_model_windows") throw new Error("PRIVATE_SQL");
        return originalCall(command);
    };
    const unavailable = await service.getPublicModelWindows(["flash"], asOfMs);
    assert.equal(unavailable.windows["1h"].status, "unavailable");
    assert.equal(unavailable.models[0].stats["1h"].totalRequests, null);
    service.storage.call = originalCall;
    assert.equal((await service.getPublicModelWindows(["flash"], asOfMs)).windows["1h"].status, "available");
    const disabled = new UsageStatsService(null, logger, null, false);
    const off = await disabled.getPublicModelWindows(["flash"], asOfMs);
    assert.equal(off.windows["24h"].status, "disabled");
    assert.equal(off.models[0].stats["24h"].totalRequests, null);
});

test("public windows wait for queued completed writes", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-queued-"));
    const service = new UsageStatsService(null, logger, directory, true, { retentionDays: 0 });
    t.after(async () => {
        await service.close();
        fs.rmSync(directory, { force: true, recursive: true });
    });
    await service.ready;
    service.startRequest("queued", { model: "flash" });
    const completed = service.finishRequest("queued", { outcome: "success" });
    const snapshot = await service.getPublicModelWindows(["flash"], Date.parse(completed.finishedAt) + 1);
    assert.equal(snapshot.models[0].stats["1h"].totalRequests, 1);
});

test("request history filters inclusive start times across cursor pages, including long requests", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-history-"));
    const service = new UsageStatsService(null, logger, directory, true, { retentionDays: 0 });
    t.after(async () => {
        await service.close();
        fs.rmSync(directory, { force: true, recursive: true });
    });
    await service.ready;
    const start = Date.now() - 3600000;
    const end = start + 1000;
    const makeEntry = (id, startedAtMs, finishedAtMs) => ({
        ...record(id, finishedAtMs),
        durationMs: finishedAtMs - startedAtMs,
        startedAt: new Date(startedAtMs).toISOString(),
    });
    const entries = [
        makeEntry("before-start", start - 1, start + 500),
        makeEntry("start-edge", start, end + 60000),
        ...Array.from({ length: 123 }, (_, i) => makeEntry(`middle-${i}`, start + 1 + i, end + 60000)),
        makeEntry("end-edge", end, end + 60000),
        makeEntry("after-end", end + 1, end + 60000),
    ];
    await service.importJsonl(entries.map(entry => JSON.stringify(entry)).join("\n"));
    const query = { from: new Date(start).toISOString(), limit: 100, to: new Date(end).toISOString() };
    const first = await service.queryRecordsAsync(query);
    assert.equal(first.records.length, 100);
    assert.equal(first.has_more, true);
    const second = await service.queryRecordsAsync({ ...query, cursor: first.next_cursor });
    assert.equal(second.records.length, 25);
    assert.equal(second.has_more, false);
    const ids = new Set([...first.records, ...second.records].map(item => item.requestId));
    assert.equal(ids.size, 125);
    assert.ok(ids.has("start-edge"));
    assert.ok(ids.has("end-edge"));
    assert.ok(!ids.has("before-start"));
    assert.ok(!ids.has("after-end"));
});
