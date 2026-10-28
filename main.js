/**
 * File: main.js
 * Description: Main entry file that initializes and starts the AIStudio To API proxy server system
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

// Load environment variables based on NODE_ENV
const path = require("path");
const envFile = process.env.NODE_ENV === "production" ? ".env" : ".env.development";
// The supervisor must keep only the original shell environment. Each child reloads
// the environment file so file-only changes also take effect on a managed restart.
if (require.main !== module || (process.env.AISTUDIO_SERVICE_CHILD === "1" && process.send))
    require("dotenv").config({ path: path.resolve(__dirname, envFile) });

const ProxyServerSystem = require("./src/core/ProxyServerSystem");

/**
 * Initialize and start the server
 */
const initializeServer = async () => {
    const parsedInitialAuthIndex = parseInt(process.env.INITIAL_AUTH_INDEX, 10);
    const initialAuthIndex =
        Number.isInteger(parsedInitialAuthIndex) && parsedInitialAuthIndex >= 0 ? parsedInitialAuthIndex : null;

    let serverSystem;
    try {
        serverSystem = new ProxyServerSystem();
        const { monitorEventLoopDelay } = require("node:perf_hooks");
        const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
        eventLoopDelay.enable();
        const runtimeTimer = setInterval(() => {
            serverSystem.runtimeHealth = {
                event_loop_max_ms: Number((eventLoopDelay.max / 1e6).toFixed(2)),
                event_loop_p99_ms: Number((eventLoopDelay.percentile(99) / 1e6).toFixed(2)),
                updated_at: new Date().toISOString(),
            };
            eventLoopDelay.reset();
        }, 5000);
        runtimeTimer.unref();
        process.send?.({ policy: serverSystem.config.scheduler, type: "supervision-policy" });
        process.on("message", message => {
            if (message?.type !== "health-probe") return;
            const health = serverSystem.browserManager.getContextInitHealth();
            process.send?.({
                progress: {
                    completed: serverSystem.scheduler?.metrics.completed || 0,
                    generation: health.generation,
                    pending:
                        (serverSystem.configurationService.waitingForQuota()
                            ? 0
                            : serverSystem.scheduler?.pending.length || 0) + health.initializing,
                    ready: health.ready,
                },
                sequence: message.sequence,
                type: "health-reply",
            });
        });
        await serverSystem.start(initialAuthIndex);

        let shuttingDown = false;
        const shutdownHandler = async signal => {
            if (shuttingDown) return;
            shuttingDown = true;
            serverSystem.restarting = true;
            console.log(`\n${signal} received, shutting down gracefully...`);
            const forceExit = setTimeout(() => process.exit(1), 40000);
            try {
                const deadline = Date.now() + 15000;
                while (serverSystem.activeBusinessRequests > 0 && Date.now() < deadline)
                    await new Promise(resolve => setTimeout(resolve, 100));
                await serverSystem.shutdown();
                clearTimeout(forceExit);
                process.exit(0);
            } catch (error) {
                console.error("Error during shutdown:", error);
                process.exit(1);
            }
        };
        process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
        process.on("SIGINT", () => shutdownHandler("SIGINT"));
        process.on("message", message => {
            if (message?.type === "shutdown") shutdownHandler("restart");
        });
        const startupDeadline = Date.now() + 240000;
        while (!shuttingDown && !serverSystem.configurationService.startupAcceptable() && Date.now() < startupDeadline)
            await new Promise(resolve => setTimeout(resolve, 250));
        if (shuttingDown) return;
        if (!serverSystem.configurationService.startupAcceptable())
            throw new Error("Service contexts did not become healthy within startup deadline");
        const address = serverSystem.httpServer.address();
        process.send?.({
            configuration: serverSystem.configurationService.runningDocument(),
            healthEndpoint: {
                host: address.address === "0.0.0.0" ? "127.0.0.1" : address.address === "::" ? "::1" : address.address,
                port: address.port,
            },
            type: "ready",
        });
    } catch (error) {
        console.error("❌ Server startup failed:", error.message);
        process.send?.({ error: error.message, type: "startup-error" });
        if (serverSystem)
            await Promise.race([
                serverSystem.shutdown().catch(() => {}),
                new Promise(resolve => setTimeout(resolve, 20000)),
            ]);
        process.exit(1);
    }
};

// If this file is run directly, start the server
if (require.main === module) {
    if (process.env.AISTUDIO_SERVICE_CHILD === "1" && process.send) initializeServer();
    else require("./src/config/ServiceSupervisor").supervise(__filename);
}

module.exports = { initializeServer, ProxyServerSystem };
