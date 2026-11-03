const { Worker } = require("node:worker_threads");
const path = require("node:path");

class UsageStatsStorage {
    constructor(options) {
        this.pending = new Map();
        this.nextId = 1;
        this.closed = false;
        this.worker = new Worker(path.join(__dirname, "UsageStatsWorker.js"), { workerData: options });
        this.ready = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        this.worker.on("message", message => {
            if (message.ready) {
                this.readySettled = true;
                this.resolveReady(message.migration);
                if (!this.pending.size) this.worker.unref();
                return;
            }
            if (message.fatal) return this.rejectReady(new Error(message.fatal.message));
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error)
                pending.reject(Object.assign(new Error(message.error.message), { status: message.error.status }));
            else pending.resolve(message.result);
            if (!this.pending.size) this.worker.unref();
        });
        this.worker.on("error", error => {
            this.rejectReady(error);
            for (const pending of this.pending.values()) pending.reject(error);
            this.pending.clear();
        });
    }

    async call(command, payload) {
        if (this.closed) throw new Error("Usage storage is closed");
        await this.ready;
        if (this.pending.size >= 10000) throw new Error("Usage storage queue is full");
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.worker.ref();
            this.pending.set(id, { reject, resolve });
            try {
                this.worker.postMessage({ command, id, payload });
            } catch (error) {
                this.pending.delete(id);
                if (!this.pending.size) this.worker.unref();
                reject(error);
            }
        });
    }

    async close() {
        if (this.closed) return;
        try {
            await this.call("close");
        } finally {
            this.closed = true;
            await this.worker.terminate();
        }
    }
}

module.exports = UsageStatsStorage;
