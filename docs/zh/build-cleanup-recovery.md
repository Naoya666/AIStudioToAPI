# Build 持续可用与最终删除

对应 2026-11-03《build-sustainable-cleanup-fix-spec》。本次为项目源码修改和离线验证；未登录 JP/US 节点、未调用真实生成/删除 RPC、未发布或修改外部渠道控制器。旧文档中“Cancel 必须先成功”“quarantined 永不自动执行”“任何历史债务阻挡账号”的策略已被替换。

## 执行与事实

CreateApplet 前写入 operationId、accountKey、requestId 和创建意图；描述包含 `gateway-operation:<operationId>`，不包含用户内容。App ID、提交意图、Task ID、任务终态分别立即落盘。每个新请求创建新项目；恢复只处理已有资源，不能重新创建或提交生成。

前台结束先保存进度和无前台所有权的交接记录，再释放 active 所有权，由同一个恢复管理器接管。清理不继承客户端 signal，不延长前台生成请求。后续清理失败不改变已成立的生成成功、主错误或统计。日志或事件存储不可写时显式报告节点故障并对 Build 临时背压；修复后定时重新读入并协调。

后台对于已知 App：任务已终态或已确认取消时直接 Delete；未知任务先有界读取原 Task，再尝试 Cancel。读取失败、Cancel RPC9、超时、其他业务失败均不会截断 Delete。401、页面或会话身份改变时停止当前上下文调用，保留删除义务等待正确身份。每个方法每轮最多一次，RPC 有独立超时，清理 RPC 强制最多 10 秒，一轮最多读取、Cancel、Delete 三步。Delete 首次失败后下轮默认直接 Delete；只有上游结构化 reason=`GENERATION_RUNNING` 时才重新安排读取/取消。

项目删除和任务停止分别记录。Cancel 失败、Delete 成功不会填造 cancelConfirmedAt 或 taskTerminalAt；项目债务释放，已知 Task 每 30 分钟进行一次可行的只读核查，不因此永久阻挡账号。没有 Task ID 的任务状态继续显示未知。

删除确认仅接受当前有效账号/页面/会话中，已限定方法返回的既有 protobuf 确认形状 `[]` 或 `[null]`，或 Delete 的明确结构化 RPC code 5。通用 HTTP404、任意 HTTP200、空正文、未知数组、超时不算删除证据。代码不假定项目删除意味着任务停止或额度返还。上述响应契约仍须在小范围真实账号上验证。

## 日志、迁移与调度

`BuildRecoveryStore` 使用 schemaVersion=3；保留旧标识、错误、尝试计数和确认，不从 complete=false 推断运行状态。资源定位、任务证据、项目删除、调度状态分开保存。v1/v2 迁移前保留权限 0600 的 `build-projects.json.pre-v3-*`。旧 quarantined 自动重新调度；App 已知的 verify_pending 进入 Delete，App 未知则保留 discovery_pending。旧孤立清理阻挡标记转成可见的资源定位记录，不盲目认为资源不存在。

同步 read/modify/write、revision 检查、文件 fsync、原子替换、目录 fsync、跨进程 flock 和进程内 operation/账号执行锁保留。活动 operation 及其他活动 operation 正在使用的项目不能被删除；旧页、旧会话、旧回调不能提交新确认。单应用进程部署；禁止旧版无锁进程与新版并行写日志，禁止删除运行中的 lock inode。

单节点恢复并发 1，按账号轮转。恢复需求使用原 context 池和容量上限。现有页面有 PG 在途时，先登记恢复需求阻止该页面接收新派发，等待在途结束后清理；其他账号需要 context 时使用原池的 drain/replacement。不会仅因持续 PG 流量永远跳过恢复。

普通故障从 5 秒指数退避至 5 分钟，带抖动；400、未知协议、持续权限问题低频最多 30 分钟。达到账号债务上限时将恢复探测间隔压至最多 5 分钟，可信 Retry-After 仍是下限。401/403 在同账号会话或认证恢复证据变化后可提前唤醒。没有失败次数截止，也不清除真实认证、管理员禁用、模型权限或生成额度状态。

## 有界准入

按用户后续决定，已退出前台且没有 App ID 的未知记录仅用于审计和后续定位，不占账号或节点债务名额，不触发降速或暂停；这取代原规范中“未定位 operation 也占名额”的条款。找到并核实 App ID 后，尚未删除的项目重新纳入债务。活动请求在拿到 App ID 前仍占预留，结束后才释放。

无债务使用原规则；有债务且未满时，同账号 Build 并发降到 1；达到账号或节点上限时停止新建资源，后台继续恢复，删除成功后自动接单。临时恢复租约仅阻挡争用页面的派发。已知 App 的债务、活动 operation 与尚未写入 operation 的 Build 派发预留合并计数；检查和 scheduler inflight 预留在同一同步派发路径执行，避免并发超限。达到上限不会随时间自动遗忘债务。

下列环境变量在启动读取，需重启生效，当前选择在恢复 snapshot 中展示：

| 配置                           | 默认       | 含义                                                             |
| ------------------------------ | ---------- | ---------------------------------------------------------------- |
| BUILD_CLEANUP_DEBT_LIMIT       | 3          | 每账号已知未删除项目与活动预留总上限，范围 1–1000                |
| BUILD_CLEANUP_NODE_DEBT_LIMIT  | 账号数 × 3 | 节点总上限；更改账号阈值后默认随之变化，范围 1–100000            |
| BUILD_RECOVERY_RPC_TIMEOUT_MS  | 10000      | 配置范围 100–60000 毫秒；清理方法实际强制最多 10000 毫秒         |
| BUILD_RECOVERY_BACKOFF_MS      | 5000       | 普通重试初始退避，范围 1000–300000 毫秒                          |
| BUILD_RECOVERY_MAX_BACKOFF_MS  | 300000     | 普通退避上限，不小于初始值，最多 3600000 毫秒                    |
| BUILD_RECOVERY_ACCOUNT_INDICES | 未设置     | 恢复账号 allowlist；空字符串暂停后台领取，不能清空债务或绕过上限 |

真实管理员禁用、认证失效、模型权限、上游额度仍独立生效。清理从不写永久禁用或日额度耗尽。scheduler summary 使用动态准入统计；对外 model-health 的 Build available_accounts 使用 canLease，临时归零后自动恢复。已只读核对外部控制器：它消费 realtime.available_accounts，自动模式在连续两个有效可用采样后自动启用；清理不会被写成 MANUAL_OFF 或日锁存，因此本次不修改控制器。

## 诊断与未知资源

沿用管理员鉴权：

- GET `/api/build-recovery`：操作、账号债务与阈值、降速/临时等待原因、方法计数与错误、删除证据、任务停止证据、下次恢复/审计时间、定位/协议告警及独立事件指标。
- POST `/api/build-recovery/wake`：合并唤醒，保留退避。
- POST `/api/build/recover/:index`：优先扫描该账号，保留退避及真实事实。
- POST `/api/build-recovery/:operationId/bind`，正文 `{accountIndex, appId, revision}`：精确资源候选绑定，校验账号、revision、所有权并留审计；不会直接把候选当成可删除项目。恢复执行器须先在当前同账号 context 中核实资源身份。
- GET `/api/build/status`、scheduler 和健康接口展示投影；管理页明确区分“项目已删除”和“任务停止未核实”。

**尚未验证的上游能力：** 仓库没有经过验证的资源列举/元数据查询 RPC。operation 标记已写入创建描述，但没有现场证据证明其保存和查询能力。默认 `resource_lookup_verified=false`，未知 App 会保留 discovery_pending/protocol_review，保留审计并低频告警，不占债务名额，也不单独触发降速或暂停。精确绑定只记录候选，不凭用户提交的 ID、时间接近或标题相似删除项目。

已实现只读验证适配接口 `system.buildResourceVerifier.lookup({page, accountKey, operationMarker, appId})`，并测试候选核实与删除的状态机。生产未安装此适配器；必须先实现并真实验证查询协议后才能启用。适配器只可返回唯一核实的 `{verified:true, accountKey, appId, operationMarker}`；恢复器再次检查账号、标记、目标 ID、重复绑定和当前会话。旧记录无标记时只允许管理员精确指定资源并经账号元数据核实。不能把接口存在当成未知资源找回能力已经交付。

事件写独立 build_recovery_events 表或 events.json，不产生生成/token；诊断遵循白名单、有界脱敏，运行时对象不进持久化 DTO。未解决债务不按年龄丢弃。已删除记录保留 30 天，之后符合条件的证据先可靠写入 archive.json 再移出主日志；已知 Task 停止仍未知时继续保留主日志审计。无恢复管理器的独立 runtime 在成功后也先归档证据再移除。

## 发布、备份和验证边界

本次不执行生产发布。上线前必须逐地核对 Compose 挂载、数据库、journal、旧隔离记录和可恢复备份，停止旧版写入并另存一致手动快照。先一地、一个账号 allowlist，验证 RPC9 后确实调用 Delete、确认形状与资源实际不存在，再逐步扩大。关联 requestId、operationId、方法事件和删除证据；客户端成功不能证明删除。

备份脚本保留 journal、scheduler、独立事件、archive、v2/v3 迁移快照及 SQLite 一致快照；新增 archive 和 v3 备份恢复测试。JP 实际备份任务及云端上传仍待发布时核实。确认新备份及云端副本后才可剪枝，独立手动快照保留。回退必须使用理解 schema v3 的修正版本，保留最新 journal 和证据，不能用旧镜像/旧库覆盖上线后的状态。

本地验收使用临时存储、可控时钟、模拟 RPC，覆盖 Cancel RPC9/超时后 Delete、缺 Task、Delete 重试、代理404、严格确认、旧记录迁移、债务和原子预留、降速与自动恢复、活动项目保护、页面/账号代际、401、存储修复、PG 恢复租约、绑定身份校验以及统计回归。离线测试和构建结果见本次修改交付记录；这些不替代上述上游查询能力、真实删除契约及逐地发布验收。

## 本次离线验证结果

- 完整 `npm test`：914 项通过，47 项按仓库条件跳过，0 失败。
- 最后修改后的 Build 通道/恢复专项：96 项通过（含事件存储无响应时有界让出恢复租约）；调度器 65 项、公示投影 8 项复核通过。
- `npm run build:ui`（含公示）、修改文件 ESLint、备份恢复模拟、备份 shell 语法和 `git diff --check` 通过。

完整回归之后补充了事件写入超时与删除预算预留，已由最后专项复核。上游资源查询适配器、真实删除确认与两地发布仍未验收，不能据此宣布整个生产方案已经完成。
