const { normalizeGroup } = require("./ProxyEgressIdentity");
const fs = require("fs");
const path = require("path");

const AUTOMATION_DEFAULTS = Object.freeze({
    autoAssignEnabled: false,
    autoFailoverEnabled: false,
    autoRebuildContext: false,
    checkIntervalSeconds: 60,
    enabled: false,
    exitIpUrl: "",
    failureThreshold: 3,
    healthCheckEnabled: false,
    healthTimeoutMs: 5000,
    maxConcurrentChecks: 20,
    recoveryThreshold: 2,
    subscriptionsEnabled: false,
    switchCooldownMinutes: 30,
    testUrl: "https://www.google.com/generate_204",
});

const defaultData = () => ({
    automation: { ...AUTOMATION_DEFAULTS },
    bindings: {},
    nodes: [],
    schemaVersion: 1,
    settings: { basePort: 10801, binaryPath: "", controllerPort: 19090, enabled: false },
    subscriptions: [],
});

class ProxyPoolStore {
    constructor(
        logger,
        filePath = process.env.PROXY_POOL_CONFIG_PATH || path.join(process.cwd(), "data", "proxy-pool.json")
    ) {
        this.logger = logger;
        this.filePath = path.resolve(filePath);
        this.data = this._load();
        this._writeQueue = Promise.resolve();
    }

    _load() {
        if (!fs.existsSync(this.filePath)) return defaultData();
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            if (parsed.schemaVersion !== 1) throw new Error(`Unsupported schemaVersion: ${parsed.schemaVersion}`);
            return this.validate({
                ...defaultData(),
                ...parsed,
                automation: { ...AUTOMATION_DEFAULTS, ...parsed.automation },
                settings: { ...defaultData().settings, ...parsed.settings },
                subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
            });
        } catch (error) {
            this.logger.error(`[ProxyPool] Cannot load ${this.filePath}: ${error.message}`);
            if (error instanceof SyntaxError) {
                const backup = `${this.filePath}.corrupt-${Date.now()}`;
                fs.renameSync(this.filePath, backup);
                this.logger.warn(`[ProxyPool] Corrupt configuration moved to ${backup}; using safe defaults.`);
                return defaultData();
            }
            throw error;
        }
    }

    snapshot() {
        return structuredClone(this.data);
    }

    validate(candidate) {
        if (!candidate || candidate.schemaVersion !== 1) throw new Error("Invalid proxy pool schema");
        if (!Array.isArray(candidate.nodes) || !candidate.bindings || typeof candidate.bindings !== "object")
            throw new Error("Invalid proxy pool nodes or bindings");
        const ids = new Set();
        const ports = new Set([Number(candidate.settings.controllerPort)]);
        let directNodeCount = 0;
        for (const node of candidate.nodes) {
            if (!node.id || ids.has(node.id)) throw new Error(`Duplicate or missing node id: ${node.id || "(empty)"}`);
            ids.add(node.id);
            node.egressGroup = normalizeGroup(node.egressGroup);
            if (node.type === "direct") {
                directNodeCount++;
                if (directNodeCount > 1) throw new Error("Only one direct node can be configured");
                if (node.localPort !== null && node.localPort !== undefined)
                    throw new Error(`Direct node ${node.id} cannot have a local port`);
                continue;
            }
            if (!Number.isInteger(node.localPort) || node.localPort < 1 || node.localPort > 65535)
                throw new Error(`Invalid local port for node ${node.id}`);
            if (ports.has(node.localPort)) throw new Error(`Local port conflict: ${node.localPort}`);
            ports.add(node.localPort);
        }
        for (const binding of Object.values(candidate.bindings)) {
            binding.egressGroup = normalizeGroup(binding.egressGroup);
            if (binding.desiredNodeId && !ids.has(binding.desiredNodeId))
                throw new Error(`Binding references missing node: ${binding.desiredNodeId}`);
        }
        return candidate;
    }

    async replace(candidate) {
        const next = this.validate(structuredClone(candidate));
        const operation = this._writeQueue
            .catch(() => {})
            .then(async () => {
                await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
                const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
                await fs.promises.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
                await fs.promises.chmod(temp, 0o600);
                await fs.promises.rename(temp, this.filePath);
                this.data = next;
            });
        this._writeQueue = operation;
        await operation;
        return this.snapshot();
    }
}

ProxyPoolStore.AUTOMATION_DEFAULTS = AUTOMATION_DEFAULTS;
module.exports = ProxyPoolStore;
