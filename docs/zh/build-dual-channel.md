# Playground + Build 代码助手双通道

实施日期：2026-11-02。后续 Token 统计与用户提供的预算更新见 [Token 统计文档](token-statistics.md)；该更新取代下文初版中“所有 Build 额度未知”的展示口径，Build 上游重置和 anti 状态仍未验证。初版完成代码与离线验收；初版**没有调用真实 Google 账号验收**；随后已完成本文记录的 bero 真实上游修复与 anti 验证。
当前 Build 默认关闭；开启后可使用已验证的合成函数 anti 传输及客户端工具共存。Playground 既有通道和 anti 能力继续保留。下文保留初版与补测历史，当前 anti 行为以“模型身份与 anti”节为准。

## 2026-11-02 真实上游修复

随后在 bero 生产主机用同镜像、同出口、隔离账号数据进行了真实对照。初版请求的
`CodeAssistantOffline` field 14（数组下标 13）仅发送 `[2]`：任务创建成功后以
`Invalid argument.` 失败。仅补全为 AIStudio2API 临时项目调用链使用的 `[2,null,2]`，
保持模式 2、新轨迹、附件及空项目创建方式不变，Flash 和 Argon 即成功；恢复 `[2]`
再次复现失败。不需要为此增加 `metadata.json` 或 `index.html`。

同时修复无正文的状态 4 步骤识别，按任务 ID 关联失败，并持久化已终止状态，直接清理
临时项目。已确认失败不再继续轮询或尝试取消；运行中及状态未知任务保留原取消确认保护。
这也避免了初版把上游参数失败表现为 504，并因取消失败阻断项目删除和账号恢复。

修改后的原生代码通过 Pro 流式工具调用及结果回传、Free 候选 Flash 普通生成与同账号
双并发，结束后 journal 为空。Free 是现场默认权限分类，未由本次独立权益查询确认真实
订阅。以上不构成 Build anti、长附件及酒馆端到端验收；该阶段 Build anti 尚未接入，当前状态见下文。

同日后续在相同生产修复镜像下补测：Free 候选 Flash、Pro Flash、Pro Argon 各自同账号
五并发均 5/5 成功，观测到五个不同已接受任务的等待区间重叠，结束后全部删除；
Free 候选 Flash 与 Pro Argon 的非流式/流式工具往返共 8/8 成功。接入 anti 前的正式 API 带工具请求覆盖两模型、两响应模式、两开启方式，8/8 返回本地 pending 门禁错误；后续接入已取代此门禁，见下文。这些结果仅适用于本次测试账号与样本。

## 来源与许可

本次阅读的是实际源码调用链，非仅 README。2026-11-02 用 `git ls-remote origin HEAD` 核对，三个本地提交均与当时远程 HEAD 相同：

| 项目 / 提交                                                                                                           | 实际参考位置                                                                                                                           | 使用方式                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [yunx738/ais2api](https://github.com/yunx738/ais2api/tree/38f2355495466fa0534eead394b6b10e7d55de0c)                   | `dual-runtime/refactor/build-page-call.js`、`build-context.js`、`build-presets.js`、`build-response.js`、`build-applet-rotation.js`    | 直接 RPC 字段、附件及项目生命周期参考；预设匹配由其代码修改。保留 CC BY-NC 4.0，署名 yunx738；未复制双 worker、本地 token 额度及重置时间、403 重签和空任务重新生成逻辑。 |
| [qiwu622/build-standalone](https://github.com/qiwu622/build-standalone/tree/bd6f28cd0f89aa4aff898ef10ee9e6dae022bf86) | `src/sillytavern.mjs`、`tool-calling.mjs`、`build-attachment-context.mjs`、`build-thinking.mjs`、`extensions/build-standalone-adapter` | 修改 MIT 分段、聊天附件、工具协议模块；附带 0.6.0 酒馆适配器快照。署名 Build Standalone contributors。未引入整套浏览器扩展运行架构。                                     |
| [Mag1cFall/AIStudio2API](https://github.com/Mag1cFall/AIStudio2API/tree/0451f26248b7ce263a4fdbf92b280897cb79d74f)     | `internal/aistudio/tool_contract.go`、`tool_validation.go`、`assistant.go` 及编解码链路                                                | 原始工具契约与上游表达分离、Build 临时项目创建 / 取消 / 删除和任务状态字段的设计参考；MIT，署名 Mag1cFall。                                                              |

许可证副本在 `docs/licenses/`、`integrations/sillytavern-build-adapter/LICENSE`，另见根目录 `THIRD_PARTY_NOTICES.md`。本网关仍按原 CC BY-NC 4.0 许可分发。

## 请求与资源

仅 `/v1/chat/completions` 开放 Build 实验入口。其他生成协议收到 Build 模型会明确拒绝；Gemini 模型目录不发布 Build。不会自动把 PG 切到 Build 或反向回退。

OpenAI 请求先分流：

- PG 保留现有转换、原生 `functionCall`、ConnectionRegistry、流式事件与重试链路。
- Build 在 Gemini 转换前保留原始 messages 和工具字段，经过上下文打包、现有 ModelScheduler 准入，再调用同一账号 `page.__makerSuiteBridge`。
- 实际业务 RPC 为 `CreateApplet` → **一次** `CodeAssistantOffline` → `StreamCodeAssistantOfflineGeneration` → `DeleteApplet`。不是 `ProxyUnaryCall` / `ProxyStreamedCall`。
- 不创建额外 context、页面或浏览器；不导航切换 PG / Build，不使用 DOM 点击生成。两通道只在签名阶段共享 `proofTail`，输入框在签名结束后清空；网络与任务读取不持有该锁。Build 签名 hash 和输入框文本分别处理，附件不作为输入框正文填入。
- 每次请求使用临时项目并要求新轨迹，附件名称随机。请求之间复用账号、context、登录、代理和签名器；**不复用含历史的项目**。这比跨请求项目池增加项目 RPC 开销，但降低历史混入风险。不修改项目源码文件承载上下文，不常驻 Build 页面。

Build 任务返回累计快照，普通正文可以按新增后缀发布。不是逐 token 传输；响应头 `X-Build-Streaming: cumulative-task-snapshots` 标记此行为。工具请求使用 `buffered-tool-validation`，完整验证后才发调用；anti 请求使用 `buffered-anti-validation`，还原回答或校验工具后才发布。等待期间每 10 秒发送 SSE 注释心跳。`-real` / `-fake` / `-early` 都可解析，Build 统一采用上述任务快照机制，不承诺等同 PG 的逐块行为。

读取网络失败或 JSON 中断只恢复**原任务 ID**，受当前请求期限限制；绝不因空任务、缺少用量、断流或校验失败再次生成、换号或修复调用。完成取决于模型步骤状态 1，状态 2 继续等，4 报错；上游内部工具动作不能作为最终内容完成。空任务与完成但无正文分别处理。累积正文被上游改写时停止发布，避免重复拼接。

## 并发、取消与故障

继续使用“账号 × 规范模型”状态。`build/X` 与 `build-st/X` 共用 `build/X`，思考和流式别名不建立新额度；PG `X` 独立。

所有限制同时满足：全局工作槽、账号总并发、context 总并发、模型全局限制、账号模型限制、账号通道限制。新增：

| 配置                      | 默认          | 含义                                 |
| ------------------------- | ------------- | ------------------------------------ |
| `BUILD_ENABLED`           | false         | 实验 Build 开关；变更重启生效        |
| `PG_MAX_CONCURRENCY`      | 0             | 账号 PG 通道附加上限；0 为不附加限制 |
| `BUILD_MAX_CONCURRENCY`   | 1             | 账号所有 Build 模型及两前缀共享上限  |
| `PG_TOOL_CALLING_MODE`    | auto_fallback | PG 原生工具响应校验                  |
| `BUILD_TOOL_CALLING_MODE` | auto_fallback | Build 提示词工具响应校验，两前缀共用 |
| `BUILD_PRESET_MATCHING`   | false         | 可选自用预设匹配，只作用于 build/    |

这些设置接入现有受保护控制台配置及 `managed-config.json` 的保存 / 重启流程，沿用版本冲突检查。未修改运行中的生产配置。已有持久化层级白名单不会自动新增权限；开启 Build 并重启后，需在权限矩阵显式授权 `build/X`。`build-st/X` 与之共享权限。

示例：`CONTEXT_MAX_CONCURRENCY=11`、`PG_MAX_CONCURRENCY=10`、`BUILD_MAX_CONCURRENCY=1`；同时需要足够的 `GLOBAL_MAX_CONCURRENCY`、账号 / 模型上限。该组合仅通过调度模拟，**不是 Google 已允许混跑的证明**。

断连 / 超时先终止当前 fetch，再对已知任务调用 `CancelCodeAssistantOfflineGeneration`，然后删除临时项目。清理使用独立 10 秒 RPC 期限，结束前保留并发租约。失败任务记录只包含账号键、项目 / 任务 ID、完成标记，原子写入 `data/build-projects.json`（0600），不存正文 / 附件。

取消或删除未确认时，账号标记 `buildRecoveryBlocked`，释放本地请求资源但不准入该账号的新 Build 生成。后台最多恢复三次，每次间隔 5 秒，成功才解锁；失败保持可见隔离。控制台提供“恢复清理”，也可使用管理员会话 POST `/api/build/recover/:index`；它只清理 journal 中的项目，不重新生成。进程重启后，已知残留项目也必须先清理。PG 不受此标记阻塞。

账号登录失效按现有账号级失效处理。Build 配额 / 模型错误只作用于其规范模型槽。上游任务创建成功但响应在返回 ID 前丢失，无法凭空重建未知 ID；此时尝试删除已知临时项目。创建项目响应完全丢失也可能遗留未知项目。这是无幂等查询证据时的限制，需要真实环境检查残留，不宣称强保证零孤儿。

## 模型身份与 anti

目前仅登记参考代码实际列出的 `gemini-4-argon`、`gemini-3.8-flash`，以及 `low` / `medium` / `high`，默认 high。登记表示适配器认识该组合，不表示本项目已验证账号可用。

解析顺序：可选 `models/` → 最外层 `anti-` → 既有内置工具后缀 → 流式后缀 → 思考后缀 → `build/` 或 `build-st/` → 上游基础名。Build 不接受 PG 内置工具后缀。前缀位置不交换；例如 `build/anti-X`、`build/X-real-high` 会拒绝。

例：`build-st/gemini-3.8-flash-high-real`：用户别名完整保留在下游；规范额度 / 调度键 `build/gemini-3.8-flash`；上游 `gemini-3.8-flash`；通道 Build；上下文 sillytavern；思考 high；流式 real。

沿用原 `ANTI_TRUNCATION_ENABLED` / `ANTI_TRUNCATION_DEFAULT` 和请求覆盖优先级。
2026-11-02 已在 bero 接入并验证 Build 合成函数 anti，开放两个已登记模型及其思考别名：

- `anti-build/gemini-3.8-flash-high-real`、`anti-build-st/gemini-4-argon` 或 `anti_truncation:true` 开启；`ANTI_TRUNCATION_DEFAULT=prefer` 也作用于 Build。
- 请求 `anti_truncation:false` 优先于别名和全局 prefer；`ANTI_TRUNCATION_ENABLED=false` 仍可整体关闭，关闭时目录不发布 Build anti 别名。
- 每个请求生成独立、避开客户端同名函数的内部回答函数，只把它作为上游输出传输；返回前去除内部函数，保留原客户端工具契约、调用 ID 及历史关联。strict 的 required / 指定函数必须由真实客户端工具满足，不能用内部回答函数替代；none 不发布真实工具。
- anti 流式响应先缓冲再验证，头为 `X-Build-Streaming: buffered-anti-validation`、`X-Build-Anti-Truncation: synthetic-answer-v1`；等待期间仍每 10 秒心跳。没有提前发布的内部函数或未验证工具参数。
- 已收到的内部回答仅缺 JSON 结束符时，可确定性补闭合并返回 `finish_reason:length`；保留收到的正文及末尾空白。完整合法 JSON 可以带 Markdown 围栏及外层换行。不完整转义、非法协议、真实工具参数截断均明确报错，不补造字符或可执行参数。失败保留已知用量。
- 不自动续写、重提生成或换账号。RPC 断流沿用原任务 ID 继续读取；任务未完成与最终正文的 JSON 截断分别处理。自然模型语义上漏写的内容无法由传输协议补回，不承诺任意截断后都能得到完整答案。

真实验证包括两模型、两上下文协议、strict / auto_fallback、流式 / 非流式、真实工具往返、none / required / 指定函数 / legacy，以及两模型各 350 行中文、emoji、转义与代码片段。可控故障验证了闭合修复、原任务断流恢复和非法截断拒绝；这些注入故障不等同于自然触发上游输出上限。酒馆浏览器扩展仍需按下节安装，实际浏览器端到端使用尚未覆盖。

## 上下文与工具

`build/` 无需插件：完整有序 messages 打包请求专属 JSON 文本附件，直接输入只放读取、生成要求。保留名称、角色、文本分段、中间 / 末尾 system/developer、assistant 续写、工具定义与历史。无工具请求不注入工具协议。当前仅文本及工具历史；多模态、强制 JSON 输出、n>1 明确拒绝。

安全保护：请求最多 10 MiB；附件最多 8 MiB；直接输入使用 180000 字节保守预算，同时保留附件适配器的 1 MiB 外层保护；酒馆 inlineTokens 超过其 45000 估算预算会拒绝。后两者都不是 Google 所有 RPC 的绝对 token 上限。超限明确报错，不截断或挪动已标记预设。附件不扩大模型上下文，不保证模型全文读取。

200 KiB 以内的附件使用 inline-data；更大附件通过同页 `/_/upload` 可续传上传，再使用 Part field 18。上传目标只接受 `https://aistudio.google.com/_/upload...`；若 Google 返回其他官方 origin，当前明确失败，需有证据后补充允许列表。不会向任意 URL 转发内容。

可选预设管理位于控制台配置页的 Build 诊断面板，也有管理员会话接口 `/api/build/presets`。上传 JSON 后提取固定文本，以宏间字面片段匹配最终 messages；命中部分留直接输入，其余历史 / 背景放附件。支持嵌套 `{{...}}`、`<%...%>`、`<USER>` 等宏间隙；长宏背景分段进附件，字面预设不截断。未命中回完整附件。工具消息和调用元数据始终保留，不因含工具而舍弃会话。仅记录命中次数 / 时间 / 条目，不记录请求正文。匹配是启发式自用功能，插件精准分段不受它覆盖。

工具由**外部客户端执行**，网关不会执行用户命令或访问用户文件。Build 内部工作区工具与客户端函数不同；提示词要求不操作空工作区、不伪造结果，这不是技术性关闭上游工具。

新增本地工具模式初版作用于 OpenAI Chat Completions；其余 PG 协议维持既有工具行为，Build 其余协议不开放。PG 使用原生函数结构，Build 使用声明 / JSON 输出提示词再解析，两者共用最终契约验证器（Ajv draft-07、本地引用，不加载远程 schema）：

- `auto_fallback`：在需兼容的工具路径把 required / 指定函数按 auto 发送；允许正文。只发布 JSON 可解析、参数对象、函数属于本轮允许集且 ID 合法的调用；none 不发布调用。无需完整 schema，也不要求满足原强制选择。
- `strict`：保留原始客户端契约，验证函数、参数 schema、required / 指定函数、none、parallel_tool_calls:false 及历史 ID / 结果关系。历史同名且本轮提供 schema 时也校验。缺少历史 schema 时只做结构与关联检查，不臆造旧契约。违反要求返回错误，不自动修复、重试或换号。严格验证不赋予上游原生强制调用能力。
- 普通正文在 auto 中成功；明显带损坏 `tool_calls` / `arguments` / `function_call` 标记的 JSON 或 function_calls 协议块报 502；无法完整识别的调用不作为工具发布。
- 现代 tools 与旧 functions 分别归一化，不混用；旧请求返回 function_call 形状。所有工具流在检查后才发送可执行字段。PG 原生工具请求也缓冲最终结果；普通 PG 文本继续原有流式能力。

## 酒馆安装与请求例子

附带快照 `integrations/sillytavern-build-adapter/`，来源版本 0.6.0。复制到 SillyTavern 的第三方扩展目录（例如 `public/scripts/extensions/third-party/aistudio-build-adapter`），刷新并在扩展面板启用。本网关附带版本识别 `build-st/` 与 `anti-build-st/`，不会拦截普通 `build/`；custom 连接或 OpenAI reverse_proxy 均有源码分支，沿用用户配置的服务地址与凭据。

实际线协议前缀为 `BUILD_ST_CONTEXT_V1\n`，内部 `version` 可以是 1 或 2；v2 保留 messageMetadata、contentNull、tool_calls、tool_call_id、function_call。normal / regenerate / swipe / continue / quiet / impersonate 均按封装执行。缺少扩展、损坏、主动 error 或不支持版本明确拒绝。不会对 build-st 自动完整附件降级或猜测分段。扩展 custom_include_body 中保留工具字段；与其他自定义 body 覆盖冲突时主动失败。

此安装路径与服务器地址支持经过源码及适配器模拟测试；**尚未在真实新版酒馆浏览器中端到端验证**。使用 `anti-build-st/` 时需复制当前附带适配器并刷新酒馆；服务端 v1/v2 封装已做真实生成验证。

免插件调用：

```sh
curl http://localhost:7860/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_API_KEY' -H 'Content-Type: application/json' \
  -d '{"model":"build/gemini-3.8-flash-high-real","stream":true,"messages":[{"role":"system","content":"请使用中文"},{"role":"user","content":"解释这段代码"}]}'
```

酒馆选择 `build-st/gemini-4-argon-medium`，由扩展封装请求。普通客户端应改用 build/；不要自行启发式分割 messages。

工具例子（`PG_TOOL_CALLING_MODE=strict` 或 `BUILD_TOOL_CALLING_MODE=strict` 在控制台保存并由管理员按需重启后生效）：

```json
{
  "model": "build/gemini-3.8-flash",
  "messages": [{ "role": "user", "content": "查询北京天气" }],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "weather",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"],
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": { "type": "function", "function": { "name": "weather" } },
  "parallel_tool_calls": false
}
```

客户端执行返回的工具后，将 assistant.tool_calls 和匹配 tool_call_id 的 tool 结果完整追加，再发下一轮。本网关不生成工具执行结果。使用默认 auto_fallback 时，即使上例指定函数，上游仍可能返回正常正文；strict 则会把未调用指定函数视为校验失败。

anti 示例：PG `anti-gemini-3.8-flash-high-real` 保持既有行为；Build 可使用 `anti-build/gemini-3.8-flash-high-real`，或在普通 `build/` 请求里设置 `anti_truncation:true`。

## 用量、诊断与最小真实验收

模型 / 通道额度未知显示未知，没有复制参考仓库的本地预算或北京时间重置规则。Build 已完成快照提供已知 usage 字段时转换并保留；没有 usage 时返回 `null`。校验失败仍保留已知消耗。用量 SQLite 兼容增加可空 `usage_json`，旧行仍未知，详情、导出、重启后保持；每个请求只记一次，恢复读取不增加生成尝试。控制台显示输入 / 输出 token，缺失为未知。

离线检查记录见本文件后续验证记录。没有写入生产账号、额度、重启或部署。真实验收建议在隔离环境 / 临时授权账号进行：

1. 单次普通 PG 回归，再分别调用两种 Build 模型和 low / medium / high。核对临时项目创建、唯一生成、完成状态与删除，不包含 Proxy* 代理。
2. 逐步到同页面 PG 10 + Build 1；观察签名串行、网络并行、PG 延迟、内存、429 / 风控与取消，不以调度模拟通过替代上游验收。
3. 短附件、跨 200 KiB 上传、接近 8 MiB 长附件，设置头 / 中 / 尾哨兵与末尾 developer；比较完整附件和命中预设效果，验证全文读取范围并记录实际上传 origin。
4. 新版酒馆安装 0.6.0 快照，custom 与 OpenAI reverse_proxy 分别运行 v1 / v2；检查所有生成类型、消息名称、分段位置、工具字段及超预算主动失败。
5. 两模式做真实工具往返：正文、合法调用、非法参数、指定函数、required、none、多调用和 legacy。验证 strict 工具片段不会提前发布，失败消耗仍在。
6. 断流恢复只读同任务；在任务接受后、读取时、完成后分别取消，验证 Google 取消确认与临时项目清理、隔离恢复、PG 可用性。
7. Build anti 已开放，后续回归继续覆盖全文合成函数、长正文 / 转义 / 代码块 / 不完整参数、工具共存 / 同名冲突、两上下文模式、两工具模式、none / required / 指定函数、流式 / 非流式，并针对真实截断场景区分任务未完成、生成截断和传输断流。继续记录生成次数、取消及用量；区分自然生成截断、可控故障注入和传输断流，不能将一次短文本解包视为全场景保证。

## 初版实际检查记录（历史）

- `npm test`：全量运行 **793 通过、47 跳过、0 失败**（840 项）。47 项为未设置 `ACCOUNT_LOGIN_BROWSER_TEST_EXECUTABLE` 的可选账号登录浏览器用例；不是 Google 账号验收。
- 全量回归之后补充了预设原始文本分段、已禁用工具定义保留、清理状态持久化与 PG 校验失败用量等检查；对最终相关代码执行 `node --test tests/build-channel.test.js tests/anti-truncation.test.js tests/playground-capabilities.test.js tests/makersuite-bridge.test.js`：**90 / 90 通过**。含当前 Build 专项 31 项，均使用本地脱敏 / 人工 fixture 与模拟上游。
- `npm run build:ui`：管理控制台和公示前端均构建成功。配置页面实际浏览器回归通过；新增诊断折叠面板对应更新了原配置待重启状态的测试选择器。
- 变更 JavaScript / Vue / 随附适配器的定向 ESLint 通过；`git diff --check` 通过。
- `npm run lint:js` 全仓检查仍被 **6 份原有 JSON fixture 的 1721 项格式 / 键序问题**阻塞：`docs/zh/fixtures/bero-flash38-tool-choice*.json`（4 份）、`context-spread-benchmark-20261024.json` 和 `tests/fixtures/mixed-zero-capacity.json`。这些文件本次没有修改，未扩大范围进行批量格式化。
- 未部署、重启服务、修改生产账号或额度。真实 Google 混跑、长附件效果、新版酒馆浏览器接入、真实工具往返及 Build anti 目标截断场景均未验收；能力开放状态见上文。
