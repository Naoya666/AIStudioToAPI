const { randomUUID } = require("node:crypto");
const path = require("node:path");
const Identity = require("./ModelIdentity");
const { parseSillyTavern, sillyTavernMessages } = require("./SillyTavern");
const { makeAttachmentContext } = require("./AttachmentContext");
const Tools = require("./ToolContract");
const AntiTransport = require("./AntiTransport");
const { buildError, errorInfo, serializeError } = require("./BuildError");
const { BuildRuntime } = require("./BuildRuntime");
const { PresetStore } = require("./Presets");
const fail = (message, status = 400) => Object.assign(new Error(message), { kind: "capability", status });
function presetStore(system) {
    return (system.buildPresets ||= new PresetStore(path.join(process.cwd(), "data", "build-presets.json")));
}
function prepare(body, config, system) {
    const identity = Identity.parse(body.model);
    const antiPolicy = require("../AntiTruncation").resolve(body, config);
    if (!config.buildEnabled) throw fail("Build 通道未开启", 403);
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 10000)
        throw fail("messages 必须为非空数组，最多 10000 条");
    if (Buffer.byteLength(JSON.stringify(body)) > 10 * 1024 * 1024) throw fail("Build 请求超过 10 MiB 安全限制", 413);
    if (body.n !== undefined && body.n !== 1) throw fail("Build 当前仅支持 n=1");
    for (const key of ["response_format", "audio", "modalities"])
        if (body[key] !== undefined) throw fail(`Build 尚未支持 ${key}`);
    let split = identity.contextMode === "sillytavern" ? parseSillyTavern(body.messages) : null;
    const messages = (split ? sillyTavernMessages(split) : body.messages).map(message =>
        config.buildToolCallingMode !== "strict" &&
        ["tool", "function"].includes(message?.role) &&
        message.content !== null &&
        typeof message.content === "object" &&
        !Array.isArray(message.content)
            ? { ...message, content: JSON.stringify(message.content) }
            : message
    );
    // Reject unsupported content rather than dropping images, names or metadata.
    for (const m of messages) {
        if (!m || !["system", "developer", "user", "assistant", "tool", "function"].includes(m.role))
            throw fail("Build 消息角色无效");
        if (
            config.buildToolCallingMode === "strict" &&
            m.name !== undefined &&
            (typeof m.name !== "string" || m.name.length > 128)
        )
            throw fail("Build 消息名称超过安全限制");
        if (!(
            typeof m.content === "string" ||
            m.content === null ||
            (Array.isArray(m.content) && m.content.every(p => p?.type === "text" && typeof p.text === "string"))
        ))
            throw fail("Build 当前只支持文本与工具历史");
    }
    const contract = Tools.prepareTools(
        { ...body, messages },
        { mode: config.buildToolCallingMode || "auto_fallback" }
    );
    const anti = antiPolicy.enabled
        ? AntiTransport.prepare(contract, { mode: config.buildToolCallingMode || "auto_fallback" })
        : null;
    if (!split && config.buildPresetMatching) split = presetStore(system).apply(messages);
    const context = makeAttachmentContext({
        messages,
        ...(split ? { sillytavern: split } : {}),
        ...(anti
            ? { toolProtocol: anti.instructions }
            : contract
              ? { toolProtocol: Tools.toolInstructions(contract) }
              : {}),
        requestedMaxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
    });
    if (anti) context.prompt += "\n\n" + anti.directInstructions;
    // A conservative local safety budget, not a Google RPC context limit.
    if (Buffer.byteLength(context.prompt) > 180000)
        throw fail("Build 直接输入超过 180000 字节保守预算；未移动或截断预设", 413);
    return { anti, context, contract, identity, presetHits: split?.hits || 0 };
}
async function process(handler, req, res) {
    const requestId = randomUUID(),
        config = handler.config,
        system = handler.serverSystem;
    const scheduler = system.scheduler;
    const controller = handler.controller || new AbortController();
    const close = () => {
        if (!res.writableFinished) controller.abort();
    };
    res.once("close", close);
    let lease,
        runtime,
        usage,
        startCleanup,
        timer,
        success = false;
    const stream = req.body.stream === true,
        model = req.body.model;
    handler._setResponseApiFormat(res, "openai");
    res.setHeader("X-Request-ID", requestId);
    handler._startTrackedRequest(requestId, req, {
        apiFormat: "openai",
        isStreaming: stream,
        model,
        requestCategory: "generation",
        streamMode: stream ? "buffered-build" : null,
    });
    const packet = data => {
        if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const envelope = {
        created: Math.floor(Date.now() / 1000),
        id: "chatcmpl-" + requestId,
        model,
        object: "chat.completion.chunk",
    };
    try {
        const prepared = prepare(req.body, config, system);
        const buffered = Boolean(prepared.contract || prepared.anti);
        if (prepared.anti) res.setHeader("X-Build-Anti-Truncation", "synthetic-answer-v1");
        if (!scheduler) throw fail("Build 需要现有多账号调度器；不支持 legacy 调度", 503);
        scheduler.assertModelAccessible(prepared.identity.canonical);
        await handler.browserManager.engine?.ensure();
        if (stream) {
            res.status(200).set({
                "Cache-Control": "no-cache",
                "Content-Type": "text/event-stream",
                "X-Accel-Buffering": "no",
                "X-Build-Streaming": prepared.anti
                    ? "buffered-anti-validation"
                    : prepared.contract
                      ? prepared.contract.mode === "strict"
                          ? "buffered-tool-validation"
                          : "buffered-tool-fallback"
                      : "cumulative-task-snapshots",
            });
            res.flushHeaders?.();
            res.write(": accepted\n\n");
            timer = setInterval(() => {
                if (!res.destroyed) res.write(": keep-alive\n\n");
            }, 10000);
            timer.unref?.();
        }
        lease = await scheduler.acquire(prepared.identity.canonical, new Set(), controller.signal);
        handler.lease = lease;
        const account = lease.account;
        handler.authSwitcher.currentAuthIndex = account.index;
        handler._updateTrackedRequest(requestId, {
            initialAccountName: handler._getAccountNameForIndex(account.index),
            initialAuthIndex: account.index,
        });
        const data = handler.browserManager.contexts.get(account.index);
        const page = data?.page;
        const transport = handler.browserManager.getTransport?.(account.index) || page?.playgroundTransport;
        if (!transport?.ready) throw fail("账号调用后端尚未就绪，Build 未发送", 503);
        handler.browserManager.notifyUserActivity(account.index);
        runtime =
            data.codeAssistantRuntime ||
            page?.codeAssistantRuntime ||
            new BuildRuntime({
                accountIndex: account.index,
                accountKey: account.key,
                logger: system.logger,
                page,
                rpcTransport: transport.backend === "local" ? transport : null,
                timeoutMs: config.makerSuiteTimeoutMs,
            });
        {
            const version = page?.accountSessionVersion ?? data.sessionVersion;
            const accountKey = account.key;
            const epoch = transport.epoch;
            const authSource = handler.authSource || system.authSource;
            const login = authSource?.accountLoginService;
            runtime.assertCurrent = () => {
                const activeTransport =
                    handler.browserManager.getTransport?.(account.index) || data.page?.playgroundTransport;
                if (
                    scheduler.account(account.index).key !== accountKey ||
                    authSource?.isExpired?.(account.index) ||
                    (login?.state &&
                        (login.invalidated.has(account.index) ||
                            !login.state.accounts.some(
                                a => a.authIndex === account.index && a.sessionVersion === version
                            ))) ||
                    handler.browserManager.isContextReady?.(account.index) === false ||
                    handler.browserManager.contexts.get(account.index) !== data ||
                    page?.isClosed?.() ||
                    (page?.accountSessionVersion ?? data.sessionVersion) !== version ||
                    activeTransport !== transport ||
                    transport.epoch !== epoch ||
                    transport.closed ||
                    !transport.ready
                )
                    throw buildError({ message: "Build cleanup context changed", source: "local", status: 503 });
            };
        }
        lease.abort = () => controller.abort();
        scheduler.startAttempt(lease);
        handler
            ._getUsageStatsService()
            ?.recordAttempt(requestId, account.index, handler._getAccountNameForIndex(account.index));
        if (stream)
            packet({
                ...envelope,
                choices: [{ delta: { role: "assistant" }, finish_reason: null, index: 0 }],
            });
        scheduler.recordTokenUsage?.(lease, null, requestId);
        const tier =
            require("../../accounts/AccountTierPolicy").resolveTier(
                require("../../accounts/AccountTierPolicy").accountForIndex(handler.authSource, account.index)
            ).effectiveTier || "unknown";
        handler._getUsageStatsService()?.recordTokenUsage?.(requestId, requestId, null, {
            accountKey: account.key,
            day: require("../../public/DashboardProtocol").usageDate(Date.now()),
            model: prepared.identity.canonical,
            tier,
        });
        const result = await runtime.generate(prepared.identity, prepared.context, {
            onCleanup: start => {
                startCleanup = start;
            },
            onText:
                stream && !buffered
                    ? text =>
                          packet({
                              ...envelope,
                              choices: [{ delta: { content: text }, finish_reason: null, index: 0 }],
                          })
                    : null,
            onUsage: observedUsage => {
                usage = observedUsage;
                scheduler.recordTokenUsage(lease, observedUsage, requestId);
                handler._getUsageStatsService()?.recordTokenUsage?.(requestId, requestId, observedUsage);
            },
            requestId,
            signal: controller.signal,
            timeoutMs: config.makerSuiteTimeoutMs,
        });
        usage = result.usage;
        if (controller.signal.aborted) throw fail("客户端已断开", 499);
        const restored = prepared.anti
            ? AntiTransport.restore(result.text, prepared.anti)
            : {
                  message: Tools.parseToolReply(result.text, prepared.contract),
                  repaired: false,
              };
        const message = restored.message;
        const finish = restored.repaired
            ? "length"
            : message.tool_calls?.length
              ? "tool_calls"
              : message.function_call
                ? "function_call"
                : "stop";
        if (stream) {
            if (buffered) {
                const { role, ...delta } = message;
                if (delta.tool_calls)
                    delta.tool_calls = delta.tool_calls.map((c, index) => ({
                        ...c,
                        index,
                    }));
                packet({
                    ...envelope,
                    choices: [{ delta, finish_reason: null, index: 0 }],
                });
            }
            packet({
                ...envelope,
                choices: [{ delta: {}, finish_reason: finish, index: 0 }],
            });
            if (req.body.stream_options?.include_usage) packet({ ...envelope, choices: [], usage: usage ?? null });
            res.end("data: [DONE]\n\n");
        } else
            res.json({
                ...envelope,
                choices: [{ finish_reason: finish, index: 0, message }],
                object: "chat.completion",
                usage: usage ?? null,
            });
        success = true;
    } catch (caught) {
        const error = controller.signal.aborted
            ? buildError({
                  code: "BUILD_ABORTED",
                  message: "客户端已断开",
                  phase: caught.phase || "poll",
                  source: "local",
                  status: 499,
                  usage: caught.usage || usage,
              })
            : caught;
        if (error !== caught && caught.secondaryErrors) error.secondaryErrors = caught.secondaryErrors;
        usage ||= error.usage;
        error.usage ||= usage;
        const info = errorInfo(error);
        handler._markTrackedResponseError(
            res,
            info.message,
            info.status,
            controller.signal.aborted ? "aborted" : "error"
        );
        res.__usageTrackingError = info;
        if (lease && !controller.signal.aborted) {
            try {
                await scheduler.failure(lease, error);
            } catch {
                system.logger?.warn?.("Build scheduler failure accounting failed");
            }
        }
        const payload = serializeError(error, requestId);
        if (!res.destroyed && !controller.signal.aborted) {
            if (res.headersSent) {
                packet(payload);
                res.end();
            } else res.status(error.status || 502).json(payload);
        }
    } finally {
        clearInterval(timer);
        res.removeListener("close", close);
        if (lease) {
            scheduler.release(lease, success);
            handler.lease = null;
        }
        handler._finalizeTrackedRequest(requestId, res, {
            error: res.__usageTrackingError || null,
            errorMessage: res.__usageTrackingError?.message,
            finalAuthIndex: lease?.account.index,
            outcome: success ? "success" : controller.signal.aborted ? "aborted" : "error",
            responseHttpStatus: res.headersSent || res.writableFinished ? res.statusCode : null,
            statusCode: res.__usageTrackingError?.status,
            usage,
        });
        system.logger?.info?.(
            `[Backend] backend=${config.callBackend || "browser"} channel=build account=${lease?.account.index ?? "none"} event=result outcome=${success ? "success" : controller.signal.aborted ? "aborted" : "error"} status=${res.__usageTrackingError?.status || res.statusCode || 0}`
        );
        startCleanup?.();
    }
}
module.exports = { prepare, presetStore, process };
