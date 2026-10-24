# 抗截断集成实施与验证记录

日期：2026-10-12（Asia/Shanghai）。依据外部项目 BUILD_ANTI_TRUNCATION_INTEGRATION.md 实施。

## 基线

| 项目                | Git HEAD                                 | 初始工作区 |
| ------------------- | ---------------------------------------- | ---------- |
| AIStudioToAPI       | 5770e83c95b711355e05f7321e19d9583144b57a | clean      |
| Antigravity-gateway | 882305ef40092537297d441ff0f0c37a3acc6643 | clean      |

本地 package.json 版本 1.3.7。生产镜像版本未核对，未执行部署或修改运行容器。网关参考算法采用 MIT，版权与许可原文保存于 docs/licenses/antigravity-gateway-MIT.txt，并由 Dockerfile 复制入镜像。项目原有许可证保持不变。

## 改造范围

- 新增 AntiTruncation 策略、随机注入、Gemini 结构化还原、有限修复、SSE 网络事件组装、choice 隔离和资源上限。
- FormatConverter 提供统一 anti 前缀解析，ModelScheduler 复用解析；RequestHandler 在准入、fake/early/real/非流式输出及重试尝试更新处接入。
- ScheduledRequestHandler 区分上游开始与客户端正文开始，限制已开始生成后的账号重试；取消和清理复用既有机制。
- 配置 definitions 与 ConfigLoader 支持持久化、校验、热更新、重置及启动参数；原配置页面根据 definitions 自动显示新项。
- 响应的真实工具 ID、推理、usage、length、安全拒绝均保留；没有移植网关错误事件忽略或 EOF 补成功 DONE 的行为。

## 验证命令与结果

| 命令                                                                                                                               | 结果                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `node --test tests/anti-truncation.test.js tests/scheduled-request.test.js tests/unified-configuration.test.js`                    | 75/75 通过，涵盖原有回归与新增行为                                   |
| `npm test`                                                                                                                         | 全部现有测试命令通过；可选真实浏览器测试按原测试条件跳过，未视为实测通过 |
| `npm run lint`                                                                                                                     | 通过；StatusPage.vue 原有 vue/no-v-html 警告 1 条                        |
| `npm run build:ui`                                                                                                                 | 管理 UI 和公开 UI 构建通过；Vite 原有 CJS/产物尺寸提示                   |
| `git diff --check`                                                                                                                 | 通过                                                                     |
| `ANTI_TEST_DELAY_MS=120000 node --test --test-name-pattern='anti early HTTP client receives live' tests/scheduled-request.test.js` | 1/1 通过，真实本地 HTTP 客户端验证                                       |

120 秒测试使用模拟 Gemini 上游和实际 Express/HTTP/fetch，客户端首批事件 29 ms 到达，共读取 121 批网络数据，等待阶段空事件持续到达，间隔断言 < 2 秒，最终只出现一次 DONE。该数据是客户端读到时间，不是服务端 write 日志；不能代表公网代理表现。

新增自动化覆盖策略优先级/总开关/非法字段/嵌套别名、模型修饰符和名单、配置保存重载重置、无工具/none/required/强制真实工具、正文冲突/SideBuffer=0 与非零、真实工具连续索引与 ID、推理/usage、多个 choice、Unicode/JSON 转义跨网络片段、有界修复和失败、真实模型调度、early 后 429 换账号且随机名称重建、流内错误和缺失 finish 无成功 DONE、取消清理、并发隔离、背压以及 early 客户端事件实际到达。

## 待完成的外部验收

未使用生产凭据或聊天记录。以下事项依赖真实部署与外部服务，本次没有完成，不能据此宣称生产已验收：

- 对上述各模型通过真实 Gemini/Build 浏览器采集函数参数形态，验证真实工具 auto/none/required 和推理。
- 使用同一模拟输入对照独立 Go 网关与集成版本的实际 HTTP 输出；本次使用其已阅读算法语义建立 JS 对照断言，未运行独立 Go 服务的端到端对照。
- 直连隔离部署、NewAPI、SillyTavern、实际公网入口分别执行 120 秒等待、429/超时/解析失败/断连与渠道错误识别测试。
- Docker 候选镜像构建及启动验收、核对生产镜像提交、灰度切换和两级回退演练。
- 并发性能基准：本次测试验证资源释放与隔离，尚未形成 CPU/内存峰值、TTFT、吞吐量与公网延迟测量报告。
- 搜索/代码执行/URL context 的真实模型能力矩阵；目前这些组合主动拒绝显式 anti 或跳过 prefer。

配置、请求格式、限制及上线步骤见 [使用说明](anti-truncation.md)。

## 错误透传修改（2026-10-12）

已按 [错误透传方案](anti-truncation-error-passthrough-plan.md) 修改运行代码，尚未部署。

- 浏览器读取 HTTP 失败响应时提取结构化上游错误，通过队列保留 code、message 和有效 type；不再将完整响应体拼进带代理前缀的 message。非 JSON 错误页面及无效字段使用明确回退信息。
- anti 还原器保留 HTTP 200 正文内嵌错误的业务字段。HTTP 状态与业务错误码分别保存，字符串业务码保持原始类型；内部分类仍使用独立的 `upstream_error`。
- JSON 与 SSE 错误出口复用归一化规则，取消按 anti 请求统一覆盖 message 的行为。覆盖 legacy、模型感知调度以及非流式、fake、early、real；early 已发出的 HTTP 200 保持不变，最终错误通过 SSE 返回并 flush、结束，不发送成功 DONE。
- 本地 anti 解码、协议和超限错误返回具体内部错误码；缓冲 JSON 解析失败在产生位置使用安全信息，避免 SyntaxError 携带正文片段。重试账号选择失败返回实际终止错误。
- 浏览器错误结构变化后，调度器通过结构化 Google `UNAUTHENTICATED` 状态保留会话过期处理和旧会话响应保护，同时兼容原有错误格式。

验证结果：`npm test` 全部测试命令通过，可选真实浏览器用例按现有条件跳过；`npm run lint` 通过。最后补充缺失/无效字段、统计状态和本地协议错误码断言后，`node tests/scheduled-request.test.js` 再次通过（53/53），相关文件 ESLint 检查通过。浏览器入口通过 VM 执行真实客户端代码、模拟 fetch 验证，真实本地 HTTP 测试通过；这些结果不代表真实 Gemini 或公网下游已经验收。

本次只修改代码、测试和文档，没有构建部署镜像、重启服务或更改运行容器。真实 Gemini、NewAPI、SillyTavern 的错误显示、识别及渠道处理仍属于上文的外部验收事项。

## blockReason 透传与禁止重试（2026-10-24）

已按 [blockReason 改造方案](upstream-block-reason-passthrough-plan.md) 完成 Build 侧改造。未部署，也未修改 NewAPI。

- 新增 `UpstreamBlock`，将有效、非空的 `promptFeedback.blockReason` 识别为 `upstream_prompt_blocked` 业务错误；识别优先于 candidates 和顶层 error。保留真实原因、有效说明、安全分类及同时存在的顶层错误基础字段，不再合成空 SAFETY 候选。
- 在生成请求转发时，为该次队列安装 `GenerationResponseGuard`。共享入口按 JSON/SSE 事件边界组装网络分片，在候选交付前检查拦截，覆盖普通请求、anti、legacy、模型感知调度与各协议。正常 SSE 事件归一为单个 data 帧；无效响应仍交给原协议解码器。anti 保持 10 MiB 资源限制及不完整非空帧后的保守禁止重放规则。
- MessageQueue 对明确拦截抛出结构化错误，避免各适配器旧的 event_type=error 分支只传 message 导致字段丢失。已识别的拦截在队列关闭、上游断连或生成期限到达时仍保留业务分类，不能降级成可重试传输错误。
- legacy 重试、立即换账号、模型调度重试、传输重试与账号失败处理均优先排除该分类。调度器释放租约，但不增加账号故障、连续失败、风控处罚、冷却或模型禁用计数；请求结果记作 error，实际尝试仍正常记录。
- 未发头时返回 HTTP 400；已发头时按协议发送终止错误并关闭连接，不追加正常结束事件或成功 DONE。已交付正文保留，不重放生成。OpenAI code 为 `upstream_prompt_blocked`，type 为 `invalid_request_error`；Gemini 保留数字 code 并使用 `INVALID_ARGUMENT`。可选诊断位于 error.upstream，Responses 流式错误使用顶层 upstream。
- 提取允许的 usage 字段，在错误对象中携带已收到的实际用量，包括前序帧的 usage，避免抛错丢失数据。OpenAI/Claude 的错误扩展字段为 usage，Gemini 为 usageMetadata；本次没有新增 SQLite schema 或改变下游扣费规则。
- 各请求入口增加 Build `X-Request-ID`，拦截错误携带 request_id；结构化日志包含请求、尝试、模型、原因、诊断、实际尝试序号、是否已交付正文、禁止重试决策，以及实际可得的上游 HTTP 状态和 Google responseId。代理 ID 与 Google responseId 分开记录。
- 拦截字段按允许列表提取；原因最多 256 字符、说明最多 1024 字符、安全分类最多 32 项，并对常见凭据形态脱敏。不将 candidates、聊天内容、任意原始响应字段或异常堆栈放入新增诊断。

### 本地验证

`npm test` 退出码为 0，全量现有检查通过；39 个可选真实浏览器用例按原条件跳过，不能视为真实浏览器验收。涉及本次改动的 anti 与 scheduled-request 测试合计 137 项通过，包含以下关键断言：

- JSON、数组和 SSE 在每个分片边界都能识别拦截，覆盖多行 data、CRLF、Unicode、转义和无末尾分隔符。
- 未知有效原因、同帧 candidates、同时存在的 503/风控关键词错误均不改变拦截优先级。
- 即使把 400 加入立即重试状态集合，首次直接拦截时实际发送生成请求次数仍为 1，账号切换次数为 0，账号故障和冷却计数不变。
- 先有其他错误并重试，再遇到 blockReason 时不再发送下一次请求；已交付内容及实际用量保留。
- anti/普通、legacy/模型调度、非流式/real/fake/early 以及 OpenAI/Responses/Claude/Gemini 的失败可见、终止与清理行为一致。
- 真实本地 Express/HTTP/fetch 验证非流式 HTTP 400 与 early HTTP 200 下的 SSE 错误，错误 request_id 与响应头一致，无成功 DONE；同时验证结构化日志不包含模拟提示词或模拟凭据。
- 队列关闭和期限竞态不把明确拦截变成传输故障；原有 anti 不完整帧断连后不重放的行为得到保留。

最初验证时，`npm run lint` 被历史文件 `docs/zh/fixtures/argon-production-diagnosis-20261017.json` 中 32 处 `jsonc/sort-keys` 错误阻挡。后续检查确认该文件仍由 Argon 生产排查报告引用，因此保留诊断证据，仅按现有 ESLint 规则重排键；JSON 解析后的内容与原版本完全一致。修改文件 ESLint、`npm run lint:css` 及 `git diff --check` 均通过；全仓 lint 的复验结果见下方补充记录。

### 外部验收边界

以上均使用模拟上游和本地 HTTP 服务，没有发送真实 Google 生成请求或重放生产提示词。未构建部署镜像、重启服务或修改生产状态。

Build 侧已保证 blockReason 不触发自动请求重试。用户已确认现有 NewAPI 重试数为 0，本次不再将下游禁止重试列为专项改造或验收任务。NewAPI 的流内错误接收与界面展示、渠道状态、零输出免单和部分输出计费，以及公网代理实际事件到达情况仍需在对应部署版本中验收。错误扩展字段携带用量不能替代下游计费验收。

### 历史诊断 JSON 整理与部署条件补充（2026-10-24）

`argon-production-diagnosis-20261017.json` 是生产排查的脱敏证据附件，由 [Argon 生产问题定位](gemini-4-argon-production-diagnosis-20261017.md) 引用，不是运行配置或测试输入。本次保留文件并修复 32 处键排序问题；通过解析后对比，确认与 Git 原版本数据完全相同。修复后 `npm run lint` 全量通过，不需要忽略该文件，`git diff --check` 通过。此次只有 JSON 键顺序和文档调整，未重复运行功能测试。

NewAPI 重试数为 0 是用户提供的既有部署条件，没有在本次连接生产服务读取或更改配置。已同步更新方案与使用说明；Build 对 blockReason 禁止重试的实现与测试保持不变。
