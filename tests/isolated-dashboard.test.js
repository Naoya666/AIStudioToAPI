const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");

test("public dashboard responds while its application owner is blocked", { timeout: 15000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-dashboard-"));
    const entry = path.join(directory, "fixture.cjs");
    const modulePath = JSON.stringify(path.resolve(__dirname, "../src/public/IsolatedPublicDashboard.js"));
    fs.writeFileSync(
        entry,
        `
const Dashboard = require(${modulePath});
const dashboard = new Dashboard({config:{host:'127.0.0.1',port:0,corsOrigins:[]},logger:{warn(){}}});
dashboard.service = {getSnapshot:async()=>({generated_at:new Date().toISOString(),models:[]})};
dashboard.browserManager = {getContextInitHealth:()=>({ready:1})};
dashboard.start().then(()=>{
    process.send({type:'ready',address:dashboard.address,worker:dashboard.child.pid});
    process.on('message',message=>{
        if(message.type==='freeze') process.send({type:'frozen'},()=>{while(true){}});
    });
});
`
    );
    const owner = fork(entry, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const state = { worker: null };
    t.after(async () => {
        if (owner.exitCode === null && owner.signalCode === null) {
            const exit = once(owner, "exit");
            owner.kill("SIGKILL");
            await exit;
        }
        // The dashboard exits on IPC disconnection, with a fallback for a failed assertion.
        await new Promise(resolve => setTimeout(resolve, 100));
        if (state.worker) {
            try {
                process.kill(state.worker, "SIGKILL");
            } catch {
                /* Already gone. */
            }
        }
        fs.rmSync(directory, { force: true, recursive: true });
    });
    const [ready] = await once(owner, "message");
    state.worker = ready.worker;
    assert.equal(ready.type, "ready");
    const frozen = once(owner, "message");
    owner.send({ type: "freeze" });
    await frozen;
    const response = await fetch(`http://127.0.0.1:${ready.address.port}/api/public/dashboard`, {
        signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.service_status, "ready");
    assert.equal(body.stale, false);
    assert.deepEqual(body.models, []);
    assert.equal((await fetch(`http://127.0.0.1:${ready.address.port}/api/configuration`)).status, 404);
});

test(
    "an expired public snapshot is explicitly stale and retains its original timestamp",
    { timeout: 5000 },
    async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-stale-"));
        const entry = path.join(directory, "clock.cjs");
        const modulePath = JSON.stringify(path.resolve(__dirname, "../src/public/dashboard-process.js"));
        fs.writeFileSync(
            entry,
            `
const now=Date.now;let offset=0;Date.now=()=>now()+offset;
process.on('message',message=>{if(message.type==='advance'){offset=16000;process.send({type:'advanced'});}});
require(${modulePath});
`
        );
        const child = fork(entry, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
        t.after(async () => {
            if (child.exitCode === null && child.signalCode === null) {
                const exit = once(child, "exit");
                child.kill("SIGKILL");
                await exit;
            }
            fs.rmSync(directory, { force: true, recursive: true });
        });
        const ready = once(child, "message");
        child.send({ config: { corsOrigins: [], host: "127.0.0.1", port: 0 }, type: "configure" });
        const [message] = await ready;
        const generatedAt = new Date().toISOString();
        child.send({
            body: { generated_at: generatedAt, models: [], quota_status: "exhausted", service_status: "unavailable" },
            type: "snapshot",
        });
        const advanced = once(child, "message");
        child.send({ type: "advance" });
        await advanced;
        const response = await fetch(`http://127.0.0.1:${message.address.port}/api/public/dashboard`);
        const body = await response.json();
        assert.equal(body.stale, true);
        assert.equal(body.quota_status, undefined);
        assert.equal(body.service_status, "unavailable");
        assert.equal(body.generated_at, generatedAt);
    }
);

for (const role of ["standalone", "agent", "master"]) {
    test(`${role} publishes quota wait without changing service readiness or cached source data`, async () => {
        const Dashboard = require("../src/public/IsolatedPublicDashboard");
        let quotaStatus = "exhausted";
        const dashboard = new Dashboard({
            browserManager: { getContextInitHealth: () => ({ ready: 0 }) },
            config: { role },
            logger: { warn: assert.fail },
            quotaStatusProvider: () => quotaStatus,
        });
        const source = {
            generated_at: new Date().toISOString(),
            models: [{ model: "flash", quota: { estimable: false, estimated_remaining: null } }],
        };
        dashboard.service = {
            getSnapshot: async () => (role === "standalone" ? source : { snapshot: source }),
        };
        let published;
        dashboard.child = {
            connected: true,
            send(message, callback) {
                published = message.body;
                callback();
            },
        };
        await dashboard.publish();
        assert.equal(published.service_status, "unavailable");
        assert.equal(published.quota_status, "exhausted");
        const snapshot = () => (role === "standalone" ? published : published.snapshot);
        assert.deepEqual(snapshot().models[0].quota, { estimable: true, estimated_remaining: 0 });
        assert.equal(source.models[0].quota.estimated_remaining, null);
        quotaStatus = "cooldown";
        await dashboard.publish();
        assert.equal(published.quota_status, "cooldown");
        assert.equal(snapshot().models[0].quota.estimated_remaining, null);
        quotaStatus = null;
        await dashboard.publish();
        assert.equal(published.quota_status, undefined);
        assert.equal(published.service_status, "unavailable");
    });
}
