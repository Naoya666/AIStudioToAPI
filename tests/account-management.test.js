const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { performance } = require("node:perf_hooks");
const Service = require("../src/accounts/AccountLoginService");
const Totp = require("../src/accounts/TotpService");
const { parseImport, Payload } = require("../src/accounts/AuthenticatorImportService");
const AccountRoutes = require("../src/routes/AccountRoutes");
const ProxyBindingService = require("../src/proxy/ProxyBindingService");
const ProxyPoolService = require("../src/proxy/ProxyPoolService");
const ProxyPoolStore = require("../src/proxy/ProxyPoolStore");
const ProxyPoolRoutes = require("../src/routes/ProxyPoolRoutes");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const schedulerConfig = require("../src/core/SchedulerConfig");
const AuthSource = require("../src/auth/AuthSource");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 4000) {
    const deadline = performance.now() + timeout;
    while (!predicate()) {
        if (performance.now() > deadline) throw new Error("Condition timed out");
        await wait(20);
    }
}
async function fixture(t, count = 0) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "account-management-test-"));
    const authDir = path.join(directory, "auth");
    await fs.mkdir(authDir);
    for (let index = 0; index < count; index++)
        await fs.writeFile(
            path.join(authDir, `auth-${index}.json`),
            JSON.stringify({ accountName: `user${index}@example.com`, cookies: [], origins: [] })
        );
    const system = {
        authSource: { availableIndices: Array.from({ length: count }, (_, index) => index), reloadAuthSources() {} },
        logger,
        scheduler: { isAccountManuallyDisabled: () => false },
    };
    const options = {
        artifactDir: path.join(directory, "artifacts"),
        authDir,
        storePath: path.join(directory, "accounts.sqlite"),
        workerPath: path.join(__dirname, "fixtures/account-login-executor.js"),
    };
    const service = new Service(system, options);
    await service.initialize({ startQueue: false });
    let closed = false;
    t.after(async () => {
        if (!closed) await service.close();
        await fs.rm(directory, { force: true, recursive: true });
    });
    return {
        close: async () => {
            await service.close();
            closed = true;
        },
        directory,
        options,
        service,
        system,
    };
}
test("RFC 6238 SHA1 vectors and strict OTP parameter rejection", () => {
    const parameters = Totp.normalize(secret);
    for (const [epoch, expected] of [
        [59, "287082"],
        [1111111109, "081804"],
        [1111111111, "050471"],
        [1234567890, "005924"],
        [2000000000, "279037"],
        [20000000000, "353130"],
    ])
        assert.equal(Totp.code(parameters, epoch * 1000), expected);
    assert.equal(Totp.normalize("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").secret, secret);
    for (const input of [
        `otpauth://hotp/test?secret=${secret}`,
        `otpauth://totp/test?secret=${secret}&digits=8`,
        `otpauth://totp/test?secret=${secret}&algorithm=SHA256`,
        "NOT-A-SECRET",
    ])
        assert.throws(() => Totp.normalize(input));
});
test("CSV preserves BOM, quoted commas, quotes, newlines and password whitespace", () => {
    const parsed = parseImport(
        "csv",
        '\ufeffemail,password,totpSecret\r\nUser@Example.com," p,a""ss\nword ",\r\nuser@example.com,second,\r\ninvalid,,'
    );
    assert.equal(parsed.rows[0].password, ' p,a"ss\nword ');
    assert.equal(parsed.rows[0].email, "user@example.com");
    assert.match(parsed.rows[1].error, /Duplicate/);
    assert.ok(parsed.rows[2].error);
});
function migration(batchIndex = 0, batchSize = 1, overrides = {}, version = 1) {
    const bytes = Payload.encode(
        Payload.create({
            batchId: 9,
            batchIndex,
            batchSize,
            entries: [
                {
                    algorithm: 1,
                    digits: 1,
                    name: "Google:user@example.com",
                    secret: Buffer.from("12345678901234567890"),
                    type: 2,
                    ...overrides,
                },
            ],
            version,
        })
    ).finish();
    return `otpauth-migration://offline?data=${Buffer.from(bytes).toString("base64")}`;
}
test("migration schema handles complete, missing, duplicate and unsupported batches", () => {
    assert.equal(parseImport("authenticator", migration()).rows[0].totp.secret, secret);
    assert.equal(parseImport("authenticator", migration(0, 2)).complete, false);
    const complete = parseImport(
        "authenticator",
        `${migration(0, 2)}\n${migration(0, 2)}\n${migration(1, 2, { name: "other@example.com" })}`
    );
    assert.equal(complete.complete, true);
    assert.equal(complete.rows.length, 2);
    assert.ok(parseImport("authenticator", migration(0, 1, { type: 1 })).rows[0].error);
    const uri = migration();
    assert.equal(
        parseImport("authenticator", uri.replace("data=", "data=").replace(/=$/, "%3D")).rows[0].email,
        "user@example.com"
    );
    assert.ok(parseImport("authenticator", "otpauth-migration://offline?data=%%%bad").rows[0].error);
});
test("migration version 2 accepts URL-encoded exports with an unknown entry ID field", () => {
    // Independently encoded synthetic export, including entry field 8 (unique ID).
    const uri =
        "otpauth-migration://offline?data=ClEKFDEyMzQ1Njc4OTAxMjM0NTY3ODkwEhdHb29nbGU6dXNlckBleGFtcGxlLmNvbRoGR29vZ2xlIAEoATACQhJzeW50aGV0aWMtZW50cnktaWQQAhgBIAA%3D";
    const parsed = parseImport("authenticator", uri);
    assert.equal(parsed.complete, true);
    assert.deepEqual(parsed.batches, [{ id: "0", received: [0], size: 1 }]);
    assert.deepEqual(parsed.rows, [
        { email: "user@example.com", name: "Google:user@example.com", totp: Totp.normalize(secret) },
    ]);
    assert.equal(parseImport("authenticator", migration(0, 2, {}, 2)).complete, false);
    const complete = parseImport(
        "authenticator",
        `${migration(0, 2, {}, 2)}\n${migration(1, 2, { name: "other@example.com" }, 2)}`
    );
    assert.equal(complete.complete, true);
    assert.equal(complete.rows.length, 2);
    assert.ok(complete.rows.every(row => !row.error));
    assert.ok(parseImport("authenticator", migration(0, 1, { type: 1 }, 2)).rows[0].error);
    for (const version of [0, 3])
        assert.equal(
            parseImport("authenticator", migration(0, 1, {}, version)).rows[0].error,
            "Damaged migration link or invalid OTP"
        );
});
test("150 existing Cookie accounts migrate without rewriting cookies or exposing secrets", async t => {
    const { service, directory } = await fixture(t, 150);
    assert.equal(service.list().length, 150);
    const account = service.state.accounts[0],
        before = await fs.readFile(path.join(directory, "auth/auth-0.json"), "utf8");
    await service.edit(account.accountId, {
        credentialVersion: account.credentialVersion,
        password: "synthetic-password",
        totpSecret: secret,
    });
    assert.equal(await fs.readFile(path.join(directory, "auth/auth-0.json"), "utf8"), before);
    assert.equal(account.sessionState, "valid");
    const metadata = JSON.stringify(service.list());
    assert.ok(!metadata.includes("synthetic-password"));
    assert.ok(!metadata.includes(secret));
    const stat = await fs.stat(service.store.dbPath);
    assert.equal(stat.mode & 0o777, 0o600);
});
test("credential edits reject empty values, distinguish clear and enforce optimistic versions", async t => {
    const { service } = await fixture(t);
    const created = await service.create(
        { email: "edit@example.com", password: "synthetic-password", totpSecret: secret },
        false
    );
    const id = created.account.accountId;
    await assert.rejects(service.edit(id, { credentialVersion: 1, password: "" }), { status: 400 });
    await service.edit(id, { autoRecovery: false, credentialVersion: 1 });
    assert.equal(service.credentials(id).password, "synthetic-password");
    await service.edit(id, { clearTotpSecret: true, credentialVersion: 1 });
    assert.equal(service.credentials(id).totpSecret, null);
    await assert.rejects(service.edit(id, { credentialVersion: 1, password: "new" }), { status: 409 });
});
test("same-account deduplication, queue capacity, pause and disabled auto recovery", async t => {
    const { service, system } = await fixture(t, 1);
    const account = service.state.accounts[0];
    await service.edit(account.accountId, { credentialVersion: 1, password: "synthetic" });
    account.sessionState = "expired";
    system.scheduler.isAccountManuallyDisabled = () => true;
    await service.scanRecovery();
    assert.equal(service.state.tasks.length, 0);
    const first = await service.login(account.accountId),
        second = await service.login(account.accountId);
    assert.equal(first.taskId, second.taskId);
    service.state.config.queueLimit = 1;
    await assert.rejects(service.create({ email: "another@example.com", password: "synthetic" }), { status: 429 });
    service.state.config.paused = true;
    await service.queue.tick();
    assert.equal(service.queue.running.size, 0);
    await service.cancel(first.taskId);
    assert.equal(service.state.tasks[0].status, "cancelled");
});
test("per-attempt hard timeout kills hanging executor descendants and next account succeeds", async t => {
    const { service } = await fixture(t);
    Object.assign(service.state.config, {
        attemptTimeout: 300,
        cleanupTimeout: 100,
        maxAttempts: 1,
        screenshotTimeout: 50,
        stepTimeout: 50,
    });
    await service.create({ email: "hang@example.com", password: "synthetic" });
    const next = await service.create({ email: "success@example.com", password: "synthetic" });
    await service.queue.tick();
    assert.equal(service.queue.running.size, 1);
    await until(() => service.state.tasks.every(task => ["failed", "succeeded"].includes(task.status)));
    assert.equal(service.state.tasks[0].error, "attempt_timeout");
    assert.equal(service.state.tasks[1].status, "succeeded");
    assert.equal(service.account(next.account.accountId).authIndex, 0);
    assert.equal(service.queue.snapshot().faultSlots, 0);
});
test("temporary failure releases slot during retry, consumes at most three attempts", async t => {
    const { service } = await fixture(t);
    Object.assign(service.state.config, { attemptTimeout: 2000, cleanupTimeout: 100, stepTimeout: 20 });
    await service.create({ email: "network@example.com", password: "synthetic" });
    const task = service.state.tasks[0];
    await service.queue.tick();
    await until(() => task.status === "retry_wait");
    assert.equal(service.queue.running.size, 0);
    for (let attempt = 2; attempt <= 3; attempt++) {
        task.nextAttemptAt = Date.now();
        await service.queue.tick();
        await until(() => task.attempts === attempt && task.status !== "running");
    }
    assert.equal(task.status, "failed");
    assert.equal(task.attempts, 3);
});
test("wrong password immediately requires manual action without retry", async t => {
    const { service } = await fixture(t);
    Object.assign(service.state.config, { attemptTimeout: 2000, cleanupTimeout: 100, stepTimeout: 20 });
    const created = await service.create({ email: "wrong@example.com", password: "synthetic" });
    await service.queue.tick();
    await until(() => service.state.tasks[0].status === "failed");
    assert.equal(service.state.tasks[0].attempts, 1);
    assert.equal(service.account(created.account.accountId).recoveryState, "manual_required");
});
test("late success after credential mutation or cancellation cannot write auth files", async t => {
    const { service, directory } = await fixture(t);
    Object.assign(service.state.config, {
        attemptTimeout: 2000,
        cleanupTimeout: 100,
        screenshotTimeout: 50,
        stepTimeout: 20,
    });
    const created = await service.create({ email: "late@example.com", password: "synthetic" });
    await service.queue.tick();
    await service.exclusive(() =>
        service.edit(created.account.accountId, { credentialVersion: 1, password: "new-synthetic" })
    );
    await until(() => !service.queue.running.size);
    assert.equal(service.state.tasks[0].status, "cancelled");
    assert.deepEqual(await fs.readdir(path.join(directory, "auth")), []);
    await service.login(created.account.accountId);
    await service.queue.tick();
    await service.cancel(service.state.tasks[1].taskId);
    await until(() => !service.queue.running.size);
    assert.deepEqual(await fs.readdir(path.join(directory, "auth")), []);
});
test("upstream 401 persists expiration, queues recovery and restores scheduler health on session commit", async t => {
    const { service, system } = await fixture(t, 1);
    const auth = system.authSource;
    auth.accountNameMap = new Map([[0, "user0@example.com"]]);
    auth.accountLoginService = service;
    auth.markAsExpired = AuthSource.prototype.markAsExpired.bind(auth);
    auth.getRotationIndices = () =>
        service.state.accounts.filter(a => a.sessionState === "valid").map(a => a.authIndex);
    const scheduler = new ModelScheduler(
        { ...schedulerConfig({ SCHEDULER_DAILY_RESET_ENABLED: "false" }), statePath: null },
        auth,
        logger
    );
    system.scheduler = scheduler;
    t.after(() => scheduler.close());
    const account = service.state.accounts[0];
    await service.edit(account.accountId, { credentialVersion: 1, password: "synthetic" });
    service.state.config.autoRecovery = true;
    const lease = await scheduler.acquire("flash");
    scheduler.startAttempt(lease);
    await scheduler.failure(lease, {
        message: "Proxy browser error: Google API returned error: 401 UNAUTHENTICATED",
    });
    assert.equal((await service.readAuth(0)).expired, true);
    assert.equal(service.list()[0].sessionState, "expired");
    assert.deepEqual(auth.getRotationIndices(), []);
    assert.equal(service.state.tasks.length, 1);
    assert.equal(service.state.tasks[0].source, "expired");
    scheduler.release(lease);
    scheduler.disable(0);
    lease.slot.unsupported = true;
    await service.exclusive(() =>
        service.commitSession(
            account,
            {
                accountName: account.email,
                cookies: [],
                origins: [],
            },
            service.state.tasks[0]
        )
    );
    assert.equal(account.sessionState, "valid");
    assert.equal((await service.readAuth(0)).expired, undefined);
    assert.equal(scheduler.account(0).healthy, true);
    assert.equal(scheduler.account(0).disabled, true);
    assert.equal(lease.slot.unsupported, true);
    // Even a write already queued before replacement is rejected by the version guard.
    assert.equal(await auth.markAsExpired(0, lease.sessionVersion), false);
    assert.equal(account.sessionState, "valid");
});

test("old Context refresh and expiration cannot overwrite new Cookie; disabled state survives", async t => {
    const { service, system } = await fixture(t, 1);
    system.scheduler.isAccountManuallyDisabled = () => true;
    await service.upload({
        accountName: "user0@example.com",
        cookies: [{ name: "fresh", value: "synthetic-cookie" }],
        origins: [],
    });
    const account = service.state.accounts[0],
        version = account.sessionVersion;
    assert.equal(await service.markExpired(0, 0), false);
    assert.equal(await service.refreshSession(0, 0, { cookies: [], origins: [] }), false);
    assert.equal((await service.readAuth(0)).cookies[0].name, "fresh");
    assert.equal(service.list()[0].disabled, true);
    assert.equal(await service.markExpired(0, version), true);
    await service.removeIndex(0);
    await service.upload({ accountName: "replacement@example.com", cookies: [], origins: [] });
    assert.notEqual(service.state.accounts[0].accountId, account.accountId);
    assert.equal(await service.refreshSession(0, version, { cookies: [], origins: [] }), false);
});
test("account list and recovery use the real scheduler's administrative disable method", async t => {
    const { service, system } = await fixture(t, 1);
    system.authSource.accountNameMap = new Map();
    const scheduler = new ModelScheduler(
        { ...schedulerConfig({ SCHEDULER_DAILY_RESET_ENABLED: "false" }), statePath: null },
        system.authSource,
        logger
    );
    system.scheduler = scheduler;
    t.after(() => scheduler.close());
    assert.equal(service.list()[0].disabled, false);
    scheduler.disable(0);
    assert.equal(service.list()[0].disabled, true);
    const account = service.state.accounts[0];
    await service.edit(account.accountId, { credentialVersion: 1, password: "synthetic" });
    account.sessionState = "expired";
    account.recoveryState = "idle";
    await service.scanRecovery();
    assert.equal(service.state.tasks.length, 0);
    const task = service.enqueue(account, "expired");
    await service.queue.tick();
    assert.equal(task.status, "cancelled");
    assert.equal(service.queue.running.size, 0);
    assert.equal(service.list()[0].disabled, true);
});
test("import preview is secret-free, session-bound, versioned and idempotent", async t => {
    const { service } = await fixture(t, 1);
    const content = 'email,password\nuser0@example.com,"synthetic, password"\nnew@example.com,new-synthetic';
    const preview = service.preview("session-a", "csv", content);
    assert.ok(!JSON.stringify(preview).includes("synthetic"));
    await assert.rejects(service.importCommit("session-b", { previewId: preview.previewId, rows: [] }), {
        status: 409,
    });
    const result = await service.importCommit("session-a", {
        previewId: preview.previewId,
        rows: [{ index: 0 }, { create: true, index: 1 }],
    });
    assert.equal(result.updated, 1);
    assert.equal(result.created, 1);
    assert.equal(service.state.tasks.length, service.state.config.autoRecovery ? 1 : 0);
    assert.equal(service.state.accounts[0].password, "synthetic, password");
    assert.deepEqual(await service.importCommit("session-a", { previewId: preview.previewId, rows: [] }), result);
    const stale = service.preview("session-a", "csv", content);
    const account = service.state.accounts[0];
    await service.edit(account.accountId, { credentialVersion: account.credentialVersion, password: "changed" });
    assert.equal(
        (await service.importCommit("session-a", { previewId: stale.previewId, rows: [{ index: 0, overwrite: true }] }))
            .failed,
        1
    );
});
test("queue state and consumed attempts survive manager restart; commit journal rolls forward", async t => {
    const { service, system, options, close } = await fixture(t, 1);
    const account = service.state.accounts[0];
    await service.edit(account.accountId, { credentialVersion: 1, password: "synthetic" });
    const task = service.enqueue(account, "manual");
    Object.assign(task, { attempts: 2, deadline: Date.now() + 900000, startedAt: Date.now(), status: "running" });
    await service.save();
    await close();
    const resumed = new Service(system, options);
    t.after(() => resumed.close());
    await resumed.initialize({ startQueue: false });
    assert.equal(resumed.state.tasks[0].attempts, 2);
    assert.equal(resumed.state.tasks[0].status, "retry_wait");
    const target = resumed.state.accounts[0];
    resumed.state.commits.push({ accountId: target.accountId, authIndex: 0, sessionVersion: 10, taskId: task.taskId });
    await resumed.atomicAuth(0, { _accountSessionVersion: 10, accountName: target.email, cookies: [], origins: [] });
    await resumed.save();
    await resumed.close();
    const recovered = new Service(system, options);
    t.after(() => recovered.close());
    await recovered.initialize({ startQueue: false });
    assert.equal(recovered.state.accounts[0].sessionVersion, 10);
    assert.equal(recovered.state.tasks[0].status, "succeeded");
    await recovered.close();
});
test("failure artifacts expire as 410 without deleting attempt metadata", async t => {
    const { service } = await fixture(t);
    const artifact = await service.artifacts.save("synthetic-account", "synthetic-task", Buffer.from("synthetic-png"));
    service.state.artifacts.push(artifact);
    artifact.createdAt = Date.now() - 8 * 86400000;
    await service.cleanup();
    await assert.rejects(service.artifacts.read(artifact), { status: 410 });
    assert.equal(service.state.artifacts[0].id, artifact.id);
});
test("deduplication exposes conflicts without secrets and merges only explicit versioned choices", async t => {
    const { service } = await fixture(t, 2);
    const first = service.state.accounts[0],
        second = service.state.accounts[1];
    second.email = first.email;
    first.password = "synthetic-one";
    second.password = "synthetic-two";
    const groups = [{ email: first.email, keptIndex: 0, removedIndices: [1] }];
    const result = await service.prepareDeduplicate(groups);
    assert.equal(result.conflicts.length, 1);
    assert.ok(!JSON.stringify(result).includes("synthetic-one"));
    const choice = {
        [first.email]: {
            accountId: second.accountId,
            versions: { [first.accountId]: first.credentialVersion, [second.accountId]: second.credentialVersion },
        },
    };
    assert.equal((await service.prepareDeduplicate(groups, choice)).conflicts.length, 0);
    assert.equal(first.password, "synthetic-two");
    await assert.rejects(
        service.edit(first.accountId, { credentialVersion: first.credentialVersion, password: "other" }),
        { status: 409 }
    );
    await service.removeIndex(1, { dedup: true });
    service.deduplicating = false;
    assert.equal(service.state.accounts.length, 1);
    assert.equal(service.state.accounts[0].password, "synthetic-two");
});
test("every management route shares existing console authentication and no-store", () => {
    const registered = [],
        middleware = [],
        guard = () => {};
    const app = { use: (...args) => middleware.push(args) };
    for (const method of ["get", "post", "patch", "delete"]) app[method] = (...args) => registered.push(args);
    new AccountRoutes({}).setupRoutes(app, guard);
    assert.equal(middleware[0][0], "/api/account-management");
    assert.equal(middleware[0][1], guard);
    const headers = {};
    middleware[0][2](
        {},
        {
            set: (key, value) => {
                headers[key] = value;
            },
        },
        () => {}
    );
    assert.equal(headers["Cache-Control"], "no-store");
    assert.ok(registered.some(args => args[0] === "/accounts" && args[1] === guard));
    assert.ok(registered.length >= 14);
});

test("credential exports round-trip CSV and keep single Cookie downloads free of credentials", async t => {
    const { credentialsCsv, accountBundle, cookieState } = require("../src/accounts/AccountExport");
    const JSZip = require("jszip");
    const { service, system } = await fixture(t, 1);
    const account = service.state.accounts[0];
    account.password = ' synthetic,p"ass\nword ';
    account.totp = Totp.normalize(secret);
    const missing = (await service.create({ email: "unbound@example.com", password: "synthetic" }, false)).account;
    const exported = credentialsCsv(service.selectedAccounts({ all: true }));
    const imported = parseImport("csv", exported);
    assert.equal(imported.rows[0].password, account.password);
    assert.equal(imported.rows[0].totp.secret, secret);
    assert.equal(imported.rows[1].email, missing.email);
    const state = { accountName: account.email, cookies: [], origins: [], password: "hidden", totpSecret: secret };
    assert.deepEqual(cookieState(state), { accountName: account.email, cookies: [], origins: [] });
    const zip = await JSZip.loadAsync(await accountBundle(service.selectedAccounts({ all: true }), () => state));
    assert.deepEqual(Object.keys(zip.files).sort(), ["auth-0.json", "credentials.csv"]);
    assert.equal(await zip.file("credentials.csv").async("string"), exported);
    assert.deepEqual(JSON.parse(await zip.file("auth-0.json").async("string")), cookieState(state));
    await assert.rejects(
        accountBundle([account], () => null),
        { status: 409 }
    );
    assert.throws(() => service.selectedAccounts({ accountIds: [] }), { status: 400 });
    assert.equal(service.selectedAccounts({ accountIds: [account.accountId, account.accountId] }).length, 1);
    const handlers = new Map(),
        app = { use() {} };
    for (const method of ["get", "post", "patch", "delete"])
        app[method] = (endpoint, ...middleware) => handlers.set(`${method} ${endpoint}`, middleware.at(-1));
    system.accountLoginService = service;
    new AccountRoutes(system).setupRoutes(app, () => {});
    const response = () => ({
        attachment(value) {
            this.filename = value;
            return this;
        },
        headersSent: false,
        json(value) {
            this.body = value;
            this.headersSent = true;
            return this;
        },
        send(value) {
            this.body = value;
            this.headersSent = true;
            return this;
        },
        status(value) {
            this.code = value;
            return this;
        },
        type(value) {
            this.contentType = value;
            return this;
        },
    });
    const csvResponse = response();
    await handlers.get("post /api/account-management/export/credentials")(
        { body: { accountIds: [account.accountId] } },
        csvResponse
    );
    assert.equal(csvResponse.filename, "credentials.csv");
    assert.equal(parseImport("csv", csvResponse.body).rows[0].password, account.password);
    const cookieResponse = response();
    await handlers.get("get /api/account-management/accounts/:id/download")(
        { params: { id: account.accountId } },
        cookieResponse
    );
    assert.equal(cookieResponse.filename, "auth-0.json");
    assert.ok(!cookieResponse.body.includes(account.password));
    system.authSource.duplicateIndices = [0];
    const listResponse = response();
    await handlers.get("get /api/account-management/accounts")(
        { query: { search: "#0", state: "duplicate" } },
        listResponse
    );
    assert.equal(listResponse.body.total, 1);
    assert.equal(listResponse.body.accounts[0].isDuplicate, true);
    const invalidSwitch = response();
    const originalConcurrency = service.state.config.concurrency;
    await handlers.get("patch /api/account-management/login-queue")(
        { body: { autoRecovery: "false", concurrency: 2 } },
        invalidSwitch
    );
    assert.equal(invalidSwitch.code, 400);
    assert.equal(service.state.config.concurrency, originalConcurrency);
});

test("batch recovery validates all credential versions before making changes", async t => {
    const { service } = await fixture(t, 2);
    const accounts = service.state.accounts;
    const entries = accounts.map(account => ({
        accountId: account.accountId,
        credentialVersion: account.credentialVersion,
    }));
    await assert.rejects(
        service.setRecovery({ accounts: [entries[0], { ...entries[1], credentialVersion: -1 }], autoRecovery: false }),
        { status: 409 }
    );
    assert.ok(accounts.every(account => account.autoRecovery));
    assert.equal((await service.setRecovery({ accounts: entries, autoRecovery: false })).updated, 2);
    assert.ok(accounts.every(account => !account.autoRecovery));
    await service.setRecovery({ accounts: entries, autoRecovery: true });
    assert.ok(accounts.every(account => account.autoRecovery));
});

test("global automatic login switch persists and holds recovery without blocking manual login", async t => {
    const { service, system, options, close } = await fixture(t, 1);
    const account = service.state.accounts[0];
    await service.edit(account.accountId, { credentialVersion: 1, password: "synthetic" });
    account.sessionState = "expired";
    const automatic = service.enqueue(account, "expired");
    service.state.config.autoRecovery = false;
    await service.queue.tick();
    assert.equal(automatic.status, "queued");
    assert.equal(automatic.attempts, 0);
    const manualAccount = await service.create({ email: "manual@example.com", password: "synthetic" }, false);
    await service.login(manualAccount.account.accountId);
    await service.queue.tick();
    await until(() => service.state.tasks.some(task => task.source === "manual" && task.status === "succeeded"));
    assert.equal(automatic.status, "queued");
    service.state.config.autoRecovery = true;
    account.autoRecovery = false;
    await service.queue.tick();
    assert.equal(automatic.attempts, 0);
    service.state.config.autoRecovery = false;
    await service.save();
    await close();
    const resumed = new Service(system, options);
    t.after(() => resumed.close());
    await resumed.initialize({ startQueue: false });
    assert.equal(resumed.state.config.autoRecovery, false);
    resumed.state.config.autoRecovery = true;
    resumed.state.accounts.find(item => item.accountId === account.accountId).autoRecovery = true;
    await resumed.queue.tick();
    await until(() => resumed.state.tasks.find(task => task.taskId === automatic.taskId).status === "succeeded");
    await resumed.close();
});

test("disabled automatic login saves new credentials and authenticator before manual batch login", async t => {
    const { service } = await fixture(t);
    service.state.config.autoRecovery = false;
    service.state.config.queueLimit = 1;
    const created = await service.create({ email: "first@example.com", password: "synthetic" });
    const second = await service.create({ email: "second@example.com", password: "synthetic" });
    assert.equal(created.taskId, undefined);
    assert.equal(created.account.recoveryState, "idle");
    assert.equal(service.state.tasks.length, 0);
    const preview = service.preview(
        "session",
        "authenticator",
        `otpauth://totp/first@example.com?secret=${secret}\notpauth://totp/second@example.com?secret=${secret}`
    );
    const result = await service.importCommit("session", {
        previewId: preview.previewId,
        rows: preview.rows.map(row => ({ index: row.index })),
    });
    assert.equal(result.updated, 2);
    await service.queue.tick();
    assert.equal(service.state.tasks.length, 0);
    service.state.config.queueLimit = 2;
    for (const { account } of [created, second]) await service.login(account.accountId);
    await service.queue.tick();
    await until(() => service.state.tasks.every(task => task.status === "succeeded"));
    assert.equal(service.state.tasks.length, 2);
    assert.ok(service.state.tasks.every(task => task.source === "manual"));
});

test("global switch holds already queued new logins and manual login releases held automatic tasks", async t => {
    const { service } = await fixture(t);
    const created = await service.create({ email: "held@example.com", password: "synthetic" });
    service.state.config.autoRecovery = false;
    await service.queue.tick();
    const task = service.state.tasks[0];
    assert.equal(task.status, "queued");
    assert.equal(task.attempts, 0);
    assert.equal((await service.login(created.account.accountId)).taskId, task.taskId);
    await service.queue.tick();
    await until(() => task.status === "succeeded");

    const account = service.account(created.account.accountId);
    account.sessionState = "expired";
    const recovery = service.enqueue(account, "expired");
    await service.login(account.accountId);
    await service.queue.tick();
    await until(() => recovery.status === "succeeded");
});

test("authenticator imports match existing emails, skip unknown and duplicate entries, and require overwrite", async t => {
    const { service } = await fixture(t);
    const { account } = await service.create({ email: "known@example.com", password: "synthetic" }, false);
    const uri = email => `otpauth://totp/${email}?secret=${secret}`;
    const preview = service.preview(
        "session",
        "authenticator",
        [uri("known@example.com"), uri("unknown@example.com"), uri("known@example.com")].join("\n")
    );
    assert.equal(preview.rows[0].accountId, account.accountId);
    assert.equal(preview.rows[1].accountId, null);
    assert.match(preview.rows[2].error, /Duplicate/);
    const result = await service.importCommit("session", {
        previewId: preview.previewId,
        rows: [{ index: 0 }, { index: 1 }, { index: 2, skip: true }],
    });
    assert.deepEqual(result, {
        created: 0,
        errors: [],
        failed: 0,
        loginQueued: 0,
        loginWarnings: [],
        skipped: 2,
        updated: 1,
    });
    assert.equal(service.state.accounts.length, 1);
    const unchanged = service.preview("session", "authenticator", uri("known@example.com"));
    assert.equal(unchanged.rows[0].unchanged, true);
    assert.equal(
        (await service.importCommit("session", { previewId: unchanged.previewId, rows: [{ index: 0 }] })).skipped,
        1
    );
    const otherSecret = Totp.encode(Buffer.from("different-secret"));
    const content = `otpauth://totp/known@example.com?secret=${otherSecret}`;
    const conflict = service.preview("session", "authenticator", content);
    assert.equal(conflict.rows[0].conflict, true);
    assert.equal(
        (await service.importCommit("session", { previewId: conflict.previewId, rows: [{ index: 0 }] })).failed,
        1
    );
    assert.equal(service.credentials(account.accountId).totpSecret, secret);
    const overwrite = service.preview("session", "authenticator", content);
    assert.equal(
        (
            await service.importCommit("session", {
                previewId: overwrite.previewId,
                rows: [{ index: 0, overwrite: true }],
            })
        ).updated,
        1
    );
    assert.equal(service.credentials(account.accountId).totpSecret, otherSecret);
    assert.equal(service.state.tasks.length, 0);
});

test("unlogged accounts keep persisted proxy bindings across first login and service restart", async t => {
    const { service, system, options, directory, close } = await fixture(t);
    system.authSource.accountLoginService = service;
    system.authSource.accountNameMap = new Map();
    const browser = {
        contexts: new Map(),
        contextUnavailable: new Map(),
        initializingContexts: new Set(),
        stickyProxyManager: {
            getProxyForAuth(index) {
                assert.notEqual(index, null);
                return null;
            },
        },
    };
    const storePath = path.join(directory, "proxy-pool.json");
    let store = new ProxyPoolStore(logger, storePath);
    const data = store.snapshot();
    data.settings.enabled = true;
    data.nodes.push({
        enabled: true,
        host: "127.0.0.1",
        id: "node-login",
        localPort: 10801,
        name: "Login",
        port: 1080,
        type: "socks5",
    });
    await store.replace(data);
    const manager = { status: { ready: true } };
    let bindings = new ProxyBindingService(store, manager, browser, system.authSource);
    const pool = Object.assign(Object.create(ProxyPoolService.prototype), { bindings, store });
    system.proxyPoolService = pool;
    const { account: created } = await service.create({ email: "Proxy@Example.com", password: "synthetic" }, false);
    const account = service.account(created.accountId);
    assert.equal(bindings.list()[0].authIndex, null);
    assert.equal(bindings.list()[0].contextState, "NOT_LOGGED_IN");
    await pool.setBinding("proxy@example.com", "node-login");
    const before = service.resolveProxy(account);
    assert.equal(before.server, "socks5://127.0.0.1:10801");
    assert.throws(() => pool.apply(account.email), { status: 409 });
    manager.status.ready = false;
    assert.throws(() => service.resolveProxy(account), { code: "MIHOMO_NOT_READY" });
    manager.status.ready = true;

    // Both stores survive restart before the account has a Cookie index.
    await close();
    const resumed = new Service(system, options);
    t.after(() => resumed.close());
    system.authSource.accountLoginService = resumed;
    await resumed.initialize({ startQueue: false });
    store = new ProxyPoolStore(logger, storePath);
    bindings = new ProxyBindingService(store, manager, browser, system.authSource);
    Object.assign(pool, { bindings, store });
    const restored = resumed.account(account.accountId);
    assert.deepEqual(resumed.resolveProxy(restored), before);
    await resumed.login(restored.accountId);
    await resumed.queue.tick();
    await until(() => resumed.state.tasks[0].status === "succeeded");
    const auth = await resumed.readAuth(restored.authIndex);
    system.authSource.availableIndices = [restored.authIndex];
    system.authSource.accountNameMap.set(restored.authIndex, auth.accountName);
    assert.deepEqual(resumed.resolveProxy(restored), before);
    assert.deepEqual(bindings.resolve(restored.authIndex).proxy, before);
    assert.equal(bindings.list().length, 1);
    assert.equal(bindings.list()[0].accountKey, "proxy@example.com");
    browser.contexts.set(restored.authIndex, { proxyInfo: bindings.resolve(restored.authIndex), state: "READY" });
    assert.equal(bindings.list()[0].state, "applied");
    await resumed.close();
});

test("bulk proxy application skips accounts without Cookie indices", async () => {
    const handlers = new Map();
    const applied = [];
    const service = {
        apply(accountKey, waitForIdle) {
            applied.push({ accountKey, waitForIdle });
            return { accountKey };
        },
        bindings: {
            list: () => [
                { accountKey: "unlogged@example.com", authIndex: null, state: "offline" },
                { accountKey: "logged@example.com", authIndex: 0, state: "offline" },
            ],
        },
    };
    const app = { use() {} };
    for (const method of ["get", "post", "put", "delete"])
        app[method] = (endpoint, handler) => handlers.set(`${method} ${endpoint}`, handler);
    new ProxyPoolRoutes({ proxyPoolService: service }).setupRoutes(app, () => {});
    const res = {
        json() {},
        status(code) {
            assert.equal(code, 202);
            return this;
        },
    };
    await handlers.get("post /api/proxy-pool/bindings/apply-idle")({}, res);
    await handlers.get("post /api/proxy-pool/bindings/apply-pending")({}, res);
    assert.deepEqual(applied, [
        { accountKey: "logged@example.com", waitForIdle: false },
        { accountKey: "logged@example.com", waitForIdle: true },
    ]);
});

test("successful relogin clears the current challenge while preserving failed attempt history", async t => {
    const { service } = await fixture(t);
    const { account: created } = await service.create({ email: "retry@example.com", password: "synthetic" }, false);
    const account = service.account(created.accountId);
    const failed = service.enqueue(account, "manual");
    Object.assign(failed, { attempts: 1, deadline: Date.now() + 180000, status: "running" });
    await service.completeAttempt(
        { config: service.state.config, startedAt: Date.now(), taskId: failed.taskId },
        { error: "manual_challenge", retryable: false }
    );
    assert.equal(account.lastFailure.error, "manual_challenge");
    assert.equal(account.recoveryState, "manual_required");
    const login = await service.login(account.accountId);
    await service.queue.tick();
    await until(() => service.state.tasks.find(task => task.taskId === login.taskId).status === "succeeded");
    assert.equal(account.sessionState, "valid");
    assert.equal(account.recoveryState, "idle");
    assert.equal(service.publicAccount(account).lastFailure, null);
    assert.equal(failed.history[0].error, "manual_challenge");
});

test("Cookie upload and manual session restoration clear stale challenge summaries", async t => {
    const { service } = await fixture(t, 1);
    const account = service.state.accounts[0];
    await service.edit(account.accountId, { credentialVersion: 1, password: "synthetic" });
    account.lastFailure = { error: "manual_challenge" };
    account.recoveryState = "manual_required";
    await service.upload({ accountName: account.email, cookies: [], origins: [] });
    assert.equal(account.lastFailure, null);
    account.sessionState = "expired";
    account.lastFailure = { error: "manual_challenge" };
    account.recoveryState = "manual_required";
    assert.equal(await service.refreshSession(account.authIndex, account.sessionVersion, null, true), true);
    assert.equal(account.sessionState, "valid");
    assert.equal(account.recoveryState, "idle");
    assert.equal(account.lastFailure, null);
});

test("startup cleans legacy failure summaries only for valid idle sessions", async t => {
    const { service, system, options, close } = await fixture(t, 2);
    const [valid, failed] = service.state.accounts;
    valid.recoveryState = "idle";
    valid.lastFailure = { error: "manual_challenge" };
    failed.recoveryState = "manual_required";
    failed.lastFailure = { error: "wrong_password" };
    await service.save();
    await close();
    const resumed = new Service(system, options);
    try {
        await resumed.initialize({ startQueue: false });
        assert.equal(resumed.account(valid.accountId).lastFailure, null);
        assert.equal(resumed.account(failed.accountId).lastFailure.error, "wrong_password");
    } finally {
        await resumed.close();
    }
});

test("not-logged-in filter selects saved credentials without a session and supports search and pagination", async t => {
    const { service, system } = await fixture(t, 2);
    service.state.accounts[0].password = "synthetic";
    Object.assign(service.state.accounts[1], { password: "synthetic", sessionState: "expired" });
    const ready = (await service.create({ email: "ready@example.com", password: "synthetic" }, false)).account;
    const totp = (await service.create({ email: "totp@example.com", password: "synthetic", totpSecret: secret }, false))
        .account;
    const manual = (await service.create({ email: "manual@example.com", password: "synthetic" }, false)).account;
    service.account(manual.accountId).recoveryState = "manual_required";
    const missingPassword = (await service.create({ email: "missing@example.com", password: "synthetic" }, false))
        .account;
    await service.edit(missingPassword.accountId, { clearPassword: true, credentialVersion: 1 });
    service.state.accounts.push(service.newAccount({ password: "synthetic" }));
    const handlers = new Map();
    const app = { use() {} };
    for (const method of ["get", "post", "patch", "delete"])
        app[method] = (endpoint, ...middleware) => handlers.set(`${method} ${endpoint}`, middleware.at(-1));
    system.accountLoginService = service;
    new AccountRoutes(system).setupRoutes(app, () => {});
    const list = async query => {
        let result;
        await handlers.get("get /api/account-management/accounts")(
            { query: { state: "not_logged_in", ...query } },
            { status: () => ({ json: value => (result = value) }) }
        );
        return result;
    };
    const all = await list({});
    assert.equal(all.total, 3);
    assert.deepEqual(
        all.accounts.map(account => account.accountId),
        [ready.accountId, totp.accountId, manual.accountId]
    );
    const searched = await list({ search: "totp" });
    assert.equal(searched.total, 1);
    assert.equal(searched.accounts[0].hasTotpSecret, true);
    const paged = await list({ page: 2, pageSize: 1 });
    assert.equal(paged.total, 3);
    assert.equal(paged.accounts[0].accountId, totp.accountId);
});

test("recovery credentials remain private, versioned and preserve empty imports", async t => {
    const { service } = await fixture(t);
    const created = await service.create(
        { email: "new@example.com", password: "synthetic", recoveryEmail: " RECOVERY@example.com " },
        false
    );
    const id = created.account.accountId;
    assert.equal(created.account.hasRecoveryEmail, true);
    assert.equal(created.account.recoveryEmail, undefined);
    assert.equal(service.credentials(id).recoveryEmail, "recovery@example.com");
    const preview = service.preview(
        "session",
        "csv",
        "email,password,recovery_email,totp_secret\nnew@example.com,synthetic,other@example.com,\n"
    );
    assert.equal(preview.rows[0].recoveryEmailConflict, true);
    assert.equal(preview.rows[0].recoveryEmail, undefined);
    assert.equal(
        (await service.importCommit("session", { previewId: preview.previewId, rows: [{ index: 0 }] })).failed,
        1
    );
    const blank = service.preview(
        "session",
        "csv",
        "email,password,recovery_email,totp_secret\nnew@example.com,synthetic,,\n"
    );
    await service.importCommit("session", { previewId: blank.previewId, rows: [{ index: 0 }] });
    assert.equal(service.credentials(id).recoveryEmail, "recovery@example.com");
    const version = service.credentials(id).credentialVersion;
    await service.edit(id, { clearRecoveryEmail: true, credentialVersion: version });
    assert.equal(service.credentials(id).recoveryEmail, null);
    assert.equal(service.credentials(id).credentialVersion, version + 1);
    await assert.rejects(service.edit(id, { credentialVersion: version, recoveryEmail: "stale@example.com" }), {
        status: 409,
    });
});
test("CSV aliases, BOM, whitespace headers and recovery export round trip", () => {
    const { credentialsCsv } = require("../src/accounts/AccountExport");
    const account = {
        email: "user@example.com",
        password: ' p,a"ss\nword ',
        recoveryEmail: "recover@example.com",
        totp: Totp.normalize(secret),
    };
    assert.deepEqual(parseImport("csv", credentialsCsv([account])).rows[0], {
        email: account.email,
        password: account.password,
        recoveryEmail: account.recoveryEmail,
        totp: account.totp,
    });
    assert.equal(
        parseImport("csv", "\uFEFF email , password , totpSecret\nuser@example.com, pw ," + secret).rows[0].password,
        " pw "
    );
    for (const columns of ["totpSecret,totp_secret", "recoveryEmail,recovery_email"]) {
        assert.equal(
            parseImport("csv", `email,password,${columns}\nuser@example.com,pw,first,second`).rows[0].error,
            "Conflicting alias columns"
        );
    }
    assert.throws(() => parseImport("csv", "user@example.com,password,SECRET"), /header/);
});

test("legacy recovery default and explicit duplicate credential choice survive storage", async t => {
    const fixtureData = await fixture(t, 2);
    const { service, options, system } = fixtureData;
    const [first, second] = service.state.accounts;
    delete first.recoveryEmail;
    second.recoveryEmail = "second@example.com";
    await service.save();
    await fixtureData.close();
    const reopened = new Service(system, options);
    try {
        await reopened.initialize({ startQueue: false });
        const [keep, remove] = reopened.state.accounts;
        assert.equal(keep.recoveryEmail, null);
        keep.recoveryEmail = "first@example.com";
        const group = { email: "duplicate@example.com", keptIndex: 0, removedIndices: [1] };
        const conflict = await reopened.prepareDeduplicate([group]);
        assert.equal(conflict.conflicts.length, 1);
        assert.equal(JSON.stringify(conflict).includes("first@example.com"), false);
        const versions = Object.fromEntries(
            reopened.state.accounts.map(account => [account.accountId, account.credentialVersion])
        );
        const version = keep.credentialVersion;
        await reopened.prepareDeduplicate([group], { [group.email]: { accountId: remove.accountId, versions } });
        assert.equal(keep.recoveryEmail, "second@example.com");
        assert.equal(keep.credentialVersion, version + 1);
    } finally {
        await reopened.close();
    }
});

test("session commit removes legacy recovery credentials from auth JSON", async t => {
    const { service } = await fixture(t, 1);
    const account = service.state.accounts[0];
    account.recoveryEmail = "private-recovery@example.com";
    await fs.writeFile(
        path.join(service.authDir, "auth-0.json"),
        JSON.stringify({
            cookies: [],
            origins: [],
            recovery_email: account.recoveryEmail,
            recoveryEmail: account.recoveryEmail,
        })
    );
    await service.commitSession(account, { accountName: account.email, cookies: [], origins: [] });
    const saved = await service.readAuth(0);
    assert.equal(saved.recoveryEmail, undefined);
    assert.equal(saved.recovery_email, undefined);
    assert.equal(account.recoveryEmail, "private-recovery@example.com");
});

test("CSV creates 19 accounts by default and only new records follow the global switch", async t => {
    for (const enabled of [false, true]) {
        const { service } = await fixture(t);
        service.state.config.autoRecovery = enabled;
        const content =
            "email,password\n" + Array.from({ length: 19 }, (_, i) => `new${i}@example.com,synthetic`).join("\n");
        const preview = service.preview("session", "csv", content);
        const input = { previewId: preview.previewId, rows: preview.rows.map(row => ({ index: row.index })) };
        const result = await service.exclusive(() => service.importCommit("session", input));
        assert.equal(result.created, 19);
        assert.equal(result.skipped, 0);
        assert.equal(result.failed, 0);
        assert.equal(result.loginQueued, enabled ? 19 : 0);
        assert.equal(service.state.tasks.length, enabled ? 19 : 0);
        assert.ok(service.state.tasks.every(task => task.source === "new"));
        assert.deepEqual(await service.importCommit("session", input), result);
        assert.equal(service.list().length, 19);
        const mixed = service.preview(
            "session",
            "csv",
            "email,password\nnew0@example.com,updated\nextra@example.com,synthetic\nskip@example.com,synthetic"
        );
        const update = await service.importCommit("session", {
            previewId: mixed.previewId,
            rows: [{ index: 0, overwrite: true }, { index: 1 }, { index: 2, overwrite: true, skip: true }],
        });
        assert.equal(update.updated, 1);
        assert.equal(update.created, 1);
        assert.equal(update.skipped, 1);
        assert.equal(update.loginQueued, enabled ? 1 : 0);
        assert.equal(
            service.state.tasks.filter(
                task => task.accountId === service.state.accounts[0].accountId && task.status !== "cancelled"
            ).length,
            0
        );
    }
});
test("CSV queue capacity warnings preserve created records and cached results", async t => {
    const { service } = await fixture(t);
    service.state.config.autoRecovery = true;
    service.state.config.queueLimit = 1;
    const preview = service.preview(
        "session",
        "csv",
        "email,password\na@example.com,synthetic\nb@example.com,synthetic"
    );
    const input = { previewId: preview.previewId, rows: [{ index: 0 }, { index: 1 }] };
    const result = await service.importCommit("session", input);
    assert.equal(result.created, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.loginQueued, 1);
    assert.match(result.loginWarnings[0].error, /queue is full/);
    assert.equal(result.loginWarnings[0].index, 1);
    assert.deepEqual(await service.importCommit("session", input), result);
    assert.equal(service.state.tasks.length, 1);
    service.state.config.autoRecovery = false;
    await service.queue.tick();
    assert.equal(service.state.tasks[0].status, "queued");
});
test("batch cancellation isolates failures, holds recovery across restart and allows manual continuation", async t => {
    const { service, close, system, options } = await fixture(t);
    service.state.config.autoRecovery = true;
    const ids = [];
    for (const name of ["queued", "retry", "idle", "unselected"]) {
        const { account } = await service.create({ email: `${name}@example.com`, password: "synthetic" }, false);
        ids.push(account.accountId);
        service.account(account.accountId).sessionState = "expired";
    }
    const queued = service.enqueue(service.account(ids[0]), "expired");
    const retry = service.enqueue(service.account(ids[1]), "expired");
    retry.status = "retry_wait";
    const other = service.enqueue(service.account(ids[3]), "expired");
    const result = await service.exclusive(() =>
        service.batchCancelLogin({ accountIds: [ids[0], ids[1], ids[2], "missing", ids[0]] })
    );
    assert.equal(result.cancelled, 2);
    assert.equal(result.unnecessary, 1);
    assert.equal(result.failed, 1);
    assert.equal(queued.status, "cancelled");
    assert.equal(retry.status, "cancelled");
    assert.equal(other.status, "queued");
    assert.equal(service.account(ids[2]).recoveryState, "idle");
    for (let i = 0; i < 3; i++) await service.scanRecovery();
    assert.equal(service.account(ids[0]).currentTaskId, null);
    assert.equal(service.account(ids[1]).recoveryState, "manual_required");
    assert.equal(service.account(ids[0]).autoRecovery, true);
    assert.equal(queued.history.at(-1).error, "cancelled");
    assert.equal((await service.batchCancelLogin({ accountIds: ids.slice(0, 2) })).unnecessary, 2);
    await assert.rejects(service.batchCancelLogin({ accountIds: [null] }), { status: 400 });
    await close();
    const resumed = new Service(system, options);
    await resumed.initialize({ startQueue: false });
    await resumed.scanRecovery();
    assert.equal(resumed.account(ids[0]).recoveryState, "manual_required");
    assert.equal(resumed.account(ids[0]).currentTaskId, null);
    await resumed.edit(ids[0], { credentialVersion: resumed.account(ids[0]).credentialVersion, password: "corrected" });
    await resumed.scanRecovery();
    assert.equal(resumed.account(ids[0]).recoveryState, "manual_required");
    assert.equal(resumed.account(ids[0]).currentTaskId, null);
    await resumed.login(ids[0]);
    assert.equal(resumed.account(ids[0]).recoveryState, "queued");
    await resumed.close();
});
test("running cancellation reports stopping, blocks a second executor and rejects late success", async t => {
    const { service, directory } = await fixture(t);
    service.state.config.autoRecovery = true;
    const created = await service.create({ email: "late@example.com", password: "synthetic" });
    const account = service.account(created.account.accountId);
    account.sessionState = "expired";
    await service.queue.tick();
    const result = await service.exclusive(() => service.batchCancelLogin({ accountIds: [account.accountId] }));
    assert.equal(result.stopping, 1);
    assert.equal(service.publicAccount(account).loginStopping, true);
    await assert.rejects(service.login(account.accountId), { status: 409 });
    await until(() => !service.queue.running.size);
    await service.chain;
    await service.scanRecovery();
    assert.equal(account.recoveryState, "manual_required");
    assert.equal(account.currentTaskId, null);
    assert.equal(service.state.tasks[0].status, "cancelled");
    assert.deepEqual(await fs.readdir(path.join(directory, "auth")), []);
    service.state.config.paused = true;
    await service.exclusive(() => service.login(account.accountId));
    assert.equal(account.recoveryState, "queued");
});

test("import protection skips changed, mapped and newly appeared accounts without credential mutation", async t => {
    const { service } = await fixture(t);
    const existing = (
        await service.create({
            email: "protected@example.com",
            password: "old-password",
            recoveryEmail: "old@example.com",
            totpSecret: secret,
        })
    ).account;
    const original = service.credentials(existing.accountId);
    const preview = service.preview(
        "session",
        "csv",
        "email,password,recovery_email\nprotected@example.com,new-password,new@example.com\nnew@example.com,new-password,\nlate@example.com,new-password,"
    );
    const late = (await service.create({ email: "late@example.com", password: "keep-password" })).account;
    await assert.rejects(
        service.importCommit("session", { previewId: preview.previewId, rows: [], skipExisting: "true" }),
        /skipExisting must be boolean/
    );
    const result = await service.importCommit("session", {
        previewId: preview.previewId,
        rows: preview.rows.map(row => ({ index: row.index, overwrite: true })),
        skipExisting: true,
    });
    assert.equal(result.created, 1);
    assert.equal(result.skipped, 2);
    assert.equal(result.updated, 0);
    assert.equal(result.failed, 0);
    assert.deepEqual(service.credentials(existing.accountId), original);
    assert.equal(service.credentials(late.accountId).password, "keep-password");
    const mapped = service.preview(
        "session",
        "authenticator",
        "otpauth://totp/unknown@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Test"
    );
    const mappedResult = await service.importCommit("session", {
        previewId: mapped.previewId,
        rows: [{ accountId: existing.accountId, index: 0, overwrite: true }],
        skipExisting: true,
    });
    assert.equal(mappedResult.skipped, 1);
    assert.deepEqual(service.credentials(existing.accountId), original);
    const update = service.preview("session", "csv", "email,password\nprotected@example.com,new-password");
    assert.equal(
        (
            await service.importCommit("session", {
                previewId: update.previewId,
                rows: [{ index: 0, overwrite: true }],
                skipExisting: false,
            })
        ).updated,
        1
    );
});

test("ambiguous CSV matches are skipped under protection and rejected without it", async t => {
    const { service } = await fixture(t);
    service.state.accounts.push(service.newAccount({ email: "duplicate@example.com", password: "keep-one" }));
    service.state.accounts.push(service.newAccount({ email: "duplicate@example.com", password: "keep-two" }));
    for (const skipExisting of [true, false]) {
        const preview = service.preview("session", "csv", "email,password\nduplicate@example.com,replace-password");
        assert.equal(preview.rows[0].matches, 2);
        const result = await service.importCommit("session", {
            previewId: preview.previewId,
            rows: [{ index: 0, overwrite: true }],
            skipExisting,
        });
        assert.equal(result.created, 0);
        assert.equal(result.updated, 0);
        assert.equal(skipExisting ? result.skipped : result.failed, 1);
        assert.deepEqual(
            service.state.accounts.map(account => account.password),
            ["keep-one", "keep-two"]
        );
    }
});

test("selection endpoint uses the list filters across every page and only returns safe summaries", async t => {
    const { service, system } = await fixture(t);
    service.state.accounts = Array.from({ length: 250 }, (_, index) =>
        service.newAccount({ email: `selection${index}@example.com`, password: "private-password" })
    );
    const handlers = new Map();
    const app = { use() {} };
    for (const method of ["get", "post", "patch", "delete"])
        app[method] = (endpoint, ...middleware) => handlers.set(`${method} ${endpoint}`, middleware.at(-1));
    system.accountLoginService = service;
    new AccountRoutes(system).setupRoutes(app, () => {});
    const read = async (endpoint, query) => {
        let result;
        const res = {
            json: value => {
                result = value;
            },
            status() {
                return this;
            },
        };
        await handlers.get(`get /api/account-management/${endpoint}`)({ query }, res);
        return result;
    };
    const all = await read("accounts/selection", {});
    assert.equal(all.accounts.length, 250);
    assert.equal(JSON.stringify(all).includes("private-password"), false);
    for (const query of [
        { search: "selection1" },
        { state: "not_logged_in" },
        { search: "selection1", state: "not_logged_in" },
        { state: "valid" },
    ]) {
        const selection = await read("accounts/selection", query);
        const list = await read("accounts", { ...query, pageSize: 100 });
        assert.equal(selection.total, list.total);
        assert.deepEqual(selection.accounts.slice(0, 100), list.accounts);
    }
    const large = Array.from({ length: 1001 }, (_, index) =>
        service.newAccount({ email: `large${index}@example.com`, password: "synthetic" })
    );
    service.state.accounts.push(...large);
    assert.equal(service.selectedAccounts({ accountIds: large.map(account => account.accountId) }).length, 1001);
});

test("account tiers persist independently from observations, credentials and session refresh", async t => {
    const f = await fixture(t, 1);
    const account = f.service.state.accounts[0];
    const id = account.accountId;
    assert.equal(account.manualTier, null);
    await f.service.recordBenefit(id, 0, { rawTier: "TIER2", source: "native", state: "ready-paid" });
    const original = { ...account.benefitObservation };
    await f.service.recordBenefit(id, 0, { reason: "query_http", state: "failed" });
    assert.deepEqual(account.benefitObservation, original);
    assert.equal(account.benefitLastCheck.status, "failed");
    await f.service.edit(id, { credentialVersion: account.credentialVersion, manualTier: "free" });
    assert.equal(f.service.publicAccount(account).tier.effectiveTier, "free");
    assert.equal(f.service.publicAccount(account).tier.conflict, false);
    for (const key of ["benefitObservation", "benefitLastCheck", "effectiveTier", "tier", "conflict"])
        await assert.rejects(
            f.service.edit(id, { credentialVersion: account.credentialVersion, [key]: {} }),
            /read-only/
        );
    await f.service.edit(id, { credentialVersion: account.credentialVersion, manualTier: null });
    assert.equal(f.service.publicAccount(account).tier.effectiveTier, "pro");
    account.sessionVersion++;
    assert.equal(f.service.publicAccount(account).tier.stale, true);
    assert.equal(f.service.publicAccount(account).tier.effectiveTier, null);
    assert.equal(await f.service.recordBenefit(id, 0, { state: "ready-free" }), false);
    await f.service.edit(id, { credentialVersion: account.credentialVersion, manualTier: "ultra20" });
    assert.equal(f.service.publicAccount(account).tier.argonEligible, true);
    assert.deepEqual(account.benefitObservation, original);
    await f.service.recordBenefit(id, 1, { rawTier: null, source: "query", state: "ready-free" });
    assert.equal(f.service.publicAccount(account).tier.conflict, true);
    f.service.state.benefitTasks.push({ accountId: id, status: "running", taskId: "interrupted" });
    const crashSnapshot = JSON.stringify(f.service.state);
    await f.close();
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(f.options.storePath);
    db.prepare("UPDATE account_state SET value=? WHERE id=1").run(crashSnapshot);
    db.close();
    const restarted = new Service(f.system, f.options);
    await restarted.initialize({ startQueue: false });
    try {
        assert.equal(restarted.account(id).manualTier, "ultra20");
        assert.equal(restarted.state.benefitTasks[0].reason, "interrupted");
        assert.equal(restarted.state.benefitTasks[0].status, "failed");
        restarted.state.accounts = [];
        assert.equal(await restarted.recordBenefit(id, 1, { rawTier: "TIER1", state: "ready-paid" }), false);
    } finally {
        await restarted.close();
    }
});

test("deduplication requires review for different manual tiers and preserves the selected tier", async t => {
    const f = await fixture(t, 2);
    const [first, second] = f.service.state.accounts;
    first.manualTier = "free";
    second.manualTier = "ultra";
    const groups = [{ email: "same@example.com", keptIndex: 0, removedIndices: [1] }];
    const preview = await f.service.prepareDeduplicate(groups);
    assert.equal(preview.conflicts.length, 1);
    const versions = Object.fromEntries([first, second].map(account => [account.accountId, account.credentialVersion]));
    await f.service.prepareDeduplicate(groups, { "same@example.com": { accountId: second.accountId, versions } });
    assert.equal(first.manualTier, "ultra");
});
