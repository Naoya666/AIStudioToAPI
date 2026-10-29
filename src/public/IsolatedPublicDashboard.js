const { fork } = require("child_process");
const path = require("path");
const PublicDashboardService = require("./PublicDashboardService");
const { defaults, nodeId } = require("./DashboardConfig");
const { MAX_AGENT_BYTES } = require("./DashboardProtocol");

// Only the public DTO crosses IPC. Account pools, authentication and mutations
// remain owned by the application process.
class IsolatedPublicDashboard {
    constructor({ config, logger, scheduler, usageStatsService, browserManager, quotaStatusProvider }) {
        this.config = { ...defaults, ...config };
        this.logger = logger;
        this.browserManager = browserManager;
        this.quotaStatusProvider = quotaStatusProvider;
        this.service = new PublicDashboardService(scheduler, usageStatsService, {
            cacheTtlMs: this.config.role === "standalone" ? 1000 : 0,
            includeAggregation: this.config.role !== "standalone",
        });
    }
    async start() {
        if (this.config.role !== "standalone") {
            this.config.nodeId = nodeId();
            if (this.config.agents.some(agent => agent.nodeId === this.config.nodeId))
                throw new Error("Public dashboard cannot collect itself");
        }
        this.child = fork(path.join(__dirname, "dashboard-process.js"), [], {
            stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.child.kill("SIGKILL");
                reject(new Error("Public dashboard startup timeout"));
            }, 10000);
            this.child.once("error", error => {
                clearTimeout(timer);
                reject(error);
            });
            this.child.once("exit", () => {
                clearTimeout(timer);
                reject(new Error("Public dashboard process exited"));
            });
            this.child.on("message", message => {
                if (message.type === "ready") {
                    this.address = message.address;
                    clearTimeout(timer);
                    resolve();
                }
                if (message.type === "startup-error") {
                    clearTimeout(timer);
                    reject(new Error(message.error));
                }
            });
            this.child.send({ config: this.config, type: "configure" });
        });
        this.child.on("exit", () => {
            if (!this.stopping) this.browserManager?._requestApplicationRecovery("public_dashboard_process_exited");
        });
        this.timer = setInterval(
            () => this.publish(),
            this.config.role === "standalone" ? 1000 : this.config.snapshotIntervalMs
        );
        this.timer.unref();
        await this.publish();
    }
    async publish() {
        if (this.publishing || !this.child?.connected || this.stopping) return;
        this.publishing = true;
        try {
            const body = await this.service.getSnapshot();
            if (this.stopping || !this.child.connected) return;
            const health = this.browserManager?.getContextInitHealth();
            const quotaStatus = this.quotaStatusProvider?.();
            const quotaState = quotaStatus ? { quota_status: quotaStatus } : {};
            // Confirmed daily exhaustion is an observed zero, even for unknown quota limits.
            const publicBody = quotaStatus === "exhausted" ? this._exhaustedSnapshot(body) : body;
            const status = health?.recovering || !health?.ready ? "unavailable" : "ready";
            const snapshot =
                this.config.role === "standalone"
                    ? { ...publicBody, ...quotaState, service_status: status }
                    : {
                          agent_schema_version: 1,
                          ...quotaState,
                          aggregation: publicBody.aggregation,
                          generated_at: body.snapshot.generated_at,
                          node_id: this.config.nodeId,
                          service_status: status,
                          snapshot: publicBody.snapshot,
                          snapshot_sequence: (this.sequence = (this.sequence || 0) + 1),
                      };
            if (
                Buffer.byteLength(JSON.stringify(snapshot)) >
                (this.config.role === "standalone" ? 256 * 1024 : MAX_AGENT_BYTES)
            )
                throw new Error("Public dashboard response too large");
            await new Promise(resolve => this.child.send({ body: snapshot, type: "snapshot" }, () => resolve()));
        } catch (error) {
            this.logger.warn("[PublicDashboard] Snapshot generation failed");
        } finally {
            this.publishing = false;
        }
    }
    _exhaustedSnapshot(body) {
        const snapshot = this.config.role === "standalone" ? body : body.snapshot;
        const exhausted = {
            ...snapshot,
            models: snapshot.models.map(model => ({
                ...model,
                quota: { ...model.quota, estimable: true, estimated_remaining: 0 },
            })),
        };
        return this.config.role === "standalone" ? exhausted : { ...body, snapshot: exhausted };
    }
    async close() {
        this.stopping = true;
        clearInterval(this.timer);
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        await new Promise(resolve => {
            const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
            if (child.connected) child.send({ type: "shutdown" }, () => {});
            else child.kill("SIGTERM");
        });
    }
}
module.exports = IsolatedPublicDashboard;
