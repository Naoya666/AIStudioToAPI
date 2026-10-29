const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pageEval } = require("./MakerSuiteBridge");
const { parseWire, rpcStatusOf } = require("./MakerSuiteCodec");
const { withHardTimeout } = require("../utils/TimeoutUtils");
const { accountForIndex } = require("../accounts/AccountTierPolicy");

const MAX_BYTES = 64 * 1024 * 1024;
const failure = (message, status = 400) => Object.assign(new Error(message), { kind: "capability", status });

// Files use Drive, as in AIStudio2API (MIT). Public IDs are local resources,
// persisted independently of browser lifetimes. Caches are local prompt reuse,
// not a claim of upstream cached-token billing. See THIRD_PARTY_NOTICES.md.
class PlaygroundResources {
    constructor(system, directory = path.join(process.cwd(), "data")) {
        this.system = system;
        this.files = new Map();
        this.caches = new Map();
        this.uploads = new Map();
        this.statePath = path.join(directory, "playground-resources.json");
        try {
            const state = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
            this.files = new Map(state.files || []);
        } catch (error) {
            if (error.code !== "ENOENT") throw failure("Cannot load Playground file registry", 503);
        }
        for (const [id, file] of this.files) this.system.scheduler?.fileAffinities.set("file:" + id, file.owner);
        this.timer = setInterval(() => {
            const now = Date.now();
            for (const [id, upload] of this.uploads) if (upload.expires <= now) this.discardUpload(id);
            for (const [id, cache] of this.caches) if (Date.parse(cache.expireTime) <= now) this.caches.delete(id);
        }, 60000);
        this.timer.unref();
    }

    close() {
        clearInterval(this.timer);
        for (const id of this.uploads.keys()) this.discardUpload(id);
    }

    save() {
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        const temporary = this.statePath + ".tmp";
        fs.writeFileSync(temporary, JSON.stringify({ files: [...this.files] }), { mode: 0o600 });
        fs.renameSync(temporary, this.statePath);
    }

    owner(index) {
        return (
            this.system.scheduler?.account(index).key ||
            accountForIndex(this.system.authSource, index).accountId ||
            String(index)
        );
    }

    prepareRequest(request) {
        if (!request.body || request.resourcesPrepared) return;
        let outer;
        try {
            outer = JSON.parse(request.body);
        } catch {
            return;
        }
        if (!outer || typeof outer !== "object" || Array.isArray(outer)) return;
        const body = outer.generateContentRequest || outer;
        const cacheName = body.cachedContent || body.cached_content;
        if (!cacheName) return;
        const cache = this.getCache(cacheName);
        const model = /\/models\/([^:/]+)/.exec(request.path)?.[1];
        if (model && model !== cache.model.replace(/^models\//, ""))
            throw failure("Cached content model does not match request model");
        for (const key of ["systemInstruction", "system_instruction", "tools", "toolConfig", "tool_config"]) {
            if (body[key] !== undefined)
                throw failure("cachedContent cannot be combined with systemInstruction, tools or toolConfig");
        }
        delete body.cachedContent;
        delete body.cached_content;
        body.contents = [...structuredClone(cache.contents || []), ...(body.contents || [])];
        for (const key of ["systemInstruction", "tools", "toolConfig"])
            if (cache[key]) body[key] = structuredClone(cache[key]);
        request.body = JSON.stringify(outer);
        Object.defineProperty(request, "resourcesPrepared", { value: true });
    }

    resolveFiles(input, index) {
        const visit = value => {
            if (!value || typeof value !== "object") return;
            const file = value.fileData || value.file_data;
            if (file) {
                const uri = file.fileUri || file.file_uri;
                const match =
                    /^(?:https:\/\/generativelanguage\.googleapis\.com\/v1beta\/)?files\/([a-zA-Z0-9_-]+)$/.exec(
                        uri || ""
                    );
                if (match) {
                    const resource = this.files.get(match[1]);
                    if (!resource) throw failure("File not found", 404);
                    if (resource.owner !== this.owner(index)) throw failure("File belongs to a different account", 409);
                    file.fileUri = "drive://" + resource.driveId;
                    file.mimeType = resource.mimeType;
                    delete file.file_uri;
                }
            }
            for (const item of Object.values(value)) if (item && typeof item === "object") visit(item);
        };
        visit(input);
        return input;
    }

    ownerFor(value) {
        const owners = new Set();
        for (const key of require("./FileAffinity").fileKeys(value)) {
            if (!key.startsWith("file:")) continue;
            const file = this.files.get(key.slice(5));
            if (!file) throw failure("File not found", 404);
            owners.add(file.owner);
        }
        if (owners.size > 1) throw failure("Files from different accounts cannot be combined");
        return [...owners][0] || null;
    }

    async withTransport(model, owner, signal, execute) {
        const system = this.system;
        const controller = new AbortController();
        signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        let lease, index;
        if (system.scheduler) {
            const excluded = new Set();
            if (owner) {
                for (const i of system.authSource.getRotationIndices())
                    if (this.owner(i) !== owner) excluded.add(this.owner(i));
                if (system.authSource.getRotationIndices().every(i => excluded.has(this.owner(i))))
                    throw failure("File account unavailable", 503);
            }
            lease = await system.scheduler.acquire(model || "__files__", excluded, signal);
            index = lease.account.index;
            lease.abort = error => controller.abort(error);
        } else {
            index = system.browserManager.currentAuthIndex;
            if (owner && this.owner(index) !== owner) throw failure("File account is not active", 503);
        }
        let success = false;
        try {
            if (signal?.aborted) throw failure("Client disconnected", 499);
            const transport = system.browserManager.contexts.get(index)?.page?.playgroundTransport;
            if (!transport?.ready) throw failure("Playground transport unavailable", 503);
            if (model && model !== "__files__")
                system.requestHandler._assertModelPermission(
                    { path: "/v1beta/models/" + model + ":countTokens" },
                    index
                );
            system.browserManager.notifyUserActivity?.(index);
            if (lease) system.scheduler.startAttempt(lease);
            const result = await execute(transport, index, signal);
            success = true;
            return result;
        } catch (error) {
            if (lease) system.scheduler.failure(lease, error);
            throw error;
        } finally {
            if (lease) system.scheduler.release(lease, success);
        }
    }

    async drive(transport, operation, signal) {
        const id = randomUUID();
        const cancel = () => transport.cancel(id);
        signal?.addEventListener("abort", cancel, { once: true });
        try {
            if (signal?.aborted) throw failure("Client disconnected", 499);
            return await withHardTimeout(
                async () => {
                    const result = await transport.page.evaluate(
                        pageEval,
                        `window.__makerSuiteBridge.run(${JSON.stringify({ body: ["users/me"], ht: "", id, readyTimeoutMs: 10000, rpcMethod: "GenerateAccessToken", timeoutMs: 30000 })})`
                    );
                    if (result.status !== 200) throw await transport.upstreamError(result);
                    const wire = parseWire(result.text);
                    if (rpcStatusOf(wire)) throw await transport.upstreamError(result);
                    const token = wire?.[0];
                    if (typeof token !== "string" || !token) throw failure("Drive authorization unavailable", 502);
                    if (signal?.aborted) throw failure("Client disconnected", 499);
                    const response = await transport.page.evaluate(
                        pageEval,
                        `window.__makerSuiteBridge.drive(${JSON.stringify({ ...operation, id, token })})`
                    );
                    if (response.status >= 400) throw await transport.upstreamError(response);
                    return response;
                },
                150000,
                { operation: "Playground file operation", status: 504 }
            );
        } catch (error) {
            if (signal?.aborted) throw failure("Client disconnected or resource operation cancelled", 499);
            if (!error.status) throw failure("Playground file transport failed", 502);
            throw error;
        } finally {
            signal?.removeEventListener("abort", cancel);
            await transport.cancel(id);
        }
    }

    fileObject(file, openai = false) {
        if (openai)
            return {
                bytes: Number(file.size),
                created_at: Math.floor(Date.parse(file.createTime) / 1000),
                filename: file.displayName,
                id: file.id,
                object: "file",
                purpose: file.purpose || "assistants",
                status: "processed",
            };
        return {
            createTime: file.createTime,
            displayName: file.displayName,
            mimeType: file.mimeType,
            name: "files/" + file.id,
            sizeBytes: String(file.size),
            state: "ACTIVE",
            updateTime: file.createTime,
            uri: "https://generativelanguage.googleapis.com/v1beta/files/" + file.id,
        };
    }

    async upload(metadata, bytes, signal, openai) {
        if (!bytes.length || bytes.length > MAX_BYTES)
            throw failure("File size must be between 1 byte and 64 MiB", 413);
        const mime = (metadata.file?.mimeType || "application/octet-stream").split(";")[0].trim();
        metadata.file ||= {};
        metadata.file.mimeType = mime;
        if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mime)) throw failure("Invalid file MIME type");
        const alias = metadata.file?.name?.replace(/^files\//, "");
        if (alias && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(alias)) throw failure("Invalid file name");
        if (alias && this.files.has(alias)) throw failure("File name already exists", 409);
        return this.withTransport(null, null, signal, async (transport, index, operationSignal) => {
            signal = operationSignal;
            const response = await this.drive(
                transport,
                {
                    data: bytes.toString("base64"),
                    method: "POST",
                    mimeType: metadata.file?.mimeType || "application/octet-stream",
                    name: metadata.file?.displayName || "upload",
                },
                signal
            );
            const result = JSON.parse(response.text);
            if (!result.id) throw failure("Drive upload returned no file ID", 502);
            const file = {
                createTime: new Date().toISOString(),
                displayName: metadata.file?.displayName || result.name || "upload",
                driveId: result.id,
                id: alias || randomUUID().replaceAll("-", ""),
                mimeType: result.mimeType || metadata.file?.mimeType || "application/octet-stream",
                owner: this.owner(index),
                purpose: metadata.purpose,
                size: bytes.length,
            };
            // A concurrent upload may have reserved the same client alias.
            if (this.files.has(file.id)) {
                await this.drive(transport, { fileId: file.driveId, method: "DELETE" }, signal);
                throw failure("File name already exists", 409);
            }
            this.files.set(file.id, file);
            try {
                this.save();
            } catch (error) {
                this.files.delete(file.id);
                await this.drive(transport, { fileId: file.driveId, method: "DELETE" }, signal).catch(() => {});
                throw error;
            }
            this.system.scheduler?.fileAffinities.set("file:" + file.id, file.owner);
            this.system.scheduler?.saveSoon();
            return openai ? this.fileObject(file, true) : { file: this.fileObject(file) };
        });
    }

    getCache(name) {
        if (typeof name !== "string") throw failure("cachedContent must be a resource name");
        const cache = this.caches.get(name.replace(/^cachedContents\//, ""));
        if (!cache || Date.parse(cache.expireTime) <= Date.now())
            throw failure("Cached content not found or expired", 404);
        return cache;
    }

    expiration(body) {
        if (body.ttl && body.expireTime) throw failure("Specify ttl or expireTime, not both");
        const ttl = body.ttl === undefined ? 3600 : Number(/^([0-9]+(?:\.[0-9]+)?)s$/.exec(body.ttl)?.[1]);
        const expires = body.expireTime ? Date.parse(body.expireTime) : Date.now() + ttl * 1000;
        if (!Number.isFinite(expires) || expires <= Date.now()) throw failure("Invalid cache expiration");
        return new Date(expires).toISOString();
    }

    cacheObject(cache) {
        const { name, model, displayName, createTime, updateTime, expireTime, usageMetadata } = cache;
        return { createTime, displayName, expireTime, model, name, updateTime, usageMetadata };
    }

    discardUpload(id) {
        const upload = this.uploads.get(id);
        if (upload) {
            this.uploads.delete(id);
            fs.rmSync(upload.directory, { force: true, recursive: true });
        }
    }

    async handle(req, res, next) {
        const requestPath = req.path.replace(/^\/proxy(?=\/)/, "");
        const route =
            /^\/(v1|v1beta|v1alpha)\/(files|cachedContents)(?:\/([a-zA-Z0-9_-]+))?(?:(?:\/|:)(content|download))?$/.exec(
                requestPath
            );
        const upload = /^\/upload\/v1(?:beta|alpha)\/files$/.test(requestPath);
        if (!route && !upload) return next();
        const controller = new AbortController();
        const onClose = () => {
            if (!res.writableFinished) controller.abort();
        };
        res.once("close", onClose);
        const signal = controller.signal;
        const openai = route?.[1] === "v1";
        const handler = this.system.requestHandler;
        handler._setResponseApiFormat(res, openai ? "openai" : "gemini");
        try {
            if (route?.[2] === "cachedContents") {
                const id = route[3],
                    body = req.body || {};
                if (req.method === "POST" && !id) {
                    if (this.caches.size >= 1000) throw failure("Local cache capacity reached", 429);
                    if (typeof body.model !== "string" || !body.model) throw failure("Cache model is required");
                    const model = body.model.replace(/^models\//, "");
                    if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw failure("Invalid cache model");
                    const expireTime = this.expiration(body);
                    const cache = structuredClone({ ...body, model: "models/" + model });
                    const countBody = {
                        contents: cache.contents || [],
                        systemInstruction: cache.systemInstruction,
                        toolConfig: cache.toolConfig,
                        tools: cache.tools,
                    };
                    const count = await this.withTransport(
                        model,
                        this.ownerFor(countBody),
                        signal,
                        async (transport, index, operationSignal) => {
                            const id = randomUUID(),
                                attempt = id + "_attempt_1";
                            const cancel = () => transport.cancelAttempt(id, attempt);
                            operationSignal.addEventListener("abort", cancel, { once: true });
                            try {
                                if (operationSignal.aborted) throw failure("Client disconnected", 499);
                                return await transport.generate({
                                    body: JSON.stringify(this.resolveFiles(countBody, index)),
                                    method: "POST",
                                    path: "/v1beta/models/" + model + ":countTokens",
                                    remaining_budget_ms: 30000,
                                    request_attempt_id: attempt,
                                    request_id: id,
                                });
                            } finally {
                                operationSignal.removeEventListener("abort", cancel);
                            }
                        }
                    );
                    const name = randomUUID().replaceAll("-", ""),
                        now = new Date().toISOString();
                    Object.assign(cache, {
                        createTime: now,
                        expireTime,
                        name: "cachedContents/" + name,
                        updateTime: now,
                        usageMetadata: { totalTokenCount: count.totalTokens },
                    });
                    const bytes = Buffer.byteLength(JSON.stringify(cache));
                    const occupied = [...this.caches.values()].reduce(
                        (total, item) => total + Buffer.byteLength(JSON.stringify(item)),
                        0
                    );
                    if (bytes + occupied > MAX_BYTES) throw failure("Local cache capacity exceeds 64 MiB", 413);
                    this.caches.set(name, cache);
                    return res.json(this.cacheObject(cache));
                }
                if (req.method === "GET" && !id)
                    return res.json(
                        this.page(
                            [...this.caches.values()]
                                .filter(c => Date.parse(c.expireTime) > Date.now())
                                .map(c => this.cacheObject(c)),
                            req.query,
                            "cachedContents"
                        )
                    );
                const cache = this.getCache(id || "");
                if (req.method === "GET") return res.json(this.cacheObject(cache));
                if (req.method === "DELETE") {
                    this.caches.delete(id);
                    return res.json({});
                }
                if (req.method === "PATCH") {
                    if (!body.ttl && !body.expireTime) throw failure("Cache update requires ttl or expireTime");
                    cache.expireTime = this.expiration(body);
                    cache.updateTime = new Date().toISOString();
                    return res.json(this.cacheObject(cache));
                }
                throw failure("Unsupported cache operation", 405);
            }
            if (req.method === "POST" && (upload || (route && !route[3]))) {
                const sessionId = req.query.upload_id;
                if (sessionId) return await this.uploadChunk(req, res, sessionId, signal);
                const protocol = req.headers["x-goog-upload-protocol"];
                if (protocol === "resumable") {
                    if (this.uploads.size >= 64) throw failure("Too many upload sessions", 429);
                    const size = Number(req.headers["x-goog-upload-header-content-length"]);
                    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES)
                        throw failure("Invalid upload size (maximum 64 MiB)", 413);
                    const id = randomUUID(),
                        directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "aistudio-upload-"));
                    const metadata = structuredClone(req.body || {});
                    metadata.file ||= {};
                    metadata.file.mimeType ||= req.headers["x-goog-upload-header-content-type"];
                    this.uploads.set(id, { directory, expires: Date.now() + 3600000, metadata, received: 0, size });
                    const protocol = String(req.headers["x-forwarded-proto"] || req.protocol)
                        .split(",")[0]
                        .trim();
                    const host = String(req.headers["x-forwarded-host"] || req.get("host"))
                        .split(",")[0]
                        .trim();
                    const origin = (protocol === "https" ? "https" : "http") + "://" + host;
                    const location = new URL(req.baseUrl + req.path, origin);
                    location.searchParams.set("upload_id", id);
                    res.setHeader("x-goog-upload-url", location.href);
                    res.setHeader("x-goog-upload-status", "active");
                    return res.status(200).end();
                }
                if (protocol === "raw" || req.query.uploadType === "media") {
                    return res.json(
                        await this.upload(
                            {
                                file: {
                                    displayName: req.headers["x-goog-upload-file-name"] || "upload",
                                    mimeType: req.headers["content-type"],
                                },
                            },
                            req.rawBody || Buffer.alloc(0),
                            signal,
                            openai
                        )
                    );
                }
                const parts = parseMultipart(req.rawBody || Buffer.alloc(0), req.headers["content-type"]);
                let metadata = {},
                    bytes;
                for (const part of parts) {
                    if (part.filename !== undefined) {
                        bytes = part.body;
                        metadata.file = { displayName: part.filename, mimeType: part.type };
                    } else if (part.type?.startsWith("application/json"))
                        metadata = { ...metadata, ...JSON.parse(part.body.toString()) };
                    else if (part.name === "purpose") metadata.purpose = part.body.toString();
                    else if (!part.name) {
                        bytes = part.body;
                        metadata.file ||= {};
                        metadata.file.mimeType ||= part.type;
                    }
                }
                if (!bytes) throw failure("Multipart upload requires a file");
                return res.json(await this.upload(metadata, bytes, signal, openai));
            }
            const id = route?.[3];
            if (req.method === "GET" && !id) {
                const objects = [...this.files.values()].map(file => this.fileObject(file, openai));
                return res.json(
                    openai ? { data: objects, has_more: false, object: "list" } : this.page(objects, req.query, "files")
                );
            }
            const file = this.files.get(id);
            if (!file) throw failure("File not found", 404);
            if (req.method === "GET" && !route[4]) return res.json(this.fileObject(file, openai));
            if (req.method === "DELETE" || (req.method === "GET" && route[4])) {
                await this.withTransport(null, file.owner, signal, async (transport, _index, operationSignal) => {
                    const result = await this.drive(
                        transport,
                        { download: req.method === "GET", fileId: file.driveId, method: req.method },
                        operationSignal
                    );
                    if (req.method === "GET")
                        return res.type(result.mimeType || file.mimeType).send(Buffer.from(result.data, "base64"));
                    this.files.delete(id);
                    this.save();
                    this.system.scheduler?.fileAffinities.delete("file:" + id);
                    return res.json(openai ? { deleted: true, id, object: "file" } : {});
                });
                return;
            }
            throw failure("Unsupported file operation", 405);
        } catch (error) {
            if (!res.destroyed)
                handler._sendErrorResponse(
                    res,
                    error.status || 500,
                    error.status ? error.message : "Playground resource operation failed",
                    null,
                    error
                );
        } finally {
            res.removeListener("close", onClose);
        }
    }

    page(items, query, key) {
        const offset = Number(query.pageToken || 0),
            size = Number(query.pageSize || 100);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 1 || size > 1000)
            throw failure("Invalid pagination");
        return {
            [key]: items.slice(offset, offset + size),
            ...(offset + size < items.length ? { nextPageToken: String(offset + size) } : {}),
        };
    }

    async uploadChunk(req, res, id, signal) {
        const session = this.uploads.get(id);
        if (!session || session.expires <= Date.now()) throw failure("Upload session not found", 404);
        if (session.busy) throw failure("Upload session is busy", 409);
        session.busy = true;
        try {
            const command = req.headers["x-goog-upload-command"] || "upload, finalize";
            if (command === "cancel") {
                this.discardUpload(id);
                return res.set("x-goog-upload-status", "cancelled").end();
            }
            if (command === "query")
                return res
                    .set("x-goog-upload-size-received", String(session.received))
                    .set("x-goog-upload-status", "active")
                    .end();
            const bytes = req.rawBody || Buffer.alloc(0),
                offset = Number(req.headers["x-goog-upload-offset"] || 0);
            if (offset !== session.received) throw failure("Upload offset does not match received bytes", 409);
            if (session.received + bytes.length > session.size) throw failure("Upload exceeds declared size", 413);
            fs.appendFileSync(path.join(session.directory, "body"), bytes);
            session.received += bytes.length;
            session.expires = Date.now() + 3600000;
            if (!command.includes("finalize")) return res.set("x-goog-upload-status", "active").end();
            if (session.received !== session.size) throw failure("Upload is incomplete");
            const result = await this.upload(
                session.metadata,
                fs.readFileSync(path.join(session.directory, "body")),
                signal,
                false
            );
            this.discardUpload(id);
            return res.set("x-goog-upload-status", "final").json(result);
        } finally {
            session.busy = false;
        }
    }
}

function parseMultipart(buffer, type = "") {
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
    if (!boundary || (!boundary[1] && !boundary[2])) throw failure("Multipart boundary is required");
    const marker = Buffer.from("--" + (boundary[1] || boundary[2])),
        parts = [];
    let start = buffer.indexOf(marker);
    while (start >= 0) {
        start += marker.length;
        if (buffer.subarray(start, start + 2).toString() === "--") break;
        const headersEnd = buffer.indexOf("\r\n\r\n", start);
        const next = buffer.indexOf(Buffer.concat([Buffer.from("\r\n"), marker]), headersEnd + 4);
        if (headersEnd < 0 || next < 0) throw failure("Malformed multipart upload");
        const headers = buffer.subarray(start, headersEnd).toString();
        parts.push({
            body: buffer.subarray(headersEnd + 4, next),
            filename: /filename="([^"]*)"/i.exec(headers)?.[1],
            name: /(?:^|;)\s*name="([^"]*)"/i.exec(headers)?.[1],
            type: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim(),
        });
        start = next + 2;
    }
    return parts;
}
module.exports = { MAX_BYTES, parseMultipart, PlaygroundResources };
