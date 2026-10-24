class ProxyPoolRoutes {
    constructor(serverSystem) {
        this.service = serverSystem.proxyPoolService;
        this.distIndexPath = serverSystem.distIndexPath;
    }

    setupRoutes(app, isAuthenticated) {
        const route = handler => async (req, res) => {
            try {
                await handler(req, res);
            } catch (error) {
                res.status(error.status || 500).json({ error: error.message });
            }
        };
        app.get("/proxy-pool", isAuthenticated, (_req, res) => res.sendFile(this.distIndexPath));
        app.use("/api/proxy-pool", isAuthenticated);
        app.get(
            "/api/proxy-pool/status",
            route(async (_req, res) => res.json(this.service.status()))
        );
        app.get(
            "/api/proxy-pool/settings",
            route(async (_req, res) => res.json(this.service.settings()))
        );
        app.put(
            "/api/proxy-pool/settings",
            route(async (req, res) => res.json(await this.service.updateSettings(req.body || {})))
        );
        app.post(
            "/api/proxy-pool/mihomo/start",
            route(async (_req, res) => res.json(await this.service.manager.start(this.service.store.snapshot())))
        );
        app.post(
            "/api/proxy-pool/mihomo/stop",
            route(async (_req, res) => {
                await this.service.manager.stop();
                res.json({ success: true });
            })
        );
        app.post(
            "/api/proxy-pool/mihomo/reload",
            route(async (_req, res) => res.json(await this.service.manager.reload(this.service.store.snapshot())))
        );
        app.get(
            "/api/proxy-pool/nodes",
            route(async (_req, res) => res.json({ nodes: this.service.nodes() }))
        );
        app.post(
            "/api/proxy-pool/nodes",
            route(async (req, res) => res.status(201).json(await this.service.addNode(req.body || {})))
        );
        app.put(
            "/api/proxy-pool/nodes/:id",
            route(async (req, res) => res.json(await this.service.updateNode(req.params.id, req.body || {})))
        );
        app.delete(
            "/api/proxy-pool/nodes/:id",
            route(async (req, res) => {
                await this.service.deleteNode(req.params.id);
                res.status(204).end();
            })
        );
        app.post(
            "/api/proxy-pool/nodes/delete",
            route(async (req, res) => res.json(await this.service.deleteNodes(req.body?.ids)))
        );
        app.post(
            "/api/proxy-pool/nodes/import",
            route(async (req, res) => {
                const action = req.body?.preview ? "previewImport" : "importNodes";
                res.json(await this.service[action](req.body?.text || "", req.body?.format || "links"));
            })
        );
        app.post(
            "/api/proxy-pool/nodes/:id/test",
            route(async (req, res) => res.json(await this.service.testNode(req.params.id)))
        );
        app.post(
            "/api/proxy-pool/nodes/test",
            route(async (req, res) => {
                const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
                const results = await Promise.all(
                    ids.map(async id => {
                        try {
                            return { id, ...(await this.service.testNode(id)) };
                        } catch (error) {
                            return { id, message: error.message, success: false };
                        }
                    })
                );
                res.json({ results });
            })
        );
        app.get(
            "/api/proxy-pool/bindings",
            route(async (_req, res) => res.json({ bindings: this.service.bindings.list() }))
        );
        app.put(
            "/api/proxy-pool/bindings/:accountKey",
            route(async (req, res) =>
                res.json(
                    await this.service.setBinding(
                        req.params.accountKey,
                        req.body?.desiredNodeId || null,
                        req.body?.egressGroup
                    )
                )
            )
        );
        app.post(
            "/api/proxy-pool/bindings/batch",
            route(async (req, res) => res.json(await this.service.setBindings(req.body?.bindings || [])))
        );
        app.post(
            "/api/proxy-pool/bindings/:accountKey/apply",
            route(async (req, res) => res.status(202).json(this.service.apply(req.params.accountKey, true)))
        );
        app.post(
            "/api/proxy-pool/bindings/apply-idle",
            route(async (_req, res) => {
                const tasks = this.service.bindings
                    .list()
                    .filter(item => item.authIndex !== null && ["pending", "offline"].includes(item.state))
                    .map(item => this.service.apply(item.accountKey, false));
                res.status(202).json({ tasks });
            })
        );
        app.post(
            "/api/proxy-pool/bindings/apply-pending",
            route(async (_req, res) => {
                const tasks = this.service.bindings
                    .list()
                    .filter(item => item.authIndex !== null && ["pending", "offline"].includes(item.state))
                    .map(item => this.service.apply(item.accountKey, true));
                res.status(202).json({ tasks });
            })
        );
        app.get(
            "/api/proxy-pool/tasks/:taskId",
            route(async (req, res) => {
                const task = this.service.task(req.params.taskId);
                if (!task) return res.status(404).json({ error: "Task not found" });
                res.json(task);
            })
        );
        app.get(
            "/api/proxy-pool/subscriptions",
            route(async (_req, res) => res.json({ subscriptions: this.service.subscriptions() }))
        );
        app.post(
            "/api/proxy-pool/subscriptions",
            route(async (req, res) => res.status(201).json(await this.service.addSubscription(req.body || {})))
        );
        app.post(
            "/api/proxy-pool/subscriptions/:id/refresh",
            route(async (req, res) => res.json(await this.service.refreshSubscription(req.params.id)))
        );
        app.delete(
            "/api/proxy-pool/subscriptions/:id",
            route(async (req, res) => res.json(await this.service.deleteSubscriptions([req.params.id])))
        );
        app.post(
            "/api/proxy-pool/subscriptions/delete",
            route(async (req, res) => res.json(await this.service.deleteSubscriptions(req.body?.ids)))
        );
    }
}

module.exports = ProxyPoolRoutes;
