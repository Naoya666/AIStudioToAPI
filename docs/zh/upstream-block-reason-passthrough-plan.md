# 上游 blockReason 错误透传改造方案

日期：2026-10-24（Asia/Shanghai）。

状态：Build 侧已实施，本地验证记录见 [实施记录](anti-truncation-implementation.md#blockreason-透传与禁止重试2026-10-24)。未部署；用户已确认 NewAPI 重试数为 0，不需要为下游禁止重试另做改造；错误接收、展示与计费仍待外部验收。下文保留改造要求与全链路完成标准。

## 目标与依据

解决上游明确拒绝生成，却在 Build → NewAPI → 客户端链路中表现为 HTTP 200、正常结束、零正文的问题。客户端应能看到真实拦截原因，管理员应能关联请求并定位失败类别。

排查依据：`/home/dev/workspace/infra/runbooks/meow-jp-empty-response-20261024.md`。该记录中的美国候选请求高度匹配日本入口请求，但缺少贯通请求 ID，不能视为已经唯一证明关联。现存日志仅能确认候选响应存在非空 blockReason，无法恢复其具体值或额外说明。

本文补充 [已有错误透传方案](anti-truncation-error-passthrough-plan.md)。已有方案主要覆盖顶层 `response.error`；本文重点覆盖生成响应中的 `promptFeedback.blockReason`，不另建一套重试循环。

**硬性要求：识别到有效、非空的 `promptFeedback.blockReason` 后，该次请求必须终止，不能因此触发任何自动请求重试。** 此规则不受是否有 candidates、是否已输出内容、响应模式、账号调度方式或重试配置影响。

## 当前实现与问题

1. `src/core/AntiTruncation.js` 的 `Attempt.restore()` 已对顶层 `response.error` 调用 `upstreamError()`，保留基础业务错误字段。
2. 对于非空 `promptFeedback.blockReason` 且无 candidates 的响应，当前实现补入空 parts、`finishReason: "SAFETY"` 的候选，只记录 `upstream_blocked` 事件。
3. 合成候选使转换器中“无 candidate 且有 promptFeedback”的处理分支无法命中；anti 流式转换还只向转换器传递 candidates，未携带 promptFeedback。
4. 合成的 SAFETY 被映射为 `content_filter`，请求随后正常结束。具体 blockReason 未展示、未落入诊断日志，usage 可能记录为 success。
5. 现有 `UpstreamError` 仅归一化 code/message/type/status，没有贯穿拦截诊断与控制策略的契约。
6. 模型感知调度的部分路径先调用 `scheduler.failure()` 再判断是否重试。仅禁止重试，仍可能更新失败计数或账号状态，必须同时处理。

因此，不能仅删除合成候选、修改 finish_reason 或在转换器追加提示文本。

## 行为契约

### blockReason 的识别与优先级

- 对协议字段进行类型校验；非空字符串视为明确拦截，保留原始值，不依赖枚举白名单。上游未来新增的原因也适用禁止重试规则。
- 空字符串、缺失值、对象等无效字段不能被字符串化成有效拦截原因；按对应协议规则处理，不凭空认定安全拦截。
- 对同时存在有效 blockReason 和 candidates 的响应，仍按明确拦截终止，不因 candidates 存在而绕过禁止重试规则。
- 同一响应同时出现有效 blockReason 与顶层 error 时，保留两者实际提供的诊断信息，控制策略以明确拦截、禁止重试为准。
- blockReason 的控制判断必须先于通用 HTTP 状态、消息关键字、账号风控或可重试错误分类。

### 绝不因 blockReason 自动重试

识别后必须满足：

- 不对相同账号重新发送生成请求。
- 不切换账号、渠道或出口重放请求。
- 不进行 anti 恢复重放、降级模式重放或外层通用错误重试。
- 不因还没有实际正文、只发了 early 空首块或仍有重试预算而重试。
- 原本其他错误可以执行的重试不受影响；若先前发生过其他可重试错误，后续某次尝试返回 blockReason，应立即终止，不再创建下一次尝试。
- 取消尚未完成的上游读取，停止心跳并清理队列、计时器和调度租约，避免终止后出现延迟重放。

Build 必须在自己的所有执行路径中保证上述规则。用户已确认当前 NewAPI 重试数为 0；这是既有部署配置，本次不增加 NewAPI 禁止重试的专项改造或验收项。Build 自身对 blockReason 禁止重试的要求保持不变。

### 正文与终止行为

| 场景 | 预期 |
| --- | --- |
| blockReason，无 candidates、无正文 | 返回明确业务错误，不合成 SAFETY 候选 |
| blockReason，有 candidates，但尚未交付正文 | 终止并返回业务错误，不将同帧候选当作成功输出 |
| 已交付部分正文后出现 blockReason | 保留已交付内容，发送终止错误，不重放、不撤回内容 |
| candidate.finishReason 表示过滤，但没有 blockReason | 保留原始终止语义，不能伪造 promptFeedback；本方案不一概转为 prompt 拦截 |
| 无正文、无 blockReason、缺少有效结束 | 按现有空响应或协议不完整规则处理，不能猜测拦截原因 |
| 正常文本、真实工具调用、长度限制 | 保持正常输出及对应结束语义 |

## 内部错误模型

建议使用统一结构化错误，具体属性命名可在实现时适配现有代码，但以下语义必须独立保存：

| 信息 | 建议值或规则 |
| --- | --- |
| 内部分类 | `upstream_prompt_blocked`，用于明确识别、禁止重试和账号策略 |
| 对外业务错误码 | `upstream_prompt_blocked` |
| 对外错误类型 | OpenAI Chat Completions 使用 `invalid_request_error` |
| 映射 HTTP 状态 | 未发头时使用 400；这是代理映射值，不冒充上游原始状态 |
| 原始诊断 | 真实 blockReason、实际提供的 blockReasonMessage、安全分类等经校验字段 |
| 原始上游状态 | 实际可取得时独立保留，例如 HTTP 200；未知时不补造 |
| 请求策略 | 显式禁止重试，不处罚账号健康 |
| 输出状态 | 是否已交付实际模型内容，与发头、空首块及心跳分别记录 |
| 用量 | 已收到的真实 usage，不因抛出错误丢弃 |

禁止仅把新字段放进 Error 后便假定它们能够贯通：队列转发、错误包装、对象复制、normalizeError 和各发送函数都必须保留所需语义。业务码、HTTP 状态、原始 blockReason 不能复用为同一个字段。

只有 blockReason 时，message 使用明确的代理回退文案并包含真实值；有上游说明时携带经长度限制与敏感信息检查后的说明，不编造具体触发内容。

## 对外错误契约

### 尚未发送响应头

返回 HTTP 400。OpenAI Chat Completions 示例：

```json
{
  "error": {
    "code": "upstream_prompt_blocked",
    "type": "invalid_request_error",
    "message": "上游拒绝生成，blockReason=SAFETY",
    "upstream": {
      "blockReason": "SAFETY"
    }
  }
}
```

示例中的 SAFETY 仅用于展示格式，必须替换为实际值。`upstream` 是本项目扩展字段；基础 code/message/type 应足以让忽略扩展字段的客户端看到失败原因。扩展对象只输出明确允许且实际存在的诊断字段，不透传任意原始对象。

### 已发送响应头

early 空首块、保活或实际内容发送后，HTTP 状态无法修改。OpenAI Chat Completions 返回同样错误对象的 SSE 帧：

```text
data: {"error":{"code":"upstream_prompt_blocked","type":"invalid_request_error","message":"上游拒绝生成，blockReason=SAFETY","upstream":{"blockReason":"SAFETY"}}}

```

停止心跳，写入并 flush 错误帧，关闭连接。错误后不得追加正常 finish 块或成功 `[DONE]`；客户端已断开时只清理资源。不得将错误放进 `delta.content` 伪装成模型回答。

### 其他协议

Claude、Responses、Gemini 使用各自错误事件与终止格式，保留真实原因及统一内部分类。不得为了复用 OpenAI 错误对象破坏协议字段类型，例如 Gemini 数字 code 与字符串业务码需要分别处理。各协议能否携带扩展诊断应按实际输出契约验证，至少 message 必须含真实原因。

识别逻辑应复用于普通请求与 anti 请求；同一个上游拦截不得因是否启用 anti 而变成成功文本或成功空流。

## 调度、统计与计费

- 在 legacy、模型感知调度及其他生成重试入口增加拦截优先判断，不能仅依赖 HTTP 400 不在默认重试集合中。
- 在 `ModelScheduler.classifyError()` 与 `failure()` 等路径中明确业务拦截类别。调度失败记录入口即使先于重试判断执行，也不能把该错误计入账号故障或冷却策略。
- 不修改账号健康、会话有效性、模型支持标记，不增加连续故障、风控处罚或账号熔断计数。
- 正常记录实际尝试与资源使用；请求级 usage outcome 使用现有 `error`，不能继续记作 success。管理员应能通过错误分类或结构化日志检索 blockReason，无须为本方案新增 outcome 枚举。
- 如需持久化业务分类、blockReason 或关联 ID，应显式设计存储字段与兼容读取，不以新增内存属性代替持久化。
- Build 请求结果统计、账号健康统计和 NewAPI 消费记录分别验证。保留现有零输出免单行为，有实际输出时保留真实用量，禁止为展示错误伪造输出 token。
- 注意抛错顺序：应在终止前采集该帧实际 usage；不能因先抛出错误而漏掉用量。

## 日志与请求关联

记录结构化事件：代理请求 ID、尝试 ID、实际可得的上游请求 ID、模型、真实 blockReason、经校验的可选诊断、是否已输出正文、实际尝试次数，以及禁止重试决策。

不记录提示词、聊天正文、凭据或完整原始响应。说明字段限制长度并检查敏感信息；缺失字段保持缺失，不输出推测值。

Build 与 NewAPI 约定请求关联方式。流开始前可通过响应头返回 Build 请求 ID；流内发生失败时应确保下游日志仍能关联。不能仅依赖错误发生后追加响应头，也不能把代理 ID 冒充 Google 请求 ID。

## 建议修改位置

| 位置 | 改造内容 |
| --- | --- |
| 统一上游响应识别辅助模块 | 校验 blockReason、提取允许的诊断字段，构造明确业务错误与控制策略 |
| `AntiTruncation.js` | 移除拦截合成空 SAFETY 候选的行为；统一识别、保留 usage 并终止；避免被完整性检查覆盖成另一错误 |
| `UpstreamError.js` | 支持归一化后仍保留拦截分类、诊断及必要控制信息，保持基础错误透传兼容 |
| `RequestHandler.js` | 覆盖首次响应、缓冲读取、实时流、错误发送、legacy 重试与清理路径 |
| `ScheduledRequestHandler.js` | 在重试及失败记账入口保留并优先识别拦截，正确释放租约 |
| `ModelScheduler.js` 及 legacy 账号切换逻辑 | 禁止因该分类重试或处罚账号，避免按 HTTP 状态或消息关键字重新分类 |
| `FormatConverter.js` | 普通请求采用一致错误语义，移除拦截作为模型正文成功返回的行为；不补造上游原因 |
| usage 与诊断日志 | 记录请求失败及真实原因，保留已收到用量，按需设计持久化字段 |
| NewAPI 接收 | 验证 HTTP/SSE 错误识别、原因传递、零输出计费和请求关联；现有重试数为 0，无需专项改造 |

实施前应再次搜索所有生成请求重试入口，包括浏览器侧和队列侧逻辑；以上文件列表不能替代完整调用链检查。

## 验证与验收标准

使用模拟上游，不重放生产敏感提示词。最少覆盖：

| 场景 | 验收点 |
| --- | --- |
| 只有 blockReason、没有 candidates | 原因可见、失败统计正确、没有合成候选 |
| 带上游说明、安全分类、usage | 合法诊断保留，用量不丢；无任意对象泄露 |
| 未知但有效的 blockReason 字符串 | 保留真实值，仍禁止重试 |
| blockReason 与 candidates 或顶层 error 同时存在 | 拦截策略优先，不交付同帧候选、不重试 |
| 无效或缺失 blockReason | 不误报拦截，不伪造原因 |
| 配置把 400 加入可重试集合 | blockReason 仍不重试 |
| message 含临时故障、权限或风控关键词 | 不改变禁止重试和不处罚账号的结论 |
| 先发生其他错误并重试，后收到 blockReason | 立即停止，不再创建后续尝试 |
| early 仅发空首块后拦截 | HTTP 保持 200，发错误帧，无成功 DONE |
| 已发正文后拦截 | 保留已发内容与用量，错误终止，不重放 |
| 客户端断开、取消与延迟响应竞态 | 清理完成，不再次写流、不启动新尝试 |
| 顶层普通 error、正常文本、工具调用、抗截断恢复 | 现有行为不被破坏 |
| candidate 过滤终止但无 blockReason | 保留候选语义，不伪造 prompt 拦截原因 |

上述用例应交叉覆盖 anti/普通请求、legacy/模型感知调度、非流式/real/fake/early 及实际支持的协议。

“没有重试”必须通过副作用断言验证：首次尝试直接拦截时，Build 实际生成请求发送次数为 1；账号和出口切换次数为 0；不产生冷却、账号失效或模型禁用。先有其他错误重试的用例，则断言识别 blockReason 后发送次数不再增加。仅检查 `_shouldRetryError()` 返回 false 不足以验收。

隔离集成验证分两步：先直连 Build 验证 HTTP/SSE 实际事件，再验证 Build → NewAPI → 客户端。记录下游版本、实际错误显示、请求结果和计费结果。NewAPI 重试数为 0 已由用户确认，不另设禁止渠道重试的验收任务。流内错误帧发出不等于全链路验收完成。

## 实施顺序与发布边界

1. 明确统一错误结构与协议输出契约，盘点所有重试和失败记账入口。
2. 在同一候选版本实现识别、错误传递、禁止重试和不处罚账号，避免只改出口导致新错误进入原有故障策略。
3. 增加针对性模拟测试和实际 HTTP/SSE 集成验证，更新旧的“上游拦截仍作为正常安全结束”测试预期。
4. 在隔离环境验证 NewAPI 错误接收、展示与计费；本次不为禁止重试改造 NewAPI。如其他兼容问题需要改动，单独记录变更和版本依赖。
5. 更新使用说明及实施记录，区分本地通过、隔离链路通过和生产验收状态。
6. 部署前遵守主机规则，核对镜像、Compose mounts、持久数据和备份，明确回退镜像及下游配置回退方式，再安排灰度。

本文不授权生产部署，也不要求调整两机时钟。完成标准是：真实原因从上游识别到客户端与管理员日志可见；Build 对 blockReason 不触发自动请求重试，NewAPI 沿用用户确认的重试数 0；请求失败统计、账号健康与计费行为符合上述契约。
