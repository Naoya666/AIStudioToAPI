const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const Guard = require("../src/utils/GenerationResponseGuard");
const UsageStatsService = require("../src/core/UsageStatsService");
const { extractModelMetadata, wrapResponse } = require("../src/core/MakerSuiteCodec");

const logger = { error() {}, info() {}, warn() {} };

test("fragmented stream metadata persists separately from requested model across restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-metadata-"));
    let service = new UsageStatsService(null, logger, directory, true, { retentionDays: 0 });
    try {
        await service.ready;
        service.startRequest("trace", { model: "gemini-4-argon" });
        service.recordAttempt("trace", 0);
        const guard = new Guard({}, Infinity, null, metadata =>
            service.recordUpstreamMetadata("trace", {
                modelVersion: metadata.modelVersion,
                requestAttemptId: "trace_attempt_1",
                transport: "legacy",
            })
        );
        const data = `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: "private response" }] } }],
            modelVersion: "gemini-3.8-flash",
        })}\n\n`;
        for (const part of [data.slice(0, 15), data.slice(15, 66), data.slice(66)])
            guard.push({ data: part, event_type: "chunk" });
        guard.push({ data: 'data: {"usageMetadata":{"totalTokenCount":5}}\n\n', event_type: "chunk" });
        const finished = service.finishRequest("trace", { outcome: "success", statusCode: 200 });
        assert.equal(finished.model, "gemini-4-argon");
        assert.equal(finished.modelVersion, "gemini-3.8-flash");
        assert.ok(!JSON.stringify(finished.upstreamMetadata).includes("private response"));
        await service.close();
        service = new UsageStatsService(null, logger, directory, true, { retentionDays: 0 });
        await service.ready;
        const [record] = (await service.queryRecordsAsync({ limit: 10 })).records;
        assert.equal(record.modelVersion, "gemini-3.8-flash");
        assert.equal(record.upstreamMetadata[0].requestAttemptId, "trace_attempt_1");
        assert.equal(record.upstreamMetadata.length, 1);
    } finally {
        await service.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("retry without a reported version does not inherit a previous attempt's model", async () => {
    const service = new UsageStatsService(null, logger, null, false);
    service.enabled = true;
    service.startRequest("retry", { model: "gemini-4-argon" });
    service.recordAttempt("retry", 0);
    service.recordUpstreamMetadata("retry", {
        modelVersion: "gemini-3.8-flash",
        requestAttemptId: "retry_attempt_1",
        transport: "makersuite",
    });
    service.recordAttempt("retry", 1);
    service.recordUpstreamMetadata("retry", { requestAttemptId: "retry_attempt_2", transport: "makersuite" });
    const tracker = service.activeRequests.get("retry");
    assert.equal(tracker.modelVersion, null);
    assert.equal(tracker.upstreamMetadata.length, 2);
    assert.equal(tracker.upstreamMetadata[0].modelVersion, "gemini-3.8-flash");
    assert.equal(tracker.upstreamMetadata[1].modelVersion, null);
});

test("MakerSuite metadata excludes generated text and opaque identifiers, and does not guess field meaning", () => {
    const chunk = [
        [[[[[null, "gemini-generated-answer"]], "model"], 1]],
        null,
        [2, 1, 3],
        null,
        null,
        null,
        "gemini-3.8-flash",
        "gemini-opaque-response-id",
    ];
    const raw = JSON.stringify([[chunk]]);
    assert.deepEqual(extractModelMetadata(raw), {
        modelIdentifiers: [{ path: "$[0][6]", value: "gemini-3.8-flash" }],
        modelVersion: null,
    });
    const converted = JSON.parse(JSON.parse(wrapResponse(raw, false))[0]);
    assert.equal(converted.modelVersion, undefined);
    chunk[6] = null;
    assert.deepEqual(extractModelMetadata(JSON.stringify([[chunk]])), { modelIdentifiers: [], modelVersion: null });
    chunk[4] = { modelVersion: "gemini-4-argon" };
    assert.equal(extractModelMetadata(JSON.stringify([[chunk]])).modelVersion, "gemini-4-argon");
});

test("existing SQLite request history survives additive metadata migration", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-migration-"));
    let service = new UsageStatsService(null, logger, directory, true, { retentionDays: 0 });
    try {
        await service.ready;
        service.startRequest("old", { model: "gemini-4-argon" });
        service.finishRequest("old", { outcome: "success", statusCode: 200 });
        await service.close();
        const db = new DatabaseSync(path.join(directory, "usage-stats.sqlite"));
        db.exec("ALTER TABLE requests DROP COLUMN model_version; ALTER TABLE requests DROP COLUMN upstream_metadata");
        db.close();
        service = new UsageStatsService(null, logger, directory, true, { retentionDays: 0 });
        await service.ready;
        const [record] = (await service.queryRecordsAsync({ limit: 10 })).records;
        assert.equal(record.requestId, "old");
        assert.equal(record.modelVersion, null);
        assert.deepEqual(record.upstreamMetadata, []);
    } finally {
        await service.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});
