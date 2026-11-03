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
        if (this.active.has(op)) throw fail("Build operation still has foreground ownership");
        if (entry.account !== this.accountKey) throw fail("Build recovery account mismatch", 401);
        if (this.store.executing.has(op)) throw fail("Build cleanup already owned");
        if (
            entry.app &&
            Object.entries(this.read()).some(
                ([id, other]) =>
                    id !== op &&
                    other.account === entry.account &&
                    other.app === entry.app &&
                    (this.active.has(id) || this.store.executing.has(id))
            )
        )
            throw fail("Build project is used by another operation");
        this.store.executing.add(op);
        const previous = this.store.accountTails.get(entry.account);
        let release;
        const tail = new Promise(resolve => {
            release = resolve;
        });
        this.store.accountTails.set(entry.account, tail);
        await previous;
        const now = () => this.recoveryManager?.now() ?? Date.now();
        const deadline = this.cleanupDeadline || Date.now() + 35000;
        try {
            if (!entry.app) {
                entry.resourceState = "discovery_pending";
                entry.cleanupStage = "verify_pending";
                this.save(op, entry);
                throw buildError({ message: "资源定位待核查：尚无已验证的资源查询协议", status: 400 });
            }
            const run = async (method, body, read = false) => {
                this.assertCurrent?.();
                entry.attempts ||= {};
                entry.lastErrorsByMethod ||= {};
                entry.attempts[method] = (entry.attempts[method] || 0) + 1;
                entry.lastAttemptAt = now();
                this.save(op, entry);
                const startedAt = now();
                let failure,
                    confirmed = false;
                try {
                    const eventBudget = this.recoveryManager?.eventTimeoutMs || 0;
                    const remaining = deadline - Date.now();
                    // Reserve a full Delete plus durable event checkpoints before spending on Read/Cancel.
                    const available =
                        method === "DeleteApplet"
                            ? remaining - eventBudget
                            : (remaining - 10000 - 2 * eventBudget) / (read ? 2 : 1);
                    const response = await this.rpc(method, body, {
                        timeoutMs: Math.min(
                            10000,
                            this.recoveryManager?.rpcTimeoutMs || 10000,
                            Math.max(1, Math.floor(available))
                        ),
                    });
                    this.assertCurrent?.();
                    if (read) {
                        let result;
                        try {
                            result = decode(response, entry.task, { httpStatus: 200 });
                        } catch (error) {
                            if (!error.taskTerminal) throw error;
                            result = { complete: true };
                        }
                        if (result.complete) {
                            entry.taskState = "terminal";
                            entry.taskTerminalAt = now();
                            entry.complete = true;
                        }
                    } else {
                        let acknowledgement;
                        try {
                            acknowledgement = JSON.parse(response);
                        } catch {
                            throw buildError({ message: "Unparseable cleanup acknowledgement", status: 400 });
                        }
                        if (
                            !Array.isArray(acknowledgement) ||
                            acknowledgement.length > 1 ||
                            acknowledgement.some(value => value !== null)
                        )
                            throw buildError({ message: "Unrecognized cleanup acknowledgement", status: 400 });
                    }
                    confirmed = true;
                    entry.lastErrorsByMethod[method] = null;
                    return { at: now(), method, source: "acknowledgement" };
                } catch (error) {
                    error.cleanupMethod = method;
                    failure = error;
                    entry.lastErrorsByMethod[method] = errorInfo(error);
                    this.assertCurrent?.();
                    // Only method-bound NOT_FOUND in the correct authenticated context is evidence.
                    if (
                        method !== "DeleteApplet" ||
                        error.source !== "google_rpc" ||
                        error.upstreamError?.rpcCode !== 5
                    )
                        throw error;
                    confirmed = true;
                    return { at: now(), method, source: "rpc_not_found" };
                } finally {
                    this.save(op, entry);
                    await this.recoveryManager?.recordEvent(op, entry, {
                        attempt: entry.attempts[method],
                        endedAt: now(),
                        error: failure ? errorInfo(failure) : null,
                        httpStatus: failure ? (failure.upstreamError?.httpStatus ?? null) : 200,
                        method,
                        nextAttemptAt: null,
                        outcome: confirmed ? "confirmed" : "failed",
                        rpcCode: failure?.upstreamError?.rpcCode ?? null,
                        startedAt,
                        status: failure?.status ?? 200,
                    });
                }
            };
            const stopOnIdentityFailure = error => {
                this.assertCurrent?.();
                if (error.status === 401 || this.recoveryManager?.fault) throw error;
            };
            // Deleted projects carry a separate, low-frequency task audit. It consumes no debt slot.
            if (entry.deleteConfirmedAt) {
                if (entry.task && !entry.complete && !entry.cancelConfirmedAt) {
                    try {
                        await run("StreamCodeAssistantOfflineGeneration", [entry.task, null, null, entry.app], true);
                    } catch (error) {
                        stopOnIdentityFailure(error);
                    }
                    entry.auditNextAttemptAt = now() + 1800000;
                    this.save(op, entry);
                }
                return;
            }
            // A previous Delete failure resumes at Delete, rather than spending its budget on Cancel again.
            if (
                entry.task &&
                !entry.complete &&
                !entry.cancelConfirmedAt &&
                (!entry.attempts?.DeleteApplet || entry.stopRequired)
            ) {
                try {
                    await run("StreamCodeAssistantOfflineGeneration", [entry.task, null, null, entry.app], true);
                } catch (error) {
                    stopOnIdentityFailure(error);
                }
                if (!entry.complete) {
                    try {
                        await run("CancelCodeAssistantOfflineGeneration", [entry.task, entry.app]);
                        entry.cancelConfirmedAt = now();
                        entry.taskState = "cancel_confirmed";
                        this.save(op, entry);
                    } catch (error) {
                        stopOnIdentityFailure(error);
                    }
                }
            }
            entry.stopRequired = false;
            entry.cleanupStage = "delete_pending";
            entry.projectState = "delete_pending";
            this.save(op, entry);
            try {
                const evidence = await run("DeleteApplet", [entry.app]);
                this.assertCurrent?.();
                entry.deleteConfirmedAt = now();
                entry.deletionEvidence = evidence;
                entry.projectState = "deleted";
                entry.cleanupStage = "done";
                entry.retryState = "done";
                entry.nextAttemptAt = null;
                entry.lastError = null;
                entry.auditNextAttemptAt = now() + 1800000;
                this.save(op, entry);
                if (!this.recoveryManager) this.store.archive(op, entry);
            } catch (error) {
                // Revisit cancellation only when an explicit structured upstream reason requires it.
                const details = error.upstreamError?.details;
                entry.stopRequired = (Array.isArray(details) ? details : [details]).some(
                    detail => detail?.reason === "GENERATION_RUNNING"
                );
                this.save(op, entry);
                throw error;
            }
        } finally {
            this.store.executing.delete(op);
            release();
            if (this.store.accountTails.get(entry.account) === tail) this.store.accountTails.delete(entry.account);
        }
    }
    async recover() {
        for (const [op, entry] of Object.entries(this.read()))
            if (entry.account === this.accountKey && !this.active.has(op) && !entry.deleteConfirmedAt)
                await this.cleanup(op, entry);
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
                creationIntentAt: Date.now(),
                deleteConfirmedAt: null,
                generationState: "active",
                lastError: null,
                nextAttemptAt: null,
                operationId: op,
                operationMarker: `gateway-operation:${op}`,
                ownership: process.pid,
                projectState: "delete_pending",
                requestId,
                resourceState: "discovery_pending",
                retryState: "scheduled",
                revision: 0,
                schemaVersion: 3,
                task: null,
                taskState: "unknown",
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
                    ["Gateway text conversation", entry.operationMarker, null, null, "default"],
                    null,
                    null,
                    1,
                ])
            );
            if (typeof created?.[0] !== "string" || !/^[a-f0-9-]{36}$/i.test(created[0]))
                throw fail("Build CreateApplet 响应无效", 502);
            entry.app = created[0];
            entry.resourceState = "known";
            entry.cleanupStage = "delete_pending";
            this.save(op, entry);
            this.readyProjects++;
            const { body, ht } = encode(identity, context, entry.app);
            entry.submissionIntentAt = Date.now();
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
                        entry.taskState = "terminal";
                        entry.taskTerminalAt = Date.now();
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
                    entry.taskState = "terminal";
                    entry.taskTerminalAt = Date.now();
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
                // The durable journal is the handoff. Release foreground ownership only after this write.
                this.active.delete(op);
                if (this.recoveryManager) {
                    this.cleanupPending = true;
                } else await this.cleanup(op, entry);
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
