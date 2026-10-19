const crypto = require("crypto");
const PublicDashboardServer = require("./PublicDashboardServer");
const PublicDashboardCollector = require("./PublicDashboardCollector");
const { aggregate } = require("./PublicDashboardAggregator");
const { defaults } = require("./DashboardConfig");
const { MAX_AGENT_BYTES, MAX_PUBLIC_BYTES, validateEnvelope } = require("./DashboardProtocol");
let server,
    snapshot,
    receivedAt = 0,
    cached,
    localCached,
    collector,
    expiryTimer,
    config,
    stopping = false;
const logger = { error: console.error, info: console.log };
function serialize(body, maximum) {
    if (!body) return null;
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > maximum) throw new Error("Dashboard snapshot too large");
    return { etag: `"${crypto.createHash("sha256").update(serialized).digest("base64url")}"`, serialized };
}
function rebuild() {
    if (stopping || config?.role !== "master") return;
    try {
        cached = serialize(
            aggregate(
                [
                    { body: snapshot, failed: false },
                    ...[...collector.entries.values()].map(entry => ({ body: entry.body, failed: entry.failed })),
                ],
                Date.now(),
                config.staleAfterMs
            ),
            MAX_PUBLIC_BYTES
        );
    } catch {
        cached = null;
        logger.error("[PublicDashboard] Unable to aggregate snapshots");
    }
}
process.on("message", async message => {
    if (stopping) return;
    if (message.type === "snapshot") {
        if (!config) return;
        if (config.role === "standalone") {
            snapshot = message.body;
            receivedAt = Date.now();
        } else {
            try {
                validateEnvelope(message.body, config.nodeId);
                const body = message.body;
                const local = serialize(
                    {
                        generated_at: body.generated_at,
                        models: body.snapshot.models.map(model => ({
                            model: model.model,
                            realtime: { available_accounts: model.realtime.available_accounts },
                        })),
                        node_id: body.node_id,
                        schema_version: 1,
                        service_status: body.service_status,
                        snapshot_sequence: body.snapshot_sequence,
                        usage_window: {
                            date: body.snapshot.usage_window.date,
                            timezone: body.snapshot.usage_window.timezone,
                        },
                    },
                    MAX_AGENT_BYTES
                );
                const next = config.role === "agent" ? serialize(body, MAX_AGENT_BYTES) : null;
                localCached = local;
                snapshot = message.body;
                receivedAt = Date.now();
                if (config.role === "agent") cached = next;
                else rebuild();
            } catch {
                logger.error("[PublicDashboard] Rejected invalid local snapshot");
            }
        }
    }
    if (message.type === "configure" && !server) {
        config = { ...defaults, ...message.config };
        server = new PublicDashboardServer({ config, logger });
        if (config.role === "standalone") {
            server.service = {
                getSnapshot: async () => {
                    if (!snapshot) throw new Error("Snapshot not yet available");
                    const stale = Date.now() - receivedAt > 15000;
                    return { ...snapshot, service_status: stale ? "unavailable" : snapshot.service_status, stale };
                },
            };
        } else server.cachedResponseProvider = () => cached;
        server.localResponseProvider = () => ({
            cached: localCached,
            usable:
                snapshot?.service_status === "ready" &&
                Date.now() - Date.parse(snapshot.generated_at) <= config.staleAfterMs,
        });
        server.healthProvider = () => ({
            status:
                config.role === "master"
                    ? cached
                        ? "ok"
                        : "stale"
                    : !snapshot ||
                        Date.now() - Date.parse(snapshot.generated_at) >
                            (config.role === "standalone" ? 15000 : config.staleAfterMs)
                      ? "stale"
                      : "ok",
            updated_at: snapshot?.generated_at || null,
        });
        try {
            if (config.role === "master") {
                collector = new PublicDashboardCollector({ config, nodeId: config.nodeId, onUpdate: rebuild });
                collector.start();
                expiryTimer = setInterval(rebuild, 1000);
                expiryTimer.unref();
            }
            await server.start();
            process.send({ address: server.server.address(), type: "ready" });
        } catch {
            collector?.close();
            clearInterval(expiryTimer);
            process.send({ error: "Public dashboard startup failed", type: "startup-error" }, () => process.exit(1));
        }
    }
    if (message.type === "shutdown") {
        stopping = true;
        collector?.close();
        clearInterval(expiryTimer);
        await server?.close();
        process.exit(0);
    }
});
process.on("disconnect", () => {
    collector?.close();
    clearInterval(expiryTimer);
    process.exit(0);
});
