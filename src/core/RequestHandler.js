const { BRIDGE_SETTLEMENT_MS, DEFAULT_MAKERSUITE_TIMEOUT_MS } = require("../config/TransportConfig");
const { accountForIndex, canUseModel } = require("../accounts/AccountTierPolicy");
const TransportPolicy = require("./ModelTransportPolicy");
const { isArgon, benefitError } = require("./BuildBenefitContext");
/**
 * File: src/core/RequestHandler.js
 * Description: Main request handler that processes API requests, manages retries, and coordinates between authentication and format conversion
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

/**
 * Request Handler Module (Refactored)
 * Main request handler that coordinates between other modules
 */
const AntiTruncation = require("./AntiTruncation");
const { geminiStatus, normalizeError } = require("../utils/UpstreamError");
const { isPromptBlocked } = require("../utils/UpstreamBlock");
const GenerationResponseGuard = require("../utils/GenerationResponseGuard");
const AuthSwitcher = require("../auth/AuthSwitcher");
const FormatConverter = require("./FormatConverter");
const { isUserAbortedError } = require("../utils/CustomErrors");
const { QueueClosedError, QueueTimeoutError } = require("../utils/MessageQueue");

const WS_RECONNECT_WAIT_MS = 130000;
const WS_CONNECTION_READY_TIMEOUT_MS = 10000;

// Default timeout constants (in milliseconds)
const DEFAULT_TIMEOUTS = {
    FAKE_STREAM: 300000,
    STREAM_CHUNK: 60000, // 60 seconds - timeout between stream chunks
};

class RequestHandler {
    constructor(serverSystem, connectionRegistry, logger, browserManager, config, authSource) {
        this.serverSystem = serverSystem;
        this.connectionRegistry = connectionRegistry;
        this.logger = logger;
        this.browserManager = browserManager;
        this.config = config;
        this.requestConfiguration = new (require("async_hooks").AsyncLocalStorage)();
        this.authSource = authSource;

        // Initialize sub-modules
        this.authSwitcher = new AuthSwitcher(logger, config, authSource, browserManager);
        this.formatConverter = new FormatConverter(logger, serverSystem, () => this.config);

        this.needsSwitchingAfterRequest = false;
    }

    get config() {
        return this.requestConfiguration?.getStore() || this._config;
    }
    set config(value) {
        this._config = value;
    }
    get timeouts() {
        return {
            FAKE_STREAM: this.config.fakeStreamTimeoutMs || DEFAULT_TIMEOUTS.FAKE_STREAM,
            STREAM_CHUNK: this.config.streamTimeoutMs || DEFAULT_TIMEOUTS.STREAM_CHUNK,
        };
    }
    withConfigurationSnapshot(next) {
        return this.requestConfiguration.run({ ...this.config, scheduler: { ...this.config.scheduler } }, next);
    }

    // Delegate properties to AuthSwitcher
    get currentAuthIndex() {
        return this.authSwitcher.currentAuthIndex;
    }

    get failureCount() {
        return this.authSwitcher.failureCount;
    }

    get usageCount() {
        return this.authSwitcher.usageCount;
    }

    get isSystemBusy() {
        return this.authSwitcher.isSystemBusy;
    }

    set isSystemBusy(value) {
        this.authSwitcher.isSystemBusy = value === true;
    }

    _getUsageStatsService() {
        return this.serverSystem.usageStatsService || null;
    }

    _getAccountNameForIndex(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) {
            return null;
        }

        return this.authSource?.accountNameMap?.get(authIndex) || null;
    }

    _getClientIp(req) {
        return this.serverSystem.webRoutes.authRoutes.getClientIP(req);
    }

    _extractModelFromPath(pathValue) {
        if (typeof pathValue !== "string") return null;

        const match = pathValue.match(/\/models\/([^:/?]+)(?::|$)/);
        return match?.[1] || null;
    }

    _convertEmbedContentBodyToBatch(bodyObj, modelName) {
        return {
            requests: [
                {
                    ...bodyObj,
                    model: `models/${modelName}`,
                },
            ],
        };
    }

    _convertBatchEmbedResponseToEmbedContent(fullBodyBuffer) {
        const batchResponse = JSON.parse(fullBodyBuffer.toString());
        const embedding = Array.isArray(batchResponse.embeddings) ? batchResponse.embeddings[0] : null;

        if (!embedding) {
            throw new Error("Backend batchEmbedContents response did not contain embeddings[0].");
        }

        return Buffer.from(
            JSON.stringify({
                embedding,
                ...(batchResponse.usageMetadata ? { usageMetadata: batchResponse.usageMetadata } : {}),
            })
        );
    }

    _categorizeRequest(pathValue, fallback = "request") {
        if (typeof pathValue !== "string") return fallback;
        if (
            pathValue.includes("embedContent") ||
            pathValue.includes("batchEmbedContents") ||
            pathValue.includes("embeddings")
        )
            return "embedding";
        if (pathValue.includes("countTokens") || pathValue.includes("input_tokens")) return "count_tokens";
        if (pathValue.includes("generateContent") || pathValue.includes("streamGenerateContent")) return "generation";
        if (pathValue.includes("/upload/")) return "upload";
        return fallback;
    }

    _setResponseApiFormat(res, apiFormat) {
        if (!res || !apiFormat) return;
        res.__proxyApiFormat = apiFormat;
    }

    _resolveErrorFormat(res) {
        const trackedFormat = res?.__proxyApiFormat;
        if (trackedFormat && trackedFormat !== "upload") return trackedFormat;
        return "gemini";
    }

    _getDefaultErrorType(format, statusCode) {
        if (statusCode === 504) return "timeout_error";
        if (statusCode === 503) {
            return format === "claude" ? "overloaded_error" : "service_unavailable";
        }
        return "api_error";
    }

    _startTrackedRequest(requestId, req, meta = {}) {
        const usageStatsService = this._getUsageStatsService();
        if (!usageStatsService) return;

        usageStatsService.startRequest(requestId, {
            clientIp: this._getClientIp(req),
            initialAccountName: this._getAccountNameForIndex(this.currentAuthIndex),
            initialAuthIndex: this.currentAuthIndex,
            method: req.method,
            path: req.path,
            ...meta,
        });
    }

    _updateTrackedRequest(requestId, patch = {}) {
        const usageStatsService = this._getUsageStatsService();
        if (!usageStatsService) return;
        usageStatsService.updateRequest(requestId, patch);
    }

    _finalizeTrackedRequest(requestId, res, overrides = {}) {
        const usageStatsService = this._getUsageStatsService();
        if (!usageStatsService) return;

        let outcome = overrides.outcome;
        if (!outcome) {
            if (res.__usageTrackingClientAborted) {
                outcome = "aborted";
            } else if (res.__usageTrackingOutcome) {
                outcome = res.__usageTrackingOutcome;
            } else {
                const statusCode = Number.isFinite(res.statusCode) ? Number(res.statusCode) : null;
                outcome = statusCode !== null && statusCode >= 400 ? "error" : "success";
            }
        }

        const statusCode =
            overrides.statusCode ??
            res.__usageTrackingErrorStatus ??
            (Number.isFinite(res.statusCode) && res.statusCode > 0 ? Number(res.statusCode) : null);

        const errorMessage =
            overrides.errorMessage ??
            res.__usageTrackingErrorMessage ??
            (outcome === "error" ? "Request failed" : null);

        usageStatsService.finishRequest(requestId, {
            errorMessage,
            finalAccountName: overrides.finalAccountName,
            finalAuthIndex: overrides.finalAuthIndex,
            outcome,
            statusCode,
        });
    }

    _markTrackedResponseError(res, message, statusCode = null, outcome = "error") {
        if (!res) return;
        res.__usageTrackingOutcome = outcome;
        res.__usageTrackingErrorMessage = message || null;
        if (Number.isFinite(statusCode)) {
            res.__usageTrackingErrorStatus = Number(statusCode);
        }
    }

    _markTrackedClientAbort(res, message = "Client disconnected") {
        if (!res) return;
        res.__usageTrackingClientAborted = true;
        res.__usageTrackingOutcome = "aborted";
        res.__usageTrackingErrorMessage = message;
    }

    _markTrackedEarlyExitIfNeeded(res, message = "Service temporarily unavailable.", statusCode = 503) {
        if (!res || res.__usageTrackingClientAborted || res.__usageTrackingOutcome) return;
        if (!this._isResponseWritable(res)) {
            this._markTrackedClientAbort(res, message);
            return;
        }
        this._markTrackedResponseError(res, message, statusCode);
    }

    // Delegate methods to AuthSwitcher
    async _switchToNextAuth() {
        return this.authSwitcher.switchToNextAuth();
    }

    async _switchToSpecificAuth(targetIndex) {
        return this.authSwitcher.switchToSpecificAuth(targetIndex);
    }

    async _waitForGraceReconnect(timeoutMs = WS_RECONNECT_WAIT_MS) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (!this.connectionRegistry.isInGracePeriod() && !this.connectionRegistry.isReconnectingInProgress()) {
                const connectionReady = await this._waitForConnection(WS_CONNECTION_READY_TIMEOUT_MS);
                return connectionReady;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return !!this.connectionRegistry.getConnectionByAuth(this.currentAuthIndex);
    }

    _isConnectionResetError(error) {
        if (!error) return false;
        if (
            error.kind === "transport" ||
            ["page_closed", "context_closed", "connection_lost", "reconnect_cleanup", "grace_period_timeout"].includes(
                error.reason
            )
        )
            return true;
        // Check for QueueClosedError type
        if (error instanceof QueueClosedError) return true;
        // Check for error code
        if (error.code === "QUEUE_CLOSED") return true;
        // Fallback to message check for backward compatibility
        if (error.message) {
            return (
                error.message.includes("Queue closed") ||
                error.message.includes("Queue is closed") ||
                error.message.includes("Connection lost")
            );
        }
        return false;
    }

    _logGeminiNativeChunkDebug(googleChunk, mode = "stream") {
        this.logger.debug(`[Proxy] Debug: Received Google chunk for Gemini native ${mode}: ${googleChunk}`);
    }

    _logGeminiNativeResponseDebug(googleResponse, mode = "non-stream") {
        try {
            this.logger.debug(
                `[Proxy] Debug: Received Google response for Gemini native ${mode}: ${JSON.stringify(googleResponse)}`
            );
        } catch (e) {
            this.logger.debug(
                `[Proxy] Debug: Received Google response for Gemini native ${mode} (non-serializable): ${String(
                    googleResponse
                )}`
            );
        }
    }

    /**
     * Handle queue closed error in real streaming mode with proper SSE error response
     * @param {Error} error - The error object (QueueClosedError)
     * @param {Object} res - Express response object
     * @returns {boolean} true if error was handled, false otherwise
     */
    _handleRealStreamQueueClosedError(error, res) {
        const format = this._resolveErrorFormat(res);
        const isClientDisconnect = error.reason === "client_disconnect" || !this._isResponseWritable(res);

        if (isClientDisconnect) {
            // Client disconnected or queue closed due to client disconnect - no error needed
            this._markTrackedClientAbort(res, error.message || "Client disconnected");
            this.logger.debug(
                `[Request] ${format} stream interrupted by client disconnect (reason: ${error.reason || "connection_lost"})`
            );
            return true;
        }

        // Queue was closed for other reasons (account switch, page_closed, etc.)
        // but client is still connected - send proper error SSE
        this.logger.warn(
            `[Request] ${format} stream interrupted: Queue closed (reason: ${error.reason || "unknown"}), sending error SSE`
        );

        if (!this._isResponseWritable(res)) {
            return true;
        }

        try {
            const errorMessage = `Stream interrupted: ${error.reason === "page_closed" ? "Account context closed" : error.reason || "Connection lost"}`;
            this._markTrackedResponseError(res, errorMessage, 503, "local_transport");

            if (format === "claude") {
                // Claude format: event: error\ndata: {...}
                res.write(
                    `event: error\ndata: ${JSON.stringify({
                        error: {
                            message: errorMessage,
                            type: "api_error",
                        },
                        type: "error",
                    })}\n\n`
                );
            } else if (format === "openai") {
                // OpenAI format: data: {"error": {...}}
                res.write(
                    `data: ${JSON.stringify({
                        error: {
                            code: 503,
                            message: errorMessage,
                            type: "api_error",
                        },
                    })}\n\n`
                );
            } else if (format === "response_api") {
                // OpenAI Response API format: event: error\ndata: {...}
                if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
                res.__responseApiSeq += 1;
                res.write(
                    `event: error\ndata: ${JSON.stringify({
                        code: "service_unavailable",
                        message: `Service unavailable: ${errorMessage}`,
                        param: null,
                        sequence_number: res.__responseApiSeq,
                        type: "error",
                    })}\n\n`
                );
            } else if (format === "gemini") {
                // Gemini format: data: {"error": {...}}
                res.write(
                    `data: ${JSON.stringify({
                        error: {
                            code: 503,
                            message: errorMessage,
                            status: "UNAVAILABLE",
                        },
                    })}\n\n`
                );
            }
        } catch (writeError) {
            this.logger.debug(`[Request] Failed to write error to ${format} stream: ${writeError.message}`);
        }

        return true;
    }

    _handleFakeStreamError(error, res) {
        if (isPromptBlocked(error)) return this._handleRequestError(error, res, error.requestId);
        const format = this._resolveErrorFormat(res);
        if (!this._isResponseWritable(res)) {
            return; // Client disconnected, no need to send error
        }

        try {
            let errorPayload;
            let trackingStatus = 500;
            let trackingMessage = String(error?.message ?? error);
            let trackingOutcome = "error";

            if (error.code === "QUEUE_TIMEOUT" || error instanceof QueueTimeoutError) {
                // True timeout error - 504
                trackingStatus = 504;
                trackingMessage = `Stream timeout: ${trackingMessage}`;
                if (format === "openai") {
                    errorPayload = {
                        error: {
                            code: 504,
                            message: `Stream timeout: ${error.message}`,
                            type: "timeout_error",
                        },
                    };
                    if (this._isResponseWritable(res)) {
                        res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                } else if (format === "claude") {
                    errorPayload = {
                        error: {
                            message: `Stream timeout: ${error.message}`,
                            type: "timeout_error",
                        },
                        type: "error",
                    };
                    if (this._isResponseWritable(res)) {
                        res.write(`event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                } else if (format === "response_api") {
                    // OpenAI Response API format
                    errorPayload = {
                        code: "timeout_error",
                        message: `Stream timeout: ${error.message}`,
                        param: null,
                        sequence_number: 0,
                        type: "error",
                    };
                    if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
                    res.__responseApiSeq += 1;
                    errorPayload.sequence_number = res.__responseApiSeq;
                    if (this._isResponseWritable(res)) {
                        res.write(`event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                } else {
                    // gemini
                    errorPayload = {
                        error: {
                            code: 504,
                            message: `Stream timeout: ${error.message}`,
                            status: "DEADLINE_EXCEEDED",
                        },
                    };
                    if (this._isResponseWritable(res)) {
                        res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                }
            } else if (error.code === "QUEUE_CLOSED" || error instanceof QueueClosedError) {
                // Queue closed (account switch, system reset, etc.) - 503
                trackingStatus = 503;
                trackingOutcome = "local_transport";
                trackingMessage = `Service unavailable: ${trackingMessage}`;
                if (format === "openai") {
                    errorPayload = {
                        error: {
                            code: 503,
                            message: `Service unavailable: ${error.message}`,
                            type: "service_unavailable",
                        },
                    };
                    if (this._isResponseWritable(res)) {
                        res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                } else if (format === "claude") {
                    errorPayload = {
                        error: {
                            message: `Service unavailable: ${error.message}`,
                            type: "overloaded_error",
                        },
                        type: "error",
                    };
                    if (this._isResponseWritable(res)) {
                        res.write(`event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                } else if (format === "response_api") {
                    // OpenAI Response API format
                    errorPayload = {
                        code: "service_unavailable",
                        message: `Service unavailable: ${error.message}`,
                        param: null,
                        sequence_number: 0,
                        type: "error",
                    };
                    if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
                    res.__responseApiSeq += 1;
                    errorPayload.sequence_number = res.__responseApiSeq;
                    if (this._isResponseWritable(res)) {
                        res.write(`event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                } else {
                    // gemini
                    errorPayload = {
                        error: {
                            code: 503,
                            message: `Service unavailable: ${error.message}`,
                            status: "UNAVAILABLE",
                        },
                    };
                    if (this._isResponseWritable(res)) {
                        res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
                    }
                }
            } else {
                // Other unexpected errors - rethrow to outer handler
                throw error;
            }

            this._markTrackedResponseError(res, trackingMessage, trackingStatus, trackingOutcome);
        } catch (writeError) {
            this.logger.debug(`[Request] Failed to write fake stream error to client: ${writeError.message}`);
            // If write failed or unexpected error, rethrow original error
            throw error;
        }
    }

    /**
     * Wait for WebSocket connection to be established for current account
     * @param {number} timeoutMs - Maximum time to wait in milliseconds
     * @returns {Promise<boolean>} true if connection established, false if timeout
     */
    async _waitForConnection(timeoutMs = 10000) {
        const startTime = Date.now();
        const checkInterval = 200; // Check every 200ms

        while (Date.now() - startTime < timeoutMs) {
            const connection = this.connectionRegistry.getConnectionByAuth(this.currentAuthIndex);
            // Check both existence and readyState (1 = OPEN)
            if (connection && connection.readyState === 1) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        this.logger.warn(
            `[Request] Timeout waiting for WebSocket connection for account #${this.currentAuthIndex}. Closing unresponsive context...`
        );
        // Proactively close the unresponsive context so subsequent attempts re-initialize it
        if (this.browserManager) {
            try {
                await this.browserManager.closeContext(this.currentAuthIndex);
            } catch (e) {
                this.logger.warn(
                    `[System] Failed to close unresponsive context for account #${this.currentAuthIndex}: ${e.message}`
                );
            }
        }
        return false;
    }

    /**
     * Wait for system to become ready (not busy with switching/recovery)
     * @param {number} timeoutMs - Maximum time to wait in milliseconds (default 120s, same as browser launch timeout)
     * @returns {Promise<boolean>} true if system becomes ready, false if timeout
     */
    async _waitForSystemReady(timeoutMs = 120000) {
        if (!this.authSwitcher.isSystemBusy) {
            return true;
        }

        this.logger.info(`[System] System is busy (switching/recovering), waiting up to ${timeoutMs / 1000}s...`);

        const startTime = Date.now();
        const checkInterval = 200; // Check every 200ms

        while (Date.now() - startTime < timeoutMs) {
            if (!this.authSwitcher.isSystemBusy) {
                this.logger.info(`[System] System ready after ${Date.now() - startTime}ms.`);
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        this.logger.warn(`[System] Timeout waiting for system after ${timeoutMs}ms.`);
        return false;
    }

    async _waitForSystemAndConnectionIfBusy(res = null, options = {}) {
        const {
            busyMessage = "Server undergoing internal maintenance (account switching/recovery), please try again later.",
            connectionMessage = "Service temporarily unavailable: Connection not established after switching.",
            connectionTimeoutMs = WS_CONNECTION_READY_TIMEOUT_MS,
            onConnectionTimeout,
            sendError = res ? (status, message) => this._sendErrorResponse(res, status, message) : () => {},
        } = options;

        const ready = await this._waitForSystemReady();
        if (!ready) {
            sendError(503, busyMessage);
            return false;
        }

        if (!this.connectionRegistry.getConnectionByAuth(this.currentAuthIndex)) {
            const connectionReady = await this._waitForConnection(connectionTimeoutMs);
            if (!connectionReady) {
                if (typeof onConnectionTimeout === "function") {
                    try {
                        onConnectionTimeout();
                    } catch (e) {
                        this.logger.debug(`[System] onConnectionTimeout handler failed: ${e.message}`);
                    }
                }
                sendError(503, connectionMessage);
                return false;
            }
        }

        return true;
    }

    async _ensureBrowserBackedRequestReady(res, options = {}) {
        const { logPrefix = "Request", waitErrorType = null, waitOptions } = options;

        // Check current account's browser connection
        if (!this.connectionRegistry.getConnectionByAuth(this.currentAuthIndex)) {
            this.logger.warn(`[${logPrefix}] No WebSocket connection for current account #${this.currentAuthIndex}`);
            const recovered = await this._handleBrowserRecovery(res);
            if (!recovered) {
                this._markTrackedEarlyExitIfNeeded(res, "Service temporarily unavailable: Browser recovery failed.");
                return false;
            }
        }

        // Wait for system to become ready if it's busy
        const effectiveWaitOptions =
            waitOptions === undefined && waitErrorType
                ? {
                      sendError: (status, message) => this._sendErrorResponse(res, status, message, waitErrorType),
                  }
                : waitOptions;
        const ready =
            effectiveWaitOptions === undefined
                ? await this._waitForSystemAndConnectionIfBusy(res)
                : await this._waitForSystemAndConnectionIfBusy(res, effectiveWaitOptions);
        if (!ready) {
            this._markTrackedEarlyExitIfNeeded(res, "Service temporarily unavailable: System not ready.");
            return false;
        }

        if (this.browserManager) {
            this.browserManager.notifyUserActivity();
        }

        return true;
    }

    async _sendAndReadInitial(proxyRequest, queue, authIndex) {
        this._forwardRequest(proxyRequest, authIndex);
        return this._readInitialMessage(queue);
    }

    _shouldRetryError(error) {
        if (isPromptBlocked(error)) return false;
        if (error.upstreamOutputStarted) return false;
        if (require("../utils/MakerSuiteAuth").isBridgeAuthFailure(error)) return false;
        return this.config.immediateSwitchStatusCodes.includes(Number(error?.status));
    }

    async _readInitialMessage(queue) {
        return queue.dequeue();
    }

    _createImmediateSwitchTracker(initialAuthIndex = this.currentAuthIndex) {
        const attemptedAuthIndices = new Set();
        if (Number.isInteger(initialAuthIndex) && initialAuthIndex >= 0) {
            attemptedAuthIndices.add(initialAuthIndex);
        }
        return { attemptedAuthIndices };
    }

    _getImmediateStatusRetryCloseReason(status) {
        return `immediate_status_retry_${status}`;
    }

    async _performImmediateSwitchRetry(errorDetails, requestId, tracker) {
        if (isPromptBlocked(errorDetails)) return false;
        await this.authSwitcher.handleRequestFailureAndSwitch(
            { message: errorDetails.message, status: Number(errorDetails.status) },
            null
        );

        const ready = await this._waitForSystemAndConnectionIfBusy(null, {
            sendError: () => {},
        });
        if (!ready) {
            throw new Error("System not ready after immediate-switch retry.");
        }

        const newAuthIndex = this.currentAuthIndex;
        if (!Number.isInteger(newAuthIndex) || newAuthIndex < 0) {
            this.logger.warn(
                `[Request] Immediate switch for request #${requestId} did not produce a valid target account.`
            );
            return false;
        }

        if (tracker.attemptedAuthIndices.has(newAuthIndex)) {
            this.logger.warn(
                `[Request] Immediate switch for request #${requestId} returned to already-attempted account #${newAuthIndex}, stopping account-switch retries.`
            );
            return false;
        }

        tracker.attemptedAuthIndices.add(newAuthIndex);
        return true;
    }

    async _prepareImmediateStatusRetry(errorDetails, requestId, tracker, sourceAuthIndex) {
        if (isPromptBlocked(errorDetails)) return false;
        const currentAuthIndex = this.currentAuthIndex;
        const hasSourceAuth = Number.isInteger(sourceAuthIndex) && sourceAuthIndex >= 0;
        const hasCurrentAuth = Number.isInteger(currentAuthIndex) && currentAuthIndex >= 0;

        if (hasSourceAuth && hasCurrentAuth && sourceAuthIndex !== currentAuthIndex) {
            const ready = await this._waitForSystemAndConnectionIfBusy(null, {
                sendError: () => {},
            });
            if (!ready) {
                throw new Error(
                    `System not ready after non-current account retry preparation for request #${requestId}: ` +
                        `status=${errorDetails.status}, sourceAuthIndex=${sourceAuthIndex}, currentAuthIndex=${currentAuthIndex}.`
                );
            }

            const retryAuthIndex = this.currentAuthIndex;
            if (sourceAuthIndex === retryAuthIndex) {
                return this._performImmediateSwitchRetry(errorDetails, requestId, tracker);
            }
            if (!Number.isInteger(retryAuthIndex) || retryAuthIndex < 0) {
                this.logger.warn(
                    `[Request] Non-current account retry for request #${requestId} did not find a valid current account ` +
                        `(status=${errorDetails.status}, sourceAuthIndex=${sourceAuthIndex}, retryAuthIndex=${retryAuthIndex}).`
                );
                return false;
            }
            if (tracker.attemptedAuthIndices.has(retryAuthIndex)) {
                this.logger.warn(
                    `[Request] Non-current account retry for request #${requestId} would reuse already-attempted account #${retryAuthIndex} ` +
                        `(status=${errorDetails.status}, sourceAuthIndex=${sourceAuthIndex}), stopping account-switch retries.`
                );
                return false;
            }

            this.logger.warn(
                `[Request] Received ${errorDetails.status} from non-current account #${sourceAuthIndex}; ` +
                    `retrying request #${requestId} on current account #${retryAuthIndex} without switching.`
            );

            tracker.attemptedAuthIndices.add(retryAuthIndex);
            return true;
        }

        return this._performImmediateSwitchRetry(errorDetails, requestId, tracker);
    }

    _logFinalRequestFailure(errorDetails, contextLabel = "Request", requestId = null, options = {}) {
        const requestIdSuffix = requestId ? `, request ID: ${requestId}` : "";
        const failurePhase = options.afterRetries === false ? "failed" : "failed after retries";
        this.logger.error(
            `❌ [Request] ${contextLabel} ${failurePhase}. Status code: ${errorDetails?.status || 500}, message: ${errorDetails?.message || "Unknown error"}${requestIdSuffix}`
        );
    }

    /**
     * Handle browser recovery when connection is lost
     *
     * Important: isSystemBusy flag management strategy:
     * - Direct recovery (recoveryAuthIndex >= 0): We manually set and reset isSystemBusy
     * - Switch to next account (recoveryAuthIndex = -1): Let switchToNextAuth() manage isSystemBusy internally
     * - This prevents the bug where isSystemBusy is set here, then switchToNextAuth() checks it and returns "already in progress"
     *
     * @returns {boolean} true if recovery successful, false otherwise
     */
    async _handleBrowserRecovery(res) {
        // If within grace period or lightweight reconnect is running, wait up to 130s for WebSocket reconnection
        if (this.connectionRegistry.isInGracePeriod() || this.connectionRegistry.isReconnectingInProgress()) {
            this.logger.info(
                "[System] Waiting up to 130s for WebSocket reconnection (grace/reconnect in progress) before full recovery..."
            );
            const reconnected = await this._waitForGraceReconnect(WS_RECONNECT_WAIT_MS);
            if (reconnected) {
                this.logger.info("[System] Connection restored, skipping recovery.");
                return true;
            }
            this.logger.warn("[System] Reconnection wait expired, proceeding to recovery workflow.");
        }

        // Wait for system to become ready if it's busy (someone else is starting/switching browser)
        if (this.authSwitcher.isSystemBusy) {
            return await this._waitForSystemAndConnectionIfBusy(res, {
                connectionMessage: "Service temporarily unavailable: Browser failed to start. Please try again.",
                onConnectionTimeout: () => {
                    this.logger.error(
                        `[System] WebSocket connection not established for account #${this.currentAuthIndex} after system ready, browser startup may have failed.`
                    );
                },
            });
        }

        // Determine if this is first-time startup or actual crash recovery
        const recoveryAuthIndex = this.currentAuthIndex;
        const isFirstTimeStartup = recoveryAuthIndex < 0 && !this.browserManager.browser;

        if (isFirstTimeStartup) {
            this.logger.info(
                "🚀 [System] Browser not yet started. Initializing browser with first available account..."
            );
        } else {
            this.logger.error(
                "❌ [System] Browser WebSocket connection disconnected! Possible process crash. Attempting recovery..."
            );
        }

        let wasDirectRecovery = false;
        let recoverySuccess = false;

        try {
            if (recoveryAuthIndex >= 0) {
                // Direct recovery: we manage isSystemBusy ourselves
                wasDirectRecovery = true;
                this.authSwitcher.isSystemBusy = true;
                this.logger.info(`[System] Set isSystemBusy=true for direct recovery to account #${recoveryAuthIndex}`);

                await this.browserManager.preCleanupForSwitch(recoveryAuthIndex);
                await this.browserManager.launchOrSwitchContext(recoveryAuthIndex);
                this.logger.info(`✅ [System] Browser successfully recovered to account #${recoveryAuthIndex}!`);

                // Wait for WebSocket connection to be established
                this.logger.info("[System] Waiting for WebSocket connection to be ready...");
                const connectionReady = await this._waitForConnection(WS_CONNECTION_READY_TIMEOUT_MS);
                if (!connectionReady) {
                    throw new Error("WebSocket connection not established within timeout period");
                }
                this.logger.info("✅ [System] WebSocket connection is ready!");
                recoverySuccess = true;
            } else if (this.authSource.getRotationIndices().length > 0) {
                // Don't set isSystemBusy here - let switchToNextAuth manage it
                const result = await this.authSwitcher.switchToNextAuth();
                if (!result.success) {
                    this.logger.error(`❌ [System] Failed to switch to available account: ${result.reason}`);
                    await this._sendErrorResponse(res, 503, `Service temporarily unavailable: ${result.reason}`);
                    recoverySuccess = false;
                } else {
                    this.logger.info(`✅ [System] Successfully recovered to account #${result.newIndex}!`);

                    // Wait for WebSocket connection to be established
                    this.logger.info("[System] Waiting for WebSocket connection to be ready...");
                    const connectionReady = await this._waitForConnection(WS_CONNECTION_READY_TIMEOUT_MS);
                    if (!connectionReady) {
                        throw new Error("WebSocket connection not established within timeout period");
                    }
                    this.logger.info("✅ [System] WebSocket connection is ready!");
                    recoverySuccess = true;
                }
            } else {
                this.logger.error("❌ [System] No available accounts for recovery.");
                await this._sendErrorResponse(res, 503, "Service temporarily unavailable: No available accounts.");
                recoverySuccess = false;
            }
        } catch (error) {
            this.logger.error(`❌ [System] Recovery failed: ${error.message}`);

            if (wasDirectRecovery && this.authSource.getRotationIndices().length > 1) {
                this.logger.warn("⚠️ [System] Attempting to switch to alternative account...");
                // Reset isSystemBusy before calling switchToNextAuth to avoid "already in progress" rejection
                this.authSwitcher.isSystemBusy = false;
                wasDirectRecovery = false; // Prevent finally block from resetting again
                try {
                    const result = await this.authSwitcher.switchToNextAuth();
                    if (!result.success) {
                        this.logger.error(`❌ [System] Failed to switch to alternative account: ${result.reason}`);
                        await this._sendErrorResponse(res, 503, `Service temporarily unavailable: ${result.reason}`);
                        recoverySuccess = false;
                    } else {
                        this.logger.info(
                            `✅ [System] Successfully switched to alternative account #${result.newIndex}!`
                        );

                        // Wait for WebSocket connection to be established
                        this.logger.info("[System] Waiting for WebSocket connection to be ready...");
                        const connectionReady = await this._waitForConnection(WS_CONNECTION_READY_TIMEOUT_MS);
                        if (!connectionReady) {
                            throw new Error("WebSocket connection not established within timeout period");
                        }
                        this.logger.info("✅ [System] WebSocket connection is ready!");
                        recoverySuccess = true;
                    }
                } catch (switchError) {
                    this.logger.error(`❌ [System] All accounts failed: ${switchError.message}`);
                    await this._sendErrorResponse(res, 503, "Service temporarily unavailable: All accounts failed.");
                    recoverySuccess = false;
                }
            } else {
                await this._sendErrorResponse(
                    res,
                    503,
                    "Service temporarily unavailable: Browser crashed and cannot auto-recover."
                );
                recoverySuccess = false;
            }
        } finally {
            // Only reset if we set it (for direct recovery attempt)
            if (wasDirectRecovery) {
                this.logger.info("[System] Resetting isSystemBusy=false in recovery finally block");
                this.authSwitcher.isSystemBusy = false;
            }
        }

        return recoverySuccess;
    }

    // Process standard Google API requests
    async processRequest(req, res) {
        if (this._rejectUnsupportedAntiRequest(req, res, "gemini")) return;
        if (this.serverSystem.scheduler && !this.scheduled) {
            return require("./ScheduledRequestHandler").dispatch(this, "processRequest", req, res);
        }
        const requestId = this._generateRequestId();
        if (!res.headersSent) res.setHeader("X-Request-ID", requestId);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "gemini",
            requestCategory: this._categorizeRequest(req.path, "request"),
        });
        this._setResponseApiFormat(res, "gemini");
        res.__proxyResponseStreamMode = null;

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res))) {
                return;
            }

            // Handle usage-based account switching
            const isGenerativeRequest =
                req.method === "POST" &&
                (req.path.includes("generateContent") || req.path.includes("streamGenerateContent"));

            if (isGenerativeRequest) {
                const usageCount = this.authSwitcher.incrementUsageCount();
                if (usageCount > 0) {
                    const rotationCountText =
                        this.config.switchOnUses > 0 ? `${usageCount}/${this.config.switchOnUses}` : `${usageCount}`;
                    this.logger.info(
                        `[Request] Google generation request - account rotation count: ${rotationCountText} (Current account: ${this.currentAuthIndex}), request ID: ${requestId}`
                    );
                    if (this.authSwitcher.shouldSwitchByUsage()) {
                        this.needsSwitchingAfterRequest = true;
                    }
                }
            }

            const proxyRequest = this._buildProxyRequest(req, requestId);
            proxyRequest.is_generative = isGenerativeRequest;
            this._initializeProxyRequestAttempt(proxyRequest);
            await this._ensureLegacyBenefit(proxyRequest);
            if (this.scheduled) {
                try {
                    await this._acquireScheduledLease(proxyRequest);
                } catch (error) {
                    return this._sendErrorResponse(res, error.status || 503, error.message, null, error);
                }
            }

            const wantsStream = req.path.includes(":streamGenerateContent");
            res.__proxyResponseStreamMode = wantsStream ? proxyRequest.streaming_mode : null;

            this._updateTrackedRequest(requestId, {
                isStreaming: wantsStream,
                model: this._extractModelFromPath(proxyRequest.path),
                path: proxyRequest.path,
                requestCategory: this._categorizeRequest(
                    proxyRequest.path,
                    isGenerativeRequest ? "generation" : "request"
                ),
                streamMode: wantsStream ? proxyRequest.streaming_mode : null,
            });

            try {
                // Create message queue inside try-catch to handle invalid authIndex
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this.currentAuthIndex,
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                if (wantsStream) {
                    if (proxyRequest.streaming_mode === "fake") {
                        await this._handlePseudoStreamResponse(proxyRequest, messageQueue, req, res);
                    } else {
                        await this._handleRealStreamResponse(proxyRequest, messageQueue, req, res);
                    }
                } else {
                    proxyRequest.streaming_mode = "fake";
                    await this._handleNonStreamResponse(proxyRequest, messageQueue, req, res);
                }
            } catch (error) {
                // Handle queue timeout by notifying browser
                this._handleQueueTimeout(error, requestId);
                if (res.__antiAttempt && error.code !== "QUEUE_TIMEOUT") {
                    const index = this.connectionRegistry.getAuthIndexForRequest(requestId);
                    if (Number.isInteger(index))
                        this._cancelBrowserRequest(requestId, index, proxyRequest.request_attempt_id);
                }
                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (this.needsSwitchingAfterRequest) {
                    this.logger.info(
                        `[Auth] Rotation count reached switching threshold (${this.authSwitcher.usageCount}/${this.config.switchOnUses}), will automatically switch account in background...`
                    );
                    this.authSwitcher.switchToNextAuth().catch(err => {
                        this.logger.error(`[Auth] Background account switching task failed: ${err.message}`);
                    });
                    this.needsSwitchingAfterRequest = false;
                }
                if (!res.writableEnded) res.end();
            }
        } catch (error) {
            this._handleRequestError(error, res, requestId);
        } finally {
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    // Process OpenAI embeddings requests
    async processOpenAIEmbeddingsRequest(req, res) {
        if (this._rejectUnsupportedAntiRequest(req, res, "embedding")) return;
        if (this.serverSystem.scheduler && !this.scheduled) {
            return require("./ScheduledRequestHandler").dispatch(this, "processOpenAIEmbeddingsRequest", req, res);
        }
        const requestId = this._generateRequestId();
        if (!res.headersSent) res.setHeader("X-Request-ID", requestId);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "openai",
            isStreaming: false,
            requestCategory: "embedding",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "openai");
        res.__proxyResponseStreamMode = null;

        try {
            if (!(await this._ensureRequestReady(res))) {
                return;
            }

            const { cleanModelName, googleRequest, path } = this.formatConverter.translateOpenAIEmbeddingsToGoogle(
                req.body
            );
            const proxyRequest = {
                body: JSON.stringify(googleRequest),
                headers: req.headers,
                is_generative: false,
                method: "POST",
                path,
                query_params: req.query || {},
                request_id: requestId,
                streaming_mode: "real",
                tracking_model: cleanModelName,
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            if (this.scheduled) {
                try {
                    await this._acquireScheduledLease(proxyRequest);
                } catch (error) {
                    return this._sendErrorResponse(res, error.status || 503, error.message, null, error);
                }
            }
            this._updateTrackedRequest(requestId, {
                isStreaming: false,
                model: proxyRequest.tracking_model,
                path: proxyRequest.path,
                requestCategory: "embedding",
                streamMode: null,
            });

            try {
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this.currentAuthIndex,
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                await this._handleNonStreamResponse(proxyRequest, messageQueue, req, res);
            } catch (error) {
                this._handleQueueTimeout(error, requestId);
                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (!res.writableEnded) res.end();
            }
        } catch (error) {
            this._handleRequestError(error, res, requestId);
        } finally {
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    // Process File Upload requests
    async processUploadRequest(req, res) {
        if (this.serverSystem.scheduler && !this.scheduled) {
            return require("./ScheduledRequestHandler").dispatch(this, "processUploadRequest", req, res);
        }
        const requestId = this._generateRequestId();
        if (!res.headersSent) res.setHeader("X-Request-ID", requestId);
        this.logger.info(`[Upload] Processing upload request ${req.method} ${req.path}, request ID: ${requestId}`);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "upload",
            isStreaming: false,
            requestCategory: "upload",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "upload");

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res, { logPrefix: "Upload" }))) {
                return;
            }

            const uploadBodyBuffer = this._patchUploadStartMetadata(req);
            const proxyRequest = {
                body_b64: uploadBodyBuffer ? uploadBodyBuffer.toString("base64") : undefined,
                headers: req.headers,
                is_generative: false, // Uploads are never generative
                method: req.method,
                path: req.path.replace(/^\/proxy/, ""),
                query_params: req.query || {},
                request_id: requestId,
                streaming_mode: "real", // Uploads always return a single JSON response
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            if (this.scheduled) {
                try {
                    await this._acquireScheduledLease(proxyRequest);
                } catch (error) {
                    return this._sendErrorResponse(res, error.status || 503, error.message, null, error);
                }
            }
            this._updateTrackedRequest(requestId, {
                path: proxyRequest.path,
            });

            try {
                // Create message queue inside try-catch to handle invalid authIndex
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this.currentAuthIndex,
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                await this._handleNonStreamResponse(proxyRequest, messageQueue, req, res);
            } catch (error) {
                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (!res.writableEnded) res.end();
            }
        } catch (error) {
            this._handleRequestError(error, res, requestId);
        } finally {
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    _patchUploadStartMetadata(req) {
        const originalBody = req.rawBody;

        if (!this._isUploadStartRequest(req)) return originalBody;

        const uploadContentType = req.headers["x-goog-upload-header-content-type"];
        if (!uploadContentType || !originalBody?.length) return originalBody;

        let bodyObj;
        try {
            bodyObj = JSON.parse(originalBody.toString());
        } catch (e) {
            this.logger.debug(`[Upload] Start metadata is not valid JSON, skipping mimeType patch: ${e.message}`);
            return originalBody;
        }

        if (!bodyObj || typeof bodyObj !== "object") return originalBody;

        const fileMetadata = bodyObj.file || bodyObj.file_metadata || bodyObj;
        if (!fileMetadata || typeof fileMetadata !== "object") return originalBody;

        if (fileMetadata.mimeType || fileMetadata.mime_type) {
            return originalBody;
        }

        fileMetadata.mimeType = uploadContentType;
        return Buffer.from(JSON.stringify(bodyObj));
    }

    _isUploadStartRequest(req) {
        const command = String(req.headers["x-goog-upload-command"] || "").toLowerCase();
        return req.method === "POST" && req.path.includes("/upload/") && command.includes("start");
    }

    async _ensureEarlyStreamReady(res) {
        // Browser readiness can be shared work in legacy mode. Stop awaiting it as
        // soon as this client leaves, and never forward this request afterwards.
        let onClose;
        const disconnected = new Promise(resolve => {
            onClose = () => {
                this._markTrackedClientAbort(res);
                resolve(false);
            };
            res.once("close", onClose);
        });
        try {
            if (!this._isResponseWritable(res)) return false;
            return await Promise.race([
                this._ensureBrowserBackedRequestReady(res, { waitErrorType: "service_unavailable" }),
                disconnected,
            ]);
        } finally {
            res.removeListener("close", onClose);
        }
    }

    _startEarlyOpenAIStream(res, model) {
        if (res.__streamStartSent || !this._isResponseWritable(res)) return;
        const state = {
            created: Math.floor(Date.now() / 1000),
            id: `chatcmpl-${this._generateRequestId()}`,
            model,
            roleSent: true,
        };
        res.__earlyOpenAIStreamState = state;
        res.status(200).set({
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
            "X-Accel-Buffering": "no",
        });
        res.flushHeaders?.();
        res.__streamStartSent = true;
        res.__modelOutputStarted = false;
        res.__streamStartAt = Date.now();
        // Explicitly distinguish this local acceptance event from model output.
        res.__writingStreamStart = true;
        try {
            res.write(
                `data: ${JSON.stringify({
                    choices: [{ delta: { content: "", role: "assistant" }, finish_reason: null, index: 0 }],
                    created: state.created,
                    id: state.id,
                    model,
                    object: "chat.completion.chunk",
                })}\n\n`
            );
            res.flush?.();
        } finally {
            res.__writingStreamStart = false;
        }
        const acceptedAt = this._acceptedAt || res.__acceptedAt || Date.now();
        this.logger.debug(
            `[Request] Early empty chunk sent for ${model}, elapsed: ${res.__streamStartAt - acceptedAt}ms`
        );
        this.scheduler?.observe("http_headers_ms", Date.now() - acceptedAt);
        this.scheduler?.observe("stream_start_ms", Date.now() - acceptedAt);
        let timer;
        let stopped = false;
        const stop = () => {
            stopped = true;
            clearTimeout(timer);
            res.removeListener("close", stop);
            res.removeListener("finish", stop);
        };
        res.__stopEarlyOpenAIStream = stop;
        res.once("close", stop);
        res.once("finish", stop);
        const emptyChunk = `data: ${JSON.stringify({
            choices: [{ delta: { content: "" }, finish_reason: null, index: 0 }],
            created: state.created,
            id: state.id,
            model: state.model,
            object: "chat.completion.chunk",
        })}\n\n`;
        const sendKeepalive = () => {
            if (
                stopped ||
                !this._isResponseWritable(res) ||
                res.__modelOutputStarted ||
                this.controller?.signal.aborted
            ) {
                stop();
                return false;
            }
            // Local empty data events must never count as actual model output.
            res.__writingEarlyKeepalive = true;
            try {
                res.write(emptyChunk);
                res.flush?.();
                res.__keepaliveSent = true;
                return true;
            } catch (error) {
                this.logger.debug(`[Request] Early stream keepalive stopped: ${error.message}`);
                stop();
                return false;
            } finally {
                res.__writingEarlyKeepalive = false;
            }
        };
        const schedule = () => {
            if (stopped) return;
            // early has its own one-second cadence; other stream modes retain
            // their configured/comment keepalive behavior.
            timer = setTimeout(() => {
                if (sendKeepalive()) schedule();
            }, 1000);
            timer.unref?.();
        };
        // NewAPI buffers one event: release the role start immediately without
        // repeating role or waiting for the first periodic heartbeat.
        if (sendKeepalive()) schedule();
    }

    async _ensureRequestReady(res) {
        let onClose;
        const disconnected = new Promise(resolve => {
            onClose = () => {
                this._markTrackedClientAbort(res);
                resolve(false);
            };
            res.once("close", onClose);
        });
        try {
            if (!this._isResponseWritable(res)) return false;
            return await Promise.race([
                this._ensureBrowserBackedRequestReady(res, { waitErrorType: "service_unavailable" }),
                disconnected,
            ]);
        } finally {
            res.removeListener("close", onClose);
        }
    }

    // Process OpenAI format requests
    async processOpenAIRequest(req, res) {
        if (this.serverSystem.scheduler && !this.scheduled) {
            return require("./ScheduledRequestHandler").dispatch(this, "processOpenAIRequest", req, res);
        }
        const requestId = this._generateRequestId();
        if (!res.headersSent) res.setHeader("X-Request-ID", requestId);
        res.__acceptedAt = Date.now();
        this._startTrackedRequest(requestId, req, {
            apiFormat: "openai",
            isStreaming: req.body.stream === true,
            requestCategory: "generation",
            streamMode: req.body.stream === true ? this.config.streamingMode : null,
        });
        this._setResponseApiFormat(res, "openai");
        res.__proxyResponseStreamMode = null;

        try {
            const antiConfig = { ...this.config };
            let policy;
            try {
                policy = AntiTruncation.resolve(req.body, antiConfig);
                this.serverSystem.scheduler?.assertModelAccessible(policy.realModel);
                if (
                    policy.enabled &&
                    antiConfig.modelList?.length &&
                    !antiConfig.modelList.some(item => item.name.replace(/^models\//, "") === policy.realModel)
                )
                    throw Object.assign(new Error("Unknown anti-truncation model"), {
                        code: "invalid_model",
                        status: 400,
                    });
            } catch (error) {
                return this._sendErrorResponse(res, error.status || 400, error.message, error.code);
            }
            this.logger.info(
                `[Anti] request=${requestId} requested=${JSON.stringify(req.body.model)} model=${policy.realModel} enabled=${policy.enabled} source=${policy.source} reason=${policy.reason || "none"}`
            );
            const baseline = structuredClone(req.body);
            baseline.model = policy.model;
            delete baseline.anti_truncation;
            const injected = policy.enabled ? AntiTruncation.inject(baseline) : { body: baseline };
            const suffixMode = FormatConverter.parseModelStreamingModeSuffix(
                FormatConverter.parseModelBuiltInToolSuffixes(req.body.model).cleanModelName
            ).streamingMode;
            const wantsEarlyStream = req.body.stream === true && (suffixMode || this.config.streamingMode) === "early";
            if (!wantsEarlyStream && !(await this._ensureRequestReady(res))) return;
            const isOpenAIStream = req.body.stream === true;
            const systemStreamMode = this.config.streamingMode;

            // Handle usage counting
            const usageCount = this.authSwitcher.incrementUsageCount();
            if (usageCount > 0) {
                const rotationCountText =
                    this.config.switchOnUses > 0 ? `${usageCount}/${this.config.switchOnUses}` : `${usageCount}`;
                this.logger.info(
                    `[Request] OpenAI generation request - account rotation count: ${rotationCountText} (Current account: ${this.currentAuthIndex}), request ID: ${requestId}`
                );
                if (this.authSwitcher.shouldSwitchByUsage()) {
                    this.needsSwitchingAfterRequest = true;
                }
            }

            // Translate OpenAI format to Google format (also handles model name suffix parsing)
            let googleBody, model, modelStreamingMode;
            try {
                const result = await this.formatConverter.translateOpenAIToGoogle(injected.body, {
                    privateTransport: policy.enabled,
                });
                googleBody = result.googleRequest;
                model = result.cleanModelName;
                modelStreamingMode = result.modelStreamingMode || null;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] OpenAI request translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(res, 400, "Invalid OpenAI request format.", "invalid_request_error");
            }

            const effectiveStreamMode = this._effectiveStreamMode(model, modelStreamingMode || systemStreamMode);
            const useEarlyStream = isOpenAIStream && effectiveStreamMode === "early";
            res.__proxyResponseStreamMode = isOpenAIStream ? effectiveStreamMode : null;
            this._updateTrackedRequest(requestId, { model, streamMode: isOpenAIStream ? effectiveStreamMode : null });
            if (useEarlyStream && !this.scheduled) this._startEarlyOpenAIStream(res, model);
            if (useEarlyStream && !(await this._ensureEarlyStreamReady(res))) {
                return;
            }

            if (!this._isResponseWritable(res)) return;
            const useRealStream = isOpenAIStream && effectiveStreamMode === "real";
            const googleEndpoint = useRealStream ? "streamGenerateContent" : "generateContent";
            const proxyRequest = {
                body: JSON.stringify(googleBody),
                headers: { "Content-Type": "application/json" },
                is_generative: true,
                method: "POST",
                path: `/v1beta/models/${model}:${googleEndpoint}`,
                query_params: useRealStream ? { alt: "sse" } : {},
                request_id: requestId,
                streaming_mode: useRealStream ? "real" : "fake",
                transport_policy: TransportPolicy.resolve(
                    model,
                    modelStreamingMode || systemStreamMode,
                    this.config.modelTransportPolicy
                ),
            };
            if (policy.enabled) {
                const context = {
                    baseline: proxyRequest.body,
                    log: event => this.logger.info(`[Anti] request=${requestId} model=${model} event=${event}`),
                    originalName: injected.name,
                    res,
                };
                Object.defineProperty(proxyRequest, "__antiContext", { value: context });
                res.__antiAttempt = new AntiTruncation.Attempt(injected.name, context.log);
                res.__antiIncludeUsage = req.body.stream_options?.include_usage === true;
            }
            this._initializeProxyRequestAttempt(proxyRequest);
            await this._ensureLegacyBenefit(proxyRequest);
            if (this.scheduled) {
                try {
                    await this._acquireScheduledLease(proxyRequest);
                } catch (error) {
                    return this._sendErrorResponse(res, error.status || 503, error.message, null, error);
                }
            }
            res.__proxyResponseStreamMode = isOpenAIStream ? effectiveStreamMode : null;
            this._updateTrackedRequest(requestId, {
                isStreaming: isOpenAIStream,
                model,
                path: proxyRequest.path,
                requestCategory: "generation",
                ...(isOpenAIStream ? { streamMode: effectiveStreamMode } : {}),
            });

            try {
                // Create message queue inside try-catch to handle invalid authIndex
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this.currentAuthIndex,
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                if (useRealStream) {
                    let currentQueue = messageQueue;
                    let currentQueueAuthIndex = this.currentAuthIndex;
                    let initialMessage;
                    let skipFinalFailureSwitch = false;
                    const immediateSwitchTracker = this._createImmediateSwitchTracker(currentQueueAuthIndex);

                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        this._getUsageStatsService()?.recordAttempt(
                            proxyRequest.request_id,
                            currentQueueAuthIndex,
                            this._getAccountNameForIndex(currentQueueAuthIndex)
                        );
                        initialMessage = await this._sendAndReadInitial(
                            proxyRequest,
                            currentQueue,
                            currentQueueAuthIndex
                        );

                        const initialStatus = Number(initialMessage?.status);
                        if (
                            initialMessage.event_type === "error" &&
                            !isUserAbortedError(initialMessage) &&
                            Number.isFinite(initialStatus) &&
                            this._shouldRetryError(initialMessage, proxyRequest)
                        ) {
                            this.logger.warn(
                                `[Request] OpenAI real stream received ${initialStatus}, preparing retry...`
                            );
                            this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

                            const retryPrepared = await this._prepareImmediateStatusRetry(
                                initialMessage,
                                requestId,
                                immediateSwitchTracker,
                                currentQueueAuthIndex
                            );
                            if (!retryPrepared) {
                                skipFinalFailureSwitch = true;
                                break;
                            }

                            try {
                                currentQueue.close(this._getImmediateStatusRetryCloseReason(initialStatus));
                            } catch {
                                /* empty */
                            }
                            this._advanceProxyRequestAttempt(proxyRequest);
                            currentQueue = this.connectionRegistry.createMessageQueue(
                                requestId,
                                this.currentAuthIndex,
                                proxyRequest.request_attempt_id
                            );
                            currentQueueAuthIndex = this.currentAuthIndex;
                            continue;
                        }

                        break;
                    }

                    if (initialMessage.event_type === "error") {
                        this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
                        this._logFinalRequestFailure(initialMessage, "OpenAI real stream", requestId, {
                            afterRetries: false,
                        });

                        // Send standard HTTP error response
                        this._sendErrorResponse(
                            res,
                            initialMessage.status,
                            initialMessage.message,
                            null,
                            initialMessage
                        );

                        // Avoid switching account if the error is just a connection reset
                        if (!skipFinalFailureSwitch && !this._isConnectionResetError(initialMessage)) {
                            await this.authSwitcher.handleRequestFailureAndSwitch(initialMessage, null);
                        } else if (skipFinalFailureSwitch) {
                            this.logger.info(
                                "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                            );
                        } else {
                            this.logger.info(
                                "[Request] Failure due to connection reset (Real Stream), skipping account switch."
                            );
                        }
                        return;
                    }

                    if (this.authSwitcher.failureCount > 0) {
                        this.logger.debug(
                            `✅ [Auth] OpenAI interface request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                        );
                        this.authSwitcher.failureCount = 0;
                    }

                    if (!res.headersSent) {
                        res.status(200).set({
                            "Cache-Control": "no-cache",
                            Connection: "keep-alive",
                            "Content-Type": "text/event-stream",
                            "X-Accel-Buffering": "no",
                        });
                    }
                    this.logger.info(`[Request] OpenAI streaming response (Real Mode) started...`);
                    await this._streamOpenAIResponse(currentQueue, res, model, requestId);
                } else {
                    // OpenAI Fake Stream / Non-Stream mode
                    // Set up keep-alive timer for fake stream mode to prevent client timeout
                    let connectionMaintainer;
                    if (isOpenAIStream && !res.__streamStartSent) {
                        const scheduleNextKeepAlive = () => {
                            const randomInterval = 12000 + Math.floor(Math.random() * 6000); // 12 - 18 seconds
                            connectionMaintainer = setTimeout(() => {
                                if (!res.headersSent) {
                                    res.status(200).set({
                                        "Cache-Control": "no-cache",
                                        Connection: "keep-alive",
                                        "Content-Type": "text/event-stream",
                                        "X-Accel-Buffering": "no",
                                    });
                                }
                                if (!res.writableEnded) {
                                    res.write(": keep-alive\n\n");
                                    scheduleNextKeepAlive();
                                }
                            }, randomInterval);
                        };
                        scheduleNextKeepAlive();
                    }

                    try {
                        const result = await this._executeRequestWithRetries(proxyRequest, messageQueue);

                        if (!result.success) {
                            this._logFinalRequestFailure(result.error, "OpenAI fake/non-stream", requestId);
                            // Send standard HTTP error response for both streaming and non-streaming
                            if (connectionMaintainer) clearTimeout(connectionMaintainer);
                            if (isOpenAIStream && res.headersSent) {
                                // If keep-alives already started the SSE response, send an SSE error event instead of JSON.
                                this._handleRequestError(result.error, res, requestId);
                            } else {
                                this._sendErrorResponse(
                                    res,
                                    result.error.status,
                                    result.error.message,
                                    null,
                                    result.error
                                );
                            }

                            // Avoid switching account if the error is just a connection reset
                            if (!result.error.skipAccountSwitch && !this._isConnectionResetError(result.error)) {
                                await this.authSwitcher.handleRequestFailureAndSwitch(result.error, null);
                            } else if (result.error.skipAccountSwitch) {
                                this.logger.info(
                                    "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                                );
                            } else {
                                this.logger.info(
                                    "[Request] Failure due to connection reset (OpenAI), skipping account switch."
                                );
                            }
                            return;
                        }

                        if (this.authSwitcher.failureCount > 0) {
                            this.logger.debug(
                                `✅ [Auth] OpenAI interface request successful - failure count reset to 0`
                            );
                            this.authSwitcher.failureCount = 0;
                        }

                        // Use the queue that successfully received the initial message
                        const activeQueue = result.queue;

                        if (isOpenAIStream) {
                            // Fake stream - ensure headers are set before sending data
                            if (!res.headersSent) {
                                res.status(200).set({
                                    "Cache-Control": "no-cache",
                                    Connection: "keep-alive",
                                    "Content-Type": "text/event-stream",
                                    "X-Accel-Buffering": "no",
                                });
                            }
                            // Clear keep-alive timer as we are about to send real data
                            if (connectionMaintainer) clearTimeout(connectionMaintainer);

                            this.logger.info(`[Request] OpenAI streaming response (Fake Mode) started...`);
                            let fullBody = "";
                            let bufferingAttemptId = proxyRequest.request_attempt_id;
                            let hadStreamError = false;
                            try {
                                // eslint-disable-next-line no-constant-condition
                                while (true) {
                                    const message = await activeQueue.dequeue(this.timeouts.FAKE_STREAM);
                                    if (message.type === "STREAM_END") {
                                        break;
                                    }

                                    if (message.event_type === "error") {
                                        if (res.__antiAttempt) {
                                            hadStreamError = true;
                                            this._handleRequestError(message, res, requestId);
                                            break;
                                        }
                                        this.logger.error(
                                            `❌ [Request] Error received during OpenAI fake stream: ${message.message}`
                                        );
                                        const errorStatus = useEarlyStream ? Number(message.status) || 500 : 500;
                                        const errorType = useEarlyStream
                                            ? message.error?.type || this._getDefaultErrorType("openai", errorStatus)
                                            : "api_error";
                                        this._markTrackedResponseError(res, message.message, errorStatus);
                                        hadStreamError = true;
                                        // Check if response is still writable before attempting to write
                                        if (this._isResponseWritable(res)) {
                                            try {
                                                res.write(
                                                    `data: ${JSON.stringify({ error: { code: errorStatus, message: message.message, type: errorType } })}\n\n`
                                                );
                                            } catch (writeError) {
                                                this.logger.debug(
                                                    `❌ [Request] Failed to write error to OpenAI fake stream: ${writeError.message}`
                                                );
                                            }
                                        }
                                        break;
                                    }

                                    if (
                                        (useEarlyStream || res.__antiAttempt) &&
                                        bufferingAttemptId !== proxyRequest.request_attempt_id
                                    ) {
                                        fullBody = "";
                                        bufferingAttemptId = proxyRequest.request_attempt_id;
                                    }
                                    if (message.data) {
                                        fullBody += message.data;
                                        if (res.__antiAttempt && Buffer.byteLength(fullBody) > AntiTruncation.MAX_BYTES)
                                            throw Object.assign(
                                                new Error("Anti-truncation response exceeds size limit"),
                                                { code: "anti_truncation_limit", status: 502 }
                                            );
                                    }
                                }
                                if (hadStreamError) {
                                    // Backend errored; don't attempt to translate/send a "normal" stream afterwards.
                                    return;
                                }
                                const streamState = res.__earlyOpenAIStreamState || {};
                                if (useEarlyStream || res.__antiAttempt)
                                    streamState.includeUsage = req.body.stream_options?.include_usage === true;
                                if (useEarlyStream && !res.__antiAttempt) JSON.parse(fullBody);
                                const translatedChunk = res.__antiAttempt
                                    ? res.__antiAttempt.stream(
                                          AntiTruncation.parseResponse(fullBody),
                                          this.formatConverter,
                                          model,
                                          streamState,
                                          true
                                      )
                                    : this.formatConverter.translateGoogleToOpenAIStream(fullBody, model, streamState);
                                if (res.__antiAttempt) {
                                    res.__antiAttempt.assertComplete();
                                }
                                if (this._isResponseWritable(res)) {
                                    try {
                                        if (translatedChunk) {
                                            if (useEarlyStream && !this.scheduled && streamState.modelOutputStarted) {
                                                res.__modelOutputStarted = true;
                                                res.__modelFirstOutputAt = Date.now();
                                                res.__stopEarlyOpenAIStream?.();
                                                this.logger.debug(
                                                    `[Request] Model output delivered, elapsed: ${res.__modelFirstOutputAt - res.__acceptedAt}ms`
                                                );
                                            }
                                            res.write(translatedChunk);
                                        }
                                        if (res.__antiAttempt) res.write(res.__antiAttempt.usageEvent(streamState));
                                        res.write("data: [DONE]\n\n");
                                        res.flush?.();
                                    } catch (writeError) {
                                        this.logger.debug(
                                            `[Request] Failed to write final fake OpenAI stream chunks: ${writeError.message}`
                                        );
                                    }
                                } else {
                                    this.logger.debug(
                                        "[Request] Response no longer writable before final fake OpenAI stream chunks."
                                    );
                                }
                                this.logger.info(
                                    `✅ [Request] Response completed (OpenAI fake stream), request ID: ${requestId}`
                                );
                            } catch (error) {
                                // Classify error type and send appropriate response
                                res.__antiAttempt
                                    ? this._handleRequestError(error, res, requestId)
                                    : this._handleFakeStreamError(error, res);
                            }
                        } else {
                            // Non-stream
                            await this._sendOpenAINonStreamResponse(activeQueue, res, model, requestId);
                        }
                    } finally {
                        if (connectionMaintainer) clearTimeout(connectionMaintainer);
                    }
                }
            } catch (error) {
                // Handle queue timeout by notifying browser
                this._handleQueueTimeout(error, requestId);

                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (this.needsSwitchingAfterRequest) {
                    this.logger.info(
                        `[Auth] Rotation count reached switching threshold (${this.authSwitcher.usageCount}/${this.config.switchOnUses}), will automatically switch account in background...`
                    );
                    this.authSwitcher.switchToNextAuth().catch(err => {
                        this.logger.error(`[Auth] Background account switching task failed: ${err.message}`);
                    });
                    this.needsSwitchingAfterRequest = false;
                }
                if (!res.writableEnded) res.end();
            }
        } catch (error) {
            this._handleRequestError(error, res, requestId);
        } finally {
            res.__stopEarlyOpenAIStream?.();
            if (res.__streamStartSent)
                this.logger.debug(`[Request] Early stream finished, elapsed: ${Date.now() - res.__acceptedAt}ms`);
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    // Process OpenAI Response API format requests
    async processOpenAIResponseRequest(req, res) {
        if (this._rejectUnsupportedAntiRequest(req, res, "response_api")) return;
        if (this.serverSystem.scheduler && !this.scheduled) {
            return require("./ScheduledRequestHandler").dispatch(this, "processOpenAIResponseRequest", req, res);
        }
        const requestId = this._generateRequestId();
        if (!res.headersSent) res.setHeader("X-Request-ID", requestId);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "response_api",
            isStreaming: req.body.stream === true,
            requestCategory: "generation",
            streamMode:
                req.body.stream === true
                    ? this.config.streamingMode === "early"
                        ? "fake"
                        : this.config.streamingMode
                    : null,
        });
        this._setResponseApiFormat(res, "response_api");
        res.__proxyResponseStreamMode = null;

        try {
            if (!(await this._ensureRequestReady(res))) {
                return;
            }

            const isOpenAIStream = req.body.stream === true;
            const normalizeInstructions = value => {
                if (typeof value === "string") return value;
                if (!Array.isArray(value)) return null;
                const chunks = [];
                for (const item of value) {
                    if (!item || typeof item !== "object") continue;
                    const content = item.content;
                    if (typeof content === "string") {
                        chunks.push(content);
                        continue;
                    }
                    if (!Array.isArray(content)) continue;
                    for (const part of content) {
                        if (!part || typeof part !== "object") continue;
                        if (part.type === "text" || part.type === "input_text") {
                            if (typeof part.text === "string" && part.text) chunks.push(part.text);
                        }
                    }
                }
                return chunks.length > 0 ? chunks.join("\n") : null;
            };
            const responseDefaultsRaw = {
                instructions: normalizeInstructions(req.body?.instructions),
                max_output_tokens: req.body?.max_output_tokens ?? null,
                metadata:
                    req.body?.metadata && typeof req.body.metadata === "object" && !Array.isArray(req.body.metadata)
                        ? req.body.metadata
                        : {},
                parallel_tool_calls:
                    typeof req.body?.parallel_tool_calls === "boolean" ? req.body.parallel_tool_calls : true,
                reasoning:
                    req.body?.reasoning && typeof req.body.reasoning === "object" && !Array.isArray(req.body.reasoning)
                        ? req.body.reasoning
                        : undefined,
                temperature: typeof req.body?.temperature === "number" ? req.body.temperature : undefined,
                text:
                    req.body?.text && typeof req.body.text === "object" && !Array.isArray(req.body.text)
                        ? req.body.text
                        : undefined,
                tool_choice: req.body?.tool_choice ?? undefined,
                tools: Array.isArray(req.body?.tools) ? req.body.tools : undefined,
                top_p: typeof req.body?.top_p === "number" ? req.body.top_p : undefined,
                truncation: typeof req.body?.truncation === "string" ? req.body.truncation : undefined,
                user: typeof req.body?.user === "string" ? req.body.user : undefined,
            };

            const responseDefaults = Object.fromEntries(
                Object.entries(responseDefaultsRaw).filter(([, v]) => v !== undefined)
            );
            const systemStreamMode = this.config.streamingMode;

            // Handle usage counting
            const usageCount = this.authSwitcher.incrementUsageCount();
            if (usageCount > 0) {
                const rotationCountText =
                    this.config.switchOnUses > 0 ? `${usageCount}/${this.config.switchOnUses}` : `${usageCount}`;
                this.logger.info(
                    `[Request] OpenAI Response generation request - account rotation count: ${rotationCountText} (Current account: ${this.currentAuthIndex}), request ID: ${requestId}`
                );
                if (this.authSwitcher.shouldSwitchByUsage()) {
                    this.needsSwitchingAfterRequest = true;
                }
            }

            // Translate OpenAI Response format to Google format
            let googleBody, model, modelStreamingMode;
            try {
                const result = await this.formatConverter.translateOpenAIResponseToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
                modelStreamingMode = result.modelStreamingMode || null;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] OpenAI Response request translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(
                    res,
                    400,
                    "Invalid OpenAI Response request format.",
                    "invalid_request_error"
                );
            }

            const effectiveStreamMode = this._effectiveStreamMode(model, modelStreamingMode || systemStreamMode);
            const useRealStream = isOpenAIStream && effectiveStreamMode === "real";

            const googleEndpoint = useRealStream ? "streamGenerateContent" : "generateContent";
            const proxyRequest = {
                body: JSON.stringify(googleBody),
                headers: { "Content-Type": "application/json" },
                is_generative: true,
                method: "POST",
                path: `/v1beta/models/${model}:${googleEndpoint}`,
                query_params: useRealStream ? { alt: "sse" } : {},
                request_id: requestId,
                streaming_mode: useRealStream ? "real" : "fake",
                transport_policy: TransportPolicy.resolve(
                    model,
                    modelStreamingMode || systemStreamMode,
                    this.config.modelTransportPolicy
                ),
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            await this._ensureLegacyBenefit(proxyRequest);
            if (this.scheduled) {
                try {
                    await this._acquireScheduledLease(proxyRequest);
                } catch (error) {
                    return this._sendErrorResponse(res, error.status || 503, error.message, null, error);
                }
            }
            res.__proxyResponseStreamMode = isOpenAIStream ? (useRealStream ? "real" : "fake") : null;
            this._updateTrackedRequest(requestId, {
                isStreaming: isOpenAIStream,
                model,
                path: proxyRequest.path,
                requestCategory: "generation",
                ...(isOpenAIStream ? { streamMode: useRealStream ? "real" : "fake" } : {}),
            });

            try {
                // Create message queue inside try-catch to handle invalid authIndex
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this.currentAuthIndex,
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                if (useRealStream) {
                    let currentQueue = messageQueue;
                    let currentQueueAuthIndex = this.currentAuthIndex;
                    let initialMessage;
                    let skipFinalFailureSwitch = false;
                    const immediateSwitchTracker = this._createImmediateSwitchTracker(currentQueueAuthIndex);

                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        this._getUsageStatsService()?.recordAttempt(
                            proxyRequest.request_id,
                            currentQueueAuthIndex,
                            this._getAccountNameForIndex(currentQueueAuthIndex)
                        );
                        initialMessage = await this._sendAndReadInitial(
                            proxyRequest,
                            currentQueue,
                            currentQueueAuthIndex
                        );

                        const initialStatus = Number(initialMessage?.status);
                        if (
                            initialMessage.event_type === "error" &&
                            !isUserAbortedError(initialMessage) &&
                            Number.isFinite(initialStatus) &&
                            this._shouldRetryError(initialMessage, proxyRequest)
                        ) {
                            this.logger.warn(
                                `[Request] OpenAI Response API real stream received ${initialStatus}, preparing retry...`
                            );
                            this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

                            const retryPrepared = await this._prepareImmediateStatusRetry(
                                initialMessage,
                                requestId,
                                immediateSwitchTracker,
                                currentQueueAuthIndex
                            );
                            if (!retryPrepared) {
                                skipFinalFailureSwitch = true;
                                break;
                            }

                            try {
                                currentQueue.close(this._getImmediateStatusRetryCloseReason(initialStatus));
                            } catch {
                                /* empty */
                            }
                            this._advanceProxyRequestAttempt(proxyRequest);
                            currentQueue = this.connectionRegistry.createMessageQueue(
                                requestId,
                                this.currentAuthIndex,
                                proxyRequest.request_attempt_id
                            );
                            currentQueueAuthIndex = this.currentAuthIndex;
                            continue;
                        }

                        break;
                    }

                    if (initialMessage.event_type === "error") {
                        this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
                        this._logFinalRequestFailure(initialMessage, "OpenAI Response API real stream", requestId, {
                            afterRetries: false,
                        });

                        // Send standard HTTP error response
                        this._sendErrorResponse(
                            res,
                            initialMessage.status,
                            initialMessage.message,
                            null,
                            initialMessage
                        );

                        // Avoid switching account if the error is just a connection reset
                        if (!skipFinalFailureSwitch && !this._isConnectionResetError(initialMessage)) {
                            await this.authSwitcher.handleRequestFailureAndSwitch(initialMessage, null);
                        } else if (skipFinalFailureSwitch) {
                            this.logger.info(
                                "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                            );
                        } else {
                            this.logger.info(
                                "[Request] Failure due to connection reset (Real Stream), skipping account switch."
                            );
                        }
                        return;
                    }

                    if (this.authSwitcher.failureCount > 0) {
                        this.logger.debug(
                            `✅ [Auth] OpenAI Response API request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                        );
                        this.authSwitcher.failureCount = 0;
                    }

                    if (!res.headersSent) {
                        res.status(200).set({
                            "Cache-Control": "no-cache",
                            Connection: "keep-alive",
                            "Content-Type": "text/event-stream",
                            "X-Accel-Buffering": "no",
                        });
                    }
                    this.logger.info(`[Request] OpenAI Response API streaming response (Real Mode) started...`);
                    await this._streamOpenAIResponseAPIResponse(currentQueue, res, model, {
                        requestId,
                        responseDefaults,
                    });
                } else {
                    // OpenAI Response API Fake Stream / Non-Stream mode
                    // Set up keep-alive timer for fake stream mode to prevent client timeout
                    let connectionMaintainer;
                    if (isOpenAIStream) {
                        const scheduleNextKeepAlive = () => {
                            const randomInterval = 12000 + Math.floor(Math.random() * 6000); // 12 - 18 seconds
                            connectionMaintainer = setTimeout(() => {
                                if (!res.headersSent) {
                                    res.status(200).set({
                                        "Cache-Control": "no-cache",
                                        Connection: "keep-alive",
                                        "Content-Type": "text/event-stream",
                                        "X-Accel-Buffering": "no",
                                    });
                                }
                                if (!res.writableEnded) {
                                    res.write(": keep-alive\n\n");
                                    scheduleNextKeepAlive();
                                }
                            }, randomInterval);
                        };
                        scheduleNextKeepAlive();
                    }

                    try {
                        const result = await this._executeRequestWithRetries(proxyRequest, messageQueue);

                        if (!result.success) {
                            this._logFinalRequestFailure(
                                result.error,
                                "OpenAI Response API fake/non-stream",
                                requestId
                            );
                            // Send standard HTTP error response for both streaming and non-streaming
                            if (connectionMaintainer) clearTimeout(connectionMaintainer);
                            if (isOpenAIStream && res.headersSent) {
                                // If keep-alives already started the SSE response, send an SSE error event instead of JSON.
                                this._handleRequestError(result.error, res, requestId);
                            } else {
                                this._sendErrorResponse(
                                    res,
                                    result.error.status,
                                    result.error.message,
                                    null,
                                    result.error
                                );
                            }

                            // Avoid switching account if the error is just a connection reset
                            if (!result.error.skipAccountSwitch && !this._isConnectionResetError(result.error)) {
                                await this.authSwitcher.handleRequestFailureAndSwitch(result.error, null);
                            } else if (result.error.skipAccountSwitch) {
                                this.logger.info(
                                    "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                                );
                            } else {
                                this.logger.info(
                                    "[Request] Failure due to connection reset (Response API), skipping account switch."
                                );
                            }
                            return;
                        }

                        if (this.authSwitcher.failureCount > 0) {
                            this.logger.debug(
                                `✅ [Auth] OpenAI Response API request successful - failure count reset to 0`
                            );
                            this.authSwitcher.failureCount = 0;
                        }

                        // Use the queue that successfully received the initial message
                        const activeQueue = result.queue;

                        if (isOpenAIStream) {
                            // Fake stream - ensure headers are set before sending data
                            if (!res.headersSent) {
                                res.status(200).set({
                                    "Cache-Control": "no-cache",
                                    Connection: "keep-alive",
                                    "Content-Type": "text/event-stream",
                                    "X-Accel-Buffering": "no",
                                });
                            }
                            // Clear keep-alive timer as we are about to send real data
                            if (connectionMaintainer) clearTimeout(connectionMaintainer);

                            this.logger.info(`[Request] OpenAI Response API streaming response (Fake Mode) started...`);
                            let fullBody = "";
                            if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
                            let hadStreamError = false;
                            try {
                                // eslint-disable-next-line no-constant-condition
                                while (true) {
                                    const message = await activeQueue.dequeue(this.timeouts.FAKE_STREAM);
                                    if (message.type === "STREAM_END") {
                                        break;
                                    }

                                    if (message.event_type === "error") {
                                        this.logger.error(
                                            `❌ [Request] Error received during OpenAI Response API fake stream: ${message.message}`
                                        );
                                        this._markTrackedResponseError(res, message.message, 500);
                                        hadStreamError = true;
                                        // Check if response is still writable before attempting to write
                                        if (this._isResponseWritable(res)) {
                                            try {
                                                res.__responseApiSeq += 1;
                                                res.write(
                                                    `event: error\ndata: ${JSON.stringify({
                                                        code: "api_error",
                                                        message: message.message,
                                                        param: null,
                                                        sequence_number: res.__responseApiSeq,
                                                        type: "error",
                                                    })}\n\n`
                                                );
                                            } catch (writeError) {
                                                this.logger.debug(
                                                    `❌ [Request] Failed to write error to OpenAI Response API fake stream: ${writeError.message}`
                                                );
                                            }
                                        }
                                        break;
                                    }

                                    if (message.data) fullBody += message.data;
                                }

                                // If backend errored, don't attempt to translate/send a "normal" Responses stream afterwards.
                                if (hadStreamError) {
                                    return;
                                }

                                const streamState = {};
                                streamState.responseDefaults = responseDefaults;
                                const translatedChunk = this.formatConverter.translateGoogleToResponseAPIStream(
                                    fullBody,
                                    model,
                                    streamState
                                );
                                if (this._isResponseWritable(res)) {
                                    try {
                                        if (translatedChunk) {
                                            res.write(translatedChunk);
                                        }
                                    } catch (writeError) {
                                        this.logger.debug(
                                            `[Request] Failed to write final fake OpenAI Response API stream chunks: ${writeError.message}`
                                        );
                                    }
                                } else {
                                    this.logger.debug(
                                        "[Request] Response no longer writable before final fake OpenAI Response API stream chunks."
                                    );
                                }
                                this.logger.info(
                                    `✅ [Request] Response completed (OpenAI Response API fake stream), request ID: ${requestId}`
                                );
                            } catch (error) {
                                // Classify error type and send appropriate response
                                this._handleFakeStreamError(error, res);
                            }
                        } else {
                            // Non-stream
                            await this._sendOpenAIResponseAPINonStreamResponse(
                                activeQueue,
                                res,
                                model,
                                requestId,
                                responseDefaults
                            );
                        }
                    } finally {
                        if (connectionMaintainer) clearTimeout(connectionMaintainer);
                    }
                }
            } catch (error) {
                // Handle queue timeout by notifying browser
                this._handleQueueTimeout(error, requestId);

                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (this.needsSwitchingAfterRequest) {
                    this.logger.info(
                        `[Auth] Rotation count reached switching threshold (${this.authSwitcher.usageCount}/${this.config.switchOnUses}), will automatically switch account in background...`
                    );
                    this.authSwitcher.switchToNextAuth().catch(err => {
                        this.logger.error(`[Auth] Background account switching task failed: ${err.message}`);
                    });
                    this.needsSwitchingAfterRequest = false;
                }
                if (!res.writableEnded) res.end();
            }
        } catch (error) {
            this._handleRequestError(error, res, requestId);
        } finally {
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    // Process Claude API format requests
    async processClaudeRequest(req, res) {
        if (this._rejectUnsupportedAntiRequest(req, res, "claude")) return;
        if (this.serverSystem.scheduler && !this.scheduled) {
            return require("./ScheduledRequestHandler").dispatch(this, "processClaudeRequest", req, res);
        }
        const requestId = this._generateRequestId();
        if (!res.headersSent) res.setHeader("X-Request-ID", requestId);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "claude",
            isStreaming: req.body.stream === true,
            requestCategory: "generation",
            streamMode:
                req.body.stream === true
                    ? this.config.streamingMode === "early"
                        ? "fake"
                        : this.config.streamingMode
                    : null,
        });
        this._setResponseApiFormat(res, "claude");
        res.__proxyResponseStreamMode = null;

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res, { waitErrorType: "overloaded_error" }))) {
                return;
            }

            const isClaudeStream = req.body.stream === true;
            const systemStreamMode = this.config.streamingMode;

            // Handle usage counting
            const usageCount = this.authSwitcher.incrementUsageCount();
            if (usageCount > 0) {
                const rotationCountText =
                    this.config.switchOnUses > 0 ? `${usageCount}/${this.config.switchOnUses}` : `${usageCount}`;
                this.logger.info(
                    `[Request] Claude generation request - account rotation count: ${rotationCountText} (Current account: ${this.currentAuthIndex}), request ID: ${requestId}`
                );
                if (this.authSwitcher.shouldSwitchByUsage()) {
                    this.needsSwitchingAfterRequest = true;
                }
            }

            // Translate Claude format to Google format
            let googleBody, model, modelStreamingMode;
            try {
                const result = await this.formatConverter.translateClaudeToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
                modelStreamingMode = result.modelStreamingMode || null;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] Claude request translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(res, 400, "Invalid Claude request format.", "invalid_request_error");
            }

            const effectiveStreamMode = this._effectiveStreamMode(model, modelStreamingMode || systemStreamMode);
            const useRealStream = isClaudeStream && effectiveStreamMode === "real";

            const googleEndpoint = useRealStream ? "streamGenerateContent" : "generateContent";
            const proxyRequest = {
                body: JSON.stringify(googleBody),
                headers: { "Content-Type": "application/json" },
                is_generative: true,
                method: "POST",
                path: `/v1beta/models/${model}:${googleEndpoint}`,
                query_params: useRealStream ? { alt: "sse" } : {},
                request_id: requestId,
                streaming_mode: useRealStream ? "real" : "fake",
                transport_policy: TransportPolicy.resolve(
                    model,
                    modelStreamingMode || systemStreamMode,
                    this.config.modelTransportPolicy
                ),
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            await this._ensureLegacyBenefit(proxyRequest);
            if (this.scheduled) {
                try {
                    await this._acquireScheduledLease(proxyRequest);
                } catch (error) {
                    return this._sendErrorResponse(res, error.status || 503, error.message, null, error);
                }
            }
            res.__proxyResponseStreamMode = isClaudeStream ? (useRealStream ? "real" : "fake") : null;
            this._updateTrackedRequest(requestId, {
                isStreaming: isClaudeStream,
                model,
                path: proxyRequest.path,
                requestCategory: "generation",
                ...(isClaudeStream ? { streamMode: useRealStream ? "real" : "fake" } : {}),
            });

            try {
                // Create message queue inside try-catch to handle invalid authIndex
                const messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this.currentAuthIndex,
                    proxyRequest.request_attempt_id
                );
                this._setupClientDisconnectHandler(res, requestId);

                if (useRealStream) {
                    let currentQueue = messageQueue;
                    let currentQueueAuthIndex = this.currentAuthIndex;
                    let initialMessage;
                    let skipFinalFailureSwitch = false;
                    const immediateSwitchTracker = this._createImmediateSwitchTracker(currentQueueAuthIndex);

                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        this._getUsageStatsService()?.recordAttempt(
                            proxyRequest.request_id,
                            currentQueueAuthIndex,
                            this._getAccountNameForIndex(currentQueueAuthIndex)
                        );
                        initialMessage = await this._sendAndReadInitial(
                            proxyRequest,
                            currentQueue,
                            currentQueueAuthIndex
                        );

                        const initialStatus = Number(initialMessage?.status);
                        if (
                            initialMessage.event_type === "error" &&
                            !isUserAbortedError(initialMessage) &&
                            Number.isFinite(initialStatus) &&
                            this._shouldRetryError(initialMessage, proxyRequest)
                        ) {
                            this.logger.warn(
                                `[Request] Claude real stream received ${initialStatus}, preparing retry...`
                            );
                            this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

                            const retryPrepared = await this._prepareImmediateStatusRetry(
                                initialMessage,
                                requestId,
                                immediateSwitchTracker,
                                currentQueueAuthIndex
                            );
                            if (!retryPrepared) {
                                skipFinalFailureSwitch = true;
                                break;
                            }

                            try {
                                currentQueue.close(this._getImmediateStatusRetryCloseReason(initialStatus));
                            } catch {
                                /* empty */
                            }
                            this._advanceProxyRequestAttempt(proxyRequest);
                            currentQueue = this.connectionRegistry.createMessageQueue(
                                requestId,
                                this.currentAuthIndex,
                                proxyRequest.request_attempt_id
                            );
                            currentQueueAuthIndex = this.currentAuthIndex;
                            continue;
                        }

                        break;
                    }

                    if (initialMessage.event_type === "error") {
                        this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
                        this._logFinalRequestFailure(initialMessage, "Claude real stream", requestId, {
                            afterRetries: false,
                        });
                        this._sendErrorResponse(res, initialMessage.status || 500, initialMessage.message, "api_error");
                        if (!skipFinalFailureSwitch && !this._isConnectionResetError(initialMessage)) {
                            await this.authSwitcher.handleRequestFailureAndSwitch(initialMessage, null);
                        } else if (skipFinalFailureSwitch) {
                            this.logger.info(
                                "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                            );
                        }
                        return;
                    }

                    if (this.authSwitcher.failureCount > 0) {
                        this.logger.debug(`✅ [Auth] Claude request successful - failure count reset to 0`);
                        this.authSwitcher.failureCount = 0;
                    }

                    if (!res.headersSent) {
                        res.status(200).set({
                            "Cache-Control": "no-cache",
                            Connection: "keep-alive",
                            "Content-Type": "text/event-stream",
                            "X-Accel-Buffering": "no",
                        });
                    }
                    this.logger.info(`[Request] Claude streaming response (Real Mode) started...`);
                    await this._streamClaudeResponse(currentQueue, res, model, requestId);
                } else {
                    // Claude Fake Stream / Non-Stream mode
                    let connectionMaintainer;
                    if (isClaudeStream) {
                        const scheduleNextKeepAlive = () => {
                            const randomInterval = 12000 + Math.floor(Math.random() * 6000);
                            connectionMaintainer = setTimeout(() => {
                                if (!res.headersSent) {
                                    res.status(200).set({
                                        "Cache-Control": "no-cache",
                                        Connection: "keep-alive",
                                        "Content-Type": "text/event-stream",
                                        "X-Accel-Buffering": "no",
                                    });
                                }
                                if (!res.writableEnded) {
                                    res.write("event: ping\ndata: {}\n\n");
                                    scheduleNextKeepAlive();
                                }
                            }, randomInterval);
                        };
                        scheduleNextKeepAlive();
                    }

                    try {
                        const result = await this._executeRequestWithRetries(proxyRequest, messageQueue);

                        if (!result.success) {
                            this._logFinalRequestFailure(result.error, "Claude fake/non-stream", requestId);
                            if (connectionMaintainer) clearTimeout(connectionMaintainer);
                            if (isClaudeStream && res.headersSent) {
                                // If keep-alives already started the SSE response, send an SSE error event instead of JSON.
                                this._handleRequestError(result.error, res, requestId);
                            } else {
                                this._sendErrorResponse(
                                    res,
                                    result.error.status || 500,
                                    result.error.message,
                                    "api_error"
                                );
                            }
                            if (!result.error.skipAccountSwitch && !this._isConnectionResetError(result.error)) {
                                await this.authSwitcher.handleRequestFailureAndSwitch(result.error, null);
                            } else if (result.error.skipAccountSwitch) {
                                this.logger.info(
                                    "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                                );
                            }
                            return;
                        }

                        if (this.authSwitcher.failureCount > 0) {
                            this.logger.debug(`✅ [Auth] Claude request successful - failure count reset to 0`);
                            this.authSwitcher.failureCount = 0;
                        }

                        // Use the queue that successfully received the initial message
                        const activeQueue = result.queue;

                        if (isClaudeStream) {
                            // Fake stream
                            if (!res.headersSent) {
                                res.status(200).set({
                                    "Cache-Control": "no-cache",
                                    Connection: "keep-alive",
                                    "Content-Type": "text/event-stream",
                                    "X-Accel-Buffering": "no",
                                });
                            }
                            if (connectionMaintainer) clearTimeout(connectionMaintainer);

                            this.logger.info(`[Request] Claude streaming response (Fake Mode) started...`);
                            let fullBody = "";
                            let hadStreamError = false;
                            try {
                                // eslint-disable-next-line no-constant-condition
                                while (true) {
                                    const message = await activeQueue.dequeue(this.timeouts.FAKE_STREAM);
                                    if (message.type === "STREAM_END") {
                                        break;
                                    }

                                    if (message.event_type === "error") {
                                        this.logger.error(
                                            `❌ [Request] Error received during Claude fake stream: ${message.message}`
                                        );
                                        this._markTrackedResponseError(res, message.message, 500);
                                        hadStreamError = true;
                                        // Check if response is still writable before attempting to write
                                        if (this._isResponseWritable(res)) {
                                            try {
                                                res.write(
                                                    `event: error\ndata: ${JSON.stringify({
                                                        error: {
                                                            message: message.message,
                                                            type: "api_error",
                                                        },
                                                        type: "error",
                                                    })}\n\n`
                                                );
                                            } catch (writeError) {
                                                this.logger.debug(
                                                    `❌ [Request] Failed to write error to Claude fake stream: ${writeError.message}`
                                                );
                                            }
                                        }
                                        break;
                                    }

                                    if (message.data) fullBody += message.data;
                                }
                                if (hadStreamError) {
                                    // Backend errored; don't attempt to translate/send a "normal" stream afterwards.
                                    return;
                                }
                                const streamState = {};
                                const translatedChunk = this.formatConverter.translateGoogleToClaudeStream(
                                    fullBody,
                                    model,
                                    streamState
                                );
                                if (this._isResponseWritable(res)) {
                                    try {
                                        if (translatedChunk) {
                                            res.write(translatedChunk);
                                        }
                                    } catch (writeError) {
                                        this.logger.debug(
                                            `[Request] Failed to write final fake Claude stream chunk: ${writeError.message}`
                                        );
                                    }
                                } else {
                                    this.logger.debug(
                                        "[Request] Response no longer writable before final fake Claude stream chunk."
                                    );
                                }
                                this.logger.info(
                                    `✅ [Request] Response completed (Claude fake stream), request ID: ${requestId}`
                                );
                            } catch (error) {
                                // Classify error type and send appropriate response
                                this._handleFakeStreamError(error, res);
                            }
                        } else {
                            // Non-stream
                            await this._sendClaudeNonStreamResponse(activeQueue, res, model, requestId);
                        }
                    } finally {
                        if (connectionMaintainer) clearTimeout(connectionMaintainer);
                    }
                }
            } catch (error) {
                // Handle queue timeout by notifying browser
                this._handleQueueTimeout(error, requestId);

                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (this.needsSwitchingAfterRequest) {
                    this.logger.info(
                        `[Auth] Rotation count reached switching threshold (${this.authSwitcher.usageCount}/${this.config.switchOnUses}), will automatically switch account in background...`
                    );
                    this.authSwitcher.switchToNextAuth().catch(err => {
                        this.logger.error(`[Auth] Background account switching task failed: ${err.message}`);
                    });
                    this.needsSwitchingAfterRequest = false;
                }
                if (!res.writableEnded) res.end();
            }
        } catch (error) {
            this._handleRequestError(error, res, requestId);
        } finally {
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    // Process Claude count tokens request
    async processClaudeCountTokens(req, res) {
        if (this.serverSystem.scheduler && !this.scheduled) {
            return require("./ScheduledRequestHandler").dispatch(this, "processClaudeCountTokens", req, res);
        }
        const requestId = this._generateRequestId();
        if (!res.headersSent) res.setHeader("X-Request-ID", requestId);
        this.logger.info(`[Request] Claude count tokens request started, request ID: ${requestId}`);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "claude",
            isStreaming: false,
            requestCategory: "count_tokens",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "claude");

        try {
            if (!(await this._ensureBrowserBackedRequestReady(res, { waitErrorType: "overloaded_error" }))) {
                return;
            }

            // Translate Claude format to Google format
            let googleBody, model;
            try {
                const result = await this.formatConverter.translateClaudeToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] Claude request translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(res, 400, "Invalid Claude request format.", "invalid_request_error");
            }

            // Build countTokens request
            // Per Gemini API docs, countTokens accepts:
            // - contents[] (simple mode)
            // - generateContentRequest (full request with model, contents, tools, systemInstruction, etc.)
            const countTokensBody = {
                generateContentRequest: {
                    model: `models/${model}`,
                    ...googleBody,
                },
            };

            const proxyRequest = {
                body: JSON.stringify(countTokensBody),
                headers: { "Content-Type": "application/json" },
                is_generative: false,
                method: "POST",
                path: `/v1beta/models/${model}:countTokens`,
                query_params: {},
                request_id: requestId,
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            await this._ensureLegacyBenefit(proxyRequest);
            if (this.scheduled) {
                try {
                    await this._acquireScheduledLease(proxyRequest);
                } catch (error) {
                    return this._sendErrorResponse(res, error.status || 503, error.message, null, error);
                }
            }
            this._updateTrackedRequest(requestId, {
                model,
                path: proxyRequest.path,
                requestCategory: "count_tokens",
            });

            try {
                // Create message queue inside try-catch to handle invalid authIndex
                let messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this.currentAuthIndex,
                    proxyRequest.request_attempt_id
                );
                const messageQueueAuthIndex =
                    this.connectionRegistry.getAuthIndexForRequest(requestId) ?? this.currentAuthIndex;
                this._setupClientDisconnectHandler(res, requestId);

                let response;
                if (this.scheduled) {
                    const result = await this._executeRequestWithRetries(proxyRequest, messageQueue);
                    response = result.success ? result.message : { ...result.error, event_type: "error" };
                    messageQueue = result.queue || messageQueue;
                } else {
                    this._getUsageStatsService()?.recordAttempt(
                        requestId,
                        messageQueueAuthIndex,
                        this._getAccountNameForIndex(messageQueueAuthIndex)
                    );
                    this._forwardRequest(proxyRequest, messageQueueAuthIndex);
                    response = await messageQueue.dequeue();
                }

                if (response.event_type === "error") {
                    this.logger.error(
                        `❌ [Request] Received error from browser, will trigger switching logic. Status code: ${response.status}, message: ${response.message}`
                    );
                    this._sendErrorResponse(res, response.status || 500, response.message, "api_error");
                    if (!this._isConnectionResetError(response)) {
                        await this.authSwitcher.handleRequestFailureAndSwitch(response, null);
                    }
                    return;
                }

                // For non-streaming requests, consume all chunks until STREAM_END
                let fullBody = "";
                if (response.type !== "STREAM_END") {
                    if (response.data) fullBody += response.data;
                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        const message = await messageQueue.dequeue();
                        if (message.type === "STREAM_END") {
                            break;
                        }
                        if (message.event_type === "error") {
                            this.logger.error(`❌ [Request] Error received during count tokens: ${message.message}`);
                            this._markTrackedResponseError(res, message.message, 500);
                            return this._sendErrorResponse(res, 500, message.message, "api_error");
                        }
                        if (message.data) fullBody += message.data;
                    }
                }

                // Parse Gemini response
                const geminiResponse = JSON.parse(fullBody || response.body);
                const totalTokens = geminiResponse.totalTokens || 0;

                // Reset failure count on success
                if (this.authSwitcher.failureCount > 0) {
                    this.logger.debug(
                        `✅ [Auth] Count tokens request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                    );
                    this.authSwitcher.failureCount = 0;
                }

                // Return Claude-compatible response
                res.status(200).json({
                    input_tokens: totalTokens,
                });

                this.logger.info(
                    `✅ [Request] Response completed (Claude count_tokens, input tokens: ${totalTokens}), request ID: ${requestId}`
                );
            } catch (error) {
                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (!res.writableEnded) res.end();
            }
        } catch (error) {
            this._handleRequestError(error, res, requestId);
        } finally {
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    // OpenAI Response API count input tokens endpoint
    // Mirrors OpenAI's /v1/responses/input_tokens by returning only the request-side token count.
    async processOpenAIResponseInputTokens(req, res) {
        if (this.serverSystem.scheduler && !this.scheduled) {
            return require("./ScheduledRequestHandler").dispatch(this, "processOpenAIResponseInputTokens", req, res);
        }
        const requestId = this._generateRequestId();
        if (!res.headersSent) res.setHeader("X-Request-ID", requestId);
        this.logger.info(`[Request] OpenAI Response input_tokens request started, request ID: ${requestId}`);
        this._startTrackedRequest(requestId, req, {
            apiFormat: "response_api",
            isStreaming: false,
            requestCategory: "count_tokens",
            streamMode: null,
        });
        this._setResponseApiFormat(res, "response_api");

        try {
            if (!(await this._ensureRequestReady(res))) {
                return;
            }

            // Translate OpenAI Response format to Google format (so we can use Gemini countTokens)
            let googleBody, model;
            try {
                const result = await this.formatConverter.translateOpenAIResponseToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
            } catch (error) {
                this.logger.error(
                    `❌ [Adapter] OpenAI Response input_tokens translation failed: ${error.message}, request ID: ${requestId}`
                );
                return this._sendErrorResponse(
                    res,
                    400,
                    "Invalid OpenAI Response request format.",
                    "invalid_request_error"
                );
            }

            // Gemini countTokens accepts either:
            // - contents[]
            // - generateContentRequest (full request; required here because tools/systemInstruction/etc may be present)
            const countTokensBody = {
                generateContentRequest: {
                    model: `models/${model}`,
                    ...googleBody,
                },
            };

            const proxyRequest = {
                body: JSON.stringify(countTokensBody),
                headers: { "Content-Type": "application/json" },
                is_generative: false,
                method: "POST",
                path: `/v1beta/models/${model}:countTokens`,
                query_params: {},
                request_id: requestId,
            };
            this._initializeProxyRequestAttempt(proxyRequest);
            await this._ensureLegacyBenefit(proxyRequest);
            if (this.scheduled) {
                try {
                    await this._acquireScheduledLease(proxyRequest);
                } catch (error) {
                    return this._sendErrorResponse(res, error.status || 503, error.message, null, error);
                }
            }
            this._updateTrackedRequest(requestId, {
                model,
                path: proxyRequest.path,
                requestCategory: "count_tokens",
            });

            try {
                let messageQueue = this.connectionRegistry.createMessageQueue(
                    requestId,
                    this.currentAuthIndex,
                    proxyRequest.request_attempt_id
                );
                const messageQueueAuthIndex =
                    this.connectionRegistry.getAuthIndexForRequest(requestId) ?? this.currentAuthIndex;
                this._setupClientDisconnectHandler(res, requestId);

                let response;
                if (this.scheduled) {
                    const result = await this._executeRequestWithRetries(proxyRequest, messageQueue);
                    response = result.success ? result.message : { ...result.error, event_type: "error" };
                    messageQueue = result.queue || messageQueue;
                } else {
                    this._getUsageStatsService()?.recordAttempt(
                        requestId,
                        messageQueueAuthIndex,
                        this._getAccountNameForIndex(messageQueueAuthIndex)
                    );
                    this._forwardRequest(proxyRequest, messageQueueAuthIndex);
                    response = await messageQueue.dequeue();
                }

                if (response.event_type === "error") {
                    this.logger.error(
                        `❌ [Request] Received error from browser for input_tokens, will trigger switching logic. Status code: ${response.status}, message: ${response.message}`
                    );

                    this._sendErrorResponse(res, response.status, response.message, null, response);

                    // Avoid switching account if the error is just a connection reset
                    if (!this._isConnectionResetError(response)) {
                        await this.authSwitcher.handleRequestFailureAndSwitch(response, null);
                    } else {
                        this.logger.info(
                            "[Request] Failure due to connection reset (input_tokens), skipping account switch."
                        );
                    }
                    return;
                }

                // For non-streaming requests, consume all chunks until STREAM_END
                let fullBody = "";
                if (response.type !== "STREAM_END") {
                    if (response.data) fullBody += response.data;
                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        const message = await messageQueue.dequeue();
                        if (message.type === "STREAM_END") {
                            break;
                        }
                        if (message.event_type === "error") {
                            this.logger.error(
                                `❌ [Request] Error received during input_tokens count: ${message.message}`
                            );
                            this._markTrackedResponseError(res, message.message, 500);
                            this._sendErrorResponse(res, 500, message.message);
                            return;
                        }
                        if (message.data) fullBody += message.data;
                    }
                }

                // Parse Gemini response
                let geminiResponse;
                try {
                    geminiResponse = JSON.parse(fullBody || response.body);
                } catch (parseError) {
                    this.logger.error(`❌ [Request] Failed to parse countTokens response: ${parseError.message}`);
                    this._sendErrorResponse(res, 500, "Failed to parse backend response");
                    return;
                }

                const totalTokens = geminiResponse.totalTokens || 0;

                // Reset failure count on success
                if (this.authSwitcher.failureCount > 0) {
                    this.logger.debug(
                        `✅ [Auth] input_tokens request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                    );
                    this.authSwitcher.failureCount = 0;
                }

                res.status(200).json({
                    input_tokens: totalTokens,
                });

                this.logger.info(
                    `✅ [Request] Response completed (OpenAI Response input_tokens, input tokens: ${totalTokens}), request ID: ${requestId}`
                );
            } catch (error) {
                this._handleRequestError(error, res, requestId);
            } finally {
                this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
                if (!res.writableEnded) res.end();
            }
        } catch (error) {
            this._handleRequestError(error, res, requestId);
        } finally {
            this._finalizeTrackedRequest(requestId, res);
        }
    }

    // === Response Handlers ===

    async _streamClaudeResponse(messageQueue, res, model, requestId) {
        const streamState = {};

        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const message = await messageQueue.dequeue(this.timeouts.STREAM_CHUNK);

                if (message.type === "STREAM_END") {
                    this.logger.info(`✅ [Request] Response completed (Claude real stream), request ID: ${requestId}`);
                    break;
                }

                if (message.event_type === "error") {
                    this.logger.error(`❌ [Request] Error received during Claude stream: ${message.message}`);
                    this._markTrackedResponseError(res, message.message, 500);
                    // Attempt to send error event to client if headers allowed, then close
                    // Check if response is still writable before attempting to write
                    if (this._isResponseWritable(res)) {
                        try {
                            res.write(
                                `event: error\ndata: ${JSON.stringify({
                                    error: {
                                        message: message.message,
                                        type: "api_error",
                                    },
                                    type: "error",
                                })}\n\n`
                            );
                        } catch (writeError) {
                            this.logger.debug(
                                `❌ [Request] Failed to write error to Claude stream: ${writeError.message}`
                            );
                        }
                    }
                    break;
                }

                if (message.data) {
                    const claudeChunk = this.formatConverter.translateGoogleToClaudeStream(
                        message.data,
                        model,
                        streamState
                    );
                    if (claudeChunk) {
                        // Before writing, ensure the response is still writable to avoid
                        // throwing if the client disconnected mid-stream.
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Claude stream; stopping stream."
                            );
                            break;
                        }
                        try {
                            res.write(claudeChunk);
                            if (message.hasModelContent) res.__modelOutputStarted = true;
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Claude chunk to stream: ${writeError.message}`
                            );
                            // Stop streaming on write failure to avoid misclassifying as a timeout.
                            break;
                        }
                    }
                }
            }
        } catch (error) {
            // Only handle connection reset errors here (client disconnect)
            // Let other errors (timeout, parsing, logic errors) propagate to outer catch
            if (this._isConnectionResetError(error)) {
                this._handleRealStreamQueueClosedError(error, res);
                return;
            }

            // Re-throw all other errors to be handled by outer catch block
            throw error;
        }
    }

    async _sendClaudeNonStreamResponse(messageQueue, res, model, requestId) {
        let fullBody = "";
        let receiving = true;
        while (receiving) {
            const message = await messageQueue.dequeue(this.timeouts.FAKE_STREAM);
            if (message.type === "STREAM_END") {
                this.logger.debug("[Request] Claude received end signal.");
                receiving = false;
                break;
            }

            if (message.event_type === "error") {
                this.logger.error(`❌ [Adapter] Error during Claude non-stream conversion: ${message.message}`);
                this._sendErrorResponse(res, 500, message.message, "api_error");
                return;
            }

            if (message.event_type === "chunk" && message.data) {
                fullBody += message.data;
            }
        }

        try {
            const googleResponse = JSON.parse(fullBody);
            const claudeResponse = this.formatConverter.convertGoogleToClaudeNonStream(googleResponse, model);
            res.type("application/json").send(JSON.stringify(claudeResponse));
            this.logger.info(`✅ [Request] Response completed (Claude non-stream), request ID: ${requestId}`);
        } catch (e) {
            this.logger.error(`❌ [Adapter] Failed to parse response for Claude: ${e.message}`);
            this._sendErrorResponse(res, 500, "Failed to parse backend response", "api_error");
        }
    }

    async _handlePseudoStreamResponse(proxyRequest, messageQueue, req, res) {
        // Per user request, convert the backend call to non-streaming.
        proxyRequest.path = proxyRequest.path.replace(":streamGenerateContent", ":generateContent");
        if (proxyRequest.query_params && proxyRequest.query_params.alt) {
            delete proxyRequest.query_params.alt;
        }

        let connectionMaintainer;
        const scheduleNextKeepAlive = () => {
            const randomInterval = 12000 + Math.floor(Math.random() * 6000); // 12 - 18 seconds
            connectionMaintainer = setTimeout(() => {
                if (!res.headersSent) {
                    res.setHeader("Content-Type", "text/event-stream");
                    res.setHeader("Cache-Control", "no-cache");
                    res.setHeader("Connection", "keep-alive");
                }
                if (!res.writableEnded) {
                    res.write(": keep-alive\n\n");
                    scheduleNextKeepAlive();
                }
            }, randomInterval);
        };
        scheduleNextKeepAlive();

        try {
            const result = await this._executeRequestWithRetries(proxyRequest, messageQueue);

            if (!result.success) {
                clearTimeout(connectionMaintainer);

                if (isUserAbortedError(result.error)) {
                    this.logger.debug(
                        `[Request] Request #${proxyRequest.request_id} was properly cancelled by user, not counted in failure statistics.`
                    );
                } else {
                    this._logFinalRequestFailure(result.error, "Gemini fake stream", proxyRequest.request_id);
                    // If keep-alives already started the SSE response, send an SSE error event instead of JSON.
                    if (res.headersSent) {
                        this._handleRequestError(result.error, res, proxyRequest.request_id);
                    } else {
                        this._sendErrorResponse(res, result.error.status, result.error.message, null, result.error);
                    }

                    // Avoid switching account if the error is just a connection reset
                    if (!result.error.skipAccountSwitch && !this._isConnectionResetError(result.error)) {
                        await this.authSwitcher.handleRequestFailureAndSwitch(result.error, null);
                    } else if (result.error.skipAccountSwitch) {
                        this.logger.info(
                            "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                        );
                    } else {
                        this.logger.info(
                            "[Request] Failure due to connection reset (Gemini Non-Stream), skipping account switch."
                        );
                    }
                }
                return;
            }

            if (proxyRequest.is_generative && this.authSwitcher.failureCount > 0) {
                this.logger.debug(
                    `✅ [Auth] Generation request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                );
                this.authSwitcher.failureCount = 0;
            }

            // Use the queue that successfully received the initial message
            const activeQueue = result.queue;

            if (!res.headersSent) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
            }
            // Clear the keep-alive timer as we are about to send real data
            clearTimeout(connectionMaintainer);
            this.logger.info(`[Request] Gemini streaming response (Fake Mode) started...`);

            // Read all data chunks until STREAM_END to handle potential fragmentation
            let fullData = "";
            let hadStreamError = false;
            try {
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    const message = await activeQueue.dequeue(this.timeouts.FAKE_STREAM); // 5 min timeout for fake streaming
                    if (message.type === "STREAM_END") {
                        break;
                    }

                    if (message.event_type === "error") {
                        this.logger.error(
                            `❌ [Request] Error received during Gemini pseudo-stream: ${message.message}`
                        );
                        this._markTrackedResponseError(res, message.message, 500);
                        hadStreamError = true;
                        this._handleRequestError(message, res, proxyRequest.request_id);
                        break;
                    }

                    if (message.data) {
                        fullData += message.data;
                    }
                }
            } catch (error) {
                // Handle timeout or other errors during streaming
                // Don't attempt to write if it's a connection reset or if response is destroyed
                if (!this._isConnectionResetError(error)) {
                    // Classify error type and send appropriate response
                    this._handleFakeStreamError(error, res);
                } else {
                    this.logger.debug(
                        "[Request] Gemini pseudo-stream interrupted by connection reset, skipping error write"
                    );
                }
                // Return early to prevent JSON parsing of incomplete data
                return;
            }
            if (hadStreamError) {
                // Backend errored; don't attempt to parse/split/send "normal" chunks afterwards.
                return;
            }

            try {
                const googleResponse = JSON.parse(fullData);
                this._logGeminiNativeResponseDebug(googleResponse, "pseudo-stream");
                const candidate = googleResponse.candidates?.[0];

                if (candidate && candidate.content && Array.isArray(candidate.content.parts)) {
                    this.logger.debug(
                        "[Request] Splitting full Gemini response into 'thought' and 'content' chunks for pseudo-stream."
                    );

                    const thinkingParts = candidate.content.parts.filter(p => p.thought === true);
                    const contentParts = candidate.content.parts.filter(p => p.thought !== true);
                    const role = candidate.content.role || "model";

                    // Send thinking part first
                    if (thinkingParts.length > 0) {
                        const thinkingResponse = {
                            candidates: [
                                {
                                    content: {
                                        parts: thinkingParts,
                                        role,
                                    },
                                    // We don't include finishReason here
                                },
                            ],
                            // We don't include usageMetadata here
                        };
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Gemini stream (thinking parts); stopping stream."
                            );
                            return;
                        }
                        try {
                            res.write(`data: ${JSON.stringify(thinkingResponse)}\n\n`);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Gemini thinking chunk to stream: ${writeError.message}`
                            );
                            return;
                        }
                        this.logger.debug(`[Request] Sent ${thinkingParts.length} thinking part(s).`);
                    }

                    // Then send content part
                    if (contentParts.length > 0) {
                        const contentResponse = {
                            candidates: [
                                {
                                    content: {
                                        parts: contentParts,
                                        role,
                                    },
                                    finishReason: candidate.finishReason,
                                    // Other candidate fields can be preserved if needed
                                },
                            ],
                            usageMetadata: googleResponse.usageMetadata,
                        };
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Gemini stream (content parts); stopping stream."
                            );
                            return;
                        }
                        try {
                            res.write(`data: ${JSON.stringify(contentResponse)}\n\n`);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Gemini content chunk to stream: ${writeError.message}`
                            );
                            return;
                        }
                        this.logger.debug(`[Request] Sent ${contentParts.length} content part(s).`);
                    } else if (candidate.finishReason) {
                        // If there's no content but a finish reason, send an empty content message with it
                        const finalResponse = {
                            candidates: [
                                {
                                    content: { parts: [], role },
                                    finishReason: candidate.finishReason,
                                },
                            ],
                            usageMetadata: googleResponse.usageMetadata,
                        };
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Gemini stream (final response); stopping stream."
                            );
                            return;
                        }
                        try {
                            res.write(`data: ${JSON.stringify(finalResponse)}\n\n`);
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Gemini final chunk to stream: ${writeError.message}`
                            );
                            return;
                        }
                    }
                } else if (fullData) {
                    // Fallback for responses without candidates or parts, or if parsing fails
                    this.logger.warn(
                        "[Request] Response structure not recognized for splitting, sending as a single chunk."
                    );
                    if (!this._isResponseWritable(res)) {
                        this.logger.debug(
                            "[Request] Response no longer writable during Gemini stream (fallback); stopping stream."
                        );
                        return;
                    }
                    try {
                        res.write(`data: ${fullData}\n\n`);
                    } catch (writeError) {
                        this.logger.debug(
                            `[Request] Failed to write Gemini fallback chunk to stream: ${writeError.message}`
                        );
                        return;
                    }
                }
            } catch (e) {
                this.logger.error(
                    `❌ [Request] Failed to parse and split Gemini response: ${e.message}. Sending raw data.`
                );
                if (fullData) {
                    if (!this._isResponseWritable(res)) {
                        this.logger.debug(
                            "[Request] Response no longer writable during Gemini stream (error fallback); stopping stream."
                        );
                        return;
                    }
                    try {
                        res.write(`data: ${fullData}\n\n`);
                    } catch (writeError) {
                        this.logger.debug(
                            `[Request] Failed to write Gemini error fallback chunk to stream: ${writeError.message}`
                        );
                        return;
                    }
                }
            }

            this.logger.info(
                `✅ [Request] Response completed (Gemini fake stream), request ID: ${proxyRequest.request_id}`
            );
        } catch (error) {
            this._handleRequestError(error, res, proxyRequest.request_id);
        } finally {
            clearTimeout(connectionMaintainer);
            if (!res.writableEnded) {
                res.end();
            }
            this.logger.debug(
                `[Request] Pseudo-stream response processing ended, request ID: ${proxyRequest.request_id}`
            );
        }
    }

    async _handleRealStreamResponse(proxyRequest, messageQueue, req, res) {
        let currentQueue = messageQueue;
        let currentQueueAuthIndex = this.currentAuthIndex;
        let headerMessage;
        let skipFinalFailureSwitch = false;
        const immediateSwitchTracker = this._createImmediateSwitchTracker(currentQueueAuthIndex);

        // eslint-disable-next-line no-constant-condition
        while (true) {
            // Record attempt before forwarding, so failed attempts are also counted
            this._getUsageStatsService()?.recordAttempt(
                proxyRequest.request_id,
                currentQueueAuthIndex,
                this._getAccountNameForIndex(currentQueueAuthIndex)
            );
            headerMessage = await this._sendAndReadInitial(proxyRequest, currentQueue, currentQueueAuthIndex);

            const headerStatus = Number(headerMessage?.status);
            if (
                headerMessage.event_type === "error" &&
                proxyRequest.is_generative &&
                !isUserAbortedError(headerMessage) &&
                Number.isFinite(headerStatus) &&
                this._shouldRetryError(headerMessage)
            ) {
                this.logger.warn(`[Request] Gemini real stream received ${headerStatus}, preparing retry...`);
                this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

                const retryPrepared = await this._prepareImmediateStatusRetry(
                    headerMessage,
                    proxyRequest.request_id,
                    immediateSwitchTracker,
                    currentQueueAuthIndex
                );
                if (!retryPrepared) {
                    skipFinalFailureSwitch = true;
                    break;
                }

                try {
                    currentQueue.close(this._getImmediateStatusRetryCloseReason(headerStatus));
                } catch {
                    /* empty */
                }

                this._advanceProxyRequestAttempt(proxyRequest);
                currentQueue = this.connectionRegistry.createMessageQueue(
                    proxyRequest.request_id,
                    this.currentAuthIndex,
                    proxyRequest.request_attempt_id
                );
                currentQueueAuthIndex = this.currentAuthIndex;
                continue;
            }

            break;
        }

        if (headerMessage.event_type === "error") {
            this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
            if (isUserAbortedError(headerMessage)) {
                this.logger.debug(
                    `[Request] Request #${proxyRequest.request_id} was properly cancelled by user, not counted in failure statistics.`
                );
            } else {
                this._logFinalRequestFailure(headerMessage, "Gemini real stream", proxyRequest.request_id, {
                    afterRetries: false,
                });
                // Avoid switching account if the error is just a connection reset
                if (!skipFinalFailureSwitch && !this._isConnectionResetError(headerMessage)) {
                    await this.authSwitcher.handleRequestFailureAndSwitch(headerMessage, null);
                } else if (skipFinalFailureSwitch) {
                    this.logger.info(
                        "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                    );
                } else {
                    this.logger.info(
                        "[Request] Failure due to connection reset (Gemini Real Stream), skipping account switch."
                    );
                }
                return this._sendErrorResponse(res, headerMessage.status, headerMessage.message);
            }
            if (!res.writableEnded) res.end();
            return;
        }

        if (proxyRequest.is_generative && this.authSwitcher.failureCount > 0) {
            this.logger.debug(
                `✅ [Auth] Generation request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
            );
            this.authSwitcher.failureCount = 0;
        }

        this._setResponseHeaders(res, headerMessage, req);
        // Fallback: Ensure Content-Type is set for streaming response
        if (!res.get("Content-Type")) {
            res.type("text/event-stream");
        }
        this.logger.info(`[Request] Gemini streaming response (Real Mode) started...`);
        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const dataMessage = await currentQueue.dequeue(this.timeouts.STREAM_CHUNK);
                if (dataMessage.type === "STREAM_END") {
                    this.logger.info(
                        `✅ [Request] Response completed (Gemini real stream), request ID: ${proxyRequest.request_id}`
                    );
                    break;
                }

                if (dataMessage.event_type === "error") {
                    this.logger.error(`❌ [Request] Error received during Gemini real stream: ${dataMessage.message}`);
                    this._markTrackedResponseError(res, dataMessage.message, 500);
                    // Check if response is still writable before attempting to write
                    if (this._isResponseWritable(res)) {
                        try {
                            res.write(
                                `data: ${JSON.stringify({ error: { code: 500, message: dataMessage.message, status: "INTERNAL" } })}\n\n`
                            );
                        } catch (writeError) {
                            this.logger.debug(
                                `❌ [Request] Failed to write error to Gemini real stream: ${writeError.message}`
                            );
                        }
                    }
                    break;
                }

                if (dataMessage.data) {
                    this._logGeminiNativeChunkDebug(dataMessage.data, "stream");
                    if (!this._isResponseWritable(res)) {
                        this.logger.debug(
                            "[Request] Response no longer writable during Gemini real stream; stopping stream."
                        );
                        break;
                    }
                    try {
                        res.write(dataMessage.data);
                        if (dataMessage.hasModelContent) res.__modelOutputStarted = true;
                    } catch (writeError) {
                        this.logger.debug(
                            `[Request] Failed to write Gemini data chunk to stream: ${writeError.message}`
                        );
                        break;
                    }
                }
            }
        } catch (error) {
            // Handle queue closed errors (account switch, context closed, etc.)
            if (isPromptBlocked(error)) {
                this._handleRequestError(error, res, proxyRequest.request_id);
            } else if (this._isConnectionResetError(error)) {
                this._handleRealStreamQueueClosedError(error, res);
            } else if (error instanceof QueueTimeoutError || error.code === "QUEUE_TIMEOUT") {
                // Keep behavior consistent with other interfaces: treat missing stream chunks as a timeout error.
                this._handleRequestError(error, res, proxyRequest.request_id);
            } else {
                // Unexpected error - rethrow to outer handler
                throw error;
            }
        } finally {
            if (!res.writableEnded) res.end();
            this.logger.debug(
                `[Request] Real stream response connection closed, request ID: ${proxyRequest.request_id}`
            );
        }
    }

    async _handleNonStreamResponse(proxyRequest, messageQueue, req, res) {
        try {
            const result = await this._executeRequestWithRetries(proxyRequest, messageQueue);

            if (!result.success) {
                // If retries failed, handle the failure (e.g., switch account)
                if (isUserAbortedError(result.error)) {
                    this.logger.info(`[Request] Request #${proxyRequest.request_id} was properly cancelled by user.`);
                } else {
                    this._logFinalRequestFailure(result.error, "Gemini non-stream", proxyRequest.request_id);
                    // Avoid switching account if the error is just a connection reset
                    if (!result.error.skipAccountSwitch && !this._isConnectionResetError(result.error)) {
                        await this.authSwitcher.handleRequestFailureAndSwitch(result.error, null);
                    } else if (result.error.skipAccountSwitch) {
                        this.logger.info(
                            "[Request] Immediate-switch retries exhausted, skipping additional account switch."
                        );
                    } else {
                        this.logger.info(
                            "[Request] Failure due to connection reset (Gemini Non-Stream), skipping account switch."
                        );
                    }
                }
                return this._sendErrorResponse(res, result.error.status, result.error.message, null, result.error);
            }

            // On success, reset failure count if needed
            if (proxyRequest.is_generative && this.authSwitcher.failureCount > 0) {
                this.logger.debug(
                    `✅ [Auth] Non-stream generation request successful - failure count reset from ${this.authSwitcher.failureCount} to 0`
                );
                this.authSwitcher.failureCount = 0;
            }

            // Use the queue that successfully received the initial message
            const activeQueue = result.queue;

            const headerMessage = result.message;
            const chunks = [];
            let receiving = true;
            while (receiving) {
                const message = await activeQueue.dequeue(this.timeouts.FAKE_STREAM);
                if (message.type === "STREAM_END") {
                    this.logger.debug("[Request] Gemini non-stream end signal received.");
                    receiving = false;
                    break;
                }

                if (message.event_type === "error") {
                    this.logger.error(`❌ [Request] Error received during Gemini non-stream: ${message.message}`);
                    this._markTrackedResponseError(res, message.message, 500);
                    this._sendErrorResponse(res, 500, message.message);
                    return;
                }

                if (message.event_type === "chunk" && message.data) {
                    chunks.push(Buffer.from(message.data));
                }
            }

            const fullBodyBuffer = Buffer.concat(chunks);
            let responseBodyBuffer = fullBodyBuffer;

            try {
                const fullResponse = JSON.parse(responseBodyBuffer.toString());
                this._logGeminiNativeResponseDebug(fullResponse, "non-stream");
            } catch (e) {
                // Ignore JSON parsing errors for finish reason
            }

            if (proxyRequest.response_transform === "batchEmbedToEmbedContent") {
                try {
                    responseBodyBuffer = this._convertBatchEmbedResponseToEmbedContent(responseBodyBuffer);
                } catch (error) {
                    this.logger.error(`❌ [Proxy] Failed to convert embedding response: ${error.message}`);
                    this._sendErrorResponse(res, 500, "Failed to convert backend embedding response");
                    return;
                }
            }

            this._setResponseHeaders(res, headerMessage, req);

            // Ensure Content-Type is set (Express defaults Buffer to application/octet-stream)
            if (!res.get("Content-Type")) {
                res.type("application/json");
            }

            res.send(responseBodyBuffer);
            this.logger.info(
                `✅ [Request] Response completed (Gemini non-stream), request ID: ${proxyRequest.request_id}`
            );
            this.logger.debug(`[Request] Complete non-stream response sent to client.`);
        } catch (error) {
            this._handleRequestError(error, res, proxyRequest.request_id);
        }
    }

    // === Helper Methods ===

    _processImageInResponse(fullBody) {
        try {
            const parsedBody = JSON.parse(fullBody);
            let needsReserialization = false;

            const candidate = parsedBody.candidates?.[0];
            if (candidate?.content?.parts) {
                const imagePartIndex = candidate.content.parts.findIndex(p => p.inlineData);

                if (imagePartIndex > -1) {
                    this.logger.info(
                        "[Proxy] Detected image data in Google format response, converting to Markdown..."
                    );
                    const imagePart = candidate.content.parts[imagePartIndex];
                    const image = imagePart.inlineData;

                    candidate.content.parts[imagePartIndex] = {
                        text: `![Generated Image](data:${image.mimeType};base64,${image.data})`,
                    };
                    needsReserialization = true;
                }
            }

            if (needsReserialization) {
                return JSON.stringify(parsedBody);
            }
        } catch (e) {
            this.logger.warn(
                `[Proxy] Response body is not valid JSON, or error occurred while processing image: ${e.message}`
            );
        }
        return fullBody;
    }

    async _executeRequestWithRetries(proxyRequest, messageQueue) {
        let lastError = null;
        let currentQueue = messageQueue;
        const registeredQueueAuthIndex = this.connectionRegistry.getAuthIndexForRequest(proxyRequest.request_id);
        // Track the authIndex registered for the current queue, which may differ from the global current account.
        let currentQueueAuthIndex =
            Number.isInteger(registeredQueueAuthIndex) && registeredQueueAuthIndex >= 0
                ? registeredQueueAuthIndex
                : this.currentAuthIndex;
        let retryAttempt = 1;
        const immediateSwitchTracker = this._createImmediateSwitchTracker(currentQueueAuthIndex);

        while (retryAttempt <= this.config.maxRetries) {
            // Record attempt at the start of each retry, before forwarding.
            // This ensures failed attempts (e.g. 429 before any response) are also counted.
            this._getUsageStatsService()?.recordAttempt(
                proxyRequest.request_id,
                currentQueueAuthIndex,
                this._getAccountNameForIndex(currentQueueAuthIndex)
            );
            try {
                this._forwardRequest(proxyRequest, currentQueueAuthIndex);

                const initialMessage = await currentQueue.dequeue(this.timeouts.FAKE_STREAM);

                if (initialMessage.event_type === "timeout") {
                    throw new Error(
                        JSON.stringify({
                            event_type: "error",
                            message: "Request timed out waiting for browser response.",
                            status: 504,
                        })
                    );
                }

                if (initialMessage.event_type === "error") {
                    // Throw a structured error to be caught by the catch block
                    throw new Error(JSON.stringify(initialMessage));
                }

                // Success, return the initial message and the queue that received it
                return { message: initialMessage, queue: currentQueue, success: true };
            } catch (error) {
                // Parse the structured error message
                if (isPromptBlocked(error)) {
                    this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
                    return { error, success: false };
                }
                let errorPayload;
                try {
                    // Upstream messages may themselves be valid JSON. Their text
                    // must not replace the structured transport error or replay flag.
                    if (error.upstreamError || error.event_type === "error" || error.upstreamOutputStarted) {
                        errorPayload = { ...error, message: error.message, status: error.status || 502 };
                    } else {
                        const parsed = JSON.parse(error.message);
                        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                            throw new Error("Not an error envelope");
                        errorPayload = { ...error, ...parsed };
                    }
                } catch (e) {
                    // JSON parse failed - check if it's a timeout error
                    if (error.code === "QUEUE_TIMEOUT" || error instanceof QueueTimeoutError) {
                        errorPayload = {
                            ...error,
                            code: error.code,
                            message: error.message || "Queue timeout",
                            status: 504,
                        };
                    } else {
                        errorPayload = { ...error, message: error.message, status: error.status || 500 };
                    }
                }

                // A lost unary response may already have generated output upstream.
                if (
                    (isArgon(this._extractModelFromPath(proxyRequest.path)) ||
                        proxyRequest.transport_policy?.transport === "makersuite") &&
                    (this._isConnectionResetError(error) ||
                        error.code === "BUILD_BENEFIT_NOT_READY" ||
                        error.code === "QUEUE_TIMEOUT" ||
                        Number(errorPayload.status) === 504)
                ) {
                    this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);
                    lastError = { ...errorPayload, skipAccountSwitch: true };
                    break;
                }

                // Stop retrying immediately if the queue is closed
                if (this._isConnectionResetError(error)) {
                    // Check the actual closure reason to provide accurate error messages
                    const reason = error.reason || "unknown";
                    const isClientDisconnect = reason === "client_disconnect";
                    const currentAuthIndex = this.currentAuthIndex;
                    const isClosedAccountRetryable = reason === "context_closed" || reason === "page_closed";
                    const canRetryOnCurrentAccountCandidate =
                        !isClientDisconnect &&
                        isClosedAccountRetryable &&
                        retryAttempt < this.config.maxRetries &&
                        Number.isInteger(currentQueueAuthIndex) &&
                        currentQueueAuthIndex >= 0 &&
                        Number.isInteger(currentAuthIndex) &&
                        currentAuthIndex >= 0 &&
                        currentQueueAuthIndex !== currentAuthIndex;

                    if (canRetryOnCurrentAccountCandidate) {
                        const ready = await this._waitForSystemAndConnectionIfBusy(null, {
                            connectionMessage: "Service temporarily unavailable: Connection not ready before retry.",
                        });
                        if (!ready) {
                            lastError = {
                                message: `WebSocket connection not ready before retry on account #${this.currentAuthIndex}.`,
                                status: 503,
                            };
                            break;
                        }
                    }

                    const canRetryOnCurrentAccount =
                        canRetryOnCurrentAccountCandidate &&
                        Boolean(this.connectionRegistry.getConnectionByAuth(currentAuthIndex, false));

                    if (isClientDisconnect) {
                        this.logger.warn(`[Request] Message queue closed due to client disconnect, aborting retries.`);
                        lastError = { message: "Connection lost (client disconnect)", status: 503 };
                    } else if (canRetryOnCurrentAccount) {
                        this.logger.warn(
                            `[Request] Message queue for non-current account #${currentQueueAuthIndex} closed ` +
                                `(reason: ${reason}); retrying request #${proxyRequest.request_id} on current account #${currentAuthIndex}.`
                        );
                        lastError = {
                            message: `Queue closed: ${error.message || reason}`,
                            reason,
                            status: 503,
                        };
                        this._advanceProxyRequestAttempt(proxyRequest);
                        currentQueue = this.connectionRegistry.createMessageQueue(
                            proxyRequest.request_id,
                            currentAuthIndex,
                            proxyRequest.request_attempt_id
                        );
                        currentQueueAuthIndex = currentAuthIndex;
                        if (Number.isInteger(currentQueueAuthIndex) && currentQueueAuthIndex >= 0) {
                            immediateSwitchTracker.attemptedAuthIndices.add(currentQueueAuthIndex);
                        }
                        await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                        retryAttempt++;
                        continue;
                    } else {
                        // Queue closed for other reasons (account_switch, system_reset, etc.)
                        this.logger.warn(`[Request] Message queue closed (reason: ${reason}), aborting retries.`);
                        lastError = {
                            message: `Queue closed: ${error.message || reason}`,
                            reason,
                            status: 503,
                        };
                    }
                    break;
                }

                lastError = errorPayload;
                this._cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex);

                if (errorPayload.upstreamOutputStarted) {
                    lastError = { ...errorPayload, skipAccountSwitch: true };
                    break;
                }
                const errorStatus = Number(errorPayload?.status);
                if (
                    (isArgon(this._extractModelFromPath(proxyRequest.path)) ||
                        proxyRequest.transport_policy?.transport === "makersuite") &&
                    ([400, 401, 403].includes(errorStatus) ||
                        errorPayload.code === "BUILD_BENEFIT_NOT_READY" ||
                        /PERMISSION_DENIED/.test(errorPayload.message || ""))
                ) {
                    lastError = { ...errorPayload, skipAccountSwitch: true };
                    break;
                }
                const isNonRetryableEmbeddingClientError =
                    (errorStatus === 400 || errorStatus === 404) &&
                    this._categorizeRequest(proxyRequest?.path, "request") === "embedding";
                if (isNonRetryableEmbeddingClientError) {
                    lastError = { ...errorPayload, skipAccountSwitch: true };
                    this.logger.warn(
                        `[Request] Embedding request failed with non-retryable status ${errorPayload.status}; skipping retries and account switching.`
                    );
                    break;
                }

                // Check if we should stop retrying immediately based on status code
                if (
                    Number.isFinite(errorStatus) &&
                    this.config?.immediateSwitchStatusCodes?.includes(errorStatus) &&
                    !isUserAbortedError(errorPayload)
                ) {
                    this.logger.warn(`[Request] Received ${errorStatus}, preparing retry...`);
                    try {
                        const retryPrepared = await this._prepareImmediateStatusRetry(
                            errorPayload,
                            proxyRequest.request_id,
                            immediateSwitchTracker,
                            currentQueueAuthIndex
                        );
                        if (!retryPrepared) {
                            lastError = { ...errorPayload, skipAccountSwitch: true };
                            break;
                        }
                    } catch (switchError) {
                        lastError = {
                            ...switchError,
                            message: switchError.message,
                            skipAccountSwitch: true,
                            status: switchError.status || 503,
                        };
                        this.logger.error(
                            `❌ [Request] Account switch failed during immediate-switch retry flow: ${switchError.message}`
                        );
                        break;
                    }

                    try {
                        currentQueue.close("retry_creating_new_queue");
                    } catch (e) {
                        this.logger.debug(`[Request] Failed to close old queue before retry: ${e.message}`);
                    }

                    this.logger.debug(
                        `[Request] Creating new message queue after immediate switch for request #${proxyRequest.request_id} (switching from account #${currentQueueAuthIndex} to #${this.currentAuthIndex})`
                    );
                    this._advanceProxyRequestAttempt(proxyRequest);
                    currentQueue = this.connectionRegistry.createMessageQueue(
                        proxyRequest.request_id,
                        this.currentAuthIndex,
                        proxyRequest.request_attempt_id
                    );
                    currentQueueAuthIndex = this.currentAuthIndex;
                    continue;
                }

                // Log the warning for the current attempt
                this.logger.warn(
                    `[Request] Attempt #${retryAttempt}/${this.config.maxRetries} for request #${proxyRequest.request_id} failed: ${errorPayload.message}`
                );

                // If it's the last attempt, break the loop to return failure
                if (retryAttempt >= this.config.maxRetries) {
                    this.logger.error(
                        `❌ [Request] All ${this.config.maxRetries} retries failed for request #${proxyRequest.request_id}. Final error: ${errorPayload.message}`
                    );
                    break;
                }

                // Explicitly close the old queue before creating a new one
                // This ensures waitingResolvers are properly rejected even if authIndex changed
                try {
                    currentQueue.close("retry_creating_new_queue");
                } catch (e) {
                    this.logger.debug(`[Request] Failed to close old queue before retry: ${e.message}`);
                }

                // Create a new message queue for the retry with CURRENT account
                // Note: We keep the same requestId so the browser response routes to the new queue
                // createMessageQueue will automatically close and remove any existing queue with the same ID from the registry
                this.logger.debug(
                    `[Request] Creating new message queue for retry #${retryAttempt + 1} for request #${proxyRequest.request_id} (switching from account #${currentQueueAuthIndex} to #${this.currentAuthIndex})`
                );
                this._advanceProxyRequestAttempt(proxyRequest);
                currentQueue = this.connectionRegistry.createMessageQueue(
                    proxyRequest.request_id,
                    this.currentAuthIndex,
                    proxyRequest.request_attempt_id
                );
                // Update tracked authIndex for the new queue
                currentQueueAuthIndex = this.currentAuthIndex;
                if (Number.isInteger(currentQueueAuthIndex) && currentQueueAuthIndex >= 0) {
                    immediateSwitchTracker.attemptedAuthIndices.add(currentQueueAuthIndex);
                }

                // Wait before the next retry
                await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
                if (
                    !(await this._waitForSystemAndConnectionIfBusy(null, {
                        connectionMessage: "Service temporarily unavailable: Connection not ready before retry.",
                    }))
                ) {
                    lastError = {
                        message: `WebSocket connection not ready before retry on account #${this.currentAuthIndex}.`,
                        status: 503,
                    };
                    break;
                }
                retryAttempt++;
            }
        }

        // After all retries, return the final failure result
        return { error: lastError, success: false };
    }

    async _streamOpenAIResponseAPIResponse(messageQueue, res, model, streamOptions = {}) {
        const streamState = {
            responseDefaults: streamOptions.responseDefaults || {},
        };
        const requestId = streamOptions.requestId;
        // Keep Response API sequence numbers consistent across helpers that might write to the same SSE response.
        if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
        streamState.sequenceNumber = res.__responseApiSeq;

        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const message = await messageQueue.dequeue(this.timeouts.STREAM_CHUNK);
                if (message.type === "STREAM_END") {
                    this.logger.info(
                        `✅ [Request] Response completed (OpenAI Response API real stream), request ID: ${requestId}`
                    );
                    break;
                }

                if (message.event_type === "error") {
                    this.logger.error(`❌ [Request] Error received during Response API stream: ${message.message}`);
                    this._markTrackedResponseError(res, message.message, 500);
                    if (this._isResponseWritable(res)) {
                        try {
                            if (!streamState.sequenceNumber) streamState.sequenceNumber = 0;
                            streamState.sequenceNumber++;
                            res.__responseApiSeq = streamState.sequenceNumber;
                            res.write(
                                `event: error\ndata: ${JSON.stringify({
                                    code: "api_error",
                                    message: message.message,
                                    param: null,
                                    sequence_number: streamState.sequenceNumber,
                                    type: "error",
                                })}\n\n`
                            );
                        } catch (writeError) {
                            this.logger.debug(
                                `❌ [Request] Failed to write error to Response API stream: ${writeError.message}`
                            );
                        }
                    }
                    break;
                }

                if (message.data) {
                    const responseAPIChunk = this.formatConverter.translateGoogleToResponseAPIStream(
                        message.data,
                        model,
                        streamState
                    );
                    if (typeof streamState.sequenceNumber === "number") {
                        res.__responseApiSeq = streamState.sequenceNumber;
                    }
                    if (responseAPIChunk) {
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during Response API stream; stopping stream."
                            );
                            break;
                        }
                        try {
                            res.write(responseAPIChunk);
                            if (message.hasModelContent) res.__modelOutputStarted = true;
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write Response API chunk (connection likely closed): ${writeError.message}`
                            );
                            break;
                        }
                    }
                }
            }
        } catch (error) {
            // Only handle connection reset errors here (client disconnect / queue closed).
            // Let other errors (timeout, parsing, logic errors) propagate to the outer catch.
            if (this._isConnectionResetError(error)) {
                this._handleRealStreamQueueClosedError(error, res);
                return;
            }

            throw error;
        }
    }

    async _writeAntiStreamChunk(res, chunk) {
        if (!chunk) return;
        if (!this._isResponseWritable(res))
            throw Object.assign(new Error("Client disconnected"), { reason: "client_disconnect" });
        const ready = res.write(chunk);
        res.flush?.();
        if (ready !== false) return;
        await new Promise((resolve, reject) => {
            const cleanup = () => {
                res.removeListener("drain", drained);
                res.removeListener("close", closed);
                res.removeListener("error", failed);
            };
            const drained = () => {
                cleanup();
                resolve();
            };
            const closed = () => {
                cleanup();
                reject(Object.assign(new Error("Client disconnected"), { reason: "client_disconnect" }));
            };
            const failed = () => {
                cleanup();
                reject(Object.assign(new Error("Client write failed"), { reason: "client_disconnect" }));
            };
            res.once("drain", drained);
            res.once("close", closed);
            res.once("error", failed);
            if (!this._isResponseWritable(res)) closed();
        });
    }

    async _streamOpenAIResponse(messageQueue, res, model, requestId) {
        const streamState = res.__antiAttempt ? { includeUsage: res.__antiIncludeUsage } : {};
        let attempt = res.__antiAttempt;

        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const message = await messageQueue.dequeue(this.timeouts.STREAM_CHUNK);
                attempt = res.__antiAttempt;
                if (message.type === "STREAM_END") {
                    if (attempt) {
                        for (const response of attempt.read("", true)) {
                            await this._writeAntiStreamChunk(
                                res,
                                attempt.stream(response, this.formatConverter, model, streamState)
                            );
                        }
                        attempt.assertComplete();
                    }
                    if (this._isResponseWritable(res)) {
                        try {
                            if (attempt) res.write(attempt.usageEvent(streamState));
                            res.write("data: [DONE]\n\n");
                            res.flush?.();
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write final [DONE] to OpenAI stream (connection likely closed): ${writeError.message}`
                            );
                        }
                    }
                    this.logger.info(`✅ [Request] Response completed (OpenAI real stream), request ID: ${requestId}`);
                    break;
                }

                if (message.event_type === "error") {
                    this._handleRequestError(message, res, requestId);
                    break;
                }

                if (message.data) {
                    let openAIChunk;
                    if (attempt) {
                        const responses = attempt.read(message.data);
                        openAIChunk = "";
                        for (const response of responses) {
                            if (
                                response.candidates?.some(candidate =>
                                    candidate.content?.parts?.some(
                                        part =>
                                            part.functionCall ||
                                            part.text ||
                                            part.inlineData ||
                                            part.executableCode ||
                                            part.codeExecutionResult ||
                                            part.fileData ||
                                            part.toolCall ||
                                            part.toolResponse
                                    )
                                )
                            ) {
                                res.__upstreamOutputStarted = true;
                                res.__modelOutputStarted = true;
                                res.__stopEarlyOpenAIStream?.();
                            }
                            openAIChunk += attempt.stream(response, this.formatConverter, model, streamState);
                        }
                    } else {
                        openAIChunk = this.formatConverter.translateGoogleToOpenAIStream(
                            message.data,
                            model,
                            streamState
                        );
                    }
                    if (openAIChunk) {
                        if (!this._isResponseWritable(res)) {
                            this.logger.debug(
                                "[Request] Response no longer writable during OpenAI stream; stopping stream."
                            );
                            break;
                        }
                        try {
                            if (attempt) await this._writeAntiStreamChunk(res, openAIChunk);
                            else {
                                res.write(openAIChunk);
                                if (streamState.modelOutputStarted) res.__modelOutputStarted = true;
                                res.flush?.();
                            }
                        } catch (writeError) {
                            this.logger.debug(
                                `[Request] Failed to write OpenAI chunk to stream: ${writeError.message}`
                            );
                            break;
                        }
                    }
                }
            }
        } catch (error) {
            // Only handle connection reset errors here (client disconnect)
            // Let other errors (timeout, parsing, logic errors) propagate to outer catch
            if (this._isConnectionResetError(error)) {
                this._handleRealStreamQueueClosedError(error, res);
                return;
            }

            // Re-throw all other errors to be handled by outer catch block
            throw error;
        }
    }

    async _sendOpenAIResponseAPINonStreamResponse(messageQueue, res, model, requestId, responseDefaults = {}) {
        let fullBody = "";
        let receiving = true;
        while (receiving) {
            const message = await messageQueue.dequeue(this.timeouts.FAKE_STREAM);
            if (message.type === "STREAM_END") {
                this.logger.debug("[Request] OpenAI Response API received end signal.");
                receiving = false;
                break;
            }

            if (message.event_type === "error") {
                this.logger.error(
                    `❌ [Adapter] Error during OpenAI Response API non-stream conversion: ${message.message}`
                );
                this._sendErrorResponse(res, 500, message.message);
                return;
            }

            if (message.event_type === "chunk" && message.data) {
                fullBody += message.data;
            }
        }

        // Parse and convert to OpenAI Response API format
        try {
            const googleResponse = JSON.parse(fullBody);
            const responseAPIResponse = this.formatConverter.convertGoogleToResponseAPINonStream(
                googleResponse,
                model,
                responseDefaults
            );
            res.type("application/json").send(JSON.stringify(responseAPIResponse));
            this.logger.info(
                `✅ [Request] Response completed (OpenAI Response API non-stream), request ID: ${requestId}`
            );
        } catch (e) {
            this.logger.error(`❌ [Adapter] Failed to parse response for OpenAI Response API: ${e.message}`);
            this._sendErrorResponse(res, 500, "Failed to parse backend response");
        }
    }

    async _sendOpenAINonStreamResponse(messageQueue, res, model, requestId) {
        let fullBody = "";
        let receiving = true;
        while (receiving) {
            const message = await messageQueue.dequeue(this.timeouts.FAKE_STREAM);
            if (message.type === "STREAM_END") {
                this.logger.debug("[Request] OpenAI received end signal.");
                receiving = false;
                break;
            }

            if (message.event_type === "error") {
                this.logger.error(`❌ [Adapter] Error during OpenAI non-stream conversion: ${message.message}`);
                this._handleRequestError(message, res, requestId);
                return;
            }

            if (message.event_type === "chunk" && message.data) {
                fullBody += message.data;
                if (res.__antiAttempt && Buffer.byteLength(fullBody) > AntiTruncation.MAX_BYTES)
                    throw Object.assign(new Error("Anti-truncation response exceeds size limit"), {
                        code: "anti_truncation_limit",
                        status: 502,
                    });
            }
        }

        // Parse and convert to OpenAI format
        try {
            const googleResponse = res.__antiAttempt ? AntiTruncation.parseResponse(fullBody) : JSON.parse(fullBody);
            const openAIResponse = res.__antiAttempt
                ? res.__antiAttempt.nonStream(googleResponse, this.formatConverter, model)
                : this.formatConverter.convertGoogleToOpenAINonStream(googleResponse, model);
            res.type("application/json").send(JSON.stringify(openAIResponse));
            this.logger.info(`✅ [Request] Response completed (OpenAI non-stream), request ID: ${requestId}`);
        } catch (e) {
            this.logger.error(`❌ [Adapter] Failed to parse response for OpenAI: ${e.message}`);
            this._handleRequestError(e, res, requestId);
        }
    }

    _setResponseHeaders(res, headerMessage, req) {
        if (res.headersSent) return;
        res.status(headerMessage.status || 200);
        const headers = headerMessage.headers || {};

        // Filter headers that might cause CORS conflicts
        const forbiddenHeaders = [
            "access-control-allow-origin",
            "access-control-allow-methods",
            "access-control-allow-headers",
        ];

        Object.entries(headers).forEach(([name, value]) => {
            const lowerName = name.toLowerCase();
            if (forbiddenHeaders.includes(lowerName)) return;
            if (lowerName === "content-length") return;

            // Special handling for upload URL and redirects: point them back to this proxy
            if (lowerName === "x-goog-upload-url" && value.includes("googleapis.com")) {
                try {
                    const urlObj = new URL(value);
                    // Rewrite upload/redirect URLs to point to this proxy server
                    // build.js already rewrote the URL to localhost with __proxy_host__ param
                    // Here we just ensure it matches the client's request host (for Docker/remote access)
                    let newAuthority;
                    if (req && req.headers && req.headers.host) {
                        newAuthority = req.headers.host;
                    } else {
                        const host = this.config.host === "0.0.0.0" ? "127.0.0.1" : this.config.host;
                        newAuthority = `${host}:${this.config.httpPort}`;
                    }

                    const protocol =
                        req.secure || (req.get && req.get("X-Forwarded-Proto") === "https") ? "https" : "http";
                    const newUrl = `${protocol}://${newAuthority}${urlObj.pathname}${urlObj.search}`;

                    this.logger.debug(`[Response] Debug: Rewriting header ${name}: ${value} -> ${newUrl}`);
                    res.set(name, newUrl);
                } catch (e) {
                    res.set(name, value);
                }
            } else {
                res.set(name, value);
            }
        });
    }

    _prepareBlockedResponse(error, res, requestId) {
        res.__stopEarlyOpenAIStream?.();
        if (res.__blockedError) return;
        res.__blockedError = error;
        this.logger.warn(
            `[Request] ${JSON.stringify({
                attemptCount: error.attemptCount,
                blockReason: error.upstream?.blockReason,
                diagnostics: error.upstream,
                event: "upstream_blocked",
                model: error.model,
                outputStarted: Boolean(res.__modelOutputStarted),
                requestAttemptId: error.requestAttemptId,
                requestId: requestId || error.requestId,
                retryable: false,
                upstreamHttpStatus: error.upstreamHttpStatus,
                upstreamResponseId: error.upstreamResponseId,
            })}`
        );
        const id = requestId || error.requestId;
        if (id) {
            const index = this.connectionRegistry.getAuthIndexForRequest(id) ?? error.authIndex;
            if (Number.isInteger(index)) this._cancelBrowserRequest(id, index, error.requestAttemptId);
        }
    }

    _addBlockedDetails(payload, error, format) {
        const normalized = normalizeError(error || {});
        if (normalized.details !== undefined) (payload.error || payload).details = normalized.details;
        if (!isPromptBlocked(error)) return payload;
        const target = payload.error || payload;
        target.upstream = error.upstream;
        if (error.requestId) target.request_id = error.requestId;
        if (error.usageMetadata) {
            if (format === "gemini") target.usageMetadata = error.usageMetadata;
            else target.usage = this.formatConverter._parseUsage({ usageMetadata: error.usageMetadata });
        }
        return payload;
    }

    _handleRequestError(error, res, requestId = null) {
        if (isPromptBlocked(error)) this._prepareBlockedResponse(error, res, requestId);
        const format = this._resolveErrorFormat(res);
        const normalized = normalizeError(error);
        const requestIdSuffix = requestId ? `, request ID: ${requestId}` : "";
        const isConnectionReset = this._isConnectionResetError(error);
        if (isConnectionReset && (error.reason === "client_disconnect" || !this._isResponseWritable(res))) {
            this._markTrackedClientAbort(res, normalized.message);
            if (!res.writableEnded) res.end();
            return;
        }
        if (error instanceof QueueTimeoutError || error.code === "QUEUE_TIMEOUT") {
            normalized.status = 504;
            normalized.type = "timeout_error";
        } else if (isConnectionReset) {
            normalized.status = 503;
            normalized.type = format === "claude" ? "overloaded_error" : "service_unavailable";
        }
        const errorType = normalized.type || this._getDefaultErrorType(format, normalized.status);
        this.logger.error(`❌ [Request] Request processing error: ${normalized.message}${requestIdSuffix}`);
        if (res.headersSent) {
            if (this._isResponseWritable(res)) {
                const contentType = res.getHeader("content-type");
                if (contentType?.includes("text/event-stream") || res.__proxyResponseStreamMode) {
                    this._sendErrorChunkToClient(
                        res,
                        normalized.message,
                        normalized.status,
                        errorType,
                        isConnectionReset ? "local_transport" : "error",
                        error
                    );
                }
                res.end();
            }
        } else {
            this._sendErrorResponse(res, normalized.status, normalized.message, errorType, error);
        }
    }

    _sendErrorResponse(res, status, message, errorType = null, details = null) {
        if (isPromptBlocked(details)) this._prepareBlockedResponse(details, res, details.requestId);
        const normalized = normalizeError({ ...details, message, status });
        status = normalized.status;
        message = normalized.message;
        errorType = normalized.type || errorType;
        if ((res.__streamStartSent || isPromptBlocked(details)) && res.headersSent) {
            if (this._isResponseWritable(res)) {
                this._sendErrorChunkToClient(res, message, status, errorType, "error", details);
                res.end();
            }
            return;
        }
        if (!res.headersSent) {
            const statusCode = Number(status) || 500;
            const resolvedFormat = this._resolveErrorFormat(res);
            const resolvedErrorType = errorType || this._getDefaultErrorType(resolvedFormat, statusCode);
            let errorPayload;

            if (resolvedFormat === "claude") {
                errorPayload = {
                    error: {
                        message,
                        type: resolvedErrorType,
                    },
                    type: "error",
                };
            } else if (resolvedFormat === "openai") {
                errorPayload = {
                    error: {
                        code: normalized.code,
                        message,
                        type: resolvedErrorType,
                    },
                };
            } else if (resolvedFormat === "response_api") {
                errorPayload = {
                    error: {
                        code: isPromptBlocked(details) ? normalized.code : resolvedErrorType,
                        message,
                        param: null,
                        type: resolvedErrorType,
                    },
                };
            } else {
                const statusText = geminiStatus(details, statusCode);
                errorPayload = {
                    error: {
                        code: statusCode,
                        message,
                        status: statusText,
                        ...(normalized.details !== undefined ? { details: normalized.details } : {}),
                    },
                };
            }

            if (normalized.details !== undefined && errorPayload.error) errorPayload.error.details = normalized.details;
            if (isPromptBlocked(details)) this._addBlockedDetails(errorPayload, details, resolvedFormat);
            this._markTrackedResponseError(res, message, statusCode, "error", details);
            res.status(statusCode).type("application/json").send(JSON.stringify(errorPayload));
        }
    }

    _isResponseWritable(res) {
        // Comprehensive check to ensure response is writable
        // Explicitly return boolean to avoid returning null/undefined from res.socket check
        return Boolean(
            !res.writableEnded && !res.destroyed && res.socket && !res.socket.destroyed && res.socket.writable !== false
        );
    }

    _sendErrorChunkToClient(res, message, statusCode = null, errorType = null, outcome = "error", details = null) {
        if (isPromptBlocked(details)) this._prepareBlockedResponse(details, res, details.requestId);
        const normalized = normalizeError({ ...details, message, status: statusCode });
        statusCode = normalized.status;
        message = normalized.message;
        errorType = normalized.type || errorType;
        const format = this._resolveErrorFormat(res);
        const resolvedErrorType = errorType || this._getDefaultErrorType(format, statusCode);
        if (!res.headersSent) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
        }
        this._markTrackedResponseError(res, message, statusCode, outcome, details);
        // Check if response is still writable before attempting to write
        if (this._isResponseWritable(res)) {
            try {
                if (format === "response_api") {
                    if (res.__responseApiSeq == null) res.__responseApiSeq = 0;
                    res.__responseApiSeq += 1;
                    res.write(
                        `event: error\ndata: ${JSON.stringify(
                            this._addBlockedDetails(
                                {
                                    code: isPromptBlocked(details) ? normalized.code : resolvedErrorType,
                                    message,
                                    param: null,
                                    sequence_number: res.__responseApiSeq,
                                    type: "error",
                                },
                                details,
                                format
                            )
                        )}\n\n`
                    );
                } else if (format === "claude") {
                    res.write(
                        `event: error\ndata: ${JSON.stringify(
                            this._addBlockedDetails(
                                {
                                    error: {
                                        message,
                                        type: resolvedErrorType,
                                    },
                                    type: "error",
                                },
                                details,
                                format
                            )
                        )}\n\n`
                    );
                } else if (format === "openai") {
                    res.write(
                        `data: ${JSON.stringify(
                            this._addBlockedDetails(
                                {
                                    error: {
                                        code: normalized.code,
                                        message,
                                        type: resolvedErrorType,
                                    },
                                },
                                details,
                                format
                            )
                        )}\n\n`
                    );
                } else if (format === "gemini") {
                    const status = geminiStatus(details, statusCode);
                    res.write(
                        `data: ${JSON.stringify(this._addBlockedDetails({ error: { code: statusCode, message, status, ...(normalized.details !== undefined ? { details: normalized.details } : {}) } }, details, format))}\n\n`
                    );
                } else {
                    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
                }
                res.flush?.();
            } catch (writeError) {
                this.logger.debug(`[Request] Failed to write error chunk to client: ${writeError.message}`);
            }
        }
    }

    _setupClientDisconnectHandler(res, requestId) {
        res.on("close", () => {
            if (!res.writableEnded) {
                this._markTrackedClientAbort(res);
                this.logger.warn(`[Request] Client closed request #${requestId} connection prematurely.`);

                // Dynamically look up the current authIndex from the connection registry
                // This ensures we cancel on the correct account even after retries switch accounts
                const targetAuthIndex =
                    this.connectionRegistry.getAuthIndexForRequest(requestId) ?? this.currentAuthIndex;
                const requestAttemptId = this.connectionRegistry.getRequestAttemptIdForRequest(requestId);

                this._cancelBrowserRequest(requestId, targetAuthIndex, requestAttemptId);
                // Close and remove the message queue to unblock any waiting dequeue() calls
                this.connectionRegistry.removeMessageQueue(requestId, "client_disconnect");
            }
        });
    }

    _cancelBrowserRequest(requestId, authIndex, requestAttemptId = null) {
        const targetAuthIndex = authIndex !== undefined ? authIndex : this.currentAuthIndex;
        this.browserManager.contexts
            ?.get(targetAuthIndex)
            ?.page?.makerSuiteBridge?.cancelAttempt(requestId, requestAttemptId);
        const connection = this.connectionRegistry.getConnectionByAuth(targetAuthIndex);
        if (connection) {
            this.logger.info(
                `[Request] Cancelling request #${requestId} on account #${targetAuthIndex}` +
                    (requestAttemptId ? ` (attempt ${requestAttemptId})` : "")
            );
            connection.send(
                JSON.stringify({
                    event_type: "cancel_request",
                    request_attempt_id: requestAttemptId,
                    request_id: requestId,
                })
            );
        } else {
            this.logger.warn(
                `[Request] Unable to send cancel instruction: No available WebSocket connection for account #${targetAuthIndex}.`
            );
        }
    }

    _cancelCurrentAttemptBeforeRetry(proxyRequest, currentQueueAuthIndex) {
        if (!Number.isInteger(currentQueueAuthIndex) || currentQueueAuthIndex < 0) {
            this.logger.debug(
                `[Request] Skipping retry cancellation for request #${proxyRequest.request_id}: invalid auth index ${currentQueueAuthIndex}.`
            );
            return;
        }
        this._cancelBrowserRequest(proxyRequest.request_id, currentQueueAuthIndex, proxyRequest.request_attempt_id);
    }

    /**
     * Handle queue timeout by notifying browser to cancel the request
     * @param {Error} error - The timeout error
     * @param {string} requestId - The request ID
     */
    _handleQueueTimeout(error, requestId) {
        if (error.code === "QUEUE_TIMEOUT" || error instanceof QueueTimeoutError) {
            // Get the authIndex for this request from the registry
            const authIndex = this.connectionRegistry.getAuthIndexForRequest(requestId);
            const requestAttemptId = this.connectionRegistry.getRequestAttemptIdForRequest(requestId);
            if (authIndex !== null) {
                this.logger.debug(
                    `[Request] Queue timeout for request #${requestId}, notifying browser on account #${authIndex} to cancel`
                );
                this._cancelBrowserRequest(requestId, authIndex, requestAttemptId);
            } else {
                this.logger.debug(
                    `[Request] Queue timeout for request #${requestId}, but queue already removed (authIndex not found)`
                );
            }
        }
    }

    /**
     * Set browser (build.js) log level at runtime for all active contexts
     * @param {string} level - 'DEBUG', 'INFO', 'WARN', or 'ERROR'
     * @returns {number} Number of browser contexts updated (0 if none)
     */
    setBrowserLogLevel(level) {
        const validLevels = ["DEBUG", "INFO", "WARN", "ERROR"];
        const upperLevel = level?.toUpperCase();

        if (!validLevels.includes(upperLevel)) {
            return 0;
        }

        // Broadcast to all active browser contexts
        const sentCount = this.connectionRegistry.broadcastMessage(
            JSON.stringify({
                event_type: "set_log_level",
                level: upperLevel,
            })
        );

        if (sentCount > 0) {
            this.logger.info(`[Config] Browser log level set to: ${upperLevel} (${sentCount} context(s) updated)`);

            // Also update server-side LoggingService level to keep in sync
            const LoggingService = require("../utils/LoggingService");
            LoggingService.setLevel(upperLevel);
            this.logger.info(`[Config] Server log level synchronized to: ${upperLevel}`);

            return sentCount;
        } else {
            this.logger.warn(`[Config] Unable to set browser log level: No active WebSocket connections.`);
            return 0;
        }
    }

    _buildProxyRequest(req, requestId) {
        const fullPath = req.__antiNormalizedPath || req.path;
        let cleanPath = fullPath.replace(/^\/proxy/, "");
        const bodyObj = req.body;
        let requestBodyObj = bodyObj;
        let responseTransform = null;

        // Parse model suffixes from model name in native Gemini generation requests
        // Only handle generation requests: /v1beta/models/{modelName}:generateContent or :streamGenerateContent
        const modelPathMatch = cleanPath.match(
            /^(\/v1beta\/models\/)([^:]+)(:(generateContent|streamGenerateContent).*)$/
        );
        let modelThinkingLevel = null;
        let modelStreamingMode = null;
        let modelForceCodeExecution = false;
        let modelForceWebSearch = false;

        if (modelPathMatch) {
            const pathPrefix = modelPathMatch[1];
            const rawModelName = modelPathMatch[2];
            const pathSuffix = modelPathMatch[3];

            const {
                cleanModelName: toolStrippedModel,
                forceCodeExecution: parsedForceCodeExecution,
                forceWebSearch: parsedForceWebSearch,
            } = FormatConverter.parseModelBuiltInToolSuffixes(rawModelName);
            const { cleanModelName: streamStrippedModel, streamingMode: parsedStreamingMode } =
                FormatConverter.parseModelStreamingModeSuffix(toolStrippedModel);
            const { cleanModelName, thinkingLevel: parsedThinkingLevel } =
                FormatConverter.parseModelThinkingLevel(streamStrippedModel);
            modelForceCodeExecution = parsedForceCodeExecution;
            modelForceWebSearch = parsedForceWebSearch;
            modelStreamingMode = parsedStreamingMode;
            modelThinkingLevel = parsedThinkingLevel;

            const modelForceToolFlags = [];
            if (modelForceWebSearch) modelForceToolFlags.push("forceWebSearch=true");
            if (modelForceCodeExecution) modelForceToolFlags.push("forceCodeExecution=true");
            if (modelForceToolFlags.length > 0) {
                this.logger.info(
                    `[Proxy] Detected built-in tool suffixes in model path: "${rawModelName}" -> model="${toolStrippedModel}", ${modelForceToolFlags.join(", ")}`
                );
            }

            if (modelStreamingMode) {
                this.logger.info(
                    `[Proxy] Detected streamingMode suffix in model path: "${toolStrippedModel}" -> model="${streamStrippedModel}", streamingMode="${modelStreamingMode}"`
                );
            }

            if (modelThinkingLevel) {
                this.logger.info(
                    `[Proxy] Detected thinkingLevel suffix in model path: "${streamStrippedModel}" -> model="${cleanModelName}", thinkingLevel="${modelThinkingLevel}"`
                );
            }

            // Always strip recognized directives from path model name
            if (cleanModelName !== rawModelName) {
                cleanPath = `${pathPrefix}${cleanModelName}${pathSuffix}`;
            }
        }

        // Force thinking for native Google requests (processed first)
        if (this.config.forceThinking && req.method === "POST" && bodyObj && bodyObj.contents) {
            if (!bodyObj.generationConfig) {
                bodyObj.generationConfig = {};
            }
            if (
                !bodyObj.generationConfig.thinkingConfig ||
                bodyObj.generationConfig.thinkingConfig.includeThoughts === undefined
            ) {
                this.logger.info(`[Proxy] ⚠️ Force thinking enabled, setting includeThoughts=true. (Google Native)`);
                bodyObj.generationConfig.thinkingConfig = {
                    ...(bodyObj.generationConfig.thinkingConfig || {}),
                    includeThoughts: true,
                };
            }
        }

        // If thinkingLevel is parsed from model name suffix, inject into thinkingConfig (after force thinking, higher priority, direct override)
        if (modelThinkingLevel && req.method === "POST" && bodyObj && bodyObj.contents) {
            if (!bodyObj.generationConfig) {
                bodyObj.generationConfig = {};
            }
            if (!bodyObj.generationConfig.thinkingConfig) {
                bodyObj.generationConfig.thinkingConfig = {};
            }
            // Model name suffix thinkingLevel has highest priority, direct override
            bodyObj.generationConfig.thinkingConfig.thinkingLevel = modelThinkingLevel;
            this.logger.info(
                `[Proxy] Applied thinkingLevel from model name suffix: ${modelThinkingLevel} (Google Native)`
            );
        }

        // Pre-process native Google requests
        // 1. Ensure thoughtSignature for functionCall (not functionResponse)
        // 2. Sanitize tools (remove unsupported fields, convert type to uppercase)
        if (req.method === "POST" && bodyObj) {
            if (bodyObj.contents) {
                this.formatConverter.ensureThoughtSignature(bodyObj);
            }
            if (bodyObj.tools) {
                this.formatConverter.sanitizeGeminiTools(bodyObj);
            }
        }

        const embedContentMatch = cleanPath.match(/^\/v1beta\/models\/([^:]+):embedContent$/);
        if (req.method === "POST" && embedContentMatch) {
            const modelName = embedContentMatch[1];
            cleanPath = `/v1beta/models/${modelName}:batchEmbedContents`;
            requestBodyObj = this._convertEmbedContentBodyToBatch(bodyObj, modelName);
            responseTransform = "batchEmbedToEmbedContent";
            this.logger.info(`[Proxy] Rewriting embedContent to batchEmbedContents for model "${modelName}".`);
        }

        // Force built-in tools for native Google requests
        if (
            (this.config.forceWebSearch ||
                modelForceWebSearch ||
                this.config.forceUrlContext ||
                this.config.forceCodeExecution ||
                modelForceCodeExecution) &&
            req.method === "POST" &&
            bodyObj &&
            bodyObj.contents
        ) {
            if (!bodyObj.tools) {
                bodyObj.tools = [];
            }

            const toolsToAdd = [];

            // Handle Google Search
            if (this.config.forceWebSearch || modelForceWebSearch) {
                const hasSearch = FormatConverter.hasGeminiGoogleSearchTool(bodyObj.tools);
                if (!hasSearch) {
                    bodyObj.tools.push({ googleSearch: {} });
                    toolsToAdd.push("googleSearch");
                } else {
                    this.logger.info(
                        `[Proxy] ✅ Client-provided web search detected, skipping force injection. (Google Native)`
                    );
                }
            }

            // Handle URL Context
            if (this.config.forceUrlContext) {
                const hasUrlContext = FormatConverter.hasGeminiUrlContextTool(bodyObj.tools);
                if (!hasUrlContext) {
                    bodyObj.tools.push({ urlContext: {} });
                    toolsToAdd.push("urlContext");
                } else {
                    this.logger.info(
                        `[Proxy] ✅ Client-provided URL context detected, skipping force injection. (Google Native)`
                    );
                }
            }

            // Handle Code Execution
            if (this.config.forceCodeExecution || modelForceCodeExecution) {
                const hasCodeExecution = FormatConverter.hasGeminiCodeExecutionTool(bodyObj.tools);
                if (!hasCodeExecution) {
                    bodyObj.tools.push({ codeExecution: {} });
                    toolsToAdd.push("codeExecution");
                } else {
                    this.logger.info(
                        `[Proxy] ✅ Client-provided code execution detected, skipping force injection. (Google Native)`
                    );
                }
            }

            if (toolsToAdd.length > 0) {
                this.logger.info(
                    `[Proxy] ⚠️ Forcing tools enabled, injecting: [${toolsToAdd.join(", ")}] (Google Native)`
                );
            }
        }

        this.formatConverter.ensureServerSideToolInvocations(bodyObj, "[Proxy]");

        // Apply safety settings for native Google requests (only if not already provided)
        if (req.method === "POST" && bodyObj && bodyObj.contents && !bodyObj.safetySettings) {
            bodyObj.safetySettings = this.formatConverter.getDefaultSafetySettings();
        }

        const outputMode = (modelStreamingMode || this.config.streamingMode) === "real" ? "real" : "fake";
        const query = { ...(req.query || {}) };
        if (outputMode === "fake" && cleanPath.endsWith(":streamGenerateContent")) {
            cleanPath = cleanPath.replace(":streamGenerateContent", ":generateContent");
            delete query.alt;
        }
        return {
            body: req.method !== "GET" ? JSON.stringify(requestBodyObj) : undefined,
            headers: req.headers,
            is_generative:
                req.method === "POST" &&
                (req.path.includes("generateContent") || req.path.includes("streamGenerateContent")),
            method: req.method,
            path: cleanPath,
            query_params: query,
            request_id: requestId,
            response_transform: responseTransform,
            streaming_mode: outputMode,
            transport_policy: TransportPolicy.resolve(this._extractModelFromPath(cleanPath), outputMode),
        };
    }

    _rejectUnsupportedAntiRequest(req, res, protocol) {
        const model = req.body?.model || req.path?.match(/\/models\/([^/:]+)/)?.[1];
        if (!model && req.body?.anti_truncation === undefined) return false;
        try {
            const policy = AntiTruncation.resolve(
                req.body || {},
                this.config,
                protocol,
                model || "gemini-2.5-flash-lite"
            );
            if (policy.prefixed && !policy.enabled) {
                if (req.body?.model) req.body.model = policy.model;
                else req.__antiNormalizedPath = req.path.replace(/(\/models\/)anti-/i, "$1");
            }
            if (req.body && typeof req.body === "object") delete req.body.anti_truncation;
            return false;
        } catch (error) {
            this._setResponseApiFormat(res, protocol);
            this._sendErrorResponse(res, error.status || 400, error.message, error.code);
            return true;
        }
    }

    _effectiveStreamMode(model, mode) {
        return TransportPolicy.resolve(model, mode).effectiveMode;
    }

    _assertModelPermission(proxyRequest, authIndex = this.currentAuthIndex) {
        let model = this._extractModelFromPath(proxyRequest.path);
        if (!model && proxyRequest.body) {
            try {
                model = JSON.parse(proxyRequest.body).model;
            } catch {
                /* File body. */
            }
        }
        if (!model) return;
        const config = this.serverSystem?.configurationService?.running || this.serverSystem?.config || this.config;
        const { normalizeModelName } = require("./ModelName");
        model = normalizeModelName(model);
        const scheduler = this.serverSystem?.scheduler;
        scheduler?.assertModelAccessible(model);
        if (config.scheduler?.registeredModels && !config.scheduler.registeredModels.includes(model))
            throw Object.assign(new Error(`Unknown model ${model}`), { code: "UNKNOWN_MODEL", status: 404 });
        if (!canUseModel(accountForIndex(this.authSource, authIndex), model, config.scheduler?.modelAllowlist))
            throw Object.assign(new Error(`Account tier does not allow model ${model}`), {
                code: "MODEL_TIER_DENIED",
                reason: "model_tier_denied",
                skipAccountSwitch: true,
                status: 403,
            });
    }

    async _ensureLegacyBenefit(proxyRequest) {
        if (!this.scheduled) this._assertModelPermission(proxyRequest);
        if (this.scheduled || !isArgon(this._extractModelFromPath(proxyRequest.path)) || !proxyRequest.is_generative)
            return;
        const benefit = this.browserManager.contexts?.get(this.currentAuthIndex)?.page?.buildBenefit;
        if (this.browserManager.benefitCheckingIndices?.has(this.currentAuthIndex))
            throw benefitError("Account benefit check in progress");
        if (!benefit) throw benefitError("Build benefit context unavailable");
        await benefit.assertReady();
    }

    _initializeProxyRequestAttempt(proxyRequest) {
        this.serverSystem?.playgroundResources?.prepareRequest(proxyRequest);
        if (proxyRequest.is_generative && !proxyRequest.transport_policy) {
            proxyRequest.transport_policy = TransportPolicy.resolve(
                this._extractModelFromPath(proxyRequest.path),
                proxyRequest.streaming_mode || "real"
            );
            proxyRequest.streaming_mode = proxyRequest.transport_policy.effectiveMode;
        }
        if (proxyRequest.is_generative && isArgon(this._extractModelFromPath(proxyRequest.path))) {
            // Client headers cannot attest to the host account's membership.
            proxyRequest.headers = Object.fromEntries(
                Object.entries(proxyRequest.headers || {}).filter(
                    ([name]) => !["x-aistudio-g1-tier", "x-goog-ext-519733851-bin"].includes(name.toLowerCase())
                )
            );
        }
        if (!proxyRequest.request_attempt_number) {
            proxyRequest.request_attempt_number = 1;
        }
        proxyRequest.request_attempt_id = this._generateRequestAttemptId(
            proxyRequest.request_id,
            proxyRequest.request_attempt_number
        );
    }

    _advanceProxyRequestAttempt(proxyRequest) {
        const context = proxyRequest.__antiContext;
        if (context) {
            const name = `agw_emit_${require("node:crypto").randomBytes(12).toString("hex")}`;
            proxyRequest.body = context.baseline.split(context.originalName).join(name);
            context.res.__antiAttempt = new AntiTruncation.Attempt(name, context.log);
            context.log("attempt_reset");
        }
        proxyRequest.request_attempt_number = (proxyRequest.request_attempt_number || 1) + 1;
        proxyRequest.request_attempt_id = this._generateRequestAttemptId(
            proxyRequest.request_id,
            proxyRequest.request_attempt_number
        );
    }

    _forwardRequest(proxyRequest, authIndex = this.currentAuthIndex) {
        this._assertModelPermission(proxyRequest, authIndex);
        const queue = this.connectionRegistry.messageQueues?.get(proxyRequest.request_id)?.queue;
        if (proxyRequest.is_generative && queue && !queue.responseGuard) {
            queue.responseGuard = new GenerationResponseGuard(
                {
                    attemptCount: proxyRequest.request_attempt_number || 1,
                    authIndex,
                    model: this._extractModelFromPath(proxyRequest.path),
                    requestAttemptId: proxyRequest.request_attempt_id,
                    requestId: proxyRequest.request_id,
                },
                proxyRequest.__antiContext ? AntiTruncation.MAX_BYTES : Infinity,
                proxyRequest.__antiContext
                    ? () => {
                          // Preserve anti's conservative no-replay rule for incomplete network frames.
                          const res = proxyRequest.__antiContext.res;
                          res.__upstreamOutputStarted = true;
                          this._stopEarlyStreamKeepalive?.();
                          res.__stopEarlyOpenAIStream?.();
                      }
                    : null
            );
        }
        const policy = proxyRequest.is_generative ? proxyRequest.transport_policy : null;
        if (policy?.transport === "makersuite") {
            const bridge = this.browserManager.contexts?.get(authIndex)?.page?.makerSuiteBridge;
            if (!bridge) throw benefitError("MakerSuite bridge unavailable");
        }
        if (policy) {
            // Capture the panel's budget once; retries, chunks and keepalives do not renew it.
            if (!proxyRequest.__generationDeadline) {
                const startedAt = performance.now();
                const budget = this.config.makerSuiteTimeoutMs || DEFAULT_MAKERSUITE_TIMEOUT_MS;
                const reserve = Math.min(BRIDGE_SETTLEMENT_MS, budget * 0.05);
                Object.defineProperty(proxyRequest, "__generationDeadline", { value: startedAt + budget + reserve });
                Object.defineProperty(proxyRequest, "__bridgeGenerationDeadline", { value: startedAt + budget });
            }
            const remaining = Math.floor(proxyRequest.__generationDeadline - performance.now());
            if (remaining <= 0) throw Object.assign(new Error("Generation deadline exceeded"), { status: 504 });
            proxyRequest.remaining_budget_ms = remaining;
            const entry = this.connectionRegistry.messageQueues?.get(proxyRequest.request_id);
            if (entry?.queue) {
                entry.queue.generationDeadline = proxyRequest.__generationDeadline;
                entry.queue.incremental = /:streamGenerateContent$/.test(proxyRequest.path);
                entry.transportPolicy = policy;
            }
        }
        if (this.browserManager.benefitCheckingIndices?.has(authIndex))
            throw benefitError("Account benefit check in progress");
        if (proxyRequest.is_generative && isArgon(this._extractModelFromPath(proxyRequest.path))) {
            const benefit = this.browserManager.contexts?.get(authIndex)?.page?.buildBenefit;
            if (!benefit || benefit.disposed || benefit.isCurrent?.() === false)
                throw benefitError("No qualified Playground account for gemini-4-argon");
            this.logger.info(
                `[Playground] account=${authIndex} request=${proxyRequest.request_id} attempt=${proxyRequest.request_attempt_id} model=gemini-4-argon transport=makersuite rpc=GenerateContent policy=${policy?.version || "unknown"} benefit_source=${benefit.source || "unknown"} benefit_state=${benefit.state} stream_mode=${proxyRequest.streaming_mode} incremental=true`
            );
        }
        if (policy)
            this.logger.info(
                `[Transport] account=${authIndex} request=${proxyRequest.request_id} attempt=${proxyRequest.request_attempt_id} model=${policy.model} transport=${policy.transport} rpc=GenerateContent policy=${policy.version} requested_mode=${policy.requestedMode} effective_mode=${policy.effectiveMode} budget=${policy.timeoutCategory} remaining_ms=${proxyRequest.remaining_budget_ms ?? "incremental"}`
            );
        const connection = this.connectionRegistry.getConnectionByAuth(authIndex);
        if (!connection?.dispatch)
            throw Object.assign(new Error(`Playground transport unavailable for account #${authIndex}`), {
                status: 503,
            });
        // Pass the original request, including its non-enumerable fixed deadlines.
        // No Build RPC envelope, URL marker or browser WebSocket is involved.
        connection.dispatch(proxyRequest);
    }

    _generateRequestId() {
        return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    }

    _generateRequestAttemptId(requestId, attemptNumber) {
        return `${requestId}_attempt_${attemptNumber}_${Math.random().toString(36).substring(2, 8)}`;
    }
}

module.exports = RequestHandler;
