const crypto = require("crypto");

function normalizeGroup(value) {
    if (value === undefined || value === null) return "";
    if (
        typeof value !== "string" ||
        value.trim().length > 80 ||
        [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
        throw Object.assign(new Error("出口组必须为不超过 80 个字符的文本，且不能包含控制字符"), { status: 400 });
    return value.trim();
}

// Only digests leave this module; proxy credentials never become API identifiers.
function egressKey(info = {}) {
    if (info.egressKey) return info.egressKey;
    if (!info.proxy) return "direct";
    const group = normalizeGroup(info.egressGroup);
    if (group) return `group:${group}`;
    if (info.appliedNodeId) return `node:${info.appliedNodeId}`;
    const proxy = info.proxy;
    let server = String(proxy.server || "");
    let username = proxy.username || "";
    let password = proxy.password || "";
    try {
        const url = new URL(server.includes("://") ? server : `http://${server}`);
        username ||= decodeURIComponent(url.username);
        password ||= decodeURIComponent(url.password);
        url.username = "";
        url.password = "";
        server = url.toString();
    } catch {
        // Keep an opaque digest for legacy proxy formats, without exposing input.
    }
    const route = JSON.stringify([server, username, password]);
    return `route:${crypto.createHash("sha256").update(route).digest("hex")}`;
}

function snapshotEgress(info = {}) {
    return { ...info, egressKey: egressKey(info) };
}

module.exports = { egressKey, normalizeGroup, snapshotEgress };
