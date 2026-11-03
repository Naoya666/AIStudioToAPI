const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { pageEval } = require("../MakerSuiteBridge");
const { withHardTimeout } = require("../../utils/TimeoutUtils");
const { BuildRecoveryStore } = require("./BuildRecoveryStore");
const { buildError, errorInfo, fromResponse, redactResources } = require("./BuildError");
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
        recoveryManager,
    }) {
        Object.assign(this, { accountKey, page, statePath, timeoutMs });
        this.store = BuildRecoveryStore.open(statePath);
        this.recoveryManager = recoveryManager;
        this.active = this.store.active;
        this.readyProjects = 0;
    }
    read() {
        return this.store.read();
    }
    save(op, value) {
        try {
            this.store.save(op, value);
        } catch (error) {
            this.recoveryManager?.storageFailed(error);
            throw error;
        }
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
            if (
                [
                    "CancelCodeAssistantOfflineGeneration",
                    "DeleteApplet",
                    "StreamCodeAssistantOfflineGeneration",
                ].includes(method)
            )
                redactResources(
                    error,
                    body.filter(value => typeof value === "string")
                );
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
        if (this.store.executing.has(op)) throw fail("Build cleanup already owned");
        this.store.executing.add(op);
        const previous = this.store.accountTails.get(entry.account);
        let release;
        const tail = new Promise(resolve => {
            release = resolve;
        });
        this.store.accountTails.set(entry.account, tail);
        await previous;
        try {
            if (entry.cleanupStage === "verify_pending" || (!entry.app && entry.generationState === "unknown"))
                throw buildError({
                    message: "Uncertain upstream submission; manual verification required",
                    status: 400,
                });
            const run = async (method, body) => {
                this.assertCurrent?.();
                entry.cleanupStage = method === "DeleteApplet" ? "delete_pending" : "cancel_pending";
                entry.attempts ||= {};
                entry.attempts[method] = (entry.attempts[method] || 0) + 1;
                this.save(op, entry);
                const startedAt = Date.now();
                let failure,
                    confirmed = false;
                try {
                    const response = await this.rpc(method, body, {
                        timeoutMs: this.recoveryManager?.rpcTimeoutMs || 10000,
                    });
                    let acknowledgement;
                    try {
                        acknowledgement = JSON.parse(response);
                    } catch {
                        throw buildError({ message: "Unparseable cleanup acknowledgement", status: 400 });
                    }
                    if (!Array.isArray(acknowledgement) || acknowledgement.some(value => value !== null))
                        throw buildError({ message: "Unrecognized cleanup acknowledgement", status: 400 });
                    this.assertCurrent?.();
                    confirmed = true;
                } catch (error) {
                    error.cleanupMethod = method;
                    failure = error;
                    this.assertCurrent?.();
                    // A proxy HTTP 404 is never proof. Only a parsed RPC NOT_FOUND
                    // on the current authenticated context can acknowledge this method.
                    if (!(error.source === "google_rpc" && error.upstreamError?.rpcCode === 5)) throw error;
                    this.assertCurrent?.();
                    confirmed = true;
                } finally {
                    await this.recoveryManager?.recordEvent(op, entry, {
                        attempt: entry.attempts[method],
                        endedAt: Date.now(),
                        error: failure ? errorInfo(failure) : null,
                        httpStatus: failure ? (failure.upstreamError?.httpStatus ?? null) : 200,
                        method,
                        nextAttemptAt: failure && !confirmed ? this.recoveryManager?.retryAt(entry, failure) : null,
                        outcome: confirmed ? "confirmed" : "failed",
                        rpcCode: failure?.upstreamError?.rpcCode ?? null,
                        startedAt,
                        status: failure?.status ?? 200,
                    });
                }
            };
            if (entry.task && !entry.complete && !entry.cancelConfirmedAt) {
                await run("CancelCodeAssistantOfflineGeneration", [entry.task, entry.app]);
                this.assertCurrent?.();
                entry.cancelConfirmedAt = Date.now();
                entry.cleanupStage = "delete_pending";
                this.save(op, entry);
            }
            if (entry.app && !entry.deleteConfirmedAt) {
                await run("DeleteApplet", [entry.app]);
                this.assertCurrent?.();
                entry.deleteConfirmedAt = Date.now();
                this.save(op, entry);
            }
            if (this.recoveryManager) {
                entry.cleanupStage = "done";
                this.save(op, entry);
            } else this.save(op, null);
        } finally {
            this.store.executing.delete(op);
            release();
            if (this.store.accountTails.get(entry.account) === tail) this.store.accountTails.delete(entry.account);
        }
    }
    async recover() {
        for (const [op, entry] of Object.entries(this.read()))
            if (entry.account === this.accountKey && !this.active.has(op)) await this.cleanup(op, entry);
    }
    async generate(identity, context, { signal, onText, onUsage, timeoutMs = this.timeoutMs, requestId = null } = {}) {
        const deadline = Date.now() + timeoutMs;
        try {
            if (!this.recoveryManager) await this.recover();
        } catch (error) {
            error.phase = "recover";
            throw error;
        }
        this.cleanupPending = false;
        this.cleanupError = null;
        const op = randomUUID(),
            entry = {
                account: this.accountKey,
                app: null,
                attempts: {},
                cancelConfirmedAt: null,
                cleanupStage: "verify_pending",
                complete: false,
                consecutiveFailures: 0,
                createdAt: Date.now(),
                deleteConfirmedAt: null,
                generationState: "active",
                lastError: null,
                nextAttemptAt: null,
                operationId: op,
                ownership: process.pid,
                requestId,
                retryState: "scheduled",
                revision: 0,
                schemaVersion: 2,
                task: null,
            };
        this.save(op, entry);
        this.active.add(op);
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
            entry.cleanupStage = "delete_pending";
            this.save(op, entry);
            this.readyProjects++;
            const { body, ht } = encode(identity, context, entry.app);
            entry.cleanupStage = "verify_pending";
            this.save(op, entry);
            const createdTask = JSON.parse(await rpc("CodeAssistantOffline", body, ht, context.prompt));
            if (typeof createdTask?.[0] !== "string" || !createdTask[0] || createdTask[0].length > 200)
                throw fail("Build 未返回任务 ID；不会再次生成", 502);
            entry.task = createdTask[0];
            entry.cleanupStage = "cancel_pending";
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
                        setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now())) + 1)
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
                        entry.generationState = "terminal";
                        this.save(op, entry);
                    }
                    if (e.code !== "BUILD_READ_INTERRUPTED") throw e;
                    await new Promise(resolve =>
                        setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now())) + 1)
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
                    entry.generationState = "terminal";
                    this.save(op, entry);
                    if (!result.text) throw fail("Build 已完成但没有可返回内容", 502);
                    return (completedResult = { ...result, usage: lastUsage });
                }
                await new Promise(resolve =>
                    setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now())) + 1)
                );
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
            entry.generationState = entry.complete ? "terminal" : "interrupted";
            entry.ownership = null;
            try {
                this.save(op, entry);
                this.recoveryManager?.block(entry.account);
                await this.cleanup(op, entry);
            } catch (error) {
                this.cleanupError = errorInfo(error);
                entry.lastError = this.cleanupError;
                entry.failedSessionVersion = this.page.accountSessionVersion ?? null;
                try {
                    this.recoveryManager ? this.recoveryManager.failed(op, entry, error) : this.save(op, entry);
                } catch {
                    this.recoveryManager?.storageFailed();
                }
                if (completedResult) completedResult.cleanupError = this.cleanupError;
                if (primaryError) (primaryError.secondaryErrors ||= []).push(error);
                // Keep the journal. Next request must recover it before creating any task.
                if (primaryError) primaryError.cleanupPending = true;
                this.cleanupPending = true;
            }
            this.readyProjects = Math.max(0, this.readyProjects - 1);
            this.active.delete(op);
            this.recoveryManager?.reconcile();
            this.recoveryManager?.wake();
        }
    }
}
module.exports = { BuildRuntime };
