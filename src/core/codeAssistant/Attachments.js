// Build attachments use the CodeAssistantOffline upload protocol documented by
// AIStudio2API (MIT). Keep media bytes outside the JSON conversation attachment.
const { randomBytes } = require("node:crypto");
const dns = require("node:dns");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const axios = require("axios");
const mimeTypes = require("mime-types");
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 32;
const MIME = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { kind: "capability", status });
function nameOf(value, fallback) {
    if (value === undefined) return fallback;
    if (
        typeof value !== "string" ||
        !value ||
        value.length > 255 ||
        Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === "/" || c === "\\")
    )
        throw fail("Build 附件文件名无效");
    return value;
}
function inline(value, name, image = false) {
    if (typeof value !== "string") throw fail("Build 附件数据无效");
    const dataURL = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(value);
    const mime = dataURL?.[1] || mimeTypes.lookup(name) || "application/octet-stream";
    const data = (dataURL ? dataURL[2] : value).replace(/\s/g, "");
    if (!MIME.test(mime) || (image && !mime.startsWith("image/"))) throw fail("Build 附件 MIME 无效");
    if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1)
        throw fail("Build 附件必须为有效 Base64");
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, ""))
        throw fail("Build 附件必须为有效 Base64");
    if (bytes.length > MAX_BYTES) throw fail("Build 单个附件超过 8 MiB", 413);
    return { data: bytes.toString("base64"), mime, name };
}
function source(part, name) {
    if (["image_url", "input_image"].includes(part?.type)) {
        const value = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (typeof value !== "string" || !value) throw fail("Build 图片需要 image_url");
        return value.startsWith("data:") ? inline(value, name, true) : { image: true, name, url: value };
    }
    if (["file", "input_file"].includes(part?.type)) {
        const file = part.file || part;
        name = nameOf(file.filename, name);
        if (file.file_data !== undefined) return inline(file.file_data, name);
        if (typeof file.file_id === "string" && file.file_id) return { fileId: file.file_id, name };
        if (typeof file.file_url === "string" && file.file_url) return { name, url: file.file_url };
        throw fail("Build 文件需要 file_data、file_id 或 file_url");
    }
    throw fail("Build 不支持此消息内容类型");
}
function extract(messages, positions) {
    const attachments = [],
        nonce = randomBytes(12).toString("hex");
    const rewritten = messages.map((message, index) => {
        if (!Array.isArray(message?.content)) return message;
        return {
            ...message,
            content: message.content.map((part, position) => {
                if (part?.type === "text" && typeof part.text === "string") return part;
                if (attachments.length >= MAX_FILES) throw fail("Build 每次最多 32 个附件", 413);
                const name = `attachment-${nonce}-${attachments.length + 1}`;
                const attachment = source(part, name);
                const originalName = attachment.name;
                // Unique upload names prevent two client files called e.g. image.png
                // from becoming ambiguous references in the ordered conversation.
                attachment.name =
                    name + (mimeTypes.extension(attachment.mime) ? "." + mimeTypes.extension(attachment.mime) : "");
                attachments.push(attachment);
                return {
                    text: `[Attached file: ${attachment.name}; original name: ${originalName}; message ${positions?.[index]?.message ?? index}, part ${positions?.[index]?.part ?? position}]`,
                    type: "text",
                };
            }),
        };
    });
    return { attachments, messages: rewritten };
}
// Resolve public HTTP(S) media with bounded downloads. Validate every redirect and
// the actual DNS addresses used by the socket, rather than trusting a prior lookup.
const blocked = new net.BlockList();
for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["192.0.0.0", 24],
    ["198.18.0.0", 15],
    ["224.0.0.0", 3],
])
    blocked.addSubnet(address, prefix);
function publicAddress(address) {
    const family = net.isIP(address);
    if (family === 4) return !blocked.check(address, "ipv4");
    // Public IPv6 global unicast only; excludes mapped IPv4 and local addresses.
    return family === 6 && /^[23][0-9a-f]{3}:/i.test(address);
}
function lookup(host, options, callback) {
    dns.lookup(host, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error);
        if (!addresses.length || addresses.some(item => !publicAddress(item.address)))
            return callback(fail("Build 附件地址必须使用公网 IP"));
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
    });
}
async function download(address, signal) {
    const httpAgent = new http.Agent({ lookup }),
        httpsAgent = new https.Agent({ lookup });
    try {
        for (let redirects = 0; redirects <= 3; redirects++) {
            let url;
            try {
                url = new URL(address);
            } catch {
                throw fail("Build 附件 URL 无效");
            }
            const host = url.hostname.replace(/^\[|\]$/g, "");
            if (
                !["http:", "https:"].includes(url.protocol) ||
                url.username ||
                url.password ||
                (net.isIP(host) && !publicAddress(host))
            )
                throw fail("Build 附件需要公网 HTTP(S) URL");
            const response = await axios.get(url.href, {
                httpAgent,
                httpsAgent,
                maxContentLength: MAX_BYTES,
                maxRedirects: 0,
                proxy: false,
                responseType: "arraybuffer",
                signal,
                timeout: 30000,
                validateStatus: status => status >= 200 && status < 400,
            });
            if (response.status >= 300) {
                if (!response.headers.location || redirects === 3) throw fail("Build 附件重定向失败", 400);
                address = new URL(response.headers.location, url).href;
                continue;
            }
            return {
                data: Buffer.from(response.data).toString("base64"),
                mime: response.headers["content-type"]?.split(";")[0].trim(),
            };
        }
    } catch (error) {
        if (signal?.aborted) throw fail("Build 附件读取已取消", 499);
        if (error.kind === "capability") throw error;
        throw fail("Build 附件下载失败或超过 8 MiB", 400);
    } finally {
        httpAgent.destroy();
        httpsAgent.destroy();
    }
}
async function resolve(attachments, system, signal) {
    let total = 0;
    const files = [];
    for (const attachment of attachments) {
        if (signal?.aborted) throw fail("Build 附件读取已取消", 499);
        let file = { ...attachment };
        if (file.fileId) {
            const resources = system.playgroundResources;
            const id = /^(?:files\/)?([a-zA-Z0-9_-]+)$/.exec(file.fileId)?.[1];
            const resource = resources?.files.get(id);
            if (!resource) throw fail("Build 附件 file_id 不存在", 404);
            if (Number(resource.size || resource.bytes || resource.sizeBytes) > MAX_BYTES)
                throw fail("Build 单个附件超过 8 MiB", 413);
            const result = await resources.withTransport(
                null,
                resource.owner,
                signal,
                (transport, _index, operationSignal) =>
                    resources.drive(
                        transport,
                        { download: true, fileId: resource.driveId, method: "GET" },
                        operationSignal
                    )
            );
            file = { ...file, data: result.data, mime: resource.mimeType };
        } else if (file.url) file = { ...file, ...(await download(file.url, signal)) };
        if (!MIME.test(file.mime || "") || (file.image && !file.mime.startsWith("image/")))
            throw fail("Build 附件缺少有效 MIME 或图片地址未返回图片");
        if (typeof file.data !== "string" || !file.data) throw fail("Build 附件为空");
        const bytes = Buffer.from(file.data, "base64").length;
        total += bytes;
        if (bytes > MAX_BYTES || total > MAX_BYTES) throw fail("Build 附件总大小超过 8 MiB", 413);
        files.push({ data: file.data, name: file.name, type: file.mime });
    }
    return files;
}
module.exports = { extract, resolve };
