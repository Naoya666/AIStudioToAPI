const { benefitError, isArgon } = require("./BuildBenefitContext");
const RequestHandler = require("./RequestHandler");
const { fileKeys, rememberUploadHeaders } = require("./FileAffinity");
const { classifyError } = require("./ModelScheduler");

// One handler per incoming request keeps the existing protocol/stream implementation
// while removing global account and retry state from the data path.
class ScheduledRequestHandler extends RequestHandler {
    constructor(parent, req, res) {
        super(
            parent.serverSystem,
            parent.connectionRegistry,
            parent.logger,
            parent.browserManager,
            { ...parent.config, scheduler: { ...parent.config.scheduler } },
            parent.authSource
        );
        this.scheduled = true;
        this.scheduler = parent.serverSystem.scheduler;
        this.acceptedSchedulerConfig = { ...this.scheduler.config };
        this.excluded = new Set();
        this.controller = new AbortController();
        this.response = res;
        this.incomingRequest = req;
        this._acceptedAt = Date.now();
        res.__modelOutputStarted = false;
        res.__keepaliveSent = false;
        if (typeof res.write === "function") {
            const write = res.write.bind(res);
            res.write = (chunk, ...args) => {
                const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk ?? "");
                if (res.__writingStreamStart || res.__writingEarlyKeepalive) return write(chunk, ...args);
                if (!/^:\s*(?:accepted|keep-alive)\s*\n\n$/.test(text) && text !== "event: ping\ndata: {}\n\n") {
                    if (
                        res.__streamStartSent &&
                        !text.split("\n").some(line => {
                            if (!line.startsWith("data: {")) return false;
                            try {
                                return JSON.parse(line.slice(6)).choices?.some(choice => {
                                    const delta = choice.delta || {};
                                    return Boolean(
                                        delta.content || delta.reasoning_content || delta.tool_calls?.length
                                    );
                                });
                            } catch {
                                return false;
                            }
                        })
                    )
                        return write(chunk, ...args);
                    if (!res.__modelOutputStarted)
                        this.scheduler.observe("model_first_output_ms", Date.now() - this._acceptedAt);
                    res.__modelOutputStarted = true;
                    res.__modelFirstOutputAt ||= Date.now();
                    this._stopEarlyStreamKeepalive();
                    res.__stopEarlyOpenAIStream?.();
                } else if (text.includes("keep-alive") || text.startsWith("event: ping")) {
                    res.__keepaliveSent = true;
                }
                return write(chunk, ...args);
            };
        }
        this.onClose = () => {
            this._stopEarlyStreamKeepalive();
            res.__stopEarlyOpenAIStream?.();
            if (!res.writableFinished) this.controller.abort();
        };
        res.on("close", this.onClose);
        const registry = this.connectionRegistry;
        this.connectionRegistry = new Proxy(registry, {
            get: (target, property) => {
                if (property === "createMessageQueue")
                    return (...args) => {
                        const queue = target.createMessageQueue(...args);
                        let activeQueue = queue;
                        let dequeue = activeQueue.dequeue.bind(activeQueue);
                        let fileBody = "";
                        queue.dequeue = async (...params) => {
                            let message;
                            // A queue may move to another ready context before model output starts.
                            // Keep the wrapper stable so RequestHandler's streaming loops do not need
                            // to know that the underlying attempt changed.
                            // eslint-disable-next-line no-constant-condition
                            while (true) {
                                try {
                                    message = await dequeue(...params);
                                    if (
                                        message.event_type === "error" &&
                                        classifyError(message) === "transport" &&
                                        !(this.response.__modelOutputStarted || this.response.__upstreamOutputStarted)
                                    ) {
                                        activeQueue = await this._retryTransportQueue(message, target);
                                        dequeue = activeQueue.dequeue.bind(activeQueue);
                                        continue;
                                    }
                                    break;
                                } catch (error) {
                                    if (
                                        classifyError(error) !== "transport" ||
                                        this.response.__modelOutputStarted ||
                                        this.response.__upstreamOutputStarted
                                    )
                                        throw error;
                                    activeQueue = await this._retryTransportQueue(error, target);
                                    dequeue = activeQueue.dequeue.bind(activeQueue);
                                }
                            }
                            if (this.response.__antiAttempt && message.data) {
                                let hasOutput = false;
                                try {
                                    const raw = JSON.parse(message.data.replace(/^data:\s*/, "").trim());
                                    hasOutput = raw.candidates?.some(candidate =>
                                        candidate.content?.parts?.some(
                                            part => part.functionCall || part.text || part.inlineData
                                        )
                                    );
                                } catch {
                                    hasOutput = Boolean(
                                        message.data.trim() && !message.data.trimStart().startsWith(":")
                                    );
                                }
                                if (hasOutput) {
                                    this.response.__upstreamOutputStarted = true;
                                    this._stopEarlyStreamKeepalive();
                                    this.response.__stopEarlyOpenAIStream?.();
                                }
                            }
                            if (message.event_type === "error") await this.scheduler.failure(this.lease, message);
                            if (message.metrics?.upstream_ttfb_ms != null)
                                this.scheduler.observe("upstream_ttfb_ms", message.metrics.upstream_ttfb_ms);
                            if (this.lease.model === "__files__") {
                                if (message.headers)
                                    rememberUploadHeaders(this.scheduler, message.headers, this.lease.account.key);
                                if (message.data && fileBody.length < 1048576) fileBody += message.data;
                                if (message.type === "STREAM_END") {
                                    try {
                                        for (const key of fileKeys(JSON.parse(fileBody)))
                                            this.scheduler.fileAffinities.set(key, this.lease.account.key);
                                        this.scheduler.saveSoon();
                                    } catch {
                                        /* Non-JSON file operation response. */
                                    }
                                }
                            }
                            return message;
                        };
                        return queue;
                    };
                const value = target[property];
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        this.authSwitcher = {
            currentAuthIndex: -1,
            failureCount: 0,
            handleRequestFailureAndSwitch: async error => this.scheduler.failure(this.lease, error),
            incrementUsageCount: () => 0,
            isSystemBusy: false,
            shouldSwitchByUsage: () => false,
            usageCount: 0,
        };
    }

    async _ensureBrowserBackedRequestReady() {
        return !this.controller.signal.aborted;
    }

    async _acquireScheduledLease(proxyRequest) {
        this.proxyRequest = proxyRequest;
        this.model = this._extractModelFromPath(proxyRequest.path);
        if (!this.model && proxyRequest.body) {
            try {
                this.model = JSON.parse(proxyRequest.body).model?.replace(/^models\//, "");
            } catch {
                /* Non-JSON upload */
            }
        }
        this.model ||= "__files__";
        this.model = this.scheduler.assertModelAccessible(this.model);
        let body;
        try {
            body = JSON.parse(proxyRequest.body || "{}");
        } catch {
            body = {};
        }
        const affinityKeys = fileKeys([proxyRequest.path, proxyRequest.query_params, body]);
        const owners = new Set([...affinityKeys].map(key => this.scheduler.fileAffinities.get(key)).filter(Boolean));
        if (owners.size > 1)
            throw Object.assign(new Error("Files from different accounts cannot be combined"), { status: 400 });
        this.affinity = [...owners][0] || null;
        this._beginEarlyStreamIfNeeded(proxyRequest);
        await this.selectNext();
        this._updateTrackedRequest(proxyRequest.request_id, {
            initialAccountName: this._getAccountNameForIndex(this.currentAuthIndex),
            initialAuthIndex: this.currentAuthIndex,
        });
    }

    async selectNext() {
        while (this.excluded.size <= this.acceptedSchedulerConfig.maxRetries) {
            const excluded = new Set(this.excluded);
            if (this.affinity) {
                for (const index of this.authSource.getRotationIndices()) {
                    const account = this.scheduler.account(index);
                    if (account.key !== this.affinity) excluded.add(account.key);
                }
            }
            this.lease = await this.scheduler.acquire(this.model, excluded, this.controller.signal);
            this.lease.abort = error => {
                this.controller.abort(error);
                if (this.proxyRequest)
                    this._cancelCurrentAttemptBeforeRetry(this.proxyRequest, this.lease?.account.index);
                this._sendErrorResponse(this.response, 503, error.message);
                this._stopEarlyStreamKeepalive();
            };
            this.excluded.add(this.lease.account.key);
            this.authSwitcher.currentAuthIndex = this.lease.account.index;
            try {
                if (
                    this.scheduler.config.readyContextOnly &&
                    this.scheduler.browserManager &&
                    !this.browserManager.isContextReady(this.currentAuthIndex)
                )
                    throw Object.assign(new Error("Selected context is no longer ready"), {
                        reason: "connection_lost",
                    });
                if (this.controller.signal.aborted)
                    throw Object.assign(new Error("Client disconnected"), { reason: "client_disconnect" });
                this.browserManager.notifyUserActivity(this.currentAuthIndex);
                return;
            } catch (error) {
                this.scheduler.failure(this.lease, error);
                this.scheduler.release(this.lease);
                this.lease = null;
                if (this.controller.signal.aborted || this.excluded.size > this.acceptedSchedulerConfig.maxRetries)
                    throw error;
            }
        }
        throw Object.assign(new Error(`Retry budget exhausted for model ${this.model}`), { status: 503 });
    }

    _shouldRetryError(error) {
        if (["MODEL_TIER_DENIED", "MODEL_DISABLED", "UNKNOWN_MODEL"].includes(error.code)) return false;
        if (require("../utils/MakerSuiteAuth").isBridgeAuthFailure(error)) return false;
        if (
            require("./ModelTransportPolicy").resolve(this.model || "", "fake", this.config?.modelTransportPolicy)
                .transport === "makersuite"
        )
            return false;
        if (
            isArgon(this.model) &&
            (error.code === "BUILD_BENEFIT_NOT_READY" ||
                error.code === "QUEUE_TIMEOUT" ||
                Number(error.status) === 504 ||
                (Number(error.status) !== 429 && /RPC.*(?:Code|code)\s*7/.test(String(error.message || ""))) ||
                ["account", "unsupported", "risk_controlled", "transport"].includes(classifyError(error)))
        )
            return false;
        return ["account", "rate_limited", "risk_controlled", "unsupported", "temporary", "transport"].includes(
            classifyError(error)
        );
    }

    async _prepareImmediateStatusRetry(error, requestId, tracker, sourceAuthIndex) {
        if (this.lease?.account.index !== sourceAuthIndex) return false;
        await this.scheduler.failure(this.lease, error);
        if (
            !this._shouldRetryError(error) ||
            this.controller.signal.aborted ||
            this.response.__modelOutputStarted ||
            this.response.__upstreamOutputStarted ||
            this.excluded.size > this.acceptedSchedulerConfig.maxRetries
        )
            return false;
        this.scheduler.release(this.lease);
        this.lease = null;
        try {
            await this.selectNext();
            tracker.attemptedAuthIndices.add(this.currentAuthIndex);
            return true;
        } catch (selectionError) {
            this.logger.info(`[Scheduler] Retry stopped: ${selectionError.message}`);
            throw selectionError;
        }
    }

    _forwardRequest(proxyRequest, authIndex = this.currentAuthIndex) {
        if (this.controller.signal.aborted)
            throw Object.assign(new Error("Client disconnected"), { reason: "client_disconnect" });
        this._assertModelPermission(proxyRequest, authIndex);
        this.scheduler.startAttempt(this.lease);
        return super._forwardRequest(proxyRequest, authIndex);
    }

    async _sendAndReadInitial(proxyRequest, queue, authIndex) {
        try {
            this._forwardRequest(proxyRequest, authIndex);
            return await this._readInitialMessage(queue);
        } catch (error) {
            return {
                ...error,
                event_type: "error",
                message: error.message,
                reason: error.reason,
                status: error.status || 503,
            };
        }
    }

    async _readInitialMessage(queue, timeout = this.timeouts.FAKE_STREAM) {
        try {
            const message = await queue.dequeue(timeout);
            if (message.event_type === "error") await this.scheduler.failure(this.lease, message);
            return message;
        } catch (error) {
            return {
                ...error,
                event_type: "error",
                message: error.message,
                reason: error.reason,
                status:
                    error.reason === "client_disconnect"
                        ? 499
                        : error.code === "QUEUE_TIMEOUT"
                          ? 504
                          : error.status || 503,
            };
        }
    }

    async _executeRequestWithRetries(proxyRequest, messageQueue) {
        let queue = messageQueue;
        const tracker = this._createImmediateSwitchTracker();
        // eslint-disable-next-line no-constant-condition
        while (true) {
            let result;
            this._getUsageStatsService()?.recordAttempt(
                proxyRequest.request_id,
                this.currentAuthIndex,
                this._getAccountNameForIndex(this.currentAuthIndex)
            );
            try {
                this._forwardRequest(proxyRequest);
                result = await this._readInitialMessage(queue);
                if (result.event_type !== "error" && result.event_type !== "timeout")
                    return { message: result, queue, success: true };
                if (result.event_type === "timeout")
                    result = { ...result, message: "Browser request timed out", status: 504 };
            } catch (error) {
                result = { ...error, message: error.message, reason: error.reason, status: error.status || 503 };
            }
            this._cancelCurrentAttemptBeforeRetry(proxyRequest, this.currentAuthIndex);
            if (
                !(await this._prepareImmediateStatusRetry(
                    result,
                    proxyRequest.request_id,
                    tracker,
                    this.currentAuthIndex
                ))
            ) {
                return { error: { ...result, skipAccountSwitch: true }, success: false };
            }
            queue.close("retry_creating_new_queue");
            this._advanceProxyRequestAttempt(proxyRequest);
            queue = this.connectionRegistry.createMessageQueue(
                proxyRequest.request_id,
                this.currentAuthIndex,
                proxyRequest.request_attempt_id
            );
        }
    }

    _markTrackedResponseError(res, message, statusCode, outcome) {
        if (this.lease?.attempted) {
            const error =
                outcome === "local_transport"
                    ? { kind: "transport", message, reason: "connection_lost", status: statusCode }
                    : { message, status: statusCode };
            this.scheduler.failure(this.lease, error);
        }
        return super._markTrackedResponseError(res, message, statusCode, outcome);
    }

    async _retryTransportQueue(error, registry) {
        if (isArgon(this.model) || this.proxyRequest?.transport_policy?.transport === "makersuite")
            throw benefitError("Argon transport interrupted; generation was not replayed");
        if (
            this.controller.signal.aborted ||
            this.response.__modelOutputStarted ||
            this.response.__upstreamOutputStarted ||
            this.excluded.size > this.acceptedSchedulerConfig.maxRetries
        )
            throw error;
        const failedAuthIndex = this.currentAuthIndex;
        this._cancelCurrentAttemptBeforeRetry(this.proxyRequest, failedAuthIndex);
        this.scheduler.failure(this.lease, error);
        this.scheduler.release(this.lease);
        this.lease = null;
        await this.selectNext();
        this._advanceProxyRequestAttempt(this.proxyRequest);
        const queue = registry.createMessageQueue(
            this.proxyRequest.request_id,
            this.currentAuthIndex,
            this.proxyRequest.request_attempt_id
        );
        this._forwardRequest(this.proxyRequest);
        return queue;
    }

    _sendErrorResponse(res, status, message, errorType = null, details = null) {
        if (res.headersSent && this._isResponseWritable(res)) {
            this._sendErrorChunkToClient(res, message, status, errorType, "error", details);
            res.end();
            return;
        }
        return super._sendErrorResponse(res, status, message, errorType, details);
    }

    _beginEarlyStreamIfNeeded(proxyRequest) {
        if (this.response.__proxyResponseStreamMode === "early") {
            this._startEarlyOpenAIStream(this.response, this.model);
            return;
        }
        const requestedStream =
            this.incomingRequest?.body?.stream === true ||
            String(this.incomingRequest?.path || proxyRequest.path).includes("streamGenerateContent");
        if (!requestedStream || !this.acceptedSchedulerConfig.streamEarlyHeaders || this.response.headersSent) return;
        this.response.status(200).set({
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
            "X-Accel-Buffering": "no",
        });
        this.response.flushHeaders?.();
        this.response.write(": accepted\n\n");
        this.scheduler.observe("http_headers_ms", Date.now() - this._acceptedAt);
        const sendKeepalive = () => {
            if (
                this.controller.signal.aborted ||
                this.response.writableEnded ||
                this.response.__modelOutputStarted ||
                this.response.__upstreamOutputStarted
            ) {
                this._stopEarlyStreamKeepalive();
                return;
            }
            this.response.write(": keep-alive\n\n");
        };
        this._earlyStreamKeepalive = setInterval(sendKeepalive, this.acceptedSchedulerConfig.streamKeepaliveIntervalMs);
        this._earlyStreamKeepalive.unref?.();
    }

    _stopEarlyStreamKeepalive() {
        if (!this._earlyStreamKeepalive) return;
        clearInterval(this._earlyStreamKeepalive);
        this._earlyStreamKeepalive = null;
    }

    async finish() {
        if (this.response.__streamStartSent)
            this.scheduler.observe("request_complete_ms", Date.now() - this._acceptedAt);
        this._stopEarlyStreamKeepalive();
        this.response.__stopEarlyOpenAIStream?.();
        this.response.removeListener("close", this.onClose);
        const success =
            !this.controller.signal.aborted && !this.response.__usageTrackingOutcome && this.response.statusCode < 400;
        await this.browserManager.contexts?.get(this.currentAuthIndex)?.page?.makerSuiteBridge?.settle?.();
        this.scheduler.release(this.lease, success);
    }
}

async function dispatch(parent, method, req, res) {
    const handler = new ScheduledRequestHandler(parent, req, res);
    try {
        await handler[method](req, res);
    } catch (error) {
        if (!handler.controller.signal.aborted) {
            if (res.headersSent) handler._handleRequestError(error, res);
            else handler._sendErrorResponse(res, error.status || 503, error.message, null, error);
        }
    } finally {
        await handler.finish();
    }
}
module.exports = { dispatch, ScheduledRequestHandler };
