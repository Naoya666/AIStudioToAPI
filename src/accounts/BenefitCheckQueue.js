/* global window */
const { randomUUID } = require("node:crypto");
const { BuildBenefitContext } = require("../core/BuildBenefitContext");
const active = task => ["queued", "waiting", "running"].includes(task.status);
const failure = reason => Object.assign(new Error(reason), { reason });

// One executor and one temporary context across all submissions. Only short
// persistence operations enter AccountLoginService.exclusive().
class BenefitCheckQueue {
    constructor(service, { waitMs = 60000, operationMs = 15000, queryMs = 5000 } = {}) {
        Object.assign(this, { operationMs, queryMs, service, waitMs });
        this.limit = 500;
        this.resourceFaultGeneration = null;
    }
    latest(accountId) {
        return this.service.state.benefitTasks?.findLast(task => task.accountId === accountId) || null;
    }
    async submit(ids) {
        if (this.stopped) throw Object.assign(new Error("Benefit queue is closed"), { status: 503 });
        if (!Array.isArray(ids) || !ids.length || ids.length > this.limit || ids.some(id => typeof id !== "string"))
            throw Object.assign(new Error("Expected 1–500 account IDs"), { status: 400 });
        const tasks = this.service.state.benefitTasks;
        const results = [];
        for (const accountId of new Set(ids)) {
            const account = this.service.state.accounts.find(item => item.accountId === accountId);
            const existing =
                this.current?.task.accountId === accountId
                    ? this.current.task
                    : tasks.find(task => task.accountId === accountId && active(task));
            if (existing) {
                results.push({ accountId, status: "duplicate", taskId: existing.taskId });
                continue;
            }
            let reason = !account
                ? "account_not_found"
                : account.authIndex === null || account.sessionState !== "valid"
                  ? "authentication_unavailable"
                  : null;
            if (!reason) {
                const storage = await this.service.readAuth(account.authIndex);
                if (!storage || !Array.isArray(storage.cookies) || !Array.isArray(storage.origins))
                    reason = "authentication_unavailable";
            }
            if (!reason && tasks.filter(active).length >= this.limit) reason = "queue_full";
            if (reason) {
                results.push({ accountId, reason, status: "rejected" });
                continue;
            }
            const task = {
                accountId,
                authIndex: account.authIndex,
                createdAt: Date.now(),
                sessionVersion: account.sessionVersion,
                status: "queued",
                taskId: randomUUID(),
            };
            tasks.push(task);
            results.push({ accountId, status: "queued", taskId: task.taskId });
        }
        this.service.state.benefitTasks = tasks
            .filter(active)
            .concat(tasks.filter(task => !active(task)).slice(-1000))
            .sort((a, b) => a.createdAt - b.createdAt);
        await this.service.save();
        setImmediate(() => this.pump());
        return { results };
    }
    cancelAccount(accountId) {
        for (const task of this.service.state.benefitTasks || []) {
            if (task.accountId !== accountId || !active(task)) continue;
            Object.assign(task, { finishedAt: Date.now(), reason: "cancelled", status: "cancelled" });
            if (this.current?.task === task) this.current.controller.abort();
        }
    }
    async cancel(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > this.limit || ids.some(id => typeof id !== "string"))
            throw Object.assign(new Error("Expected 1–500 account IDs"), { status: 400 });
        for (const id of new Set(ids)) this.cancelAccount(id);
        await this.service.save();
        return { cancelled: true };
    }
    valid(task) {
        const account = this.service.state.accounts.find(item => item.accountId === task.accountId);
        return (
            active(task) &&
            !this.stopped &&
            !!account &&
            account.authIndex === task.authIndex &&
            account.sessionVersion === task.sessionVersion &&
            account.sessionState === "valid" &&
            !this.service.invalidated.has(task.authIndex)
        );
    }
    async bound(work, signal, ms = this.operationMs, lateCleanup) {
        if (signal.aborted) throw failure("cancelled");
        let timer, abort;
        let expired = false;
        const promise = Promise.resolve().then(work);
        promise.then(
            value => {
                if (expired) lateCleanup?.(value);
            },
            () => {}
        );
        try {
            return await Promise.race([
                promise,
                new Promise((_, reject) => {
                    abort = () => {
                        expired = true;
                        reject(failure("cancelled"));
                    };
                    signal.addEventListener("abort", abort, { once: true });
                    timer = setTimeout(() => {
                        expired = true;
                        reject(failure("timeout"));
                    }, ms);
                }),
            ]);
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
        }
    }
    async pause(signal) {
        await this.bound(() => new Promise(resolve => setTimeout(resolve, 200)), signal, 1000);
    }
    async pump() {
        if (this.running || this.stopped) return;
        this.running = this.run()
            .catch(() => this.service.logger.error("[Accounts] Benefit queue failed"))
            .finally(() => {
                this.running = null;
            });
        await this.running;
    }
    async run() {
        while (!this.stopped) {
            const task = this.service.state.benefitTasks.find(item => item.status === "queued");
            if (!task) return;
            const controller = new AbortController();
            this.current = { controller, task };
            const signal = controller.signal;
            let context,
                benefit,
                reused = false,
                reservation;
            const browserManager = this.service.system.browserManager;
            let generation;
            let locked = false;
            const current = () =>
                this.valid(task) &&
                !signal.aborted &&
                (generation === undefined || generation === browserManager?.browserGeneration);
            const monitor = setInterval(() => {
                if (!current()) controller.abort();
            }, 200);
            try {
                if (!browserManager) throw failure("browser_unavailable");
                Object.assign(task, { startedAt: Date.now(), status: "waiting" });
                await this.service.exclusive(() => this.service.save());
                const deadline = Date.now() + this.waitMs;
                while (!signal.aborted) {
                    if (!current()) throw failure("session_changed");
                    if (Date.now() >= deadline) throw failure("resource_wait_timeout");
                    const loginBusy =
                        this.service.state.tasks.some(
                            item => item.accountId === task.accountId && (item.status === "running" || item.executor)
                        ) || this.service.isLoginStopping(task.accountId);
                    const existingContext = browserManager.contexts.get(task.authIndex);
                    const contextBusy =
                        existingContext &&
                        (!browserManager.isContextReady(task.authIndex) ||
                            existingContext.draining ||
                            existingContext.monitorRunning);
                    if (
                        !contextBusy &&
                        (!this.resourceBarrier || this.resourceGeneration !== browserManager.browserGeneration) &&
                        this.resourceFaultGeneration !== browserManager.browserGeneration &&
                        !loginBusy &&
                        !browserManager._recovering &&
                        !browserManager.isClosingIntentionally &&
                        !browserManager.initializingContexts?.has(task.authIndex) &&
                        !browserManager.contextCapacityReservations?.has(task.authIndex) &&
                        !browserManager._poolClosingContexts?.has(task.authIndex) &&
                        !browserManager._contextPoolReplacements?.has(task.authIndex) &&
                        browserManager._isContextIdle(task.authIndex)
                    )
                        break;
                    await this.pause(signal);
                }
                if (signal.aborted) throw failure("cancelled");
                // Claim before awaiting: scheduler leases, pool navigation and login
                // executors all respect this same account lock.
                browserManager.benefitCheckingIndices ||= new Set();
                browserManager.benefitCheckingIndices.add(task.authIndex);
                locked = true;
                const data = browserManager.contexts.get(task.authIndex);
                if (data) {
                    if (
                        !browserManager.isContextReady(task.authIndex) ||
                        !data.page?.buildBenefit ||
                        data.page.accountSessionVersion !== task.sessionVersion
                    )
                        throw failure("context_unavailable");
                    benefit = data.page.buildBenefit;
                    reused = true;
                } else {
                    // Ordinary capacity is reserved when available; otherwise this
                    // sole executor owns the one global overflow detection context.
                    const capacity = browserManager.scheduler?.config?.maxWorkers || browserManager.config?.maxContexts;
                    if (capacity && browserManager._contextCapacityIndices().size < capacity) {
                        reservation = { authIndex: task.authIndex, purpose: "benefit" };
                        browserManager.contextCapacityReservations ||= new Map();
                        browserManager.contextCapacityReservations.set(task.authIndex, reservation);
                    }
                    await this.bound(() => browserManager._ensureBrowser(), signal);
                    generation = browserManager.browserGeneration;
                    const storage = await this.service.readAuth(task.authIndex);
                    if (
                        !storage ||
                        (storage._accountSessionVersion ?? task.sessionVersion) !== task.sessionVersion ||
                        !current()
                    )
                        throw failure("session_changed");
                    const proxy = await this.bound(
                        async () => this.service.resolveProxy(this.service.account(task.accountId)),
                        signal
                    );
                    const creation = browserManager._createBrowserContext(
                        {
                            storageState: { cookies: storage.cookies, origins: storage.origins },
                            ...(proxy ? { proxy } : {}),
                        },
                        task.authIndex
                    );
                    this.resourceGeneration = generation;
                    const barrier = creation
                        .then(async value => {
                            if (signal.aborted || !current()) await value.close();
                        })
                        .catch(() => {
                            this.resourceFaultGeneration = generation;
                            browserManager._triggerBrowserRecovery?.("benefit_context_creation_failed");
                        });
                    this.resourceBarrier = barrier;
                    barrier.finally(() => {
                        if (this.resourceBarrier === barrier) this.resourceBarrier = null;
                    });
                    context = await this.bound(
                        () => creation,
                        signal,
                        this.operationMs,
                        value => {
                            const closing = value.close();
                            this.holdResource(closing, generation);
                            closing.catch(() => {});
                        }
                    );
                    const page = await this.bound(() => context.newPage(), signal);
                    benefit = new BuildBenefitContext(page, {
                        authIndex: task.authIndex,
                        isCurrent: current,
                        timeoutMs: this.queryMs,
                    });
                    await this.bound(() => benefit.install(), signal);
                    await this.bound(
                        () =>
                            page.goto(browserManager.targetUrl, {
                                timeout: this.operationMs,
                                waitUntil: "domcontentloaded",
                            }),
                        signal
                    );
                }
                generation ??= browserManager.browserGeneration;
                const epoch = benefit.epoch;
                const validDocument = () =>
                    current() && !benefit.disposed && benefit.isCurrent() && benefit.epoch === epoch;
                Object.assign(task, { status: "running" });
                await this.service.exclusive(() => this.service.save());
                const authDeadline = Date.now() + this.operationMs;
                while (!(await this.bound(() => benefit._evaluate(() => !!window.__buildBenefit?.auth), signal))) {
                    if (!validDocument()) throw failure("document_changed");
                    if (Date.now() >= authDeadline) throw failure("auth_unavailable");
                    await this.pause(signal);
                }
                await this.bound(() => benefit.ensure({ refresh: true, signal }), signal, this.queryMs + 1000);
                if (!validDocument()) throw failure("document_changed");
                const result = {
                    rawTier: benefit.rawTier,
                    reason: benefit.failureReason,
                    source: "query",
                    state: benefit.state,
                };
                const saved = await this.service.recordBenefit(
                    task.accountId,
                    task.sessionVersion,
                    result,
                    validDocument
                );
                if (!saved) throw failure("session_changed");
                Object.assign(task, {
                    reason: result.reason || null,
                    result,
                    status: result.state === "failed" ? "failed" : "succeeded",
                });
            } catch (error) {
                const reason = error.reason || "query_failed";
                if (active(task)) {
                    task.status = signal.aborted ? "cancelled" : "failed";
                    task.reason = reason;
                    if (current() || (task.status === "failed" && this.valid({ ...task, status: "running" })))
                        await this.service.recordBenefit(
                            task.accountId,
                            task.sessionVersion,
                            { reason, state: "failed" },
                            () => generation === undefined || generation === browserManager?.browserGeneration
                        );
                }
            } finally {
                clearInterval(monitor);
                // Abort an in-flight RPC on a reused document without disposing its observer.
                if (reused && signal.aborted)
                    await this.bound(
                        () => benefit._evaluate(() => window.__buildBenefit?.controller?.abort()),
                        new AbortController().signal
                    ).catch(() => {});
                if (!reused) benefit?.dispose();
                if (context) {
                    // Retain global ownership if close stalls; reset the browser rather
                    // than admitting another temporary context alongside an orphan.
                    const closing = context.close();
                    this.holdResource(closing, generation);
                    await this.bound(() => closing, new AbortController().signal).catch(() => {
                        this.resourceFaultGeneration = generation;
                        browserManager._triggerBrowserRecovery?.("benefit_context_cleanup_timeout");
                    });
                }
                if (locked) browserManager.benefitCheckingIndices.delete(task.authIndex);
                browserManager?._releaseContextCapacity?.(task.authIndex, reservation);
                task.finishedAt = Date.now();
                this.current = null;
                await this.service.exclusive(() => this.service.save());
                this.service.notifyTierChanged();
                browserManager?.handleAccountLeaseReleased?.(task.authIndex);
            }
        }
    }
    holdResource(promise, generation) {
        const barrier = Promise.resolve(promise).catch(() => {
            this.resourceFaultGeneration = generation;
            this.service.system.browserManager?._triggerBrowserRecovery?.("benefit_context_cleanup_failed");
        });
        this.resourceGeneration = generation;
        this.resourceBarrier = barrier;
        barrier.finally(() => {
            if (this.resourceBarrier === barrier) this.resourceBarrier = null;
        });
    }
    async close() {
        this.stopped = true;
        for (const task of this.service.state.benefitTasks || []) if (active(task)) this.cancelAccount(task.accountId);
        await this.running;
    }
}
module.exports = BenefitCheckQueue;
