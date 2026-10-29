# 日额度耗尽账号反复重建 context 的修复

对应诊断：`/home/dev/workspace/infra/diagnostics/meow-jp-quota-context-rebuild-20261029/README.md`。

PlaygroundTransport.dispose 会同步关闭 PlaygroundConnection。closeContext 现在先记录关闭 owner、移出 contexts、结束消息队列并取消恢复任务，再释放 transport 和底层 context。浏览器整体清理同样先移出全部 owner 并取消恢复，再 dispose，避免同步 close 被识别为意外掉线。旧 owner 的关闭标记不会阻挡同账号替换 context 的恢复。

ConnectionRegistry.cancelReconnect 统一清理 grace timer、轻量重连超时和重连状态，即使连接已不存在也执行。每次恢复持有独立任务身份，并绑定 context owner；grace 开始、回调启动以及 finally 补建前重新检查身份和入池资格。旧回调不能登记恢复需求，也不能清除新任务的状态。先登记取消机制再调用恢复回调，覆盖回调同步重新连接的情况。

无模型自动恢复在登记和有效性判断时遵守 isAccountPoolResident，不再通过短期需求绕过模型额度。初始化在关闭旧 context 后、创建新 context 前再次检查资格。保留有模型的有效排队需求、真实前台等待和 **files** 文件租约的合法例外，不清空模型冷却。轻量恢复在异步步骤间检查原 owner 和资格；旧页面操作晚返回或抛认证错误时不能关闭替换 context，同一 owner 的真实认证失效仍正常清理。

新增 tests/context-reconnect-lifecycle.test.js 并接入 npm test，覆盖真实 PlaygroundConnection 同步 close、已有和已执行恢复任务的取消、新旧任务隔离、正常意外掉线成功及失败恢复、grace 或回调期间额度变化、双模型耗尽、单模型恢复可用、前台和文件需求、浏览器整体清理以及迟到认证错误。

本地验证：npm test 全量通过（含现有条件跳过的测试）；相关生命周期、browser-workers、browser-recovery、model-context-warm-targets 共 146 项通过。原诊断 repro.cjs 输出主动关闭残留 timer 为 0、无 unscoped 恢复需求、recovery_bypasses_quota=false。修改文件的 ESLint、Prettier 和 git diff --check 通过。全仓 npm run lint 被 5 个未修改的历史 JSON fixture 中共 1694 项格式及键排序错误阻塞。

此修复仅涉及项目源码和本地验证，未部署日本实例，未调整生产配置或冷却记录。
