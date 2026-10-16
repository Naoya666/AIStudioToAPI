# AI Studio Build 生成请求统一 400：新版 GenerateContent 协议修复方案

日期：2026-10-16（Asia/Shanghai）。状态：待实施；本次仅完成源码核对与修复设计，没有修改运行代码、部署服务或执行真实上游请求。

## 1. 问题与修复依据

用户已确认：本项目近期所有模型调用返回的 400，与 `yunx738/ais2api` 最新修复针对的问题相同。本方案以迁移该修复为起点，不再把模型名错误或个别账号参数异常作为首要调查方向。

参考仓库与固定版本：

- 仓库：<https://github.com/yunx738/ais2api>。
- 用户提供的本地副本：`/home/dev/workspace/projects/AIStudioToAPI/ais2api`，与本项目目录同级。
- 已核对提交：`79807728179482509cf1f8a4f5e3e175d9dd6702`。
- 提交链接：<https://github.com/yunx738/ais2api/commit/79807728179482509cf1f8a4f5e3e175d9dd6702>。
- 提交时间：2026-10-16 21:45:21 +08:00。
- 核心实现：`dual-runtime/code/unified-server.runtime.js` 第 390–519 行；该提交在此文件新增 131 行。
- 本项目核对基线：`94b93edd7f9da16102e6566c618d90b664dda135`，编写前工作区无未提交变更。

参考提交说明：Google 已拒绝经 `ProxyUnaryCall / ProxyStreamedCall` 转发的生成 POST 请求并返回 400，因此直接调用 MakerSuite `GenerateContent`。这里引用的是作者提交说明与实现；本次没有独立抓取 Google 页面请求来确认变更时间或完整协议定义。

授权记录：用户已明确表示获得原作者许可，并提供了聊天截图，原作者答复“可以随便用”。后续移植时保留来源、提交号和必要署名；不将该对话解释为整个仓库更换许可证。参考仓库当前 `LICENSE` 为 CC BY-NC 4.0。本次无需再次向用户索取同一移植授权。

## 2. 当前请求链路与故障位置

当前链路：

```text
OpenAI / Anthropic / Gemini 客户端
  → RequestHandler / FormatConverter 构造 Gemini 请求
  → WebSocket 下发给对应账号的 Build 页面
  → scripts/client/build.js 执行 fetch(generativelanguage.googleapis.com/...)
  → AI Studio 页面机制转为 MakerSuite ProxyUnaryCall / ProxyStreamedCall
  → 上游拒绝旧生成转发路径，返回 400
```

当前仓库没有显式构造旧 MakerSuite RPC 的代码，也没有新版 GenerateContent 桥接。旧 RPC 位于页面机制这一层，不能因 `rg` 找不到它就认为当前项目没有经过该入口。修复时应通过受控网络观测确认实际拦截命中，日志只记录方法、RPC 名与状态等必要信息。

主要关联文件：

| 文件                                                       | 现有职责                                         | 修复关联                                         |
| ---------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| `src/core/RequestHandler.js`                               | 构造 Gemini 生成请求，处理多种客户端协议与流模式 | 保留客户端 API；核对错误、超时及反截断兼容性     |
| `src/core/FormatConverter.js`                              | Gemini 与 OpenAI / Anthropic 格式转换            | 继续接收标准 Gemini 响应，避免重复实现客户端适配 |
| `scripts/client/build.js`                                  | 按账号接收 WebSocket 请求、fetch、取消及回传     | 核对错误封装、5 分钟浏览器超时与取消传播         |
| `src/core/BrowserManager.js`                               | 创建账号 context/page、导航、恢复及销毁          | 安装桥接并管理账号隔离和生命周期                 |
| `src/core/ModelScheduler.js`、`ScheduledRequestHandler.js` | 派发、额度、重试与在途请求管理                   | 保证协议失败不误判账号额度或重复生成             |
| `src/utils/UpstreamError.js`                               | 规范化上游错误                                   | 保留新 RPC 错误状态、消息与业务字段              |

## 3. 已核对的协议变化

以下映射来自参考实现，不是完整、稳定的 Google 官方协议。所有下标从 0 开始。未明确含义的字段只记实际值，不猜测用途。

### 3.1 入口与请求头

旧生成 RPC：

```text
.../MakerSuiteService/ProxyUnaryCall
.../MakerSuiteService/ProxyStreamedCall
```

新入口：

```text
POST {tb.mb.F}/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent
```

参考实现使用浏览器页面内 `fetch`，设置 `credentials: 'include'`，并从同一账号页面取得认证信息：

| 请求头            | 参考实现取值                     |
| ----------------- | -------------------------------- |
| `content-type`    | `application/json+protobuf`      |
| `x-user-agent`    | `grpc-web-javascript/0.1`        |
| `x-goog-api-key`  | `tb.mb.jK`                       |
| `authorization`   | `tb.getMetadata().Authorization` |
| `x-goog-authuser` | `String(tb.mb.Ml)`               |

不能把这个调用简单替换为 Node 侧无页面上下文的 HTTP 请求，也不能只改原 Gemini URL。

### 3.2 页面令牌

参考代码通过 `window.default_MakerSuite` 的 `Cn`、`GB` 方法获取新请求需要的令牌：

1. 包装 `M.Cn`，在其被页面调用且第一个参数存在 `mb` 属性时，捕获该服务对象为页面内 `tb`。
2. 将对话中的文本或内联媒体 base64 数据拼接为 `ht`。
3. 调用 `body[4] = await M.Cn(tb, await M.GB(ht))`。
4. 在同一页面中发起新 RPC。

`Cn`、`GB`、`mb`、`F`、`jK`、`Ml` 是当前页面实现细节，不能视为稳定 API；令牌具体语义没有在源码中证实。参考实现每 3 秒尝试安装 hook，未捕获服务对象时返回 503。后续实现必须区分“页面模块未出现”“hook 已安装但对象尚未捕获”“桥接已可用”。不能把已安装 hook 等同于可生成。

参考代码通过 Firefox 页面环境的 `window.wrappedJSObject.eval(...)` 执行。移植时验证实际浏览器支持，不能假设所有浏览器均提供该入口。

### 3.3 新请求顶层结构

```js
[
  "models/" + model, // [0]
  contents, // [1]
  safety, // [2]
  generationConfig, // [3]
  token, // [4] 在页面内生成
  systemContent, // [5]
  tools, // [6]
  null,
  null,
  null,
  1, // [10] 参考实现固定值，含义待确认
  null,
  null,
  [[null, null, "UTC"]], // [13] 参考实现固定值
];
```

`Content` 编码为 `[parts, role]`。参考实现将模型角色保留为 `model`，其他角色转为 `user`；系统提示词单独放入 `body[5]`，其 role 也编码为 `user`。

`Part` 映射：

| Gemini 字段        | 数组位置与结构                                           |
| ------------------ | -------------------------------------------------------- |
| `text`             | `part[1] = text`                                         |
| `inlineData`       | `part[2] = [mimeType, base64Data]`                       |
| `functionCall`     | `part[10] = [name, encodedStruct(args), id 或 null]`     |
| `functionResponse` | `part[11] = [name, encodedStruct(response), id 或 null]` |
| `thought`          | `part[12] = true`                                        |
| `thoughtSignature` | `part[14] = signature`                                   |

例如 `{ role: 'user', parts: [{ text: '你好' }] }` 转为 `[[[null, '你好']], 'user']`。中间空位必须保持，不能用压缩数组的方式移除 `null`。

函数参数用位置数组编码的 `Struct / Value` 表示：null 为 `[0]`；数字、字符串、布尔值分别放在 Value 的 `[1]`、`[2]`、`[3]`；对象放 `[4]`；列表放 `[5]`。必须验证嵌套对象、空对象、空列表、`false` 和 `0` 的往返编码。

### 3.4 生成配置、安全与工具

| Gemini 配置        | 新 `generationConfig` 位置 | 参考实现行为        |
| ------------------ | -------------------------- | ------------------- |
| `stopSequences`    | `[1]`                      | 有数组时写入        |
| `maxOutputTokens`  | `[3]`                      | `gc.maxOutputTokens |     | 65536` |
| `temperature`      | `[4]`                      | 缺省为 1            |
| `topP`             | `[5]`                      | 缺省为 0.95         |
| `topK`             | `[6]`                      | 缺省为 64           |
| `responseMimeType` | `[7]`                      | 有值时写入          |
| 未明确字段         | `[13]`                     | 固定为 1            |
| `thinkingConfig`   | `[16]`                     | 进一步编码为数组    |

思考配置：`includeThoughts` 在思考数组 `[0]`，false 编码为 0，其余缺省编码为 1；`thinkingBudget` 在 `[1]`；`thinkingLevel` 在 `[3]`，low 为 1、high 为 2，未指定 budget 和 level 时参考实现设为 high。此处的缺省行为属于移植时必须明确核对的差异，不能无意覆盖当前项目策略。

安全设置条目为 `[null, null, category, threshold]`。类别映射：骚扰 7、仇恨 8、色情 9、危险内容 10、公民诚信 11；阈值映射：LOW 1、MEDIUM 2、ONLY_HIGH 3、BLOCK_NONE 4、OFF 5。参考代码默认前四类 OFF；移植应优先保留当前项目和客户端已有设置，对未知枚举显式报错，避免套用参考代码的默认值掩盖异常。

函数声明的名称、说明及参数 schema 被编码到 `tools`，支持 schema 的 type、format、description、nullable、enum、items、properties、required。参考 schema 类型编号为 string 1、number 2、integer 3、boolean 4、array 5、object 6。

### 3.5 响应与旧 RPC 包装

参考 `convChunk()` 把新 RPC 数组转换为标准 Gemini JSON：

- `m[0]` 为候选列表；每个候选的 `c[0]` 是 Content，`c[1]` 是结束原因。
- 结束原因映射：1 STOP、2 MAX_TOKENS、3 SAFETY、4 RECITATION、5 OTHER。
- Part 按前述位置还原文本、inlineData、functionCall、thought、thoughtSignature。
- `m[2]` 为 usage 数组：`[0]` 输入 token、`[1]` 输出 token、`[2]` 总 token、`[9]` 思考 token。
- `m[7]` 为 responseId。

旧 unary RPC 的兼容响应为 `JSON.stringify([JSON.stringify(mergedGeminiResponse)])`。旧 streamed RPC 则将各 Gemini chunk 编为单元素字符串数组，再放入双层数组；若存在尾部记录，参考实现会保留该记录。必须用固定样本验证页面能够解包，不要直接把 Gemini JSON 填入旧 RPC 响应。

参考实现使用数组形状和 role 为 `model` 的判断来识别 chunk。对空响应、纯错误、usage 尾块、拦截提示和未知数组结构需单独处理，不能把无法识别的结果自动变成空成功。

## 4. 参考补丁的兼容性边界

以下是源码可见的限制，后续实施不能直接继承并宣称完整兼容：

1. **流式被缓冲。** 页面内先 `await r.text()` 收完上游，再 `route.fulfill()` 一次返回。旧 streamed 响应结构可用，不代表客户端在生成中持续收到内容。
2. **工具与媒体字段不完整。** 仅编码函数声明；没有编码 googleSearch、urlContext、codeExecution、toolConfig、fileData、responseSchema 等。未知 Part 在参考实现里被直接丢弃。
3. **思考配置覆盖不完整。** level 只映射 low/high；其他级别和缺省策略不能未经确认就降级到 high。
4. **usage 缺失变成 0。** 参考实现用 `|| 0`；本项目应保留缺失与实际为零的区别，避免用量和成本误报。
5. **结束状态可能误报。** merge 缺少 finishReason 时补 STOP，还只合并首个候选。必须区分完整完成、传输中断和无法识别响应，多候选也需明确策略。
6. **取消未贯穿。** `Promise.race` 10 分钟超时不会自动中止页面内 fetch；计时器也没有在成功时清除。客户端取消、超时或 context 销毁后，不能继续无主生成并触发下一轮重试。
7. **错误外形不同。** 新 RPC 的 protobuf JSON 数组错误不一定满足 build.js 现有的 `{error: ...}` 解析，直接透传可能丢失消息、429 重试时间等信息。
8. **页面重载与初始化存在竞态。** hook 只有包装后才捕获服务对象；页面必须实际调用对应方法。轮询安装不保证一定捕获，需要有界等待和可诊断的就绪流程。

这些项目应分别记录为“已支持并验证”“明确拒绝”“待补齐”。不能静默删除客户端字段后返回成功；本项目默认强制注入的工具也要纳入检查，避免迁移后普通请求被全部拒绝或悄悄失去功能。

## 5. 本项目建议实现

### 5.1 模块划分与接入点

建议新增下列模块，名称可在实施时按代码约定调整：

| 模块                              | 职责                                                              |
| --------------------------------- | ----------------------------------------------------------------- |
| `src/core/MakerSuiteCodec.js`     | 纯函数编码请求、解码响应、合并候选、构造旧 RPC 包装、校验支持字段 |
| `src/core/MakerSuiteBridge.js`    | 安装 context route、页面 hook、就绪探测、请求执行、取消与资源清理 |
| `tests/makersuite-codec.test.js`  | 使用脱敏固定样本验证编码、解码和错误边界                          |
| `tests/makersuite-bridge.test.js` | 验证账号隔离、初始化、重载、取消及清理                            |

在 `BrowserManager` 创建每个账号 context/page 后、首次导航前安装 route 和页面初始化机制，纳入现有初始化 attempt 和超时管理。当前公共初始化路径在 `context.newPage()` 附近；轻量 reconnect 会重新导航已有 page，因此必须覆盖页面重载后重新安装 hook 的场景。

桥接实例绑定具体 `context`、`page`、`authIndex`、browser generation 和初始化 attempt。不能在请求执行时使用可被其他账号切换的 `this.page` / `this.context` 作为实际目标。销毁、初始化失败和过期 attempt 都必须清理 route、计时器、监听器及活动 fetch；旧实例清理不得删除同账号新实例的资源。

客户端继续提交 Gemini JSON，`FormatConverter` 继续接收标准 Gemini JSON，不将位置数组扩散到 OpenAI / Anthropic 适配层。

### 5.2 拦截范围与就绪

只拦截 MakerSuite 的两个旧 Proxy RPC，并且仅处理其中模型路径明确为 `generateContent / streamGenerateContent` 的请求。GET 模型列表、文件、embedding、countTokens 以及其他 RPC 保持原路径，分别回归验证。

解析旧请求体时校验 `[0]` 路径与 `[1]` JSON。确认属于生成请求但结构无效时返回明确协议错误；不通过放行已失效的旧路径掩盖适配问题。新 GenerateContent 请求不得被递归拦截。

首次生成派发前需确认桥接可用。就绪等待须有上限并参与现有初始化取消；缺少模块或令牌对象时输出可归类错误，不无限轮询，不伪装为额度耗尽，也不通过轮换全部账号重复放大同一个协议错误。

### 5.3 流模式、取消和超时

先以参考实现验证普通非流式和 fake / early 模式的完整生成链路。沿用缓冲桥接时，必须明确记录 `real` 模式不能提供实时上游内容；要么明确提示限制或拒绝该模式，要么实现可增量读取的新传输方案后再宣称恢复 real。不要静默改变模式含义。early 的保活事件不能视为模型首个内容 chunk。

如需真正增量转发，应独立设计页面内 ReadableStream 读取、分帧解析、向 Node / 客户端传递、背压与取消；单次 `route.fulfill()` 方案不能满足这项目标。

桥接 timeout、build.js 的 fetch/read 5 分钟上限、服务端 fetch/stream/fake-stream timeout 和调度 supervisor 的关系需统一核对。不能只照搬参考的 10 分钟常量，导致外层提前重试而上游仍在生成。

每次调用持有独立 AbortController；使用现有 request/attempt 标识关联，客户端断开、请求取消、deadline 或 context 关闭时中止对应 fetch，清除所有定时器。generation / attempt 已变化的迟到结果不可写回新请求。取消传播和上游执行结果不确定时，应遵守现有执行结算规则，不自动认定可安全重试。

### 5.4 错误与观测

转换新 RPC 错误为本项目可识别的错误对象，保留实际 HTTP 状态、可确定的业务码、消息和 retry 信息。区分上游 400/401/403/429/5xx、令牌未就绪、协议不匹配、超时和客户端取消；不要把所有失败统一改成 500 或把所有 400 当账号故障。

对成功 HTTP 中包含的应用错误、空数组、格式异常和未确认完成状态做显式校验，不能返回伪造 STOP。协议字段缺失时不捏造 usage。

诊断日志记录账号内部标识、请求/attempt 标识、RPC、状态、耗时和桥接阶段即可。不要照搬参考实现截取原始响应体的日志方式；不记录 Cookie、Authorization、令牌、完整请求或回答。

## 6. 实施顺序

1. 固定参考提交，提取双向 codec，添加来源说明与固定样本测试；列出当前请求字段和支持范围。
2. 实现每账号桥接、页面 hook、就绪检查与清理，接入 context 初始化及 reconnect。
3. 接通文本、系统提示词、思考、函数工具与函数结果；验证反截断依赖的工具调用和签名往返。
4. 补齐错误规范化、请求取消、超时联动、迟到结果隔离与执行结算。
5. 验证 inlineData；为内置工具、文件引用、结构化输出等明确实现或可见限制，处理默认注入策略。
6. 明确各流模式的实际能力，完成离线回归和受控真实请求验收。
7. 将实际改动、验证命令、结果、未支持项与部署状态回填本文，再按现有发布流程上线。

不得把其他仓库的整个 BrowserManager 或账号调度系统覆盖进来；本次迁移的是协议适配，保留本项目现有池管理、账号代理、额度与恢复机制。

## 7. 验证与验收要求

### 7.1 离线验证

- 精确检查顶层数组、Content/Part、systemInstruction、思考参数、函数 schema、Struct/Value 的编码和反解，包含 0、false、空值及嵌套值。
- 使用独立预期值或脱敏真实样本，避免只用自身 encoder/decoder 互相验证。
- 覆盖 unary 与 streamed 包装、多个候选、思考签名、工具调用、usage 尾块、安全拦截、缺失结束标志、未知枚举、未知结构和应用错误。
- 覆盖两个账号并发、同账号并发、请求取消、初始化超时、页面 reload、轻量 reconnect、context 关闭及旧 attempt 迟到结果。
- 验证生成请求被桥接一次，非生成请求继续原路径，新入口不递归；确认不会残留 timer、route 或 fetch。
- 新测试纳入 `package.json` 的 `npm test`。运行相关定向测试后，完成现有 `npm test` 与改动 JS 的 lint；没有修改 UI 时不额外要求 UI 构建作为协议修复证据。

### 7.2 真实请求验收

真实验证会使用账号额度，应记录使用的模型、协议、模式、结果与时间，但不落盘凭据或正文。至少包括：

| 场景                               | 通过条件                                                           |
| ---------------------------------- | ------------------------------------------------------------------ |
| 可用的不同模型家族                 | 均命中新 GenerateContent，不再发送旧生成 POST 到上游，生成成功     |
| OpenAI / Anthropic / Gemini 非流式 | 正文、系统提示词、结束状态、usage 外形正确                         |
| fake / early                       | 完整内容和终止正确，保活与实际内容耗时分别记录                     |
| real                               | 按选定方案验证真实增量；若仍缓冲，明确记录限制，不能记为实时流通过 |
| 思考与函数工具                     | 思考内容/签名、函数参数、工具返回后的第二轮调用正确                |
| 反截断                             | emit_answer、续写、结束判断和跨轮 usage 符合现有规则               |
| 内联媒体及扩展能力                 | 已支持能力实际生效；未支持能力明确报错或有可见限制                 |
| 取消、超时、reload、双账号并发     | 无串号、无旧响应写回、无重复无主执行或无限等待                     |
| 400/403/429/5xx                    | 状态和消息正确，不破坏账号资格、冷却与额度结算                     |
| 文件、模型列表等非生成请求         | 未被错误桥接，原有功能无回归                                       |

离线测试、参考作者提交中“已验证”的说明，均不能替代本项目自己的真实验收。

## 8. 发布与回退

发布前保留当前代码版本和必要配置备份，不覆盖当前账号、额度或执行状态。先用少量账号和请求验证，再恢复正常派发；记录当前实现采用缓冲桥接还是增量传输。

出现串号、取消失效、重复生成、假成功或额度结算异常时，停止扩大流量并回退代码。回退旧版本只恢复原有代码行为，不能保证已失效的旧上游协议恢复可用；必要时暂停生成派发并返回明确的暂不可用错误，避免用反复重试消耗账号与资源。

## 9. 后续实施记录

- 运行代码改动：尚未开始。
- 新增测试与执行结果：尚未开始。
- 真实请求验收：尚未执行。
- 实时流方案与未支持字段：待实施时确认并记录。
- 部署状态：未部署。
