/* global window */
const { validate } = require("./ModelCatalog");
const { parseWire } = require("./MakerSuiteCodec");
const { withHardTimeout } = require("../utils/TimeoutUtils");
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const METADATA = [
    "displayName",
    "description",
    "version",
    "inputTokenLimit",
    "outputTokenLimit",
    "supportedGenerationMethods",
];

// AIStudio2API's ListModels array protocol: metadata in fields 1–8,
// capability codes in field 65 (48 = code_assistant).
function parseModels(text) {
    let payload;
    try {
        payload = parseWire(text);
    } catch {
        throw fail("上游模型目录不是有效 JSON");
    }
    if (!Array.isArray(payload?.[0]) || !payload[0].length) throw fail("上游返回空目录或未知模型协议");
    const rows = [];
    for (const item of payload[0]) {
        if (!Array.isArray(item) || typeof item[0] !== "string") throw fail("上游模型条目缺少 ID");
        const id = item[0].replace(/^models\//, "");
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) throw fail("上游模型 ID 无效");
        const row = { name: `models/${id}` };
        for (const [key, index] of [
            ["version", 2],
            ["displayName", 3],
            ["description", 4],
            ["inputTokenLimit", 5],
            ["outputTokenLimit", 6],
            ["supportedGenerationMethods", 7],
        ]) {
            if (item[index] != null) row[key] = item[index];
        }
        rows.push(row);
        if (Array.isArray(item[64]) && item[64].includes(48)) rows.push({ ...row, name: `models/build/${id}` });
    }
    try {
        return validate(rows);
    } catch {
        throw fail("上游模型目录字段无效，未修改本地目录");
    }
}
function compareModels(upstream, local) {
    const byName = new Map(local.map(row => [row.name.replace(/^models\//, ""), row]));
    const names = new Set(upstream.map(row => row.name.replace(/^models\//, "")));
    return {
        localOnly: local.filter(row => !names.has(row.name.replace(/^models\//, ""))),
        rows: upstream.map(row => {
            const current = byName.get(row.name.replace(/^models\//, ""));
            const changedFields = current
                ? METADATA.filter(key => JSON.stringify(current[key] ?? null) !== JSON.stringify(row[key] ?? null))
                : [];
            return { changedFields, row, status: !current ? "new" : changedFields.length ? "changed" : "existing" };
        }),
    };
}
async function discover(system) {
    const manager = system.browserManager;
    const contexts = [...(manager?.contexts || [])];
    // Use an existing page only; do not create sessions or change the active account.
    const entry = contexts.find(([index]) => {
        const benefit = manager.getBenefit(index);
        return benefit?._evaluate && !benefit.disposed && benefit.isCurrent?.() !== false;
    });
    if (!entry) throw fail("没有可用的上游账号会话，请先启动并登录账号", 503);
    const [accountIndex] = entry;
    const benefit = manager.getBenefit(accountIndex);
    const result = await withHardTimeout(
        () =>
            benefit._evaluate(async () => {
                const state = window.__buildBenefit;
                if (!state?.auth || !state.nativeFetch) return { status: 503 };
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 20000);
                try {
                    const response = await state.nativeFetch(
                        "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListModels",
                        {
                            body: "[]",
                            credentials: "include",
                            headers: { ...state.auth, "content-type": "application/json+protobuf" },
                            method: "POST",
                            signal: controller.signal,
                        }
                    );
                    const text = await response.text();
                    return { status: response.status, text: text.length <= 4 * 1024 * 1024 ? text : "" };
                } finally {
                    clearTimeout(timer);
                }
            }),
        25000,
        { operation: "模型探测", status: 504 }
    );
    if (result?.status !== 200)
        throw fail(
            `上游模型探测失败（HTTP ${result?.status || 503}），请检查账号会话`,
            result?.status === 503 ? 503 : 502
        );
    const upstream = parseModels(result.text);
    return {
        ...compareModels(upstream, system.configurationService.running.modelList),
        accountIndex,
        fetchedAt: new Date().toISOString(),
    };
}
module.exports = { compareModels, discover, METADATA, parseModels };
