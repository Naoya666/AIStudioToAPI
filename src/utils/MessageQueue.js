/**
 * File: src/utils/MessageQueue.js
 * Description: Asynchronous message queue for managing request/response communication between server and browser client
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const { EventEmitter } = require("events");
const { isPromptBlocked } = require("./UpstreamBlock");

/**
 * Custom error class for queue closed errors
 */
class QueueClosedError extends Error {
    constructor(message = "Queue is closed", reason = "unknown", details = {}) {
        super(message);
        this.name = "QueueClosedError";
        this.code = "QUEUE_CLOSED";
        this.reason = reason;
        this.kind = details.kind || "transport";
        this.retryable = details.retryable ?? true;
        this.cooldown = details.cooldown ?? false;
    }
}

/**
 * Custom error class for queue timeout errors
 */
class QueueTimeoutError extends Error {
    constructor(message = "Queue timeout") {
        super(message);
        this.name = "QueueTimeoutError";
        this.code = "QUEUE_TIMEOUT";
        this.status = 504;
    }
}

/**
 * Message Queue Module
 * Responsible for managing asynchronous message enqueue and dequeue
 */
class MessageQueue extends EventEmitter {
    constructor(timeoutMs = 300000) {
        super();
        this.messages = [];
        this.waitingResolvers = [];
        this.defaultTimeout = timeoutMs;
        this.closed = false;
        this.closeReason = null;
    }

    enqueue(message) {
        const messages = this.responseGuard ? this.responseGuard.push(message) : [message];
        for (const item of messages) this._enqueue(item);
    }

    _enqueue(message) {
        if (message.upstreamOutputStarted) this.upstreamOutputStarted = true;
        if (message.event_type === "response_headers") this.receivedHeaders = true;
        if (isPromptBlocked(message)) this.blockedError = Object.assign(new Error(message.message), message);
        if (this.closed) return;
        if (this.waitingResolvers.length > 0) {
            const resolver = this.waitingResolvers.shift();
            // Check if resolver is still valid (not timed out)
            if (resolver && resolver.timeoutId) {
                clearTimeout(resolver.timeoutId);
                resolver.resolve(message);
            } else {
                // Resolver already timed out, push message to queue instead
                this.messages.push(message);
            }
        } else {
            this.messages.push(message);
        }
    }

    async dequeue(timeoutMs = this.defaultTimeout) {
        const message = await this._dequeue(timeoutMs);
        if (isPromptBlocked(message) || message.responseGuardError)
            throw Object.assign(new Error(message.message), message);
        return message;
    }

    async _dequeue(timeoutMs = this.defaultTimeout) {
        if (this.generationDeadline !== undefined) {
            const remaining = Math.floor(this.generationDeadline - performance.now());
            timeoutMs = this.incremental && this.receivedHeaders ? Math.min(timeoutMs, remaining) : remaining;
            if (timeoutMs <= 0) throw this.blockedError || new QueueTimeoutError("Generation deadline exceeded");
        }
        if (this.closed) {
            throw this._closedError();
        }
        return new Promise((resolve, reject) => {
            // Check if there are already queued messages
            if (this.messages.length > 0) {
                resolve(this.messages.shift());
                return;
            }

            // Create resolver with timeout BEFORE pushing to waitingResolvers
            // This prevents race condition where enqueue() sees timeoutId=null
            const resolver = { reject, resolve, timeoutId: null };

            // Set timeout first to ensure resolver is fully initialized
            resolver.timeoutId = setTimeout(() => {
                const index = this.waitingResolvers.indexOf(resolver);
                if (index !== -1) {
                    this.waitingResolvers.splice(index, 1);
                }
                // Clear timeoutId to mark resolver as invalid
                resolver.timeoutId = null;
                reject(new QueueTimeoutError());
            }, timeoutMs);

            // Now push to waitingResolvers - resolver is fully initialized
            this.waitingResolvers.push(resolver);

            // CRITICAL: Check again if messages arrived during initialization
            // This handles the race where enqueue() was called between the initial
            // check (line 70) and push (line 89)
            if (this.messages.length > 0 && this.waitingResolvers[0] === resolver) {
                // We're still the first waiter, consume the message
                this.waitingResolvers.shift();
                clearTimeout(resolver.timeoutId);
                resolve(this.messages.shift());
            }
        });
    }

    close(reason = "unknown") {
        this.closed = true;
        this.closeReason = reason;
        this.waitingResolvers.forEach(resolver => {
            clearTimeout(resolver.timeoutId);
            resolver.reject(this._closedError());
        });
        this.waitingResolvers = [];
        this.messages = [];
    }

    _closedError() {
        if (this.blockedError) return this.blockedError;
        const details = typeof this.closeReason === "object" ? this.closeReason : { reason: this.closeReason };
        const reason = details.reason || "unknown";
        return Object.assign(
            new QueueClosedError(`Queue is closed (reason: ${reason})`, reason, details),
            this.upstreamOutputStarted ? { upstreamOutputStarted: true } : {}
        );
    }
}

module.exports = MessageQueue;
module.exports.QueueClosedError = QueueClosedError;
module.exports.QueueTimeoutError = QueueTimeoutError;
