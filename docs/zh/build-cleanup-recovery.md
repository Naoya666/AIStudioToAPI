# Build 清理恢复交付说明

本次实现以 `babaf38` 为基线，对应 2026-11-03 修复要求。所有验证使用本地模拟、临时存储与现有离线回归；未访问 JP/US 生产节点、未调用真实生成或清理 RPC、未发布。现场历史错误缺失仍为未知，不能据此归因为 503 或推导日限额。

## 执行与数据

`BuildRecoveryStore` 集中同步读改写，文件 fsync、原子替换并 fsync 父目录。operation 映射保持旧 account/app/task/complete 字段；schemaVersion=2 追加 requestId、revision、generationState、cleanupStage、独立 Cancel/Delete 确认、调度状态、时间、方法尝试计数和最后错误。更新检查 revision；迁移后的尝试计数只累计新执行，不表示历史尝试为零；进程内共享 active、operation 执行锁和账号串行队列，运行中的生成不会被恢复扫描取消。

迁移前保留 `build-projects.json.pre-v2-*`，权限 0600；旧 requestId、创建时间、确认时间、错误保持 null，unknown 不代表任务还在运行。未知字段保留。启动时把旧进程 active 转为 unknown，清理只依据资源 ID、终态和已确认的进度。已加载 journal 丢失、JSON 损坏、格式错误、未知版本或写入失败均保持 Build 阻挡并报告 storage fault。scheduler 有阻挡、journal 无对应记录时保留 `recovery_state_inconsistent`，不自动清标记。

Linux `flock` 文件描述符锁（`build-projects.json.lock`）阻止另一存活的新版本进程消费同目录，内核在进程退出时释放，避免过期 PID 抢锁竞态。Docker 明确安装 util-linux；本地 Build 恢复也需要 flock，缺失时故障隔离。锁文件保留为固定 inode，不得删除运行中锁。此实现按单应用进程部署；旧版本没有锁，升级前必须停止旧进程，不能新旧并行写同一目录。进程退出后锁可自动接管；文件中的 PID 仅作诊断，锁异常需保留证据核查。关闭停止领取任务，等待当前有界清理；前台仍执行时保留锁，后续进程只在旧进程退出后接管。

正常清理最多 Cancel 和 Delete 两次独立 RPC；Cancel 未确认时绝不 Delete。Cancel 确认先写入，Delete 成功确认也先写入，保存 done 检查点；调度阻挡状态 fsync 落盘后再移除完成记录。若两者之间崩溃，启动根据 done 的已确认进度核对阻挡，避免产生新的孤立标记；崩溃窗口按幂等语义重试。Create/Submit 结果不明进入 verify_pending 并隔离，不生成新内容。资源未创建且可确认未发送的场景不需要上游清理；无法证明时保守隔离。

当前仅接受空数组或全 null 的 protobuf 清理确认，以及当前账号、页面、会话和方法匹配的结构化 RPC code 5。通用 HTTP 404 不构成证明。页面替换、关闭、会话版本变化和 bridge 不就绪均使旧确认失效。未验证“删除项目可终止任务”的契约，不使用该假设。没有已验证的只读核实 RPC，未知资源需要人工核实。

恢复每秒合并扫描，单节点同时一个后台 operation；前台清理使用同一账号串行执行器。每次后台执行最多两个独立超时 RPC，执行后让出资源；正常派发使用现有池，恢复入口共用全局 context 上限并只登记一个恢复需求，不使用 Build acquire。不能驱逐在途生成或恢复执行页面。阻挡账号仍保留 PG 价值，正常冷账号可以替换空闲的阻挡驻留账号。

## 配置

以下环境变量在进程启动读取，需重启生效：

| 配置                           | 默认   | 校验范围/含义                                        |
| ------------------------------ | ------ | ---------------------------------------------------- |
| BUILD_RECOVERY_RPC_TIMEOUT_MS  | 10000  | 100–60000 毫秒，每个清理 RPC                         |
| BUILD_RECOVERY_BACKOFF_MS      | 5000   | 1000–300000 毫秒，初始退避                           |
| BUILD_RECOVERY_MAX_BACKOFF_MS  | 300000 | 不小于初始值，最多 3600000 毫秒                      |
| BUILD_RECOVERY_ACCOUNT_INDICES | 未设置 | 允许所有账号；逗号分隔非负整数；空字符串暂停后台领取 |

退避指数增加并加入 0–20% 抖动；可信 Retry-After 优先作为等待下限。503/RPC14、网络中断和超时持续恢复，不设三次截止。429/RPC8 不推断午夜重置。401/RPC16 等待页面会话版本变化或现有认证服务确认恢复；403/RPC7 至少间隔五分钟核实；400、通用 404、未知提交和无法识别的确认隔离处理。没有 context 不增加 RPC 尝试号。唤醒不绕过 nextAttemptAt。认证恢复仍遵守已持久化的退避。

## 事件、API 与界面

启用用量存储时，独立 `build_recovery_events` 表保存清理尝试，不创建 requests 或 token 记录；按 operation、request 和结束时间建立索引。最多保留最近 30 天、10000 条，插入时清理。用量存储关闭时，使用 `build-projects.json.events.json`，保留相同时间/数量上限。未解决任务的当前原因仍保存在 journal，不随历史轮换丢失。

记录包含 operationId、可空 requestId、账号编号、方法、阶段、触发来源、开始/结束、尝试号、HTTP/RPC/归一化状态、脱敏错误、结果和下一次时间。允许字段、有界诊断，并脱敏认证信息、密钥、URL、邮箱和 UUID。账号键、app/task ID 只在受限恢复存储中使用；管理界面不输出资源 ID。资源 ID 未知时不靠时间猜测 requestId。

所有恢复 API 沿用管理员认证：

- GET `/api/build-recovery?operationId=...&requestId=...&limit=100`：当前任务、最近事件、各方法尝试/确认/失败及总耗时。单页最多 500 条。
- POST `/api/build-recovery/wake`：合并唤醒，不改变进度、确认或退避。
- POST `/api/build/recover/:index`：优先扫描该账号；允许人工重新尝试资源已知的隔离任务，但不绕过 nextAttemptAt。verify_pending 保持隔离，仍由同一执行器负责；不直接清阻挡。
- GET `/api/build/status` 和 scheduler/status：提供 recovery 状态。

scheduler 保留 `available_accounts`（符合模型条件）、`ready_accounts`（历史候选字段）；增加 `eligible_accounts`、`context_ready_accounts`（实际页面就绪）、`dispatchable_accounts`（候选通过 canLease）、`cleanup_blocked_accounts`、`queue_wait_reason`。dispatchable_accounts 是当前账号准入数量，全局工作槽占用仍单独展示。后台页面展示清理数量、等待页面/认证/权限、隔离、下次时间、操作当前原因及实际可派发账号。孤立阻挡账号在恢复 API 的 inconsistent_accounts 中列出。公示继续使用原聚合白名单，不公开操作或账号诊断。

## 按账号恢复与验收

1. 核对各节点当前镜像、Compose mounts/volumes、journal、scheduler 状态、SQLite、在途生成、磁盘和备份。停止旧进程后取得一致手动快照，在线数据库用 SQLite backup 或在完全停止写入后复制，不能漏 WAL。
2. 验证快照完整性与云端副本，手动快照独立保留。定时备份仍本地最多 1、云端最多 10。本仓库 US 备份脚本新增 journal/迁移快照/回退事件文件，并在建立 SQLite 只读事务前后核对 journal 与 scheduler 未变；固定快照后允许线上继续写入，复制始终使用该事务。获取快照时变化重试五次后失败，不上传不一致备份。生产脚本尚未安装；JP 的实际任务需发布时核对。
3. 先单节点设置 `BUILD_RECOVERY_ACCOUNT_INDICES=`，启动只迁移、重建阻挡并观察。确认无活跃生成后将列表设为一个目标账号并重启；观察具体方法、确认、退避、错误、context 总数及 PG 状态。
4. 验证遗留 operation 的解决率与年龄、自然流量 active/queue timeout、冷账号派发、可派发统计和控制器语义。逐步扩大 allowlist；第二节点在第一节点稳定后再处理。新业务会产生新 journal，不能要求总数严格递减。
5. verify_pending/quarantined 或 recovery_state_inconsistent 必须先核实真实资源与历史快照。不得通过清 journal、修改 complete、删除确认字段或强行清阻挡来恢复服务。没有可信核实方法的项目继续隔离；代码没有提供伪造确认的管理接口。

## 备份与回退

至少保存 accounts/auth、scheduler-state.json、build-projects.json、pre-v2 快照、usage-stats.sqlite 一致备份及禁用用量存储时的 events.json；包括部署配置与 allowlist。运行期 lock 文件不用于恢复。备份还原需保持这些数据属于同一停写窗口，并在临时目录验证 JSON、schema、权限和 SQLite integrity_check 后演练。

回退前设空 allowlist 停止后台领取，关闭进程并等待有界收尾，另存最新恢复与用量数据。不能把上线前快照覆盖到上线后业务数据。优先回退到理解 schema v2 的兼容版本；必须回 babaf38 时暂停相关 Build 派发和恢复消费，保留所有新数据，由只读工具核对/制定转换方案后再启用。旧版本不认识独立确认和 verify_pending，不能仅保留旧字段就宣称安全兼容。离线测试证明旧 reader 能读 operation 映射，不证明旧 runtime 可安全恢复新记录。

## 验证记录

专项测试覆盖清理状态机、Cancel 确认重启、503 退避、旧页结果失效、同账号串行、活动 operation 保护、重复唤醒、代理 404、结构化 NOT_FOUND、本地写入崩溃窗口、损坏/丢失 journal、旧格式迁移、孤立阻挡、401 会话变化、PG 状态保留、SQLite 独立计数、冷账号派发和单 context 恢复。新增测试加入 npm test。验证结果：

- `npm test` 完整执行成功：898 项通过、47 项按仓库条件跳过、0 失败。
- 最后一次针对性验收（Build 通道、恢复、浏览器 worker）：178 项通过，包括完整回归运行期间补充的账号编号复用保护。
- `npm run build:ui`（含公示构建）、修改文件 ESLint、CSS lint、文档格式、备份 shell/内嵌 Python 语法和 diff 空白检查通过。
- `npm run lint` 被 6 个未修改的既有 JSON fixture 的 1721 项格式/排序问题阻塞；未批量重写这些调查或测试数据。修改的 JS/Vue 文件单独检查通过。

这些是合成离线验收，不代替生产逐节点恢复观察或上游契约验证。
