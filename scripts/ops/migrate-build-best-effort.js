// Run only with the old application stopped, after a host-level pre-change snapshot.
const fs = require("node:fs");
const path = require("node:path");
const CLEANUP_FIELDS = [
    "buildRecoveryBlocked",
    "buildRecoveryReason",
    "buildRecoveryHoldUntil",
    "buildCleanupDegraded",
    "cleanupDebtCount",
];
function migrate(dataDir, historyDir) {
    fs.mkdirSync(historyDir, { mode: 0o700, recursive: true });
    fs.chmodSync(historyDir, 0o700);
    const archived = [];
    // Copy historical artifacts without changing their upstream state or reattaching them to runtime.
    for (const name of fs.readdirSync(dataDir)) {
        if (name === "scheduler-state.json" || name.startsWith("build-projects.json")) {
            fs.copyFileSync(path.join(dataDir, name), path.join(historyDir, name), fs.constants.COPYFILE_EXCL);
            fs.chmodSync(path.join(historyDir, name), 0o600);
            archived.push(name);
        }
    }
    const statePath = path.join(dataDir, "scheduler-state.json");
    const changes = [],
        unknownDisabled = [];
    if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        if (!Array.isArray(state.accounts)) throw new Error("Invalid scheduler state");
        for (const [position, account] of state.accounts.entries()) {
            const removed = CLEANUP_FIELDS.filter(field => Object.hasOwn(account, field));
            if (removed.length) changes.push({ account: account.index ?? position, removed });
            for (const field of removed) delete account[field];
            // Never infer that account/model disables or cooldowns were caused by cleanup.
            if (account.disabled || Object.values(account.models || {}).some(slot => slot.disabled || slot.unsupported))
                unknownDisabled.push(account.index ?? position);
        }
        const temporary = `${statePath}.best-effort.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, statePath);
    }
    const report = { archived, changes, mode: "best_effort", unknownDisabled };
    fs.writeFileSync(path.join(historyDir, "migration-diff.json"), JSON.stringify(report, null, 2), {
        flag: "wx",
        mode: 0o600,
    });
    return report;
}
if (require.main === module) {
    const [dataDir, historyDir] = process.argv.slice(2);
    if (!dataDir || !historyDir)
        throw new Error("Usage: node scripts/ops/migrate-build-best-effort.js DATA_DIR NEW_HISTORY_DIR");
    const result = migrate(path.resolve(dataDir), path.resolve(historyDir));
    console.log(
        JSON.stringify({
            historicalFiles: result.archived.length,
            migratedAccounts: result.changes.length,
            retainedDisabledAccounts: result.unknownDisabled.length,
        })
    );
}
module.exports = { CLEANUP_FIELDS, migrate };
