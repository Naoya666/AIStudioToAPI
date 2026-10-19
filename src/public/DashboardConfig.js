const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const defaults = {
    agents: [],
    agentToken: "",
    fetchTimeoutMs: 2000,
    healthToken: "",
    pollIntervalMs: 5000,
    role: "standalone",
    snapshotIntervalMs: 5000,
    staleAfterMs: 20000,
};
const fields = [
    ["ROLE", "role"],
    ["AGENT_TOKEN", "agentToken"],
    ["HEALTH_TOKEN", "healthToken"],
    ["AGENTS", "agents"],
    ["SNAPSHOT_INTERVAL_MS", "snapshotIntervalMs"],
    ["POLL_INTERVAL_MS", "pollIntervalMs"],
    ["FETCH_TIMEOUT_MS", "fetchTimeoutMs"],
    ["STALE_AFTER_MS", "staleAfterMs"],
];
const validToken = value => typeof value === "string" && /^[\x21-\x7e]{1,4096}$/.test(value);
function normalizeAgents(value) {
    if (!Array.isArray(value) || value.length > 100) throw new Error("PUBLIC_DASHBOARD_AGENTS: 最多配置 100 个节点");
    const ids = new Set(),
        urls = new Set();
    return value.map(row => {
        let url;
        try {
            url = new URL(row.url);
        } catch {
            throw new Error("PUBLIC_DASHBOARD_AGENTS: 无效节点 URL");
        }
        if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.href.includes("?") ||
            url.href.includes("#")
        )
            throw new Error("PUBLIC_DASHBOARD_AGENTS: URL 仅允许 HTTP(S) 根地址或路径前缀");
        const normalized = url.href.replace(/\/+$/, "");
        if (
            typeof row.nodeId !== "string" ||
            !/^[\w-]{1,128}$/.test(row.nodeId) ||
            ids.has(row.nodeId) ||
            urls.has(normalized)
        )
            throw new Error("PUBLIC_DASHBOARD_AGENTS: 节点 ID 或 URL 为空、无效或重复");
        if (!validToken(row.token)) throw new Error("PUBLIC_DASHBOARD_AGENTS: 每个节点必须提供有效 Token");
        if (row.name !== undefined && (typeof row.name !== "string" || row.name.length > 100))
            throw new Error("PUBLIC_DASHBOARD_AGENTS: 无效节点名称");
        ids.add(row.nodeId);
        urls.add(normalized);
        return { name: row.name || "", nodeId: row.nodeId, token: row.token, url: normalized };
    });
}
function load(config, env) {
    Object.assign(config, defaults, { agents: [] });
    for (const [suffix, key] of fields) {
        const raw = env[`PUBLIC_DASHBOARD_${suffix}`];
        if (raw === undefined) continue;
        if (key === "agents") {
            try {
                config.agents = normalizeAgents(JSON.parse(raw));
            } catch {
                throw new Error("PUBLIC_DASHBOARD_AGENTS: 无效节点列表，请检查 ID、URL 和 Token");
            }
        } else if (key.endsWith("Ms")) {
            const value = Number(raw);
            if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(value) || value < 100 || value > 3600000)
                throw new Error(`PUBLIC_DASHBOARD_${suffix}: 必须为 100–3600000 毫秒的整数`);
            config[key] = value;
        } else config[key] = raw;
    }
    if (!["standalone", "master", "agent"].includes(config.role)) throw new Error("PUBLIC_DASHBOARD_ROLE: 无效角色");
    if (config.healthToken && !validToken(config.healthToken))
        throw new Error("PUBLIC_DASHBOARD_HEALTH_TOKEN: 无效 Token");
    if (config.agentToken && !validToken(config.agentToken))
        throw new Error("PUBLIC_DASHBOARD_AGENT_TOKEN: 无效 Token");
    if (config.enabled && config.role === "agent" && !validToken(config.agentToken))
        throw new Error("PUBLIC_DASHBOARD_AGENT_TOKEN: agent 模式必须配置 Token");
    if (config.staleAfterMs <= config.snapshotIntervalMs + config.pollIntervalMs + config.fetchTimeoutMs)
        throw new Error("PUBLIC_DASHBOARD_STALE_AFTER_MS: 必须大于快照周期、采集周期与请求超时之和");
    return config;
}
function nodeId(directory = path.join(process.cwd(), "data")) {
    fs.mkdirSync(directory, { mode: 0o700, recursive: true });
    const file = path.join(directory, "public-dashboard-node-id");
    try {
        fs.writeFileSync(file, crypto.randomUUID(), { flag: "wx", mode: 0o600 });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
    }
    const id = fs.readFileSync(file, "utf8").trim();
    if (!/^[\w-]{1,128}$/.test(id)) throw new Error("Invalid public dashboard node ID file");
    return id;
}
module.exports = { defaults, fields, load, nodeId, normalizeAgents, validToken };
