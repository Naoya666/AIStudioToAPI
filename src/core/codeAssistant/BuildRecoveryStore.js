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
            if (entry.schemaVersion === 2) continue;
            if (entry.schemaVersion !== undefined) throw new Error("Unsupported Build recovery schema");
            migrated = true;
            state[id] = {
                ...entry,
                attempts: {},
                cancelConfirmedAt: null,
                cleanupStage:
                    entry.task && !entry.complete ? "cancel_pending" : entry.app ? "delete_pending" : "verify_pending",
                consecutiveFailures: 0,
                createdAt: null,
                deleteConfirmedAt: null,
                generationState: entry.complete ? "terminal" : "unknown",
                importedAt: Date.now(),
                lastError: null,
                nextAttemptAt: null,
                operationId: id,
                ownership: null,
                requestId: null,
                retryState: "scheduled",
                revision: 1,
                schemaVersion: 2,
                updatedAt: null,
            };
        }
        if (migrated) {
            const backup = `${file}.pre-v2-${Date.now()}`;
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
                    (entry.app != null && typeof entry.app !== "string") ||
                    (entry.task != null && typeof entry.task !== "string") ||
                    (entry.schemaVersion === 2 &&
                        (!["cancel_pending", "delete_pending", "verify_pending", "done"].includes(entry.cleanupStage) ||
                            (entry.cleanupStage === "done" &&
                                (!entry.app ||
                                    !entry.deleteConfirmedAt ||
                                    (entry.task && !entry.complete && !entry.cancelConfirmedAt)))))
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
        const directory = fs.openSync(path.dirname(this.file), "r");
        try {
            fs.fsyncSync(directory);
        } finally {
            fs.closeSync(directory);
        }
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
