const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const modulePath = name => JSON.stringify(path.resolve(__dirname, "../src/config", name));
const expressPath = JSON.stringify(require.resolve("express"));
const sessionPath = JSON.stringify(require.resolve("express-session"));

test(
    "supervisor restarts the child, keeps sessions, recovers once after failure and permits a later retry",
    { timeout: 30000 },
    async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "configuration-supervisor-"));
        const entry = path.join(directory, "fixture.cjs");
        // Exercise the production supervisor and HTTP configuration routes with an isolated service fixture.
        fs.writeFileSync(
            entry,
            `
const fs = require('fs'), path = require('path');
const { ConfigurationService } = require(${modulePath("ConfigurationService.js")});
if (!process.send) require(${modulePath("ServiceSupervisor.js")}).supervise(__filename);
else {
    const system = { logger: { error(){}, info(){}, warn(){}, setDisplayLimit(){} }, ready: true };
    const service = new ConfigurationService(system, { env: process.env });
    system.configurationService = service;
    if (system.config.publicDashboard.enabled) {
        process.send({type:'startup-error',error:'Simulated dashboard bind failure'});
        process.exit(1);
    }
    const app = require(${expressPath})();
    app.use(require(${expressPath}).json());
    app.use(require(${sessionPath})({secret:process.env.AISTUDIO_SESSION_SECRET,resave:false,saveUninitialized:false,store:new (require(${modulePath("RestartSessionStore.js")}))(),cookie:{maxAge:60000}}));
    app.post('/login', (req,res)=>{req.session.isAuthenticated=true;res.json({ok:true});});
    new (require(${modulePath("ConfigurationRoutes.js")}))(system).setupRoutes(app,(req,res,next)=>req.session.isAuthenticated ? next() : res.sendStatus(401));
    const server = app.listen(Number(process.env.FIXTURE_PORT || 0),'127.0.0.1',()=>{
        fs.writeFileSync(path.join(process.cwd(),'port'),String(server.address().port));
        process.send({type:'ready',configuration:service.runningDocument()});
    });
    process.on('message',message=>{if(message.type==='shutdown')setTimeout(()=>server.close(()=>process.exit(0)),100);});
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
`
        );
        let output = "";
        const child = spawn(process.execPath, [entry], {
            cwd: directory,
            env: { ...process.env, ACCOUNT_STORE_PATH: "", AISTUDIO_SERVICE_CHILD: "0", FIXTURE_PORT: "0" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", value => (output += value));
        child.stderr.on("data", value => (output += value));
        t.after(async () => {
            if (child.exitCode === null) {
                const ended = once(child, "exit");
                child.kill("SIGTERM");
                await ended;
            }
            fs.rmSync(directory, { force: true, recursive: true });
        });
        let cookie;
        const request = async (url, method = "GET", body) => {
            const port = fs.readFileSync(path.join(directory, "port"), "utf8");
            const response = await fetch(`http://127.0.0.1:${port}${url}`, {
                headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
                method,
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            const session = response.headers.get("set-cookie");
            if (session) cookie = session.split(";")[0];
            return { data: response.status === 401 ? null : await response.json(), status: response.status };
        };
        const waitFor = async predicate => {
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
                try {
                    const result = await predicate();
                    if (result) return result;
                } catch {
                    /* Child may be between listeners. */
                }
                assert.equal(child.exitCode, null, output);
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error(`Supervisor did not reach expected state: ${output}`);
        };
        await waitFor(() => fs.existsSync(path.join(directory, "port")));
        await request("/login", "POST", {});
        const initial = (await request("/api/configuration")).data;
        const saved = (
            await request("/api/configuration", "PATCH", {
                changes: { FORCE_THINKING: true, GLOBAL_MAX_CONCURRENCY: 2 },
                version: initial.version,
            })
        ).data;
        assert.equal(saved.running.GLOBAL_MAX_CONCURRENCY, 1);
        assert.equal(saved.saved.GLOBAL_MAX_CONCURRENCY, 2);
        const accepted = await request("/api/configuration/restart", "POST", { version: saved.version });
        assert.equal(accepted.status, 202);
        assert.equal((await request("/api/configuration/restart", "POST", { version: saved.version })).status, 409);
        const restarted = await waitFor(async () => {
            const result = await request("/api/configuration");
            return result.data?.instanceId !== initial.instanceId && result.data?.ready ? result.data : null;
        });
        assert.equal(restarted.running.GLOBAL_MAX_CONCURRENCY, 2);
        assert.equal(restarted.running.FORCE_THINKING, true);
        assert.equal(restarted.pending.length, 0);
        const failedTarget = (
            await request("/api/configuration", "PATCH", {
                changes: { PUBLIC_DASHBOARD_ENABLED: true },
                version: restarted.version,
            })
        ).data;
        await request("/api/configuration/restart", "POST", { version: failedTarget.version });
        const recovered = await waitFor(async () => {
            const result = await request("/api/configuration");
            return result.data?.instanceId !== restarted.instanceId && result.data?.ready ? result.data : null;
        });
        assert.match(recovered.restartError, /Simulated dashboard bind failure/);
        assert.equal(recovered.running.PUBLIC_DASHBOARD_ENABLED, false);
        assert.equal(recovered.saved.PUBLIC_DASHBOARD_ENABLED, true);
        assert.equal(recovered.pending.length, 1);
        const undone = (await request("/api/configuration/undo-pending", "POST", { version: recovered.version })).data;
        await request("/api/configuration/restart", "POST", { version: undone.version });
        const retried = await waitFor(async () => {
            const result = await request("/api/configuration");
            return result.data?.instanceId !== recovered.instanceId && result.data?.ready ? result.data : null;
        });
        await waitFor(async () => !(await request("/api/configuration")).data.restartError);
        assert.equal(retried.pending.length, 0);
    }
);

for (const [hasLastGood, browserState] of [
    [false, "STOPPED"],
    [true, "STOPPED"],
    [false, "FAILED"],
    [true, "FAILED"],
]) {
    test(
        `production startup with quota idle, browser=${browserState}, last-good=${hasLastGood}`,
        { timeout: 15000 },
        async t => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quota-startup-"));
            const data = path.join(directory, "data");
            fs.mkdirSync(data);
            const saved = {
                migratedAccounts: true,
                overrides: { CONTEXT_POOL_MIN_READY: 8, GLOBAL_MAX_CONCURRENCY: 80, MAX_BROWSER_WORKERS: 8 },
                version: 2,
            };
            fs.writeFileSync(path.join(data, "managed-config.json"), JSON.stringify(saved));
            if (hasLastGood)
                fs.writeFileSync(
                    path.join(data, "managed-config.last-good.json"),
                    JSON.stringify({
                        ...saved,
                        overrides: { CONTEXT_POOL_MIN_READY: 1, GLOBAL_MAX_CONCURRENCY: 1, MAX_BROWSER_WORKERS: 1 },
                        version: 1,
                    })
                );
            const entry = path.join(directory, "fixture.cjs");
            fs.writeFileSync(
                entry,
                `
const fs = require('fs'), path = require('path'), http = require('http');
if (!process.send) require(${modulePath("ServiceSupervisor.js")}).supervise(__filename);
else {
    fs.appendFileSync('launches', process.env.AISTUDIO_CONFIG_RECOVERY + '\\n');
    // Advance beyond the production startup deadline if main enters its wait loop.
    const realSetTimeout = global.setTimeout, realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    global.setTimeout = (callback, delay, ...args) => {
        if (delay === 250) { offset += 240001; delay = 1; }
        return realSetTimeout(callback, delay, ...args);
    };
    class FixtureSystem {
        constructor() {
            this.logger = { error(){}, info(){}, warn(){} };
            this.authSource = { availableIndices: [0] };
            this.configurationService = new (require(${modulePath("ConfigurationService.js")})).ConfigurationService(this, { env: { AISTUDIO_CONFIG_RECOVERY: process.env.AISTUDIO_CONFIG_RECOVERY, SUPERVISOR_HEARTBEAT_MS: "20", SUPERVISOR_TIMEOUT_MS: "1500", CONTEXT_OPERATION_TIMEOUT_MS: "10", CONTEXT_INIT_TOTAL_TIMEOUT_MS: "20" } });
            // Queued inference has no capacity; it is not stalled initialization.
            this.scheduler = { metrics: {}, pending: [{}], isWaitingForQuota: () => true };
            this.browserManager = { getContextInitHealth: () => ({ browserState: ${JSON.stringify(browserState)}, ready: 0, initializing: 0, staleInitializing: 0 }) };
        }
        async start() {
            this.httpServer = http.createServer((req,res) => { res.end('ok'); });
            await new Promise(resolve => this.httpServer.listen(0, '127.0.0.1', resolve));
            this.ready = true;
        }
        async shutdown() { await new Promise(resolve => this.httpServer.close(resolve)); }
    }
    const systemPath = ${JSON.stringify(require.resolve("../src/core/ProxyServerSystem"))};
    require.cache[systemPath] = { id: systemPath, filename: systemPath, loaded: true, exports: FixtureSystem };
    require(${JSON.stringify(require.resolve("../main"))}).initializeServer();
}
`
            );
            let output = "";
            const child = spawn(process.execPath, [entry], {
                cwd: directory,
                env: { ...process.env, AISTUDIO_SERVICE_CHILD: "0" },
                stdio: ["ignore", "pipe", "pipe"],
            });
            child.stdout.on("data", value => (output += value));
            child.stderr.on("data", value => (output += value));
            t.after(async () => {
                if (child.exitCode === null) {
                    const ended = once(child, "exit");
                    child.kill("SIGTERM");
                    await ended;
                }
                fs.rmSync(directory, { force: true, recursive: true });
            });
            const deadline = Date.now() + 8000;
            if (browserState === "FAILED") {
                while (child.exitCode === null && Date.now() < deadline)
                    await new Promise(resolve => setTimeout(resolve, 50));
                assert.equal(child.exitCode, 1, output);
                assert.equal(
                    fs.readFileSync(path.join(directory, "launches"), "utf8"),
                    hasLastGood ? "0\n1\n" : "0\n",
                    output
                );
                assert.match(output, /Service contexts did not become healthy within startup deadline/);
                if (hasLastGood)
                    assert.equal(
                        JSON.parse(fs.readFileSync(path.join(data, "managed-config.last-good.json"))).version,
                        1
                    );
                else assert.equal(fs.existsSync(path.join(data, "managed-config.last-good.json")), false);
                return;
            }
            let good;
            while (Date.now() < deadline) {
                assert.equal(child.exitCode, null, output);
                try {
                    good = JSON.parse(fs.readFileSync(path.join(data, "managed-config.last-good.json")));
                } catch {
                    /* Not accepted yet. */
                }
                if (good?.overrides.MAX_BROWSER_WORKERS === 8) break;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert.equal(good?.overrides.MAX_BROWSER_WORKERS, 8, output);
            assert.equal(good?.overrides.GLOBAL_MAX_CONCURRENCY, 80, output);
            // Cover multiple supervisor probes and its no-progress watchdog window.
            await new Promise(resolve => setTimeout(resolve, 3200));
            assert.equal(child.exitCode, null, output);
            assert.equal(fs.readFileSync(path.join(directory, "launches"), "utf8"), "0\n", output);
            const actualSaved = JSON.parse(fs.readFileSync(path.join(data, "managed-config.json")));
            assert.equal(actualSaved.overrides.MAX_BROWSER_WORKERS, 8);
            assert.equal(actualSaved.overrides.GLOBAL_MAX_CONCURRENCY, 80);
            assert.doesNotMatch(output, /startup failed|restoring last usable|recovery budget exhausted/i);
        }
    );
}
