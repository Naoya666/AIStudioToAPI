const { randomUUID } = require("node:crypto");
const { PlaygroundTransport } = require("../PlaygroundTransport");
const { MakerSuiteBridge } = require("../MakerSuiteBridge");
const { unavailable } = require("./LocalEngine");

class LocalBenefit {
    constructor(transport, raw) {
        this.transport = transport;
        this.source = "normal-query";
        this.disposed = false;
        this.apply(raw);
    }
    isCurrent() {
        return !this.disposed && this.transport.ready && !this.transport.closed;
    }
    apply(raw) {
        let tier;
        try {
            tier = JSON.parse(raw)[0];
        } catch {
            tier = null;
        }
        if (![0, 1, 2, 3].includes(tier)) {
            this.state = "failed";
            this.failureReason = "query_response";
        } else {
            this.rawTier = tier === 1 ? "TIER1" : tier === 2 ? "TIER2" : tier === 3 ? "TIER0" : null;
            this.state = tier === 1 || tier === 2 ? "ready-paid" : "ready-free";
            this.failureReason = null;
        }
        this.queryStatus = this.state === "failed" ? "failed" : "succeeded";
    }
    async query() {
        const result = await this.transport.run({
            body: [],
            id: randomUUID(),
            rpcMethod: "GetAiStudioBenefitTier",
            timeoutMs: 30000,
        });
        if (result.status !== 200) throw await this.transport.upstreamError(result);
        this.apply(result.text);
        return this;
    }
    async assertReady() {
        if (!this.isCurrent() || this.state !== "ready-paid") throw unavailable(503, "benefit_not_ready");
    }
    dispose() {
        this.disposed = true;
    }
}

// A transport session owns no page or browser context. Protocol decoding and business
// tool/output policies are shared with the browser backend through these methods.
class LocalTransport {
    constructor({ engine, session, authIndex, logger, resources, timeoutMs, catalog }) {
        Object.assign(this, { authIndex, engine, logger, resources, session, timeoutMs });
        this.backend = "local";
        this.ready = true;
        this.closed = false;
        this.epoch = 0;
        this.active = new Map();
        this.attempts = new Map();
        this.cleanup = new Set();
        this.operations = new Map();
        this.benefit = new LocalBenefit(this, Buffer.from(catalog.Tier || "", "base64").toString());
    }
    expectedDocumentId() {
        return Promise.resolve(this.session);
    }
    async startRpc(args) {
        if (this.closed) throw unavailable();
        const controller = new AbortController();
        const iterator = this.engine.stream(this.session, args, {
            signal: controller.signal,
            timeoutMs: args.timeoutMs,
        });
        this.operations.set(args.id, { controller, iterator });
    }
    async nextRpc(id) {
        const op = this.operations.get(id);
        if (!op) throw unavailable(499, "cancelled");
        let next;
        try {
            next = await op.iterator.next();
        } catch (error) {
            if (error.reason === "local_waa") this.ready = false;
            throw error;
        }
        if (next.done) throw unavailable(502, "transport");
        return next.value;
    }
    async run(args) {
        if (args.expectedBridgeId && args.expectedBridgeId !== this.session)
            return { cleanupSkipped: true, source: "local", status: 503, text: "" };
        await this.startRpc(args);
        let text = "";
        try {
            for (;;) {
                const event = await this.nextRpc(args.id);
                if (event.result) return { ...event.result, bridgeId: this.session, text: text + event.result.text };
                text += event.text || "";
            }
        } finally {
            await this.releaseRpc(args.id);
        }
    }
    async drive(operation) {
        const controller = new AbortController();
        this.operations.set(operation.id, { controller });
        try {
            return await this.engine.json("POST", `/sessions/${this.session}/drive`, operation, {
                signal: controller.signal,
                timeoutMs: 150000,
            });
        } finally {
            this.operations.delete(operation.id);
        }
    }
    cancel(id) {
        this.operations.get(id)?.controller.abort();
        return Promise.resolve();
    }
    async releaseRpc(id) {
        const operation = this.operations.get(id);
        this.operations.delete(id);
        operation?.controller.abort();
        await operation?.iterator?.return().catch(() => {});
    }
    proofIsBroken() {
        return Promise.resolve(false);
    }
    rejectStreamAuth() {
        return Promise.resolve();
    }
    async diagnoseAuth() {
        try {
            const result = await this.run({
                body: [],
                id: randomUUID(),
                rpcMethod: "GetLoggingContext",
                timeoutMs: 2000,
            });
            return result.status === 401 ? "session_expired" : "unverified";
        } catch (error) {
            return error.authState === "session_expired" ? "session_expired" : "unverified";
        }
    }
    dispose() {
        if (this.closed) return;
        this.closed = true;
        this.ready = false;
        this.epoch++;
        for (const operation of this.operations.values()) operation.controller.abort();
        for (const entry of this.active.values()) entry.invalidate();
        this.benefit.dispose();
        this.connection?.close();
    }
}
for (const name of ["generate", "connect", "upstreamError"])
    LocalTransport.prototype[name] = PlaygroundTransport.prototype[name];
for (const name of ["cancelAttempt", "settle"]) LocalTransport.prototype[name] = MakerSuiteBridge.prototype[name];
module.exports = { LocalBenefit, LocalTransport };
