const http = require("node:http");
const net = require("node:net");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { WebSocketServer } = require("ws");

// A disposable network boundary for the login browser. Keep the application's
// native WebSocket and fixed URL; only its TCP destination changes.
class TargetValidationTransport {
    constructor(registry, proxy, timeout) {
        this.registry = registry;
        this.proxy = proxy;
        this.timeout = timeout;
        this.sockets = new Set();
    }

    track(socket) {
        this.sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => this.sockets.delete(socket));
        if (this.closed) socket.destroy(new Error("Validation transport closed"));
        return socket;
    }

    async listen(server) {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        return server.address().port;
    }

    async start() {
        this.wsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
        await new Promise((resolve, reject) => {
            this.wsServer.once("listening", resolve);
            this.wsServer.once("error", reject);
        });
        this.wsServer.on("connection", (socket, request) => {
            const index = new URL(request.url, "http://localhost").searchParams.get("authIndex");
            if (index !== "0") return socket.close(1008, "Invalid validation account");
            this.registry.addConnection(socket, { address: "127.0.0.1", authIndex: 0 });
        });
        this.server = http.createServer((request, response) => {
            this.forward(request, response).catch(() => response.destroy());
        });
        this.server.on("connection", socket => this.track(socket));
        this.server.on("upgrade", (request, socket, head) => {
            this.forward(request, socket, head).catch(() => socket.destroy());
        });
        this.server.on("connect", (request, socket, head) => {
            const destination = new URL(`http://${request.url}`);
            this.connect(destination.hostname, Number(destination.port) || 443)
                .then(upstream => {
                    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                    if (head.length) upstream.write(head);
                    this.pipe(socket, upstream);
                })
                .catch(() => socket.destroy());
        });
        const port = await this.listen(this.server);
        return { bypass: "", server: `http://127.0.0.1:${port}` };
    }

    pipe(client, upstream) {
        client.once("close", () => upstream.destroy());
        upstream.once("close", () => client.destroy());
        client.pipe(upstream).pipe(client);
    }

    async forward(request, client, head) {
        const destination = new URL(request.url);
        if (!["http:", "ws:"].includes(destination.protocol)) throw new Error("Unsupported transport");
        const headers = { ...request.headers };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        if (!head) {
            const agent = new http.Agent();
            agent.createConnection = (options, callback) => {
                this.connect(destination.hostname, Number(destination.port) || 80).then(
                    socket => callback(null, socket),
                    callback
                );
            };
            const outgoing = http.request(destination, { agent, headers, method: request.method }, response => {
                client.writeHead(response.statusCode, response.headers);
                response.pipe(client);
            });
            outgoing.on("error", () => client.destroy());
            client.once("close", () => {
                outgoing.destroy();
                agent.destroy();
            });
            request.pipe(outgoing);
            return;
        }
        const upstream = await this.connect(destination.hostname, Number(destination.port) || 80);
        upstream.write(
            `${request.method} ${destination.pathname}${destination.search} HTTP/${request.httpVersion}\r\n` +
                Object.entries(headers)
                    .map(([name, value]) => `${name}: ${value}\r\n`)
                    .join("") +
                "\r\n"
        );
        if (head.length) upstream.write(head);
        this.pipe(client, upstream);
    }

    async connect(host, port) {
        if (this.closed) throw new Error("Validation transport closed");
        if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(host.toLowerCase()) && port === 9998) {
            return this.direct("127.0.0.1", this.wsServer.address().port);
        }
        const bypass = (this.proxy?.bypass || "").split(",").some(pattern => {
            const suffix = pattern.trim().replace(/^\*?\./, "");
            return suffix && (host === suffix || host.endsWith(`.${suffix}`));
        });
        if (!this.proxy || bypass) return this.direct(host, port);
        const proxy = new URL(this.proxy.server);
        if (this.proxy.username) proxy.username = this.proxy.username;
        if (this.proxy.password) proxy.password = this.proxy.password;
        if (/^socks/.test(proxy.protocol)) {
            const agent = new SocksProxyAgent(proxy, { timeout: this.timeout });
            const socket = await agent.connect({ destroy() {} }, { host, port, secureEndpoint: false });
            socket.setTimeout(0);
            return this.track(socket);
        }
        if (!["http:", "https:"].includes(proxy.protocol)) throw new Error("Unsupported proxy");
        return new Promise((resolve, reject) => {
            const headers = {};
            if (proxy.username || proxy.password)
                headers["Proxy-Authorization"] =
                    "Basic " +
                    Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString(
                        "base64"
                    );
            const request = (proxy.protocol === "https:" ? require("node:https") : http).request({
                headers,
                hostname: proxy.hostname,
                method: "CONNECT",
                path: `${host}:${port}`,
                port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
                timeout: this.timeout,
            });
            request.once("connect", (response, socket, head) => {
                if (response.statusCode !== 200) {
                    socket.destroy();
                    reject(new Error("Proxy connection rejected"));
                } else {
                    if (head.length) socket.unshift(head);
                    resolve(this.track(socket));
                }
            });
            request.once("error", reject);
            request.once("socket", socket => this.track(socket));
            request.once("timeout", () => request.destroy(new Error("Proxy timeout")));
            request.end();
        });
    }

    direct(host, port) {
        return new Promise((resolve, reject) => {
            const socket = this.track(net.createConnection({ host, port }));
            socket.setTimeout(this.timeout, () => socket.destroy(new Error("Connection timeout")));
            socket.once("error", reject);
            socket.once("connect", () => {
                socket.setTimeout(0);
                resolve(socket);
            });
        });
    }

    async close() {
        this.closed = true;
        for (const socket of this.wsServer?.clients || []) socket.terminate();
        for (const socket of this.sockets) socket.destroy();
        await Promise.all(
            [this.server, this.wsServer].filter(Boolean).map(server => new Promise(resolve => server.close(resolve)))
        );
    }
}
module.exports = TargetValidationTransport;
