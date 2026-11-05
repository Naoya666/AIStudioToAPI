const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");

const unavailable = (status = 503, kind = "local_engine") =>
    Object.assign(new Error("本地无浏览器服务不可用；请检查构建产物及服务健康状态"), {
        backend: "local",
        cooldown: false,
        kind: "transport",
        reason: kind,
        retryable: false,
        status,
    });

function engineError(status, kind) {
    const error = unavailable(status, kind);
    if (kind === "payload_limit") {
        error.kind = "capability";
        error.message = "本地后端传输大小超限：请求最多 100 MiB，Build 响应最多 16 MiB";
    }
    if (kind === "local_credentials_incomplete") error.message = "本地无浏览器凭证不完整；请检查保存的 Google Cookie";
    if (kind === "local_waa") error.message = "本地 SpiderMonkey WAA 签名失败";
    if (kind === "google_http") {
        error.kind = "upstream";
        error.message =
            status === 401
                ? "[MakerSuiteAuth:unverified] Google authentication could not be verified"
                : "Google request failed before response delivery";
        error.cooldown = status === 403 || status === 429 || status >= 500;
        error.retryable = status === 429 || status >= 500;
    }
    if (kind === "session_expired") {
        error.authState = "session_expired";
        error.kind = "upstream";
        error.message = "[MakerSuiteAuth:session_expired] Google session expired";
        error.upstreamError = { code: 401, status: "UNAUTHENTICATED" };
    }
    return error;
}

// Node is the sole supervisor. Unix socket and scratch credentials are private to this process.
class LocalEngine extends EventEmitter {
    constructor({
        logger,
        binary = process.env.LOCAL_ENGINE_BINARY || path.join(process.cwd(), "local-engine/bin/local-engine"),
    } = {}) {
        super();
        Object.assign(this, { binary, logger });
        this.restarts = 0;
        this.closed = false;
    }
    ensure() {
        if (this.closed || this.exhausted) return Promise.reject(unavailable());
        if (this.starting) return this.starting;
        if (this.ready) return Promise.resolve();
        const task = this.start().catch(error => {
            this.startFailures = (this.startFailures || 0) + 1;
            if (this.startFailures >= 3) this.exhausted = true;
            this.logger?.warn?.("[Backend] backend=local event=start_failed kind=local_engine");
            throw error;
        });
        this.starting = task;
        task.finally(() => {
            if (this.starting === task) this.starting = null;
        }).catch(() => {});
        return task;
    }
    async start() {
        if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw unavailable();
        await fs.access(this.binary).catch(() => {
            throw unavailable();
        });
        const previousDirectory = this.directory;
        this.directory = await fs.mkdtemp(path.join(os.tmpdir(), "aistudio-engine-"));
        if (previousDirectory) await fs.rm(previousDirectory, { force: true, recursive: true });
        await fs.chmod(this.directory, 0o700);
        this.socket = path.join(this.directory, "engine.sock");
        await fs.rm(this.socket, { force: true });
        const child = spawn(this.binary, [], {
            env: { ...process.env, AISTUDIO_ENGINE_SOCKET: this.socket },
            stdio: ["pipe", "ignore", "ignore"],
        });
        this.child = child;
        let exited = false;
        child.once("error", () => {
            exited = true;
        });
        child.once("exit", (code, signal) => {
            exited = true;
            if (this.child !== child) return;
            const wasReady = this.ready;
            this.ready = false;
            this.child = null;
            if (wasReady) this.emit("unavailable");
            this.logger?.warn?.(`[Backend] backend=local event=exit code=${code ?? "none"} signal=${signal || "none"}`);
            if (!this.closed && wasReady && this.restarts++ < 2) {
                const timer = setTimeout(() => this.ensure().catch(() => {}), 500 * this.restarts);
                timer.unref();
            } else if (!this.closed && wasReady) this.exhausted = true;
        });
        const deadline = Date.now() + 10000;
        while (!this.closed && !exited && Date.now() < deadline) {
            try {
                const health = await this.json("GET", "/health", null, { timeoutMs: 500 });
                if (health.status === "ready") {
                    this.ready = true;
                    this.startFailures = 0;
                    this.logger?.info?.("[Backend] backend=local event=ready engine=spidermonkey-152");
                    return;
                }
            } catch {
                /* bounded readiness polling */
            }
            await delay(50);
        }
        child.kill("SIGKILL");
        throw unavailable();
    }
    request(method, endpoint, body, { signal, timeoutMs = 300000 } = {}) {
        if (this.closed || !this.child) return Promise.reject(unavailable());
        const payload = body == null ? null : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const req = http.request(
                {
                    headers: {
                        "content-type": "application/json",
                        "x-timeout-ms": String(Math.max(1, Math.floor(timeoutMs))),
                    },
                    method,
                    path: endpoint,
                    signal,
                    socketPath: this.socket,
                },
                response => {
                    // The timer must cover the entire body, including stalled streaming reads.
                    response.once("close", () => clearTimeout(timer));
                    resolve(response);
                }
            );
            const timer = setTimeout(() => req.destroy(unavailable(504)), timeoutMs);
            req.once("error", () => {
                clearTimeout(timer);
                reject(signal?.aborted ? unavailable(499, "cancelled") : unavailable());
            });
            if (payload) req.write(payload);
            req.end();
        });
    }
    async json(method, endpoint, body, options) {
        const response = await this.request(method, endpoint, body, options);
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        let result;
        try {
            result = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
            throw unavailable();
        }
        if (response.statusCode >= 400) {
            throw engineError(result.status || response.statusCode, result.kind || "local_engine");
        }
        return result;
    }
    async *stream(session, args, options) {
        const response = await this.request("POST", `/sessions/${session}/rpc`, args, options);
        if (response.statusCode !== 200) {
            const chunks = [];
            for await (const chunk of response) chunks.push(chunk);
            let data;
            try {
                data = JSON.parse(Buffer.concat(chunks));
            } catch {
                data = {};
            }
            throw engineError(data.status || response.statusCode, data.kind || "local_engine");
        }
        let pending = "",
            complete = false;
        const decoder = new TextDecoder();
        try {
            for await (const chunk of response) {
                pending += chunk.toString("utf8");
                let end;
                while ((end = pending.indexOf("\n")) >= 0) {
                    const line = pending.slice(0, end);
                    pending = pending.slice(end + 1);
                    if (!line) continue;
                    const event = JSON.parse(line);
                    if (event.error) throw engineError(event.error.status, event.error.kind);
                    if (event.data !== undefined)
                        yield { text: decoder.decode(Buffer.from(event.data, "base64"), { stream: true }) };
                    else {
                        if (event.result) complete = true;
                        yield event;
                    }
                }
            }
            if (!complete || pending.trim()) throw unavailable(502, "transport");
        } finally {
            response.destroy();
        }
    }
    health() {
        return { backend: "local", pid: this.child?.pid || null, ready: !!this.ready, restarts: this.restarts };
    }
    async close() {
        this.closed = true;
        this.ready = false;
        const child = this.child;
        if (child) {
            const exited = once(child, "exit").catch(() => {});
            child.kill("SIGTERM");
            await Promise.race([exited, delay(5000, undefined, { ref: false })]);
            if (this.child === child) child.kill("SIGKILL");
        }
        await this.starting?.catch(() => {});
        if (this.directory) await fs.rm(this.directory, { force: true, recursive: true });
    }
}
module.exports = { LocalEngine, unavailable };
