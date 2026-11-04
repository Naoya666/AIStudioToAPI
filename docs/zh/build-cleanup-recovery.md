# Build 一次尽力清理（2026-11-04）

当前实现采用 `best_effort`，此前持续恢复、删除债务、降速和恢复 context 的要求已停用。每次生成创建独立 App；请求结束先释放生成租约，再异步交接清理，同 operation 至多执行一次。

有 Task 且未确认终态时尝试一次 Cancel，然后尝试一次 Delete。两个步骤各有全新的 AbortController 和完整 10 秒预算。Cancel 的 RPC9、网络错误或超时不阻止 Delete。已知终态、无 Task 而有 App 时直接 Delete。不额外读任务状态、不做删除确认或任务停止审计、不重试、不在重启后补跑。

清理仅使用原账号、页面、会话代际和现有 RPC 传输；身份变更、认证明确失效、页面关闭、传输不可用时跳过。现有传输有其他 RPC 时立即跳过该清理步骤，不等待容量、不申请 context、不中断 Playground。超时按调用 ID 取消并结束本地等待；迟到响应不能改写调度、额度或已结束请求。

失败只在现有日志中写关联 ID、账号编号、方法、attempted/skipped/failed、耗时和脱敏错误码。`attempted`/`response_received` 只表示收到响应，不是确认项目删除或任务已停止。日志写入失败也不影响生成、usage、账号/模型权限、额度或健康。

接受少量临时项目遗留。本地放弃清理不代表上游任务停止，也不保证额度退还。

## API 与配置

`GET /api/build/status` 的 `cleanup`、兼容的 `GET /api/build-recovery` 返回 `mode: best_effort` 和历史自动恢复已停用说明，不读取 journal 或恢复事件表，不声称旧项目已清零。旧 recover/bind/wake POST 返回 410、`scheduled: false`。管理界面已移除债务、下次恢复和清理阻挡展示。

`BUILD_CLEANUP_DEBT_LIMIT`、`BUILD_CLEANUP_NODE_DEBT_LIMIT`、`BUILD_RECOVERY_RPC_TIMEOUT_MS`、`BUILD_RECOVERY_BACKOFF_MS`、`BUILD_RECOVERY_MAX_BACKOFF_MS`、`BUILD_RECOVERY_ACCOUNT_INDICES` 不再生效。Cancel/Delete 固定各 10 秒。真实认证、额度、管理员禁用及层级权限继续有效。

外部渠道控制器只消费 `realtime.available_accounts`，未发现读取清理状态的契约；服务端健康投影已取消清理债务和恢复故障的影响。账号/模型业务规则仍控制真实可用性。

## 发布时的显式迁移

本次项目修改不执行生产发布或迁移。发布前分别核对 meow_us、meow_jp 的实际部署版本、Compose mounts、named volumes、账号/usage 数据库、journal 和可恢复备份，生成受限预变更快照，不输出凭据或数据库内容。源码修改前基线为 `be668b0`，工作区干净；实际生产版本须在发布时重新检查。

停止旧应用并确认旧恢复进程退出后，针对真实挂载的数据目录运行：

```sh
node scripts/ops/migrate-build-best-effort.js /actual/data /restricted/new-history-directory
```

工具把 `scheduler-state.json`、`build-projects.json*` 复制到权限 0700 的历史目录，文件为 0600，并写入脱敏 `migration-diff.json`。目标文件必须不存在，防止覆盖历史快照。journal 原件及归档保留，新应用不读取或恢复它们；不会将 pending 改为 deleted/done，也不会删除上游项目。

只从 scheduler 账号移除可明确归因于清理的五个字段：`buildRecoveryBlocked`、`buildRecoveryReason`、`buildRecoveryHoldUntil`、`buildCleanupDegraded`、`cleanupDebtCount`。账号/模型 disabled、禁用原因、认证、请求/token 与额度/冷却均保留；来源不明的禁用账号编号列入差异记录，交由发布核查。自定义 scheduler 文件名需按实际部署路径调整，不能迁移错误的数据目录。

历史 `build_recovery_events` 留在 usage 数据库，不再有新清理事件写入。不改变现有备份调度，历史材料纳入正常备份；检查新备份和云端上传，维持本地 1 份、云端最多 10 份，手工回退快照独立保留。

先发布一地，再扩展另一地。用同机相近负载的自然流量核对 Playground 派发、后台响应耗时、事件循环、子进程和 context 轮转，按 request ID 区分生成错误和清理错误。不主动批量生成消耗额度；自然事件不足时保留验证限制，不以 HTTP200 宣称已确认删除。

回退保留上线后的账号、请求、token 和额度状态，不以旧数据库覆盖新数据。禁止自动把历史 journal 接回旧恢复器，或伪造停用期间的新项目登记。旧镜像若重新启用持续恢复，会恢复原性能问题；优先修正简单清理实现。
