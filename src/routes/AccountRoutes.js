const { accountBundle, cookieState, credentialsCsv } = require("../accounts/AccountExport");
class AccountRoutes {
    constructor(system) {
        this.system = system;
    }
    setupRoutes(app, isAuthenticated) {
        const prefix = "/api/account-management";
        app.use(prefix, isAuthenticated, (req, res, next) => {
            res.set("Cache-Control", "no-store");
            next();
        });
        app.get("/accounts", isAuthenticated, (req, res) => res.sendFile(this.system.distIndexPath));
        const route = (method, endpoint, handler, status = 200) =>
            app[method](prefix + endpoint, async (req, res) => {
                try {
                    const service = this.system.accountLoginService;
                    if (!service?.state) return res.status(503).json({ error: "Account service unavailable" });
                    const result = await service.exclusive(() => handler(service, req, res));
                    if (!res.headersSent) res.status(status).json(result);
                } catch (cause) {
                    // Only domain errors reach the console; runtime errors can include submitted secrets.
                    res.status(cause.status || 503).json({
                        error: cause.status ? cause.message : "Account service unavailable",
                    });
                }
            });
        const matchingAccounts = (service, req) => {
            const search = String(req.query.search || "").toLowerCase(),
                filter = req.query.state;
            return service
                .list()
                .filter(
                    account =>
                        (!search ||
                            `${account.email} ${account.displayName} ${account.authIndex === null ? "" : "#" + account.authIndex}`
                                .toLowerCase()
                                .includes(search)) &&
                        (!filter ||
                            (filter === "duplicate"
                                ? account.isDuplicate
                                : filter === "not_logged_in"
                                  ? account.sessionState === "missing" && !!account.email && account.hasPassword
                                  : account.sessionState === filter || account.recoveryState === filter))
                );
        };
        route("get", "/accounts/selection", (service, req) => {
            const accounts = matchingAccounts(service, req);
            return { accounts, total: accounts.length };
        });
        route("get", "/accounts", (service, req) => {
            const accounts = matchingAccounts(service, req);
            const page = Math.max(1, Number(req.query.page) || 1),
                size = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
            return { accounts: accounts.slice((page - 1) * size, page * size), total: accounts.length };
        });
        route("post", "/benefit-checks", (service, req) => service.benefitQueue.submit(req.body?.accountIds), 202);
        route("get", "/benefit-checks", service => ({ tasks: service.state.benefitTasks }));
        route("post", "/benefit-checks/cancel", (service, req) => service.benefitQueue.cancel(req.body?.accountIds));
        route(
            "post",
            "/accounts/:id/check-benefits",
            (service, req) => service.benefitQueue.submit([req.params.id]),
            202
        );
        route("post", "/accounts/batch/cancel-login", (service, req) => service.batchCancelLogin(req.body));
        route("post", "/accounts", (service, req) => service.create(req.body), 202);
        route("patch", "/accounts/batch/recovery", (service, req) => service.setRecovery(req.body));
        route("post", "/export/credentials", (service, req, res) => {
            const csv = credentialsCsv(service.selectedAccounts(req.body));
            res.type("text/csv; charset=utf-8").attachment("credentials.csv").send(csv);
        });
        route("post", "/export/bundle", async (service, req, res) => {
            const buffer = await accountBundle(service.selectedAccounts(req.body), index => service.readAuth(index));
            res.type("application/zip").attachment("accounts.zip").send(buffer);
        });
        route("get", "/accounts/:id/download", async (service, req, res) => {
            const account = service.account(req.params.id);
            const state = account.authIndex === null ? null : await service.readAuth(account.authIndex);
            if (!state) throw Object.assign(new Error("Authentication file unavailable"), { status: 404 });
            res.type("application/json")
                .attachment(`auth-${account.authIndex}.json`)
                .send(JSON.stringify(cookieState(state), null, 2));
        });
        route("get", "/accounts/:id/credentials", (service, req) => service.credentials(req.params.id));
        route("patch", "/accounts/:id/credentials", (service, req) => service.edit(req.params.id, req.body));
        route("post", "/accounts/:id/login", (service, req) => service.login(req.params.id), 202);
        route("delete", "/accounts/:id", async (service, req) => {
            if (service.deduplicating)
                throw Object.assign(new Error("Account deduplication is in progress"), { status: 409 });
            const account = service.account(req.params.id);
            service.invalidate(account);
            if (account.authIndex !== null) {
                await service.retireContext(account.authIndex);
                await service.removeIndex(account.authIndex);
            } else {
                service.state.accounts = service.state.accounts.filter(item => item !== account);
                await service.save();
            }
            return { deleted: true };
        });
        route("get", "/login-tasks", (service, req) => {
            const tasks = service.state.tasks
                .filter(task => !req.query.accountId || task.accountId === req.query.accountId)
                .slice()
                .reverse();
            const page = Math.max(1, Number(req.query.page) || 1),
                size = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
            return {
                tasks: tasks.slice((page - 1) * size, page * size).map(({ token, ...task }) => task),
                total: tasks.length,
            };
        });
        route("post", "/login-tasks/:id/cancel", (service, req) => service.cancel(req.params.id));
        route("get", "/login-queue", service => service.queue.snapshot());
        route("patch", "/login-queue", async (service, req) => {
            const { autoRecovery, concurrency, paused } = req.body;
            if (
                concurrency !== undefined &&
                (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)
            )
                throw Object.assign(new Error("Concurrency must be 1–32"), { status: 400 });
            if (paused !== undefined && typeof paused !== "boolean")
                throw Object.assign(new Error("paused must be boolean"), { status: 400 });
            if (autoRecovery !== undefined && typeof autoRecovery !== "boolean")
                throw Object.assign(new Error("autoRecovery must be boolean"), { status: 400 });
            if (autoRecovery !== undefined || concurrency !== undefined) {
                const manager = this.system.configurationService;
                if (!manager) throw Object.assign(new Error("统一配置服务未就绪"), { status: 503 });
                const changes = {};
                if (autoRecovery !== undefined) changes.ACCOUNT_AUTO_RELOGIN_ENABLED = autoRecovery;
                if (concurrency !== undefined) changes.ACCOUNT_LOGIN_CONCURRENCY = concurrency;
                manager.save({ changes, version: req.body.version });
            }
            if (paused !== undefined) service.state.config.paused = paused;
            await service.save();
            return service.queue.snapshot();
        });
        route("post", "/import/preview", (service, req) =>
            service.preview(req.sessionID, req.body.kind, req.body.content)
        );
        route("post", "/import/commit", (service, req) => service.importCommit(req.sessionID, req.body));
        route("get", "/artifacts/:id", async (service, req, res) => {
            const data = await service.artifacts.read(service.state.artifacts.find(item => item.id === req.params.id));
            res.type("png").send(data);
        });
    }
}
module.exports = AccountRoutes;
