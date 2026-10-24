const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const ProxyNodeParser = require("../src/proxy/ProxyNodeParser");
const ProxyPoolStore = require("../src/proxy/ProxyPoolStore");
const MihomoConfigGenerator = require("../src/proxy/MihomoConfigGenerator");
const ProxyBindingService = require("../src/proxy/ProxyBindingService");
const ProxyPoolService = require("../src/proxy/ProxyPoolService");

const logger = { error() {}, info() {}, warn() {} };

const listen = server =>
    new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });

const close = server => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));

function createSocksServer() {
    return net.createServer(client => {
        client.once("data", () => {
            client.write(Buffer.from([5, 0]));
            client.once("data", request => {
                const addressType = request[3];
                let host;
                let portOffset;
                if (addressType === 1) {
                    host = [...request.subarray(4, 8)].join(".");
                    portOffset = 8;
                } else if (addressType === 3) {
                    const length = request[4];
                    host = request.subarray(5, 5 + length).toString();
                    portOffset = 5 + length;
                } else {
                    client.destroy(new Error(`Unsupported SOCKS address type: ${addressType}`));
                    return;
                }
                const port = request.readUInt16BE(portOffset);
                const upstream = net.connect({ host, port }, () => {
                    client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                    client.pipe(upstream).pipe(client);
                });
                upstream.once("error", error => client.destroy(error));
            });
        });
    });
}

async function main() {
    const ss = ProxyNodeParser.parseUri("ss://YWVzLTI1Ni1nY206c2VjcmV0@example.com:443#US-01");
    assert.deepStrictEqual(
        { cipher: ss.cipher, host: ss.host, name: ss.name, password: ss.password, port: ss.port, type: ss.type },
        { cipher: "aes-256-gcm", host: "example.com", name: "US-01", password: "secret", port: 443, type: "ss" }
    );
    const socks = ProxyNodeParser.parseUri("socks5://user:pass@127.0.0.1:1080#Local");
    assert.strictEqual(socks.username, "user");
    assert.strictEqual(socks.password, "pass");
    const vless = ProxyNodeParser.parseUri(
        "vless://11111111-1111-1111-1111-111111111111@v.example.com:443?type=ws&security=tls&path=%2Fws&host=cdn.example.com#VLESS"
    );
    assert.strictEqual(vless.type, "vless");
    assert.strictEqual(vless.network, "ws");
    assert.strictEqual(vless["ws-opts"].headers.Host, "cdn.example.com");

    const clash = ProxyNodeParser.parseSubscription(
        `proxies:\n  - name: JP\n    type: ss\n    server: jp.example.com\n    port: 8443\n    cipher: aes-128-gcm\n    password: hidden\n`
    );
    assert.strictEqual(clash.nodes.length, 1);
    assert.strictEqual(clash.nodes[0].host, "jp.example.com");
    const encoded = Buffer.from("socks5://u:p@proxy.example.com:1080#B64").toString("base64");
    assert.strictEqual(ProxyNodeParser.parseSubscription(encoded).nodes[0].name, "B64");

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pool-"));
    const filePath = path.join(temp, "proxy-pool.json");
    const store = new ProxyPoolStore(logger, filePath);
    const scaleStore = new ProxyPoolStore(logger, path.join(temp, "routing-scale.json"));
    const scaleData = scaleStore.snapshot();
    scaleData.settings.enabled = true;
    scaleData.nodes = Array.from({ length: 5 }, (_, index) => ({
        enabled: true,
        host: "proxy.example.com",
        id: `node-${index}`,
        localPort: 10801 + index,
        port: 1080,
        type: "socks5",
    }));
    for (let index = 0; index < 218; index++)
        scaleData.bindings[`account-${index}`] = { desiredNodeId: `node-${index % 5}` };
    await scaleStore.replace(scaleData);
    const scaleManager = { status: { ready: true } };
    const scaleBrowser = { stickyProxyManager: { getProxyForAuth: () => null } };
    const optimized = new ProxyBindingService(scaleStore, scaleManager, scaleBrowser, {});
    const reference = new ProxyBindingService(
        { snapshot: () => scaleStore.snapshot() },
        scaleManager,
        scaleBrowser,
        {}
    );
    for (let index = 0; index < 218; index++)
        assert.deepStrictEqual(
            optimized.resolveKey(`account-${index}`, null),
            reference.resolveKey(`account-${index}`, null)
        );
    const narrow = scaleStore.snapshotForAccount("account-0");
    assert.strictEqual(Object.keys(narrow.bindings).length, 1);
    assert.strictEqual(narrow.nodes.length, 1);
    narrow.nodes[0].enabled = false;
    narrow.bindings["account-0"].desiredNodeId = "node-4";
    assert.strictEqual(optimized.resolveKey("account-0", null).appliedNodeId, "node-0");
    const changedRoute = scaleStore.snapshot();
    changedRoute.bindings["account-0"].desiredNodeId = "node-4";
    changedRoute.nodes[4].egressGroup = "shared-egress";
    await scaleStore.replace(changedRoute);
    scaleStore.snapshot = () => {
        throw new Error("Route lookup must not copy the entire pool");
    };
    assert.strictEqual(optimized.resolveKey("account-0", null).egressKey, "group:shared-egress");
    scaleStore.data.settings.enabled = false;
    assert.throws(() => optimized.resolveKey("account-0", null), { code: "PROXY_POOL_DISABLED" });
    scaleStore.data.settings.enabled = true;
    delete scaleStore.data.bindings["account-0"];
    assert.deepStrictEqual(scaleStore.snapshotForAccount("account-0").nodes, []);
    const data = store.snapshot();
    assert.strictEqual(data.automation.enabled, false);
    assert.strictEqual(data.automation.subscriptionsEnabled, false);
    data.nodes.push({ ...ss, enabled: true, id: "node-one", localPort: 10801 });
    const direct = {
        ...ProxyNodeParser.validate({ name: "VPS Direct", type: "direct" }),
        enabled: true,
        id: "node-direct",
        localPort: null,
    };
    data.nodes.push(direct);
    await store.replace(data);
    assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.strictEqual(new ProxyPoolStore(logger, filePath).snapshot().nodes[0].localPort, 10801);
    fs.writeFileSync(filePath, "{broken");
    assert.deepStrictEqual(new ProxyPoolStore(logger, filePath).snapshot().nodes, []);
    assert.ok(fs.readdirSync(temp).some(file => file.includes(".corrupt-")));
    await store.replace(data);

    const yaml = MihomoConfigGenerator.generate(store.snapshot(), "not-public");
    assert.match(yaml, /127\.0\.0\.1/);
    assert.match(yaml, /listener-node-one/);
    assert.match(yaml, /secret: not-public/);
    assert.doesNotMatch(yaml, /node-direct/);

    const serviceMethods = Object.create(ProxyPoolService.prototype);
    assert.throws(
        () => serviceMethods._normalizeNode({ name: "Second Direct", type: "direct" }, data),
        /Only one direct node/
    );
    assert.throws(
        () => store.validate({ ...data, nodes: [...data.nodes, { ...direct, id: "node-direct-2" }] }),
        /Only one direct node/
    );
    assert.throws(
        () => serviceMethods._normalizeNode({ type: "direct" }, data, data.nodes[0]),
        /Node type cannot be changed/
    );

    const authSource = { accountNameMap: new Map([[0, "User@Example.com"]]), availableIndices: [0] };
    const browserManager = {
        contexts: new Map(),
        contextUnavailable: new Map(),
        initializingContexts: new Set(),
        stickyProxyManager: { getProxyForAuth: () => null },
    };
    const manager = { status: { ready: false } };
    const bindingService = new ProxyBindingService(store, manager, browserManager, authSource);
    data.bindings["user@example.com"] = { desiredNodeId: "node-one", updatedAt: new Date().toISOString() };
    data.settings.enabled = true;
    await store.replace(data);
    assert.throws(() => bindingService.resolve(0), /Mihomo is not ready/);
    manager.status.ready = true;
    assert.strictEqual(bindingService.resolve(0).proxy.server, "socks5://127.0.0.1:10801");
    data.bindings["user@example.com"] = { desiredNodeId: "node-direct", updatedAt: new Date().toISOString() };
    data.settings.enabled = false;
    await store.replace(data);
    const oldHttpsProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://environment-proxy.invalid:8080";
    const directResolution = bindingService.resolve(0);
    assert.strictEqual(directResolution.appliedNodeId, "node-direct");
    assert.strictEqual(directResolution.proxy, null);
    assert.strictEqual(directResolution.source, "direct_node");
    assert.strictEqual(bindingService.list()[0].state, "offline");
    browserManager.contexts.set(0, { proxyInfo: directResolution, state: "READY" });
    assert.strictEqual(bindingService.list()[0].state, "applied");
    assert.notStrictEqual(bindingService.list()[0].state, "unbound");
    Object.assign(serviceMethods, {
        browserManager,
        manager: { status: { running: false } },
        store,
        testResults: new Map(),
    });
    await assert.rejects(() => serviceMethods.deleteNodes(["node-direct"]), /Cannot delete in-use nodes/);
    serviceMethods.bindings = bindingService;
    serviceMethods.manager.inspect = () => ({ ready: true });
    const historical = store.snapshot();
    historical.bindings["deleted@example.com"] = { desiredNodeId: "node-direct" };
    historical.bindings["offline@example.com"] = { desiredNodeId: "node-one" };
    await store.replace(historical);
    authSource.accountLoginService = {
        state: { accounts: [{ accountId: "offline", authIndex: null, email: "OFFLINE@example.com" }] },
    };
    assert.strictEqual(serviceMethods.status().bindingCount, 2);
    assert.strictEqual(serviceMethods.nodes().find(node => node.id === "node-direct").boundAccounts, 1);
    authSource.availableIndices = [];
    assert.strictEqual(serviceMethods.status().bindingCount, 1);
    assert.strictEqual(serviceMethods.nodes().find(node => node.id === "node-direct").boundAccounts, 0);
    assert.ok(store.snapshot().bindings["user@example.com"]);
    const reloadedStore = new ProxyPoolStore(logger, filePath);
    const reloadedBindings = new ProxyBindingService(reloadedStore, manager, browserManager, authSource);
    assert.ok(reloadedStore.snapshot().bindings["user@example.com"]);
    assert.strictEqual(reloadedBindings.existingBindings().filter(binding => binding.desiredNodeId).length, 1);

    authSource.availableIndices = [0];
    authSource.accountLoginService.state.accounts.push({
        accountId: "duplicate",
        authIndex: null,
        email: "USER@example.com",
    });
    assert.strictEqual(serviceMethods.status().bindingCount, 2);
    assert.strictEqual(serviceMethods.nodes().find(node => node.id === "node-direct").boundAccounts, 1);

    const subscriptionData = store.snapshot();
    subscriptionData.bindings = {};
    subscriptionData.subscriptions = [
        {
            id: "sub-one",
            name: "Private subscription",
            url: "https://user:password@subscription.example.com/private/token-value?key=secret",
        },
    ];
    subscriptionData.nodes.find(node => node.id === "node-one").subscriptionId = "sub-one";
    browserManager.contexts.clear();
    await store.replace(subscriptionData);
    assert.strictEqual(serviceMethods.subscriptions()[0].url, "https://subscription.example.com/***");
    const deleted = await serviceMethods.deleteSubscriptions(["sub-one"]);
    assert.deepStrictEqual(deleted, { deletedNodes: 1, deletedSubscriptions: 1 });
    assert.deepStrictEqual(
        store.snapshot().nodes.map(node => node.id),
        ["node-direct"]
    );

    const targetServer = http.createServer((request, response) => {
        response.writeHead(204, { Connection: "close" });
        response.end();
    });
    const socksServer = createSocksServer();
    try {
        const targetPort = await listen(targetServer);
        const socksPort = await listen(socksServer);
        const probeData = store.snapshot();
        probeData.nodes.push({ ...ss, enabled: true, id: "node-probe", localPort: socksPort });
        probeData.automation.testUrl = `http://127.0.0.1:${targetPort}/generate_204`;
        await store.replace(probeData);
        serviceMethods.manager.status.ready = true;
        const result = await serviceMethods.testNode("node-probe");
        assert.strictEqual(result.success, true);
        assert.ok(Number.isInteger(result.latencyMs));
    } finally {
        await Promise.all([close(socksServer), close(targetServer)]);
    }

    if (oldHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = oldHttpsProxy;

    fs.rmSync(temp, { recursive: true });
    console.log("proxy-pool tests passed");
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
