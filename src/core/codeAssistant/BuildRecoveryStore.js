const fs = require("node:fs");
const path = require("node:path");
const { atomicWrite } = require("../../config/ConfigurationService");
const stores = new Map();
class BuildRecoveryStore {
    static open(file) {
        if (!stores.has(file)) stores.set(file, new BuildRecoveryStore(file));
        return stores.get(file);
    }
    constructor(file) {
        this.file = file;
        this.active = new Set();
        this.executing = new Set();
        this.accountTails = new Map();
        const state = this.read();
        let migrated = false;
        for (const [id, entry] of Object.entries(state)) {
            if (!entry || typeof entry !== "object" || !entry.account) throw new Error("Invalid Build recovery entry");
            if (entry.schemaVersion === 3) continue;
            if (entry.schemaVersion !== undefined && entry.schemaVersion !== 2)
                throw new Error("Unsupported Build recovery schema");
            migrated = true;
            state[id] = {
                attempts: {},
                cancelConfirmedAt: null,
                consecutiveFailures: 0,
                createdAt: null,
                deleteConfirmedAt: null,
                importedAt: Date.now(),
                lastError: null,
                ownership: null,
                requestId: null,
                revision: 1,
                updatedAt: null,
                ...entry,
                cleanupStage: entry.deleteConfirmedAt ? "done" : entry.app ? "delete_pending" : "verify_pending",
                generationState: entry.generationState || (entry.complete ? "terminal" : "unknown"),
                // Upgrade wakes previously isolated records without inventing upstream facts.
                nextAttemptAt: entry.retryState === "quarantined" ? null : (entry.nextAttemptAt ?? null),

                operationId: id,
                projectState: entry.deleteConfirmedAt ? "deleted" : "delete_pending",
                resourceState: entry.app ? "known" : "discovery_pending",
                retryState: entry.retryState === "quarantined" ? "scheduled" : entry.retryState || "scheduled",
                schemaVersion: 3,
                taskState: entry.cancelConfirmedAt ? "cancel_confirmed" : entry.complete ? "terminal" : "unknown",
            };
        }
        if (migrated) {
            const backup = `${file}.pre-v3-${Date.now()}`;
            fs.copyFileSync(file, backup);
            fs.chmodSync(backup, 0o600);
            this.commit(state);
        }
    }
    read() {
        try {
            const state = JSON.parse(fs.readFileSync(this.file, "utf8"));
            if (!state || Array.isArray(state) || typeof state !== "object") throw new Error("Invalid journal");
            for (const entry of Object.values(state)) {
                if (
                    !entry ||
                    typeof entry !== "object" ||
                    typeof entry.account !== "string" ||
                    (entry.schemaVersion !== undefined && ![2, 3].includes(entry.schemaVersion)) ||
                    (entry.app != null && typeof entry.app !== "string") ||
                    (entry.task != null && typeof entry.task !== "string") ||
                    ([2, 3].includes(entry.schemaVersion) &&
                        (!["cancel_pending", "delete_pending", "verify_pending", "done"].includes(entry.cleanupStage) ||
                            (entry.cleanupStage === "done" &&
                                !entry.deleteConfirmedAt &&
                                entry.resourceState !== "verified_not_created")))
                )
                    throw new Error("Invalid Build recovery record");
            }
            this.existed = true;
            return state;
        } catch (error) {
            if (error.code === "ENOENT" && !this.existed) return {};
            throw new Error("Build recovery journal unreadable; dispatch blocked", { cause: error });
        }
    }
    commit(state) {
        atomicWrite(this.file, state);
        this.existed = true;
        this.syncDirectory();
    }
    syncDirectory() {
        const directory = fs.openSync(path.dirname(this.file), "r");
        try {
            fs.fsyncSync(directory);
        } finally {
            fs.closeSync(directory);
        }
    }
    archive(id, entry) {
        if (!entry.deleteConfirmedAt && entry.resourceState !== "verified_not_created")
            throw new Error("Cannot archive unresolved Build debt");
        const file = `${this.file}.archive.json`;
        let records = {};
        try {
            records = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        if (!records || Array.isArray(records) || typeof records !== "object") throw new Error("Invalid Build archive");
        atomicWrite(file, { ...records, [id]: entry });
        this.syncDirectory();
        this.save(id, null);
    }
    save(id, entry) {
        // Synchronous read/modify/atomic replace: no await can interleave writers in this process.
        const state = this.read();
        if (entry) {
            if (state[id] && entry.revision !== undefined && entry.revision !== state[id].revision)
                throw new Error("Stale Build recovery revision");
            entry.revision = (state[id]?.revision || 0) + 1;
            entry.updatedAt = Date.now();
            state[id] = entry;
        } else delete state[id];
        this.commit(state);
    }
}
module.exports = { BuildRecoveryStore };
