# 抗截断传输集成

状态：代码和隔离测试已完成；2026-10-17 在 bero 实测 Argon 的 AUTO 合成函数传输，非流式与缓冲 SSE 两次均通过。项目全局默认策略仍为 off；bero 使用 prefer。其他模型及客户端组合不能据此视为已完成生产验收。

## 使用

仅支持 OpenAI Chat Completions (`POST /v1/chat/completions`) 的文本请求。可用模型名前加一个大小写不敏感的 `anti-`；支持 `models/`、原有思考、流式和工具后缀的解析顺序，真实模型大小写保持不变。

```json
{
  "model": "anti-gemini-3.7-flash-early",
  "stream": true,
  "stream_options": { "include_usage": true },
  "messages": [{ "role": "user", "content": "请写一段故事" }]
}
```

`anti-gemini-3.7-flash-real` 为真实流式，`-fake` 为缓冲交付，无后缀沿用全局流式模式。`stream: false` 返回完整 JSON。early 在准入后发送 role + 空 content，立即再发送无 role 空增量，等待阶段每秒保活。

可选请求字段 `anti_truncation` 只接受布尔值。优先级为总开关/能力限制 → 显式字段 → anti 前缀 → 全局默认。显式 false 可以退出全局 prefer，也可以覆盖 anti 前缀；仍会剥离前缀。字段不会发送给 Gemini。空模型、`anti-`、`anti-anti-xxx`、非法字段类型均返回首包前 HTTP 400。

模型别名不新建账号队列、配额或统计分组，不自动出现在 `/v1/models`。响应 model 沿用原有真实模型命名，同一流中的 id、created、model 一致。隐藏模型仍由现有调度准入拒绝。

## 配置

配置页“请求处理与模型功能”及统一配置 API 可以保存、读取、校验和重置以下设置，热更新只影响新请求。

| 环境变量/管理字段         | 内部字段                | 默认 | 合法值       |
| ------------------------- | ----------------------- | ---- | ------------ |
| `ANTI_TRUNCATION_ENABLED` | `antiTruncationEnabled` | true | 布尔值       |
| `ANTI_TRUNCATION_DEFAULT` | `antiTruncationDefault` | off  | off / prefer |

环境变量总开关接受 `true`/`false` 字符串，管理 API 使用 JSON 布尔值。非法环境变量在启动时拒绝。prefer 对下列准入模型和工具组合默认启用，不支持的组合跳过并记录原因；显式启用不支持组合返回 HTTP 400。

总开关关闭时普通请求照常运行，明确启用请求返回 `anti_truncation_disabled`，不会先发送 early 首包。第一阶段没有 required 全局策略。

## 能力矩阵

此矩阵表示本地转换与模拟上游验证结果，不能代替真实账号的模型/工具能力测试。

模型采用静态准入名单 `src/core/AntiTruncation.js` 的 `TEXT_MODELS`，不根据名称自动放行未来型号。此前 Argon 未加入是因为尚未验证，并非已确认上游不支持。新模型需要验证文本与函数传输后加入名单；只加入 `/v1/models` 不会自动启用抗截断。

| 模型/入口/组合                                                                   | 行为                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| gemini-2.5-flash / pro / flash-lite                                              | 文本、函数工具隔离验证通过                                              |
| gemini-3-flash-preview、gemini-3.1-pro-preview                                   | 文本注入、转换及修饰符隔离验证通过                                      |
| gemini-3.1-flash-lite-preview / gemini-3.1-flash-lite                            | 同上                                                                    |
| gemini-3.5-flash / flash-lite、gemini-3.6/3.7/3.8-flash                          | 同上；依赖部署模型目录与账号实际可用性                                  |
| gemini-4-argon                                                               | 已加入默认名单；真实 AUTO 合成函数、非流式及缓冲 SSE 正文还原通过。MakerSuite 当前只支持 AUTO 工具选择，none / required 等强制模式仍受桥接限制 |
| 普通回答、函数 auto / required、并行真实函数                                     | 保留真实工具、参数和已有调用 ID；synthetic 只还原成正文                 |
| tool_choice none（含旧 function_call none）                                      | 本次声明只包含 synthetic，Gemini ANY 仅允许该内部函数，真实工具不可调用 |
| 强制指定真实函数                                                                 | 跳过 anti，原指定工具语义保留，记录 forced_real_tool                    |
| 搜索、代码执行、URL context、其他托管工具及全局强制工具                          | 未实测组合；显式 anti 拒绝，prefer 跳过                                 |
| 图片/音频输入、非 text 输出、response_format、旧 functions schema                | 第一阶段显式拒绝，prefer 跳过                                           |
| Gemma、latest 动态别名、未知模型、图片/音频/embedding/robotics/computer-use 模型 | 不在准入名单                                                            |
| Claude、Responses、Gemini 原生、Embeddings 入口                                  | 显式 anti 在首包前拒绝；prefer 不启用                                   |

准入还要求模型存在于部署的 modelList（目录可用时），并通过隐藏模型检查。名单在 `src/core/AntiTruncation.js` 的 `TEXT_MODELS` 中维护；扩展名单前须补充协议测试，并在独立环境实测模型支持函数调用。

## 实现与状态约定

- 每次尝试使用 96-bit 随机工具名。原请求先深拷贝，再注入一次工具和尾部 user 控制消息；assistant 预填由这一条 user 收口。现有转换器负责 Gemini 轮次处理。
- 重试使用不可变的已转换模板，替换其中唯一的随机名称，重建 Attempt。与每次重新运行转换器等价的注入部分不重复执行，避免累加工具、提示词和异步外部资源转换。
- 上游函数参数是结构化对象，直接检查 `content` 字符串。real 的网络 SSE 片段先有界组装成 JSON 事件，随后使用同一还原器；不把结构化对象序列化成 OpenAI 参数碎片再解码。
- 字符串形式 args 仅支持 JSON、代码围栏和有限缺失末尾引号/花括号修复。不补全答案，不丢弃半个转义以伪造成功；非法类型、未完成转义、格式错误和超限均显式失败。
- 单次响应、事件组装及 synthetic 内容设 10 MiB 上限。choice 状态隔离，choice index 限制为 0–127，真实工具索引由原转换器连续生成。real 写入遇到背压等待 drain，断连清理临时监听器。
- 完整缓冲回答发现 synthetic 时丢弃未交付普通正文，保留推理和真实工具。real 默认 SideBuffer 为 0：先交付的普通正文无法收回，后到 synthetic 不拼接尚未发送的普通正文，已发生冲突会记录。内部非零 side buffer 有测试，但第一阶段没有新增全局预缓冲设置。
- 无 synthetic 的普通回答可以按 prefer 交付，不额外调用模型。上游必须有明确 finishReason；EOF 不视为生成成功。明确的 `promptFeedback.blockReason` 转为 `upstream_prompt_blocked` 业务错误；只有 candidate 过滤终止且无 blockReason 时保留对应结束语义，length 保持 length；存在真实工具且上游 STOP 时保留 tool_calls，仅 synthetic 时变为 stop。
- stream_options.include_usage 为 true 时统一在成功终结前交付一次 usage-only 事件，包含独立或混合到达的上游 usage。业务用量采集仍由既有 UsageStatsService 处理，注入开销按实际上游统计，不根据还原字符数重估。
- early 空包不设置真实输出状态，不影响原本允许的重试；有效非空 blockReason 始终禁止自动重试、换账号或换出口重放，也不触发账号处罚。收到函数名称、参数、文本等真实上游增量后禁止换账号重生成。尚未解析完的非空网络片段保守视为上游开始，避免错误重放；完整空事件、注释和 usage-only 不作为正文。只有 empty heartbeat 不影响业务 token、工具或 choice。
- 状态分别使用 headersSent / __streamStartSent / __upstreamOutputStarted / __modelOutputStarted / writableEnded，Attempt 保管还原状态。账号选择、取消、超时、错误处理及 usage 沿用原生命周期，没有独立 HTTP 或重试循环。
- 首包前本地准入错误为 HTTP 非 200；首包后错误走原 SSE error 终结，保留状态信息，flush 后结束，不补成功 DONE。上游业务错误保留原始 code、message 及有效 type，不增加代理前缀；业务错误码与 HTTP 状态独立保存。缺失字段使用明确回退值。本地解码/协议错误返回具体内部错误码和安全信息，在错误产生位置避免包含私有工具名、参数和完整正文；这些内容不写入新增日志或转换器调试日志。

错误字段、early 流内错误及验收约定见 [错误透传方案](anti-truncation-error-passthrough-plan.md) 与 [blockReason 改造方案](upstream-block-reason-passthrough-plan.md)。

上游明确拦截时，未发头返回 HTTP 400；已发头通过协议对应的流内错误终止，不补成功 DONE。OpenAI 错误码为 `upstream_prompt_blocked`，message 包含真实 blockReason，`error.upstream` 携带经过校验、长度限制及常见凭据脱敏的诊断。`error.usage` 保留已收到的用量，Gemini 使用 `error.usageMetadata`。已交付内容保持不变，不重放生成。响应头 `X-Request-ID`、错误体 `request_id` 与结构化日志使用 Build 请求 ID；实际存在的 Google responseId 单独记录，不冒充贯通 ID。此项已完成本地模拟验证，NewAPI 的流内错误展示及计费仍需外部验收；用户已确认 NewAPI 重试数为 0，无需为下游禁止重试另做改造。

该机制可能改善普通正文通道截断和有限格式问题，不能突破 token 上限、恢复丢失内容或绕过安全拒绝。默认不开启，多一层工具 JSON 与控制消息会增加真实 token 成本。不要叠加独立网关的 synthetic 包装。

## 构建、部署与回退

本次只修改仓库并构建 UI，未修改运行容器。

1. 在隔离 checkout 中执行 `npm ci`、`npm test`、`npm run lint`、`npm run build:ui`，审查 diff 和本实施记录。
2. 使用现有 Dockerfile 构建独立版本镜像，例如 `docker build -t aistudio-to-api:anti-candidate .`，保留上一镜像、配置及网关版本。MIT 参考算法许可随仓库及镜像保存于 docs/licenses。
3. 在独立实例保持 ANTI_TRUNCATION_DEFAULT=off，以具体 anti 别名测试真实模型、工具 none/required/auto、上游失败和取消；先直连，再经过 NewAPI/SillyTavern 及公网入口记录事件到达时间。
4. NewAPI 手工映射同名 anti 别名到本实例的 anti 模型名，避免 NewAPI 提前剥离前缀。当前 NewAPI 重试数为 0，重点验证流内错误展示、渠道状态及计费，再小范围切换；稳定后才考虑 prefer。
5. 第一级回退：默认设 off，NewAPI 映射改回普通模型，显式 anti 仍然有效。
6. 第二级回退：总开关设 false 并移除 anti 映射，明确 anti 请求将收到准入错误；必要时回退镜像或恢复原独立网关链路。

完整链路与性能实测待办见 [实施记录](anti-truncation-implementation.md)。
