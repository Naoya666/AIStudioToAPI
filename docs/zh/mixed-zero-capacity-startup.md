# 混合零容量启动策略

管理服务完成配置加载和监听，与推理有可用 context 是两个状态。纯额度等待保持原行为；当健康、未禁用、认证未标记过期的全部调度账号，其获准可见模型都处于有效冷却或已有 unsupported 状态，且至少一个非 unsupported 槽位有有效限流截止时间时，允许确认启动。无需存在 last-good，也不要求当前配置与旧快照相同。

这不是对 Google 会话有效性的在线验证，unsupported 也不被解释为永久权限结论。管理配置响应新增 `modelAvailability`、`resourceWaiting` 和 `startupAcceptable`；`operational` 继续表达原有运行就绪语义。`modelAvailability.state` 区分 `available`、`quota_wait`、`model_availability_wait`、`models_unsupported` 和 `blocked`，后者通过 `reasons` 列出账号、认证、权限、模型可见性或调度暂停等原因。槽位数量不是账号数量。

全 unsupported、权限为空、认证失效、不健康或禁用账号不会通过新增等待路径。浏览器 FAILED/STARTING、初始化或清理未结束、恢复中、stale initialization、失败 context 和未结束的初始化任务同样不能通过。真正启动失败仍使用原有截止时间和 supervisor recovery。

等待期间不建立耗尽账号的 context，不把推理标为可用。main 心跳把资源等待与初始化阻塞区分，避免 supervisor 因等待额度的请求没有进展而重启。原有冷却唤醒、账号导入和模型权限变更路径继续重新评估候选池；不清除冷却、unsupported、用量或账号数据。

成功启动后 supervisor 确认实际运行配置。后续热更新成功时通过 IPC 更新 last-good，记录实际已应用的值及当前保存版本，待重启的目标值不会提前进入 last-good。因此同版本不意味着 saved 和 last-good 的全部字段必须相等。加载旧快照恢复时，用户在 managed overrides 中明确关闭的自动重登始终保留为关闭。

历史同版本自动重登差异的一个代码层来源是：原实现只在 ready/restart 消息时更新 last-good，热更新自身不更新。本修复覆盖此路径，不宣称已证明生产现场差异的唯一来源。

验证使用 `tests/fixtures/mixed-zero-capacity.json` 中的合成账号，结合真实 ModelScheduler、BrowserManager 候选池/协调逻辑及 main/supervisor 子进程。覆盖无旧快照、不同版本和配置的旧快照、纯冷却、混合等待、全 unsupported、浏览器故障、热更新与恢复、冷却到期、新账号及模型状态恢复。测试中的浏览器初始化与 HTTP 服务为隔离夹具，不连接 Google；真实 Camoufox 初始化和额度恢复后的上游生成需在具备有效会话的环境验收。
