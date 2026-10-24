# 模型感知账号池与浏览器 Worker 调度

## 原架构与改造范围

原来 `RequestHandler` 和 `AuthSwitcher` 共享 `BrowserManager.currentAuthIndex`，按使用次数、失败阈值和状态码触发全局切换。`BrowserManager` 已经在一个 Firefox/Camoufox 进程中维护多个独立 context/page，`ConnectionRegistry` 也已经按 `authIndex` 和 `request_attempt_id` 隔离 WebSocket 消息，但请求仍集中在当前账号上。

现在保留登录、storageState、Build App 注入脚本、WebSocket 消息格式和协议转换。`ModelScheduler` 管理账号×模型状态、同步租约和模型队列；`ScheduledRequestHandler` 为每次 HTTP 请求创建独立处理器，复用原有协议与 streaming 方法。真正完成模型后缀转换之后才申请租约，因此 `-high`、`-real`、`-search` 等变体共享真实模型额度。

Worker 是逻辑执行槽，多个槽可同时复用同一账号的 context/page，**不是独立 Firefox 进程**。账号并发默认不设上限，仍受全局、模型及显式账号上限约束；一个账号也能承接多个并发请求。账号 cookie 始终属于自己的 context，worker 可以在请求之间选用其他账号。后台热池最多保留 `MAX_BROWSER_WORKERS` 个 context，并以 `CONTEXT_INIT_CONCURRENCY` 有界并行初始化。请求只租用 page 与 WebSocket 均就绪的 context；冷账号需求交给后台换入，只有无在途请求的 context 可以被置换。

页面保活、Launch 检测和 WebSocket 重连按 context 工作。旧账号池后台 rebalance 在新模式下停用，避免清理已被 worker 预留的 context。管理界面的账号修改、删除和 auth 文件写入在存在运行任务时返回 409；管理操作执行期间暂停新租约发放。

## 配置

新模式默认开启。未配置 worker 数量时沿用正数 `MAX_CONTEXTS`，否则使用 1；原先 `MAX_CONTEXTS=0` 的无限缓存不会转换成无限 worker。配置修改后重启生效。

下面的模型名仅用于展示配置格式，必须替换为实际 upstream model ID（可查看 `configs/models.json`）：

```dotenv
ACCOUNT_ROTATION_STRATEGY=least_recently_used
MAX_BROWSER_WORKERS=6
CONTEXT_POOL_MIN_READY=6
CONTEXT_INIT_CONCURRENCY=2
CONTEXT_CREATION_TIMEOUT_MS=120000
GLOBAL_MAX_CONCURRENCY=24
CONTEXT_MAX_CONCURRENCY=0
ACCOUNT_MAX_CONCURRENCY=0
ACCOUNT_MODEL_MAX_CONCURRENCY={"model-a":0,"model-b":0}
MODEL_WORKER_ALLOCATION={"model-a":{"min_workers":3,"preferred_workers":5},"model-b":{"min_workers":1,"preferred_workers":1}}
MODEL_MAX_CONCURRENCY={"model-a":6,"model-b":6}
ENABLE_DYNAMIC_WORKER_ALLOCATION=true
MODEL_QUEUE_SIZE=100
MODEL_QUEUE_TIMEOUT_MS=120000
REQUEST_DISPATCH_TIMEOUT_MS=30000
SCHEDULER_READY_CONTEXT_ONLY=true
STREAM_EARLY_HEADERS=true
STREAM_KEEPALIVE_INTERVAL_MS=10000
RATE_LIMIT_COOLDOWN=86400
RISK_CONTROL_COOLDOWN=600
RISK_CONTROL_MAX_COOLDOWN=10800
SCHEDULER_DAILY_RESET_ENABLED=true
SCHEDULER_DAILY_RESET_TIME=00:00
TEMP_ERROR_COOLDOWN=30
MAX_RETRIES_PER_REQUEST=2
SCHEDULER_STATE_PATH=data/scheduler-state.json
```

| 配置                               | 语义                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ACCOUNT_ROTATION_STRATEGY`        | `least_recently_used` 默认；`least_used` 按调用次数优先；`different_proxy_first` 不同代理优先；`legacy` 恢复原账号轮换                    |
| `MAX_BROWSER_WORKERS`              | 最大缓存 context/page 数量                                                                          |
| `GLOBAL_MAX_CONCURRENCY`           | 最大执行租约数，默认等于 context 上限，可以大于它                                                   |
| `CONTEXT_POOL_MIN_READY`           | 后台最少就绪目标，只对具备驻留资格的账号生效；可用账号不足或全部显示模型处于实际 429 冷却时可低于目标（含 0），不得超过 `MAX_BROWSER_WORKERS`                                     |
| `CONTEXT_INIT_CONCURRENCY`         | 后台同时初始化的 context 数，默认 2                                                                 |
| `CONTEXT_CREATION_TIMEOUT_MS`      | 串行 BrowserContext 创建阶段的超时毫秒数，默认 120000                                               |
| `CONTEXT_MAX_CONCURRENCY`          | 单 context 并发硬上限，0 表示不限但仍执行 least-inflight                                            |
| `ACCOUNT_MAX_CONCURRENCY`          | 单账号跨模型总并发上限，默认 0 表示不限                                                             |
| `ACCOUNT_MODEL_MAX_CONCURRENCY`    | JSON：单账号在指定模型上的并发上限，0 不限，未配置继承账号上限；账号总上限仍独立生效                |
| `MODEL_WORKER_ALLOCATION`          | JSON 对象。值为整数时表示 preferred、min 为 0；也支持上面的对象写法。preferred 总和不能超过全局并发 |
| `MODEL_MAX_CONCURRENCY`            | 模型的硬并发上限；默认等于全局并发；不得低于该模型 min                                              |
| `ENABLE_DYNAMIC_WORKER_ALLOCATION` | 默认 `true`，可借用空闲配额；`false` 时每个已配置模型以 preferred 为上限                            |
| `MODEL_QUEUE_SIZE`                 | 每模型最大等待数，不包含已拿到租约的请求；0 表示不排队                                              |
| `MODEL_QUEUE_TIMEOUT_MS`           | 最长排队时间，默认 120000 毫秒                                                                      |
| `REQUEST_DISPATCH_TIMEOUT_MS`      | ready context 调度超时；未设置时兼容 `MODEL_QUEUE_TIMEOUT_MS`                                       |
| `STREAM_EARLY_HEADERS`             | 流式请求通过校验后立即发送 SSE headers 和 accepted 注释，默认开启                                   |
| `STREAM_KEEPALIVE_INTERVAL_MS`     | 等待调度或上游首包期间的 SSE 注释心跳间隔，默认 10000 毫秒                                          |
| `RATE_LIMIT_COOLDOWN`              | 429 冷却秒数，默认 86400（24 小时），不猜测 Google 的日额度重置时刻                                  |
| `RISK_CONTROL_COOLDOWN`            | HTTP 403 风控初始冷却秒数，默认 600，连续风控按 1、3、6、18 倍退避并带 ±10% 抖动                    |
| `RISK_CONTROL_MAX_COOLDOWN`        | HTTP 403 风控最大冷却秒数，默认 10800                                                               |
| `SCHEDULER_DAILY_RESET_ENABLED`    | 是否在每天太平洋时间自动清理可恢复冷却，默认 `true`；仅 `false` 关闭                                |
| `SCHEDULER_DAILY_RESET_TIME`       | 每日重置时间，固定使用 `America/Los_Angeles` 时区及严格 `HH:mm` 格式，默认 `00:00`                  |
| `TEMP_ERROR_COOLDOWN`              | 临时错误初始冷却秒数，默认 30，连续失败退避到 60、120，最多 4 倍                                    |
| `MAX_RETRIES_PER_REQUEST`          | 初次之外的最大重试次数，默认继承旧 `MAX_RETRIES - 1`，未配置时为 2                                  |
| `SCHEDULER_STATE_PATH`             | 默认工作目录下 `data/scheduler-state.json`                                                          |

`MODEL_WORKER_ALLOCATION={}` 表示共享池。动态模式下，未配置模型的默认 min=0、preferred=1；静态模式下，未配置模型使用剩余共享容量（至少允许一个槽位竞争）。静态模式限制每模型并发，但不绑定具体 worker ID。

账号选择先过滤 ready context，再比较账号×模型 inflight、context 总 inflight和近期本地传输失败，最后以 LRU / Least Used 打破平局。租约选择和 inflight 预留同步完成。若排队模型必须使用尚未驻留的账号，后台等待空闲 context 后换入，不在 HTTP 请求热路径初始化。429 停止该资源槽的新租约，已开始的其他请求继续执行，成功响应不会清除其他并发请求设置的冷却。

`different_proxy_first` 模式优先比较出口跨模型总在途租约数，再比较出口最近选择顺序，最后在同出口内沿用上述 LRU 规则。只有一个出口可立即调度时直接使用该出口，不等待其他代理启动。后台热池优先覆盖不同出口，可用空闲 Context 修正重复出口，不为轮换中断忙 Context，也不在出口数超过容量时持续换入换出。

出口按 Context 实际应用的代理识别。节点可设置可选“出口组”，账号可设置“出口组覆盖”（也适用于旧代理文件及环境变量代理），共用公网出口的代理可填相同组名；直连统一归组。修改组名后，需要在代理池账号列表执行应用，重建后的 Context 才使用新分组。测试节点得到的公网 IP 仅供参考，不会自动修改分组。重试优先尚未尝试的出口，没有其他出口时仍可选择同出口其他账号，所有原有冷却、并发和文件归属规则继续生效。

管理调度面板提供出口在途数、可租用账号数、各模型可调度出口数量及回退/置换计数。配置新模式后重启生效，默认模式保持不变。完整设计与验收条件见 [不同代理优先调度改造方案](./different-proxy-first-scheduling-design.md)。

每次有空闲逻辑 worker 时，调度顺序是：低于 min 的等待模型、低于 preferred 的等待模型、其他等待模型；同级按入队顺序。热门模型不能绕过更早入队的同级请求。借用不会中断正在输出的流，低流量模型的最低配额在下一次 worker 释放时满足，还受可用账号数和 context 初始化时间约束。这里的 min 是调度优先级保证，不是可抢占的独立进程保留。

## 错误、重试与恢复

- 429 / `RESOURCE_EXHAUSTED`：仅对该账号×模型冷却，其他模型继续可选。
- 明确 `PERMISSION_DENIED` 或模型不支持：仅该账号×模型标记 `UNSUPPORTED`，重启后保留；需手动恢复。没有明确模型权限证据的普通 403 不会永久禁用账号或模型。
- 明确的上游 5xx：按配置短暂模型冷却；不会永久剔除整个账号。
- page/context/MessageQueue/WebSocket 等本地传输故障：不修改账号×模型 cooldown；尚未输出模型内容时迁移到其他 ready context。
- 明确登录、cookie 失效或账号暂停：整个账号 unhealthy。context 初始化排队、取消和本地初始化故障不污染模型额度状态；原有 auth 文件过期标记仍然有效。
- 参数错误不自动切换账号。客户端取消不作为账号故障。

账号从第一次真实上游 403 起开始记录连续观察窗口。若 48 小时内始终没有观察到成功或明确的非 403 上游响应，管理页会显示“长期 403”警示，提示认证信息可能需要删除后重新登录。该警示不参与调度、健康判断或冷却；手动恢复、429 重置、每日重置和服务重启都不会清除它，只有真实成功或明确的非 403 上游结果会清除。

模型感知调度默认每天在太平洋时间 00:00 清除 403、429 和临时错误的当前冷却，以便在 Build 配额日界线后重新探测。自动重置保留人工禁用、账号 unhealthy、模型 unsupported、用量统计、活动租约及长期 403 计时。它使用一次性定时器逐日换算，因此会跟随太平洋夏令时；服务停机期间错过的任务不会补跑。`ACCOUNT_ROTATION_STRATEGY=legacy` 时不创建该任务。

重试发生在真实响应内容输出之前，整个请求不重试同一账号，即使该账号的 auth 文件编号变化。模型池没有任何符合条件的账号时立即返回 503；上游失败之后无法找到下一个账号时保留最后一次上游错误（例如 429）。全局、模型、显式账号并发或 context 容量不足时排队；账号已有在途请求本身不触发排队。队列满返回 429，排队超时返回 504。已经输出流内容后发生错误，只记录状态并沿用原协议错误输出，不重放内容。

冷却到期后，下一个实际请求作为 probe，不进行额外的付费/额度消耗健康请求。`request_count` 记录真实转发次数，不存在“达到 100 次就认为耗尽”的规则。

管理快照的 `active_workers` / `idle_workers` 表示逻辑执行槽；context 分别以 ready、busy、idle、initializing、reconnecting、unavailable 展示，同时提供 inflight、WebSocket epoch、最近断线原因和首包延迟分位数。

Web 管理主页展示模型调用次数、成功/失败、可用账号数、429 数、排队数和 worker 配额，并提供账号×模型状态详情与恢复按钮。管理接口沿用原 Web UI session 认证：

- `POST /api/scheduler/reset-rate-limits`：一键清除全部账号所有模型的 429 标记及对应冷却，保留账号健康、unsupported、其他临时冷却、历史错误和统计；允许在任务运行时使用，后续新的 429 仍会重新触发冷却。管理主页提供同名按钮。
- `GET /api/scheduler`：全局、模型、账号与 worker 快照。
- `POST /api/scheduler/reset`，body `{"account_id":0,"model":"model-a"}`：恢复单模型，保留统计。
- `POST /api/scheduler/reset`，body `{"account_id":0}`：恢复账号及全部模型，保留统计。

正在执行任务的账号不能被 reset（409）。如果原 auth 文件已被标记 expired，仍需通过原登录/恢复流程修复 auth；scheduler reset 不会伪造有效登录。

## 持久化与兼容性

JSON 状态由单个 Node 进程串行更新，250ms 合并写入、同目录临时文件原子 rename；正常停机 flush。异常断电最多可能丢失最近一次合并窗口的更新；不承诺 fsync 级断电持久性。重启不恢复 inflight。损坏状态备份为 `.corrupt-时间戳` 后重建，并在日志提示。写入失败记录错误。Docker 继续挂载 `/app/data` 即可。**多个服务进程不要共享此 JSON 文件和同一套账号池**；当前租约只保证单进程 async 并发安全。

OpenAI Chat、Responses、Embeddings，Gemini 原生，以及 Anthropic Messages/count tokens 使用同一调度层；转换实现保持原样。非模型文件操作记在 `__files__` 池。服务记录它收到的 resumable upload ID、返回的文件 URI 与账号的映射，并持久化；后续已知文件引用固定到拥有它的账号，不能通过换账号绕过文件所属账号的额度。不同账号文件不能混在一次请求里。服务未见过的外部上传文件没有可推断的账号映射。

设置 `ACCOUNT_ROTATION_STRATEGY=legacy` 可恢复原 `SWITCH_ON_USES`、`FAILURE_THRESHOLD`、`IMMEDIATE_SWITCH_STATUS_CODES` 和 `MAX_CONTEXTS` 轮换流程。新模式不使用这些旧轮换阈值，避免全局切换干扰请求。

## 验证与部署验收

```bash
npm test
npm run lint
npm run build:ui
```

自动测试使用模拟浏览器/WebSocket，覆盖单账号并发、独立 context 容量预留、消息隔离、配额隔离、冷却、持久化、动态借用、静态上限、队列取消、重试预算、流式中途失败、文件归属、context 置换及旧 WebSocket 延迟关闭。真实登录、Google 上游行为和六账号持续压力测试需要有效 auth 文件及 Camoufox 环境，自动测试不替代这些验收。

部署后建议先使用两个账号并交替请求两个模型，确认一个模型的 429 不影响另一个；再提高到六个 worker，观察 context 内存、每模型排队和上游延迟。浏览器进程崩溃会影响其所有 context；状态保持模型粒度，后续请求按需重建 context。真正的多进程浏览器隔离和跨服务分布式租约留作后续扩展。
