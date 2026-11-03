const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pageEval } = require("../MakerSuiteBridge");
const { withHardTimeout } = require("../../utils/TimeoutUtils");
const { atomicWrite } = require("../../config/ConfigurationService");
const { buildError, errorInfo, fromResponse } = require("./BuildError");
const { encode, decode } = require("./BuildCodec");
const fail = (message, status = 503) => buildError({ message, source: "local", status });
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
    async rpc(method, body, { signal, ht = "", proofText, timeoutMs = this.timeoutMs, phase = "cleanup" } = {}) {
        if (signal?.aborted) throw buildError({ message: "Build 请求已取消", phase, source: "local", status: 499 });
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
                timeoutMs,
                { operation: "Build RPC", status: 504 }
            );
            const error = fromResponse(result, phase);
            if (error) throw error;
            return result.text;
        } catch (error) {
            if (!error.source)
                throw buildError({
                    code: "BUILD_READ_INTERRUPTED",
                    message: signal?.aborted ? "Build 请求已取消" : "Build 浏览器 RPC 读取中断",
                    phase,
                    source: "transport",
                    status: signal?.aborted ? 499 : error.status || 502,
                });
            throw error;
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
        const deadline = Date.now() + timeoutMs;
        try {
            await this.recover();
        } catch (error) {
            error.phase = "recover";
            throw error;
        }
        this.cleanupPending = false;
        this.cleanupError = null;
        const op = randomUUID(),
            entry = { account: this.accountKey, app: null, complete: false, task: null };
        this.active.set(op, entry);
        let primaryError, lastUsage, completedResult;
        const rpc = (method, body, ht = "", proofText) => {
            if (Date.now() >= deadline)
                throw buildError({
                    code: "BUILD_DEADLINE_EXCEEDED",
                    message: "Build 已达整体等待期限；未重新生成",
                    phase: method === "StreamCodeAssistantOfflineGeneration" ? "poll" : "create",
                    source: "local",
                    status: 504,
                });
            return this.rpc(method, body, {
                ht,
                phase: method === "CreateApplet" ? "create" : method === "CodeAssistantOffline" ? "submit" : "poll",
                proofText,
                signal,
                timeoutMs: Math.max(1, deadline - Date.now()),
            });
        };
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
                if (signal?.aborted)
                    throw buildError({ message: "Build 请求已取消", phase: "poll", source: "local", status: 499 });
                let raw;
                try {
                    raw = await rpc("StreamCodeAssistantOfflineGeneration", [entry.task, null, null, entry.app]);
                } catch (e) {
                    // Resume only reads of an already known task, never submission. Bounded by deadline.
                    if (
                        signal?.aborted ||
                        e.taskTerminal ||
                        ![502, 504].includes(e.status) ||
                        !["local", "transport", "google_http"].includes(e.source)
                    )
                        throw e;
                    await new Promise(resolve =>
                        setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now())))
                    );
                    continue;
                }
                let result;
                try {
                    result = decode(raw, entry.task, { httpStatus: 200 });
                } catch (e) {
                    if (e.taskTerminal) {
                        // Failed tasks are terminal too. Do not cancel an already ended generation.
                        entry.complete = true;
                        this.save(op, entry);
                    }
                    if (e.code !== "BUILD_READ_INTERRUPTED") throw e;
                    await new Promise(resolve =>
                        setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now())))
                    );
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
                    return (completedResult = { ...result, usage: lastUsage });
                }
                await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
            }
            throw buildError({
                code: "BUILD_DEADLINE_EXCEEDED",
                message: "Build 任务未完成（已达等待期限）；未重新生成",
                phase: "poll",
                source: "local",
                status: 504,
            });
        } catch (caught) {
            const e =
                caught instanceof SyntaxError
                    ? buildError({
                          message: "Build RPC 响应不可解码；未重新生成",
                          phase: entry.app ? "submit" : "create",
                          source: "local",
                          status: 502,
                      })
                    : caught;
            e.phase ||= "poll";
            primaryError = e;
            if (e.usage) onUsage?.(e.usage);
            if (lastUsage && !e.usage) e.usage = lastUsage;
            throw e;
        } finally {
            try {
                await this.cleanup(op, entry);
            } catch (error) {
                this.cleanupError = errorInfo(error);
                if (completedResult) completedResult.cleanupError = this.cleanupError;
                if (primaryError) (primaryError.secondaryErrors ||= []).push(error);
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
