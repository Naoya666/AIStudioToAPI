const { randomUUID } = require("node:crypto");
const { pageEval } = require("../MakerSuiteBridge");
const { withHardTimeout } = require("../../utils/TimeoutUtils");
const { buildError, fromResponse, redactResources } = require("./BuildError");
const { encode, decode } = require("./BuildCodec");
const fail = (message, status = 503) => buildError({ message, source: "local", status });
// Each operation owns its resource identifiers only until its single best-effort cleanup finishes.
class BuildRuntime {
    constructor({ page, rpcTransport, accountKey, accountIndex, timeoutMs = 300000, logger, assertCurrent }) {
        Object.assign(this, { accountIndex, accountKey, assertCurrent, logger, page, rpcTransport, timeoutMs });
        this.active = new Set();
        this.readyProjects = 0;
    }
    diagnostic(op, entry, method, outcome, startedAt, code) {
        // No upstream messages, resource IDs, request content or credentials enter cleanup logs.
        try {
            this.logger?.warn?.(
                `[BuildCleanup] backend=${this.rpcTransport?.backend || "browser"} operation=${op} request=${entry.requestId || "none"} account=${this.accountIndex ?? "unknown"} method=${method} outcome=${outcome} duration_ms=${Date.now() - startedAt} code=${code}`
            );
        } catch {
            /* Logging must never affect generation or cleanup. */
        }
    }
    async rpc(
        method,
        body,
        {
            signal,
            ht = "",
            proofText,
            timeoutMs = this.timeoutMs,
            phase = "cleanup",
            bestEffort = false,
            expectedBridgeId = this.bridgeId,
        } = {}
    ) {
        if (signal?.aborted) throw buildError({ message: "Build 请求已取消", phase, source: "local", status: 499 });
        const id = randomUUID();
        let rejectAborted;
        const aborted = new Promise((_, reject) => {
            rejectAborted = reject;
        });
        aborted.catch(() => {});
        let cancelled = false;
        const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            rejectAborted(buildError({ message: "Build RPC cancelled", phase, source: "local", status: 499 }));
            if (this.rpcTransport) void this.rpcTransport.cancel(id);
            else
                void this.page
                    .evaluate(pageEval, `window.__makerSuiteBridge.cancel(${JSON.stringify(id)})`)
                    .catch(() => {});
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
            const args = {
                bestEffort,
                body,
                expectedBridgeId,
                expiresAt: Date.now() + timeoutMs,
                ht,
                id,
                proofText,
                readyTimeoutMs: 10000,
                rpcMethod: method,
                timeoutMs,
            };
            const result = await withHardTimeout(
                () =>
                    Promise.race([
                        this.rpcTransport
                            ? this.rpcTransport.run(args)
                            : this.page.evaluate(
                                  pageEval,
                                  `window.__makerSuiteBridge.run(${JSON.stringify(args)}).then(result => ({...result, bridgeId: window.__makerSuiteBridge.instanceId}))`
                              ),
                        aborted,
                    ]),
                timeoutMs,
                { operation: "Build RPC", status: 504, unref: bestEffort }
            );
            if (!bestEffort) this.bridgeId = result.bridgeId;
            if (result.cleanupSkipped)
                throw Object.assign(fail("Build cleanup capacity unavailable"), { cleanupSkipped: true });
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
            if (error.backend === "local") {
                const normalized = buildError({
                    httpStatus: error.authState === "session_expired" ? 401 : null,
                    message: error.message,
                    phase,
                    source: error.authState === "session_expired" ? "google_http" : "local",
                    status: error.status || 503,
                });
                normalized.backend = "local";
                normalized.kind = error.kind;
                normalized.retryable = false;
                normalized.cooldown = false;
                throw normalized;
            }
            if (!error.source)
                throw buildError({
                    code: "BUILD_READ_INTERRUPTED",
                    message: signal?.aborted ? "Build 请求已取消" : "Build RPC 读取中断",
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
    async cleanup(op, entry, { assertCurrent = this.assertCurrent, bridgeId = this.bridgeId } = {}) {
        if (entry.cleanupStarted) return;
        entry.cleanupStarted = true;
        const usable = method => {
            try {
                if (
                    entry.authInvalid ||
                    entry.account !== this.accountKey ||
                    this.rpcTransport?.closed ||
                    this.page?.isClosed?.()
                )
                    throw fail("identity changed");
                assertCurrent?.();
                return true;
            } catch {
                this.diagnostic(op, entry, method, "skipped", Date.now(), "session_unavailable");
                return false;
            }
        };
        let authInvalid = false;
        const run = async (method, body) => {
            if (!usable(method)) return;
            const startedAt = Date.now();
            const controller = new AbortController();
            // Each step owns a new full budget, even when the preceding call never settles.
            try {
                await withHardTimeout(
                    () =>
                        this.rpc(method, body, {
                            bestEffort: true,
                            expectedBridgeId: bridgeId,
                            phase: "cleanup",
                            signal: controller.signal,
                            timeoutMs: 10000,
                        }),
                    10000,
                    { operation: "Build cleanup", status: 504, unref: true }
                );
                this.diagnostic(op, entry, method, "attempted", startedAt, "response_received");
            } catch (error) {
                authInvalid ||= error?.status === 401 && ["google_http", "google_rpc"].includes(error?.source);
                const code = Number.isInteger(error?.upstreamError?.rpcCode)
                    ? `rpc_${error.upstreamError.rpcCode}`
                    : Number.isInteger(error?.status)
                      ? `status_${error.status}`
                      : "rpc_failed";
                this.diagnostic(op, entry, method, error?.cleanupSkipped ? "skipped" : "failed", startedAt, code);
            } finally {
                controller.abort();
            }
        };
        if (!entry.app) return;
        if (entry.task && !entry.complete) await run("CancelCodeAssistantOfflineGeneration", [entry.task, entry.app]);
        if (!authInvalid) await run("DeleteApplet", [entry.app]);
        else this.diagnostic(op, entry, "DeleteApplet", "skipped", Date.now(), "authentication_invalid");
    }
    async generate(
        identity,
        context,
        { signal, onText, onUsage, onCleanup, timeoutMs = this.timeoutMs, requestId = null } = {}
    ) {
        const deadline = Date.now() + timeoutMs;
        const op = randomUUID(),
            entry = {
                account: this.accountKey,
                app: null,
                complete: false,
                operationMarker: `gateway-operation:${op}`,
                requestId,
                task: null,
            };
        this.active.add(op);
        let lastUsage;
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
            this.readyProjects++;
            const { body, ht } = encode(identity, context, entry.app);
            const createdTask = JSON.parse(await rpc("CodeAssistantOffline", body, ht, context.prompt));
            if (typeof createdTask?.[0] !== "string" || !createdTask[0] || createdTask[0].length > 200)
                throw fail("Build 未返回任务 ID；不会再次生成", 502);
            entry.task = createdTask[0];
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
                    }
                    if (e.code !== "BUILD_READ_INTERRUPTED") throw e;
                    await new Promise(resolve =>
                        setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now())) + 1)
                    );
                    continue;
                }
                entry.complete ||= result.complete;
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
                    if (!result.text) throw fail("Build 已完成但没有可返回内容", 502);
                    return { ...result, usage: lastUsage };
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
            entry.authInvalid = e.status === 401 && ["google_http", "google_rpc"].includes(e.source);
            e.phase ||= "poll";
            if (e.usage) onUsage?.(e.usage);
            if (lastUsage && !e.usage) e.usage = lastUsage;
            throw e;
        } finally {
            this.active.delete(op);
            this.readyProjects = Math.max(0, this.readyProjects - 1);
            const cleanupSession = { assertCurrent: this.assertCurrent, bridgeId: this.bridgeId };
            const startCleanup = () => {
                // Catch even unexpected failures and do not keep the process alive for cleanup.
                const immediate = setImmediate(() => {
                    void this.cleanup(op, entry, cleanupSession).catch(() =>
                        this.diagnostic(op, entry, "cleanup", "failed", Date.now(), "unexpected")
                    );
                });
                immediate.unref?.();
            };
            if (onCleanup) onCleanup(startCleanup);
            else startCleanup();
        }
    }
}
module.exports = { BuildRuntime };
