/* eslint-disable sort-keys-fix/sort-keys-fix */
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const EMPTY = "\u0000";
const DAY_MS = 86400000;
let db;

const metaGet = key => db.prepare("SELECT value FROM storage_meta WHERE key = ?").get(key)?.value ?? null;
const metaSet = (key, value) =>
    db
        .prepare("INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(key, String(value));
const iso = value => (value === null || value === undefined ? null : new Date(Number(value)).toISOString());
const nullable = value => (value === undefined || value === "" ? null : value);
const norm = value => (value === null || value === undefined || value === "" ? EMPTY : String(value));

function initialize() {
    fs.mkdirSync(path.dirname(workerData.dbPath), { recursive: true });
    db = new DatabaseSync(workerData.dbPath);
    db.exec(`
        PRAGMA foreign_keys=ON;
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA busy_timeout=5000;
        PRAGMA auto_vacuum=INCREMENTAL;
        CREATE TABLE IF NOT EXISTS storage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests(
            id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE,
            started_at_ms INTEGER NOT NULL, finished_at_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
            method TEXT NOT NULL, path TEXT NOT NULL, api_format TEXT NOT NULL, request_category TEXT NOT NULL,
            model TEXT, is_streaming INTEGER NOT NULL, stream_mode TEXT, client_ip TEXT,
            account_key TEXT NOT NULL, initial_auth_index INTEGER, initial_account_name TEXT,
            final_auth_index INTEGER, final_account_name TEXT, outcome TEXT NOT NULL,
            status_code INTEGER, error_message TEXT, attempt_count INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_requests_started ON requests(started_at_ms,id);
        CREATE INDEX IF NOT EXISTS idx_requests_finished ON requests(finished_at_ms,id);
        CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model,id);
        CREATE INDEX IF NOT EXISTS idx_requests_account ON requests(account_key,id);
        CREATE TABLE IF NOT EXISTS request_attempts(
            request_row_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
            attempt_number INTEGER NOT NULL, account_key TEXT NOT NULL,
            PRIMARY KEY(request_row_id,attempt_number)
        );
        CREATE TABLE IF NOT EXISTS usage_totals(
            account_key TEXT NOT NULL, auth_index INTEGER, account_name TEXT,
            model TEXT NOT NULL, api_format TEXT NOT NULL, request_category TEXT NOT NULL, stream_mode TEXT NOT NULL,
            request_count INTEGER NOT NULL, success_count INTEGER NOT NULL, error_count INTEGER NOT NULL,
            aborted_count INTEGER NOT NULL, total_duration_ms INTEGER NOT NULL,
            last_used_at_ms INTEGER, last_path TEXT,
            PRIMARY KEY(account_key,model,api_format,request_category,stream_mode)
        );
        CREATE TABLE IF NOT EXISTS usage_daily(
            day TEXT NOT NULL, account_key TEXT NOT NULL, auth_index INTEGER, account_name TEXT,
            model TEXT NOT NULL, api_format TEXT NOT NULL, request_category TEXT NOT NULL, stream_mode TEXT NOT NULL,
            request_count INTEGER NOT NULL, success_count INTEGER NOT NULL, error_count INTEGER NOT NULL,
            aborted_count INTEGER NOT NULL, total_duration_ms INTEGER NOT NULL,
            PRIMARY KEY(day,account_key,model,api_format,request_category,stream_mode)
        );
    `);
    if (!metaGet("schema_version")) metaSet("schema_version", 1);
    if (!metaGet("dataset_revision")) metaSet("dataset_revision", 1);
    if (!metaGet("started_at_ms")) metaSet("started_at_ms", Date.now());
    if (!metaGet("purged_before_ms")) metaSet("purged_before_ms", -1);
}

function normalizeRecord(raw) {
    const requestId = typeof raw?.requestId === "string" ? raw.requestId.trim() : "";
    const startedAtMs = Number(raw?.startedAtMs ?? Date.parse(raw?.startedAt));
    const finishedAtMs = Number(raw?.finishedAtMs ?? Date.parse(raw?.finishedAt));
    const durationMs = Number(raw?.durationMs);
    if (!requestId || !Number.isFinite(startedAtMs) || !Number.isFinite(finishedAtMs) || !Number.isFinite(durationMs)) {
        return null;
    }
    const outcome = ["success", "error", "aborted"].includes(raw.outcome) ? raw.outcome : "error";
    return {
        accountKey: raw.accountKey || "unassigned",
        apiFormat: raw.apiFormat || "unknown",
        attemptCount: Math.max(0, Number(raw.attemptCount) || 0),
        attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
        clientIp: nullable(raw.clientIp),
        durationMs: Math.max(0, Math.round(durationMs)),
        errorMessage: nullable(raw.errorMessage),
        finalAccountName: nullable(raw.finalAccountName),
        finalAuthIndex: Number.isInteger(raw.finalAuthIndex) ? raw.finalAuthIndex : null,
        finishedAtMs: Math.round(finishedAtMs),
        initialAccountName: nullable(raw.initialAccountName),
        initialAuthIndex: Number.isInteger(raw.initialAuthIndex) ? raw.initialAuthIndex : null,
        isStreaming: Boolean(raw.isStreaming),
        method: raw.method || "GET",
        model: nullable(raw.model),
        outcome,
        path: raw.path || "/",
        requestCategory: raw.requestCategory || "request",
        requestId,
        startedAtMs: Math.round(startedAtMs),
        statusCode: Number.isFinite(Number(raw.statusCode)) ? Number(raw.statusCode) : null,
        streamMode: nullable(raw.streamMode),
    };
}

function insertRequest(record) {
    db.exec("BEGIN IMMEDIATE");
    try {
        const r = normalizeRecord(record);
        if (!r) {
            db.exec("ROLLBACK");
            return { inserted: false, invalid: true };
        }
        const result = db
            .prepare(
                `INSERT OR IGNORE INTO requests(
            request_id,started_at_ms,finished_at_ms,duration_ms,method,path,api_format,request_category,model,
            is_streaming,stream_mode,client_ip,account_key,initial_auth_index,initial_account_name,
            final_auth_index,final_account_name,outcome,status_code,error_message,attempt_count
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
            )
            .run(
                r.requestId,
                r.startedAtMs,
                r.finishedAtMs,
                r.durationMs,
                r.method,
                r.path,
                r.apiFormat,
                r.requestCategory,
                r.model,
                r.isStreaming ? 1 : 0,
                r.streamMode,
                r.clientIp,
                r.accountKey,
                r.initialAuthIndex,
                r.initialAccountName,
                r.finalAuthIndex,
                r.finalAccountName,
                r.outcome,
                r.statusCode,
                r.errorMessage,
                r.attemptCount
            );
        if (!result.changes) {
            db.exec("ROLLBACK");
            return { inserted: false, invalid: false };
        }
        const rowId = Number(result.lastInsertRowid);
        const attempt = db.prepare(
            "INSERT INTO request_attempts(request_row_id,attempt_number,account_key) VALUES(?,?,?)"
        );
        r.attempts.forEach((item, index) => attempt.run(rowId, index + 1, item?.accountKey || "unassigned"));
        const success = r.outcome === "success" ? 1 : 0;
        const error = r.outcome === "error" ? 1 : 0;
        const aborted = r.outcome === "aborted" ? 1 : 0;
        const dimensions = [
            r.accountKey,
            r.finalAuthIndex,
            r.finalAccountName,
            norm(r.model),
            norm(r.apiFormat),
            norm(r.requestCategory),
            norm(r.streamMode),
        ];
        db.prepare(
            `INSERT INTO usage_totals(account_key,auth_index,account_name,model,api_format,request_category,stream_mode,
        request_count,success_count,error_count,aborted_count,total_duration_ms,last_used_at_ms,last_path)
        VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?) ON CONFLICT(account_key,model,api_format,request_category,stream_mode) DO UPDATE SET
        request_count=request_count+1,success_count=success_count+excluded.success_count,error_count=error_count+excluded.error_count,
        aborted_count=aborted_count+excluded.aborted_count,total_duration_ms=total_duration_ms+excluded.total_duration_ms,
        auth_index=excluded.auth_index,account_name=excluded.account_name,last_used_at_ms=MAX(last_used_at_ms,excluded.last_used_at_ms),
        last_path=CASE WHEN excluded.last_used_at_ms>=last_used_at_ms THEN excluded.last_path ELSE last_path END`
        ).run(...dimensions, success, error, aborted, r.durationMs, r.finishedAtMs, r.path);
        const day = new Intl.DateTimeFormat("en-CA", {
            day: "2-digit",
            month: "2-digit",
            timeZone: "America/Los_Angeles",
            year: "numeric",
        }).format(new Date(r.finishedAtMs));
        db.prepare(
            `INSERT INTO usage_daily(day,account_key,auth_index,account_name,model,api_format,request_category,stream_mode,
        request_count,success_count,error_count,aborted_count,total_duration_ms) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?)
        ON CONFLICT(day,account_key,model,api_format,request_category,stream_mode) DO UPDATE SET
        request_count=request_count+1,success_count=success_count+excluded.success_count,error_count=error_count+excluded.error_count,
        aborted_count=aborted_count+excluded.aborted_count,total_duration_ms=total_duration_ms+excluded.total_duration_ms`
        ).run(day, ...dimensions, success, error, aborted, r.durationMs);
        db.exec("COMMIT");
        return { id: rowId, inserted: true };
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // Best effort rollback; preserve the original database error.
        }
        throw error;
    }
}

async function migrateJsonl() {
    if (metaGet("migration_complete") === "1") return null;
    metaSet("migration_state", "running");
    const legacy = workerData.legacyPath;
    const report = { duplicates: 0, imported: 0, invalid: 0 };
    if (legacy && fs.existsSync(legacy)) {
        const input = fs.createReadStream(legacy, { encoding: "utf8" });
        for await (const line of readline.createInterface({ crlfDelay: Infinity, input })) {
            if (!line.trim()) continue;
            try {
                const result = insertRequest(JSON.parse(line));
                if (result.invalid) report.invalid += 1;
                else if (result.inserted) report.imported += 1;
                else report.duplicates += 1;
            } catch {
                report.invalid += 1;
            }
        }
    }
    const integrity = db.prepare("PRAGMA integrity_check").all();
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (integrity.some(row => row.integrity_check !== "ok") || foreignKeys.length) {
        throw new Error("SQLite migration validation failed");
    }
    metaSet("migration_complete", 1);
    metaSet("migration_state", "complete");
    metaSet("migration_report", JSON.stringify(report));
    return report;
}

function summary() {
    const total = db
        .prepare(
            `SELECT COALESCE(SUM(request_count),0) totalRequests,COALESCE(SUM(success_count),0) successCount,
        COALESCE(SUM(error_count),0) errorCount,COALESCE(SUM(aborted_count),0) abortedCount,
        COALESCE(SUM(total_duration_ms),0) totalDurationMs FROM usage_totals`
        )
        .get();
    const breakdown = column =>
        db
            .prepare(
                `SELECT CASE WHEN ${column}=? THEN 'unknown' ELSE ${column} END key,SUM(request_count) count FROM usage_totals GROUP BY ${column} ORDER BY count DESC`
            )
            .all(EMPTY);
    const accountRows = db
        .prepare(
            `SELECT account_key accountKey,auth_index authIndex,account_name accountName,SUM(request_count) totalRequests,
        SUM(success_count) successCount,SUM(error_count) errorCount,SUM(aborted_count) abortedCount,SUM(total_duration_ms) totalDurationMs,
        MAX(last_used_at_ms) lastUsedAtMs FROM usage_totals GROUP BY account_key ORDER BY totalRequests DESC,lastUsedAtMs DESC`
        )
        .all();
    const accounts = accountRows.map(a => {
        const latest = db
            .prepare(
                "SELECT last_path lastPath FROM usage_totals WHERE account_key=? ORDER BY last_used_at_ms DESC LIMIT 1"
            )
            .get(a.accountKey);
        const models = db
            .prepare(
                "SELECT CASE WHEN model=? THEN 'unknown' ELSE model END key,SUM(request_count) count,SUM(error_count) error FROM usage_totals WHERE account_key=? GROUP BY model ORDER BY count DESC"
            )
            .all(EMPTY, a.accountKey);
        return {
            ...a,
            avgDurationMs: a.totalRequests ? Math.round(a.totalDurationMs / a.totalRequests) : 0,
            lastPath: latest?.lastPath || null,
            lastUsedAt: iso(a.lastUsedAtMs),
            modelCounts: models,
            successRate: a.totalRequests ? Number(((a.successCount * 100) / a.totalRequests).toFixed(1)) : 0,
        };
    });
    const modelRows = db
        .prepare(
            `SELECT model modelKey,SUM(request_count) totalRequests,SUM(success_count) successCount,SUM(error_count) errorCount,
        SUM(aborted_count) abortedCount,SUM(total_duration_ms) totalDurationMs FROM usage_totals GROUP BY model ORDER BY totalRequests DESC`
        )
        .all();
    const models = modelRows.map(m => ({
        ...m,
        accountCounts: db
            .prepare(
                "SELECT account_key key,auth_index authIndex,account_name accountName,SUM(request_count) count,SUM(error_count) error FROM usage_totals WHERE model=? GROUP BY account_key ORDER BY count DESC"
            )
            .all(m.modelKey),
        avgDurationMs: m.totalRequests ? Math.round(m.totalDurationMs / m.totalRequests) : 0,
        modelKey: m.modelKey === EMPTY ? "unknown" : m.modelKey,
        successRate: m.totalRequests ? Number(((m.successCount * 100) / m.totalRequests).toFixed(1)) : 0,
    }));
    return {
        accounts,
        dataset_revision: Number(metaGet("dataset_revision")),
        models,
        startedAt: iso(metaGet("started_at_ms")),
        summary: {
            ...total,
            avgDurationMs: total.totalRequests ? Math.round(total.totalDurationMs / total.totalRequests) : 0,
            formatBreakdown: breakdown("api_format"),
            requestCategoryBreakdown: breakdown("request_category"),
            streamModeBreakdown: breakdown("stream_mode"),
            successRate: total.totalRequests
                ? Number(((total.successCount * 100) / total.totalRequests).toFixed(1))
                : 0,
            uniqueAccountPairs: accounts.length,
        },
    };
}

function rowToRecord(row) {
    return {
        apiFormat: row.api_format,
        durationMs: row.duration_ms,
        finishedAt: iso(row.finished_at_ms),
        clientIp: row.client_ip,
        isStreaming: Boolean(row.is_streaming),
        accountKey: row.account_key,
        method: row.method,
        initialAccountName: row.initial_account_name,
        requestId: row.request_id,
        finalAccountName: row.final_account_name,
        sequence: row.id,
        finalAuthIndex: row.final_auth_index,
        startedAt: iso(row.started_at_ms),
        errorMessage: row.error_message,
        model: row.model,
        attemptCount: row.attempt_count,
        path: row.path,
        attempts: db
            .prepare(
                "SELECT account_key accountKey FROM request_attempts WHERE request_row_id=? ORDER BY attempt_number"
            )
            .all(row.id),
        requestCategory: row.request_category,
        expired: Boolean(
            workerData.retentionDays && row.finished_at_ms <= Date.now() - workerData.retentionDays * DAY_MS
        ),
        expires_at: workerData.retentionDays ? iso(row.finished_at_ms + workerData.retentionDays * DAY_MS) : null,
        streamMode: row.stream_mode,
        initialAuthIndex: row.initial_auth_index,
        outcome: row.outcome,
        statusCode: row.status_code,
    };
}

function queryRecords(options) {
    const limit = Number(options.limit || 20);
    if (![10, 20, 50, 100].includes(limit)) throw Object.assign(new Error("Invalid records limit"), { status: 400 });
    const revision = Number(metaGet("dataset_revision"));
    let cursor = null;
    if (options.cursor) {
        try {
            cursor = JSON.parse(Buffer.from(String(options.cursor), "base64url").toString("utf8"));
        } catch {
            throw Object.assign(new Error("Invalid records cursor"), { status: 400 });
        }
        if (cursor.revision !== revision || !Number.isSafeInteger(cursor.before))
            return { dataset_revision: revision, has_more: true, next_cursor: null, records: [], reset: true };
    }
    if (options.after_sequence !== undefined && Number(options.dataset_revision) !== revision)
        return {
            dataset_revision: revision,
            has_more: true,
            latest_sequence: db.prepare("SELECT COALESCE(MAX(id),0) id FROM requests").get().id,
            next_cursor: null,
            records: [],
            reset: true,
        };
    const clauses = [],
        values = [];
    const addList = (key, column) => {
        if (options[key] !== undefined && options[key] !== "") {
            const vals = String(options[key]).split(",");
            clauses.push(`${column} IN (${vals.map(() => "?").join(",")})`);
            values.push(...vals);
        }
    };
    addList("model", "model");
    addList("outcome", "outcome");
    addList("status_code", "status_code");
    addList("auth_index", "final_auth_index");
    addList("api_format", "api_format");
    addList("request_category", "request_category");
    addList("stream_mode", "stream_mode");
    addList("client_ip", "client_ip");
    if (options.from) {
        const value = Date.parse(options.from);
        if (!Number.isFinite(value)) throw Object.assign(new Error("Invalid records time range"), { status: 400 });
        clauses.push("started_at_ms>=?");
        values.push(value);
    }
    if (options.to) {
        const value = Date.parse(options.to);
        if (!Number.isFinite(value)) throw Object.assign(new Error("Invalid records time range"), { status: 400 });
        clauses.push("started_at_ms<=?");
        values.push(value);
    }
    let direction = "DESC";
    if (options.after_sequence !== undefined) {
        const after = Number(options.after_sequence);
        if (!Number.isSafeInteger(after) || after < 0)
            throw Object.assign(new Error("Invalid records sequence"), { status: 400 });
        clauses.push("id>?");
        values.push(after);
        direction = "ASC";
    } else if (cursor) {
        clauses.push("id<?");
        values.push(cursor.before);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    let rows = db.prepare(`SELECT * FROM requests ${where} ORDER BY id ${direction} LIMIT ?`).all(...values, limit + 1);
    const hasMore = rows.length > limit;
    rows = rows.slice(0, limit);
    if (direction === "ASC") rows.reverse();
    const records = rows.map(rowToRecord);
    const maxId = db.prepare("SELECT COALESCE(MAX(id),0) id FROM requests").get().id;
    return {
        dataset_revision: revision,
        has_more: hasMore,
        latest_sequence: direction === "ASC" ? (rows[0]?.id ?? Number(options.after_sequence)) : maxId,
        next_cursor:
            hasMore && rows.length
                ? Buffer.from(JSON.stringify({ before: rows.at(-1).id, revision })).toString("base64url")
                : null,
        records,
        reset: false,
    };
}

async function cleanup(now = Date.now()) {
    if (!workerData.retentionDays) return { deleted: 0, purgedBeforeMs: Number(metaGet("purged_before_ms")) };
    const cutoff = now - workerData.retentionDays * DAY_MS;
    let deleted = 0,
        watermark = Number(metaGet("purged_before_ms"));
    metaSet("last_cleanup_attempt_at_ms", now);
    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const ids = db
                .prepare(
                    "SELECT id,finished_at_ms FROM requests WHERE finished_at_ms<=? ORDER BY finished_at_ms,id LIMIT ?"
                )
                .all(cutoff, workerData.cleanupBatchSize);
            if (!ids.length) break;
            db.exec("BEGIN IMMEDIATE");
            try {
                const statement = db.prepare(`DELETE FROM requests WHERE id IN (${ids.map(() => "?").join(",")})`);
                deleted += Number(statement.run(...ids.map(x => x.id)).changes);
                watermark = Math.max(watermark, ...ids.map(x => x.finished_at_ms));
                metaSet("purged_before_ms", watermark);
                db.exec("COMMIT");
            } catch (e) {
                db.exec("ROLLBACK");
                throw e;
            }
            if (ids.length < workerData.cleanupBatchSize) break;
            await new Promise(resolve => setImmediate(resolve));
        }
        metaSet("last_cleanup_success_at_ms", Date.now());
        metaSet("last_cleanup_deleted", deleted);
        metaSet("last_cleanup_error", "");
    } catch (error) {
        metaSet("last_cleanup_error", error.message);
        throw error;
    }
    if (deleted) {
        metaSet("dataset_revision", Number(metaGet("dataset_revision")) + 1);
        db.exec("PRAGMA incremental_vacuum(100)");
    }
    return { deleted, purgedBeforeMs: watermark };
}

async function importJsonl(content) {
    const report = {
        duplicateCount: 0,
        expiredSkipped: 0,
        importedCount: 0,
        invalidLineCount: 0,
        missingRequestIdCount: 0,
        purgedHistorySkipped: 0,
    };
    const cutoff = workerData.retentionDays ? Date.now() - workerData.retentionDays * DAY_MS : -Infinity;
    const watermark = Number(metaGet("purged_before_ms"));
    for (const line of String(content).split(/\r?\n/)) {
        if (!line.trim()) continue;
        let raw, r;
        try {
            raw = JSON.parse(line);
            r = normalizeRecord(raw);
        } catch {
            report.invalidLineCount++;
            continue;
        }
        if (!raw?.requestId || typeof raw.requestId !== "string") {
            report.missingRequestIdCount++;
            continue;
        }
        if (!r) {
            report.invalidLineCount++;
            continue;
        }
        if (r.finishedAtMs <= watermark) {
            report.purgedHistorySkipped++;
            continue;
        }
        if (r.finishedAtMs <= cutoff) {
            report.expiredSkipped++;
            continue;
        }
        const result = insertRequest(r);
        if (result.inserted) report.importedCount++;
        else report.duplicateCount++;
    }
    metaSet("dataset_revision", Number(metaGet("dataset_revision")) + 1);
    report.totalRecords = db.prepare("SELECT COUNT(*) count FROM requests").get().count;
    return report;
}

function storageStatus() {
    const count = db.prepare("SELECT COUNT(*) count FROM requests").get().count;
    const next = workerData.retentionDays
        ? db
              .prepare("SELECT MIN(finished_at_ms) value FROM requests WHERE finished_at_ms>?")
              .get(Date.now() - workerData.retentionDays * DAY_MS).value
        : null;
    const size = file => {
        try {
            return fs.statSync(file).size;
        } catch {
            return 0;
        }
    };
    return {
        databaseBytes: size(workerData.dbPath),
        datasetRevision: Number(metaGet("dataset_revision")),
        lastCleanupAttemptAt: iso(metaGet("last_cleanup_attempt_at_ms")),
        lastCleanupDeleted: Number(metaGet("last_cleanup_deleted") || 0),
        lastCleanupError: metaGet("last_cleanup_error") || null,
        lastCleanupSuccessAt: iso(metaGet("last_cleanup_success_at_ms")),
        nextRecordExpiresAt: next == null ? null : iso(next + workerData.retentionDays * DAY_MS),
        purgedBeforeMs: Number(metaGet("purged_before_ms")),
        retainedRecords: count,
        walBytes: size(`${workerData.dbPath}-wal`),
    };
}

// Both rolling windows share one indexed scan and one snapshot boundary.
function publicModelWindows({ visibleModels, asOfMs }) {
    const models = [...new Set(visibleModels.filter(model => typeof model === "string" && model.trim()))];
    if (!Number.isSafeInteger(asOfMs)) throw new Error("Invalid snapshot time");
    if (!models.length) return [];
    const hour = asOfMs - 3600000;
    return db
        .prepare(
            `
        SELECT model,
            COUNT(*) AS total_24h,
            SUM(outcome = 'success') AS success_24h,
            SUM(outcome IN ('error', 'aborted')) AS failed_24h,
            SUM(duration_ms) AS duration_24h,
            SUM(finished_at_ms >= ?) AS total_1h,
            SUM(finished_at_ms >= ? AND outcome = 'success') AS success_1h,
            SUM(finished_at_ms >= ? AND outcome IN ('error', 'aborted')) AS failed_1h,
            SUM(CASE WHEN finished_at_ms >= ? THEN duration_ms ELSE 0 END) AS duration_1h
        FROM requests
        WHERE finished_at_ms >= ? AND finished_at_ms < ?
            AND model IN (${models.map(() => "?").join(",")})
        GROUP BY model
    `
        )
        .all(hour, hour, hour, hour, asOfMs - DAY_MS, asOfMs, ...models);
}

async function handle(command, payload) {
    if (command === "insert") return insertRequest(payload);
    if (command === "public_model_windows") return publicModelWindows(payload);
    if (command === "summary") return summary();
    if (command === "query") return queryRecords(payload || {});
    if (command === "cleanup") return cleanup(payload?.now);
    if (command === "import") return importJsonl(payload.content);
    if (command === "storage") return storageStatus();
    if (command === "export")
        return db
            .prepare("SELECT * FROM requests WHERE id>? ORDER BY id LIMIT ?")
            .all(payload.afterId || 0, payload.limit || 500)
            .map(rowToRecord);
    if (command === "close") {
        db.close();
        return true;
    }
    throw new Error(`Unknown usage storage command: ${command}`);
}

(async () => {
    initialize();
    const migration = await migrateJsonl();
    parentPort.postMessage({ migration, ready: true });
})().catch(error => parentPort.postMessage({ fatal: { message: error.message, stack: error.stack } }));
parentPort.on("message", async message => {
    try {
        parentPort.postMessage({ id: message.id, result: await handle(message.command, message.payload) });
    } catch (error) {
        parentPort.postMessage({ error: { message: error.message, status: error.status }, id: message.id });
    }
});
