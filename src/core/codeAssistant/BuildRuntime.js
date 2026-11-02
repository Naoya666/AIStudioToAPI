const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pageEval } = require("../MakerSuiteBridge");
const { withHardTimeout } = require("../../utils/TimeoutUtils");
const { atomicWrite } = require("../../config/ConfigurationService");
const { encode, decode } = require("./BuildCodec");
const fail = (message, status = 503) =>
    Object.assign(new Error(message), { kind: "capability", retryable: false, status });
// Only project/task identifiers are persisted. A crash cannot silently orphan a
// known task and then send a second generation before attempting cleanup.
class BuildRuntime {
    constructor({
        page,
        accountKey,
        statePath = path.join(process.cwd(), "data", "build-projects.json"),
        timeoutMs = 300000,
    }) {
        Object.assign(this, { accountKey, page, statePath, timeoutMs });
        this.active = new Map();
        this.readyProjects = 0;
    }
    read() {
        try {
            return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
        } catch (e) {
            if (e.code === "ENOENT") return {};
            throw fail("Build 项目状态损坏，已停止生成");
        }
    }
    save(op, value) {
        const state = this.read();
        if (value) state[op] = value;
        else delete state[op];
        atomicWrite(this.statePath, state);
    }
    async rpc(method, body, { signal, ht = "", proofText, timeoutMs = this.timeoutMs } = {}) {
        if (signal?.aborted) throw fail("Build 请求已取消", 499);
        const id = randomUUID();
        const cancel = () => {
            void this.page
                .evaluate(pageEval, `window.__makerSuiteBridge.cancel(${JSON.stringify(id)})`)
                .catch(() => {});
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
            const args = { body, ht, id, proofText, readyTimeoutMs: 10000, rpcMethod: method, timeoutMs };
            const result = await withHardTimeout(
                () => this.page.evaluate(pageEval, `window.__makerSuiteBridge.run(${JSON.stringify(args)})`),
                timeoutMs + 2000,
                { operation: "Build RPC", status: 504 }
            );
            let rpcCode;
            try {
                const value = JSON.parse(result.text);
                if (Array.isArray(value) && Number.isInteger(value[0]) && value[0] > 0 && typeof value[1] === "string")
                    rpcCode = value[0];
            } catch {
                /* Decoder validates the body below. */
            }
            if (rpcCode) result.status = { 1: 499, 3: 400, 4: 504, 5: 404, 7: 403, 8: 429, 16: 401 }[rpcCode] || 502;
            if (result.status !== 200)
                throw Object.assign(fail(`Build ${method} 失败（HTTP ${result.status}）`, result.status), {
                    kind: "upstream",
                    upstreamError: result.status === 401 ? { status: "UNAUTHENTICATED" } : undefined,
                });
            return result.text;
        } finally {
            signal?.removeEventListener("abort", cancel);
            cancel();
        }
    }
    async cleanup(op, entry) {
        // Cancellation acknowledgement or deletion must finish before reusing capacity.
        if (entry.task && !entry.complete) {
            try {
                await this.rpc("CancelCodeAssistantOfflineGeneration", [entry.task, entry.app], { timeoutMs: 10000 });
            } catch (e) {
                if (e.status !== 404) throw e;
            }
        }
        if (entry.app) {
            try {
                await this.rpc("DeleteApplet", [entry.app], { timeoutMs: 10000 });
            } catch (e) {
                if (e.status !== 404) throw e;
            }
        }
        this.save(op, null);
    }
    async recover() {
        for (const [op, entry] of Object.entries(this.read()))
            if (entry.account === this.accountKey && !this.active.has(op)) {
                try {
                    await this.cleanup(op, entry);
                } catch (e) {
                    this.cleanupPending = true;
                    throw e;
                }
            }
    }
    async generate(identity, context, { signal, onText, onUsage, timeoutMs = this.timeoutMs } = {}) {
        await this.recover();
        this.cleanupPending = false;
        const op = randomUUID(),
            entry = { account: this.accountKey, app: null, complete: false, task: null };
        this.active.set(op, entry);
        let primaryError, lastUsage;
        const deadline = Date.now() + timeoutMs;
        const rpc = (method, body, ht = "", proofText) =>
            this.rpc(method, body, { ht, proofText, signal, timeoutMs: Math.max(1, deadline - Date.now()) });
        try {
            const created = JSON.parse(
                await rpc("CreateApplet", [
                    null,
                    ["Gateway text conversation", "Temporary request project", null, null, "default"],
                    null,
                    null,
                    1,
                ])
            );
            if (typeof created?.[0] !== "string" || !/^[a-f0-9-]{36}$/i.test(created[0]))
                throw fail("Build CreateApplet 响应无效", 502);
            entry.app = created[0];
            this.save(op, entry);
            this.readyProjects++;
            const { body, ht } = encode(identity, context, entry.app);
            const createdTask = JSON.parse(await rpc("CodeAssistantOffline", body, ht, context.prompt));
            if (typeof createdTask?.[0] !== "string" || !createdTask[0] || createdTask[0].length > 200)
                throw fail("Build 未返回任务 ID；不会再次生成", 502);
            entry.task = createdTask[0];
            this.save(op, entry);
            let emitted = "";
            while (Date.now() < deadline) {
                if (signal?.aborted) throw fail("Build 请求已取消", 499);
                let raw;
                try {
                    raw = await rpc("StreamCodeAssistantOfflineGeneration", [entry.task, null, null, entry.app]);
                } catch (e) {
                    // Resume only reads of an already known task, never submission. Bounded by deadline.
                    if (signal?.aborted || ![502, 504].includes(e.status)) throw e;
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }
                let result;
                try {
                    result = decode(raw, entry.task);
                } catch (e) {
                    if (e.taskTerminal) {
                        // Failed tasks are terminal too. Do not cancel an already ended generation.
                        entry.complete = true;
                        this.save(op, entry);
                    }
                    if (e.code !== "BUILD_READ_INTERRUPTED") throw e;
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }
                lastUsage = result.usage || lastUsage;
                if (result.usage) onUsage?.(result.usage);
                if (onText && result.text) {
                    if (!result.text.startsWith(emitted)) throw fail("Build 累计输出发生变化；已停止输出", 502);
                    const delta = result.text.slice(emitted.length);
                    if (delta) onText(delta);
                    emitted = result.text;
                }
                if (result.complete) {
                    entry.complete = true;
                    this.save(op, entry);
                    if (!result.text) throw fail("Build 已完成但没有可返回内容", 502);
                    return { ...result, usage: lastUsage };
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            throw fail("Build 任务未完成（已达等待期限）；未重新生成", 504);
        } catch (e) {
            primaryError = e;
            if (e.usage) onUsage?.(e.usage);
            if (lastUsage && !e.usage) e.usage = lastUsage;
            throw e;
        } finally {
            try {
                await this.cleanup(op, entry);
            } catch {
                // Keep the journal. Next request must recover it before creating any task.
                if (primaryError) primaryError.cleanupPending = true;
                this.cleanupPending = true;
            }
            this.readyProjects = Math.max(0, this.readyProjects - 1);
            this.active.delete(op);
        }
    }
}
module.exports = { BuildRuntime };
