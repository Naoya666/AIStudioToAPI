class OperationTimeoutError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "OperationTimeoutError";
        this.code = details.code || "OPERATION_TIMEOUT";
        this.reason = details.reason || "operation_timeout";
        Object.assign(this, details);
    }
}

function withHardTimeout(task, timeoutMs, details = {}) {
    let timer;
    const operation = Promise.resolve().then(task);
    // Promise.race observes the rejection too, but keep an explicit handler on
    // the underlying RPC because it can settle long after the race is over.
    operation.catch(() => {});
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(
                new OperationTimeoutError(`${details.operation || "Operation"} timed out after ${timeoutMs}ms`, {
                    ...details,
                    timeoutMs,
                })
            );
        }, timeoutMs);
        if (details.unref) timer.unref?.();
    });
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { OperationTimeoutError, withHardTimeout };
