# MakerSuite 大规模 401：页面 API Key 与工具回放修复方案

状态：已完成本地代码实现，测试及提交状态见第 7 节。真实 Google 调用与生产复测由用户部署后进行。第 1–6 节保留修复依据和设计。

## 1. 背景、范围与版本依据

用户反馈：此前遇到过大规模 401。当前项目已经实现上一轮 GenerateContent 桥接，但仍采用旧的页面内部属性读取认证信息。参考仓库随后发布了直接针对“重启后 401”的修复。

本方案只针对该修复提交及其在本项目中的适配：

- 参考提交：[`e1340636af3ac37df72ddbfacaf46bafddca427d`](https://github.com/yunx738/ais2api/commit/e1340636af3ac37df72ddbfacaf46bafddca427d)。
- 参考提交时间：2026-10-17 07:04:20 +08:00；版本和时间以 Git 提交记录为准，不将用户所说的“昨天”擅自换算为故障日期。
- 参考本地仓库：`/home/dev/workspace/projects/AIStudioToAPI/ais2api`，当前 HEAD 为 `6ab0683fffd1e460050c0689c3fa943f0eb67556`。
- 本项目核对基线：`8a137ca67b458bb8abb3634e8580dbc4181a0235`（`400报错`）；编写前工作区干净。
- 参考实现文件：`dual-runtime/code/unified-server.runtime.js`。目标提交只修改此文件，新增 53 行、删除 15 行。
- 前置方案：[GenerateContent 协议修复记录](makersuite-generate-content-protocol-repair-plan-20261016.md)。本方案在现有桥接上增量修复，不覆盖上一轮生命周期和取消处理。

用户已自行建好 Build App。本次不涉及应用创建、共享、链接切换或 `6ab0683` 的建站文档变更。此前用户提供的原作者使用许可继续适用，移植保留来源、提交号及现有许可证说明。

证据边界：参考作者将该提交描述为修复重启后 401；本项目源码确实仍存在其替换掉的认证读取方式，因此这是本次优先修复项。但尚未核对用户故障期间的响应详情，不能据此断言全部历史 401 都不是 Cookie 或会话过期。

## 2. 为什么当前实现仍可能出现批量 401

当前 `src/core/MakerSuiteBridge.js` 从捕获到的页面服务对象读取：

```js
const metadata = tb.getMetadata();
const mb = tb.mb;

// 当前实现
const base = mb.F;
const key = mb.jK;
const authuser = String(mb.Ml);
```

这些属性是页面混淆实现细节。旧代码将其中某个字段直接当作生成接口的 API Key，没有验证其服务用途。参考更新明确区分“页面 MakerSuite API Key”和另一类令牌服务使用的 Key，转为从页面实际请求中学习前者。

故障链路可能是：重启或页面版本变化 → 旧属性不再提供正确的生成服务 Key / 认证上下文 → 多个账号共同使用错误取值 → GenerateContent 401 → 调度器将账号视为故障并继续换号 → 故障影响扩大。

这里“重启或页面变化导致错误取值”是基于参考修复的推断，不是对用户历史日志的独立复现。

本项目调度器还有以下已核对的放大路径：

- `ModelScheduler.classifyError()` 将 HTTP 401 分类为 `account`。
- `failure()` 对该分类设置 `account.healthy = false`。
- 满足 `UNAUTHENTICATED` 条件时，会调用 `authSource.markAsExpired()`；已有 sessionVersion 检查用于防止旧会话错误影响新会话，必须保留。

因此不能用“重新登录所有账号”或无限轮换账号替代认证取值修复；也不能反过来一律忽略 401，掩盖真实失效会话。

## 3. 参考提交的具体变化

### 3.1 学习页面实际使用的 API Key

参考实现增加 context 的 `request` 监听器，只观察目标 MakerSuite 服务请求：

```text
https://alkalimakersuite-pa.clients6.google.com/$rpc/...MakerSuiteService/...
```

从这些请求的 `x-goog-api-key` 头取得候选 Key，排除参考代码指定的另一类服务 Key，然后将学习结果传入页面内 `__gcCall(body, ht, key)`。

页面侧的备用路径：从 `tb.getMetadata()['X-Goog-Api-Key']` 取得需要排除的值，再遍历 `tb.mb` 中符合 `AIza...` 形状且与排除值不同的字符串。找不到候选时返回 503，消息为 `page api key not found`，不再盲目使用 `mb.jK`。

注意：上述 metadata Key 在此处是排除依据，不应直接当作生成服务 Key。参考代码的前缀或正则只检查字符串形状，不能证明 Key 有效或用途正确。本方案不抄录具体 Key，也不将它写入用户配置、日志或数据库。

### 3.2 固定服务地址，改用 metadata 的账号索引

| 项目              | 当前项目                   | 参考更新                                          |
| ----------------- | -------------------------- | ------------------------------------------------- |
| 服务地址          | `tb.mb.F`                  | `https://alkalimakersuite-pa.clients6.google.com` |
| 生成服务 API Key  | `tb.mb.jK`                 | 观察页面请求所得 Key；扫描内部对象作为备用        |
| `x-goog-authuser` | `String(tb.mb.Ml)`         | `metadata['X-Goog-AuthUser']`，缺省 `'0'`         |
| `authorization`   | `metadata.Authorization`   | 仍从 metadata 获取                                |
| Cookie            | `credentials: 'include'`   | 保留                                              |
| 请求令牌          | `M.Cn(tb, await M.GB(ht))` | 保留                                              |

`authuser` 缺省值 `'0'` 是参考实现的兼容行为，不能覆盖页面实际给出的其他索引。不得混用账号 A 的 Key / metadata 与账号 B 的 Cookie 或令牌对象。

### 3.3 无签名函数调用使用新的回放标记

参考 `toPart()` 增加：函数调用 Part 缺少签名且无文本时，在 `[14]` 写入：

```text
skip_thought_signature_validator
```

已有真实 `thoughtSignature / thought_signature` 时优先保留。该值是参考项目使用的特殊回放标记，不是真实签名；不要给普通文本、媒体或 functionResponse 添加它，也不能覆盖模型实际返回的签名。

### 3.4 令牌输入字符串保留空项

`ht` 拼接移除了 `.filter(x => x)`。文本 / 媒体之外的 Part 仍贡献空字符串及其对应空格：

```text
Part 序列：文本 "A"、函数调用、文本 "B"
旧 ht："A B"
新 ht："A  B"
```

当前 `MakerSuiteCodec.buildBody()` 仍使用 `.filter(Boolean)`，需要同步移除。空文本、多次工具调用、函数返回和混合媒体都应有精确预期值，不能额外 trim 或合并连续空格。

### 3.5 OpenAI 工具调用转换

参考提交还补齐其自身的工具链路：

- 输入的 `tools / functions` → Gemini `functionDeclarations`。
- assistant 历史 `tool_calls` → Gemini `functionCall`。
- `tool / function` 消息 → Gemini `functionResponse`，通过 `tool_call_id` 找回函数名，并合并连续工具结果。
- Gemini `functionCall` → 非流式 `message.tool_calls` 或流式 `delta.tool_calls`，对应结束原因使用 `tool_calls`。
- 无文本的工具响应不再把 `undefined` 拼入正文。

本项目已有这些主要能力，应检查和测试现有路径，不能整段替换成参考仓库的简化转换器。参考提交没有提供新的 toolConfig、结构化输出或实时流映射；不能据此宣称上一轮未支持的能力已经补齐。

## 4. 本项目的增量实施方案

### 4.1 API Key 获取、优先级与失效

修改 `MakerSuiteBridge`，由每个桥接实例保存自己的观察结果：

1. 在首次导航前安装 context 请求监听器，限定 HTTPS、精确 hostname、MakerSuite RPC 路径及当前桥接对应的页面来源。用 URL 解析验证来源，不只用容易误匹配的宽泛正则。
2. 优先学习页面原生 MakerSuite 请求携带的 Key。排除已知其他服务 Key，并处理 metadata 排除值先后到达的情况。
3. **排除桥接自己发出的 GenerateContent 请求**，避免将错误候选反复观察成“页面已确认 Key”。通过桥接活动调用或请求来源追踪识别，不向上游新增调试头。
4. 必要时采用参考的内部对象扫描，但仅作为备用候选：排除其他服务 Key，区分唯一候选、多个候选和没有候选。候选不唯一时等待页面观测或返回明确的未就绪错误，不随意取第一个属性。
5. 将候选、来源和页面版本关联；生成请求执行时使用当前页面同一认证上下文。只缓存 Key 的必要状态，不缓存长期 Authorization。
6. 主框架导航、reload、context 重建或销毁时清空观察结果，解绑旧监听器。迟到的旧导航请求不能更新新页面状态。
7. 观察优先级高于扫描备用；若已学习值后来被确认属于排除服务，则使其失效，不能继续生成。

参考代码存在 `global.__gcbPage`。本项目已有多账号、多 context 和 browser generation 隔离，**不移植这个全局页面引用或跨账号共享 Key**。

就绪必须同时包含页面模块、令牌服务对象、可用页面 Key 和可读取的认证 metadata。未就绪时在既有 deadline 内有界等待；期限到达返回可诊断的本地 503，不发送缺失或明显错误认证的上游生成请求。

### 4.2 HTTP 401 与账号健康分类

保持上游真实状态和错误详情，不把所有 401 改成 503。明确在发出请求之前发现的本地 Key 未就绪、候选冲突或协议取值错误，应使用本地桥接错误分类，不能进入凭据过期处理。

实现时需验证错误分类能够穿过旧 RPC 包装、页面解包、Build 脚本及服务端错误规范化。不能只在页面返回对象上加一个字段，就假设调度器能收到它。

对已经收到的 401：

- 记录 Key 来源、页面版本、metadata 是否可用及 HTTP 状态等非敏感诊断信息。
- 检查当前调用是否使用了过期、已排除或扫描备用候选；此类证据支持认证适配问题，不能仅凭这次结果将所有账号持久标为过期。
- 当证据不足以区分 API Key 与会话问题时，保留失败状态，进入有界的认证诊断；只有通过现有会话验证路径确认失效后，才按真实会话故障处理。必须避免“诊断中”无限占用租约或反复发生成请求。
- 保留真实登录失效处理、sessionVersion 保护和已有执行结算规则。不通过批量清空健康状态或重置额度掩盖问题。
- 不在已发送的生成请求后无条件重放；若设计重新学习 Key 后重试，需要明确安全重试依据、次数上限和取消行为。

修复后的历史故障账号是否需要恢复，先检查当前持久状态与正常会话验证结果，再使用现有恢复入口处理。本轮文档不授权盲目批量改写过期标记、账号健康或额度数据。

### 4.3 签名在各适配层的处理

当前 `FormatConverter.DUMMY_THOUGHT_SIGNATURE` 为：

```text
context_engineering_is_the_way_to_go
```

`ensureThoughtSignature()`、OpenAI Chat、Anthropic 和 Responses 的输入转换等路径可能预先插入该值。因此只在 `MakerSuiteCodec` 中对“没有签名”补新标记，会遗漏这些已经填了旧占位值的请求。

建议在 MakerSuite 编码边界统一处理：

- 原始真实签名原样编码到 `[14]`。
- 无真实签名的函数调用，包括明确由本项目生成的旧占位值，使用参考的新回放标记。
- 对无法确认来源的非空签名不做任意替换。
- 对同一内容中的多个函数调用逐个检查；兼容历史上只给第一个调用补占位值的情况。
- 保留函数调用 id、参数、响应 id 关联及签名独立尾块的已有合并处理。
- 如果要修改通用转换器的常量，必须先确认它是否影响其他协议和非 MakerSuite 用途，避免无关回归。

### 4.4 文件改动范围

| 文件                                        | 计划改动                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/core/MakerSuiteBridge.js`              | 观察 Key、筛选来源、metadata authuser、固定服务地址、完整就绪条件、缓存失效和监听器清理 |
| `src/core/MakerSuiteCodec.js`               | 无真实签名函数调用的回放标记、ht 空项保留                                               |
| `src/core/FormatConverter.js`               | 优先复用现有工具链路；仅在边界处理无法覆盖时调整占位或转换行为                          |
| `src/core/ModelScheduler.js` 及错误传递路径 | 区分已确认的本地桥接认证失败与真实会话失效；保留状态、结算和版本隔离                    |
| `tests/makersuite-bridge.test.js`           | Key 获取、认证头、观察来源、重启/重载及账号隔离回归                                     |
| `tests/makersuite-codec.test.js`            | ht 精确值、旧占位与真实签名、多工具调用                                                 |
| `tests/makersuite-browser.test.js`          | 模拟混淆属性变更和错误 Key 的真实 Firefox 验证                                          |
| 调度器 / 多协议现有测试                     | 401 分类、凭据过期副作用及完整工具往返                                                  |

不要覆盖既有 AbortController、fetch / XHR 取消关联、主框架导航隔离、有限等待、错误尾块检查、多候选响应和 unknown usage 语义。继续保留当前流式缓冲限制，实时传输属于另外的工作范围。

## 5. 验证与验收

### 5.1 离线协议与生命周期测试

- 页面实际请求提供正确 Key，同时 `mb.jK` 故意错误或不存在：生成使用学习到的值。
- metadata 提供其他服务 Key：不会误将其作为生成 Key；监听器也不会学习排除值。
- 页面原生请求尚未出现：唯一扫描候选可作为备用；没有或多个候选时有界失败，零上游生成调用。
- 自身桥接请求不能污染学习结果；非目标域、相似域名、错误路径及其他账号/页面请求不能更新缓存。
- 页面请求的真实 authuser 非零时正确传递；缺省 `'0'` 和缺少 Authorization 的行为有明确测试。
- reload、context 重建、两个账号并发、旧页面迟到事件、安装中取消和销毁后，缓存及监听器均符合所有权。
- `ht` 的空文本、前后空项、连续函数调用、函数结果和混合媒体拼接值逐字符断言。
- 无签名、旧占位、新回放标记、真实签名、snake_case 签名和多个函数调用分别断言；functionResponse 不加签名。
- 400 / 401 / 403 / 429、HTTP 200 内错误、取消及 deadline 的原有传播不回归。

### 5.2 调度与多协议回归

- 本地 Key 未就绪不触发 `account.healthy = false` 或 `markAsExpired()`。
- 有明确 Key 适配失败证据的错误，不造成跨账号连锁失效；错误分类必须通过实际中间转换链验证。
- 经会话验证确认失效的账号仍能按现有机制标记过期；旧 sessionVersion 结果不得影响新会话。
- OpenAI 非流式 / 流式工具响应保留名称、JSON 参数、id、tool_calls 结束原因；正文无 `undefined`。
- assistant tool_calls → 多个 tool 结果 → 再生成的完整往返正确，包括无正文工具调用。
- Anthropic、Gemini native、Responses 以及 AUTO 反截断路径分别检查签名与函数结果编码。
- 不将本提交没有适配的非 AUTO toolConfig、内置工具、结构化 schema 或实时增量流记为新增支持。

先运行定向 codec / bridge / scheduler 测试，再运行 `npm test`、改动 JS 的 ESLint、格式检查和 `git diff --check`。

### 5.3 真实 Firefox 本地测试

现有 fixture 仍固定提供 `mb.F / mb.jK / mb.Ml`，只能证明旧属性在理想情况下可用，不能覆盖本次问题。更新测试至少模拟：

1. 页面原生 MakerSuite 请求携带正确 Key；内部旧属性指向错误 Key 或其他服务。
2. 假上游仅接受正确 Key + metadata authuser；错误值返回 401。
3. 重载及重新创建浏览器 context 后重新学习 Key，再次成功，不依赖进程全局缓存。
4. fetch / XHR 取消、跨域预检、并发账号、监听器销毁和 Key 不外泄均通过。

固定 Google 服务地址在测试中通过受控网络拦截映射到本地 fixture，不为生产开放任意上游地址配置。用 `npm run test:protocol:browser` 运行；该测试不能替代真实 Google 验收。

### 5.4 受控真实上游验收

使用用户已建好的 Build App，不创建新应用或修改共享设置。覆盖：

- 冷启动后首次生成、页面 reload 后首次生成、context 重建及服务重启后的首次生成。
- 不同账号与可用模型的少量调用，检查 401 是否消失及是否重新学习 Key。
- OpenAI 和 Gemini native 的普通生成，以及至少一轮函数调用 → 工具结果 → 第二次生成。
- 若具备相应环境，检查 Anthropic、Responses 和反截断 AUTO 路径。
- 验证正常账号未被批量标为不健康或过期；确认失效账号仍正确拒绝。

验收记录模型、客户端协议、是否冷启动、Key 来源类型、状态与时间；不保存 Key、Cookie、Authorization、请求令牌、提示词或回答正文。

## 6. 实施顺序与发布要求

1. 先完成认证来源、完整就绪状态、页面版本隔离与对应失败分类，消除已知错误认证取值。
2. 再同步 ht 空项与函数回放签名，核对多协议已有工具能力。
3. 完成离线、Firefox 本地和受控真实请求验证，回填实际支持范围与结果。
4. 发布前保留代码、配置与必要状态备份；按现有流程控制派发和在途请求，再用少量账号验证。
5. 如果出现持续 401 或健康账号连锁失效，停止扩大流量并保留诊断证据。回退旧代码不保证 401 恢复；不要循环重启或批量重新登录来掩盖协议问题。

## 7. 实施记录

### 7.1 已实现

- `MakerSuiteBridge` 在页面主执行环境观察原生 fetch / XHR 的目标 MakerSuite 请求头；只接受固定 HTTPS origin 和 RPC 路径。Key 按页面 realm 隔离，不跨账号、导航或重建复用。
- context 的 request 监听器只确认当前页面 realm 已观察到的 Key，不将旧文档请求的 Key 注入新文档。新上游调用使用注入时捕获的 nativeFetch，绕过学习入口；context 监听也排除 GenerateContent，避免将桥接自己的错误候选学成页面依据。
- 优先使用页面观测，内部对象只有一个未排除候选时才作为备用。已知令牌服务 Key 和 metadata 指出的其他服务 Key 被排除，后到达的排除信息立即作用于候选；已确认排除的 Key 在当前文档生命周期内保持排除。
- 不再用 `mb.F / mb.jK / mb.Ml` 发生成请求。上游地址固定为参考服务，Authorization 每次读取，authuser 取 metadata，缺省 `'0'`。
- 模块、令牌对象、页面 Key、Authorization 不完整时有界等待并返回本地 503；不发送生成请求。
- 上游 HTTP 401 或响应内的 UNAUTHENTICATED Status 均保留 401。当前使用的 Key 会失效，只有新的原生页面观测才能重新建立相同 Key 的依据；本次请求不自动重放。
- 401 后做最长 2 秒的登录页诊断，实际页面 title 查询限时 1.5 秒，复用已有登录 URL / 标题判断。诊断不创建额外浏览器、不发生成探测、不直接改凭据。正常页、检查失败或超时均为未确认；明确登录页证据才视为会话过期。
- 新增 `src/utils/MakerSuiteAuth.js`。通过 RPC Status 消息中的稳定标记传递诊断结论，避免依赖旧 Build 客户端会丢弃的自定义字段：`key_unavailable`、`unverified`、`session_expired`。
- 调度器将前两类记为 `bridge_auth`，保留失败统计和 HTTP 状态，但不禁用账号、不标凭据过期；调度和 legacy 路径均停止对这类错误自动重试、换号。确认过期的标记仍走已有过期流程及 sessionVersion 保护。非桥接错误保持原有行为。
- 编码边界将缺失签名或本项目旧占位值转为 `skip_thought_signature_validator`，保留真实签名；原生 snake_case 签名不会被 ensureThoughtSignature 覆盖。ht 拼接保留空项。
- 复用现有多协议转换器，修复 Chat 工具结果省略 name 时的函数名查找，保留调用与结果 id，支持 legacy function 结果和标量结果的 Struct 包装。未改动全局占位常量，也未新增其他协议能力声明。
- 保留原有取消、deadline、响应尾块检查、多候选、未知 usage 和流式缓冲语义。README 中英文均已补充认证修复行为。

### 7.2 验证结果

执行环境为本地 Node 22.23.2 与 Playwright Firefox 148.0.2（firefox-1511）。提交前最终结果：

- 定向协议 / 错误链路：`node --test tests/makersuite-auth.test.js tests/makersuite-codec.test.js tests/makersuite-bridge.test.js`，37 项通过，0 失败。
- 现有调度器测试：`node tests/model-scheduler.test.js`，49 项通过，0 失败。
- 完整回归：`npm test`，378 项通过、32 项按原有条件跳过，0 失败。
- Firefox：`npm run test:protocol:browser`，1 项通过，0 失败。
- 改动 JS 的 ESLint、所有改动文件的 Prettier 和 `git diff --check` 均通过。

错误链路测试通过实际 `scripts/client/build.js` 的 RequestProcessor、错误 WebSocket 序列化、服务端规范化与调度器验证分类，不只检查页面返回的附加字段。其中 Google 页面 RPC → REST 适配使用代表性 fixture；Google 实际解包行为仍需生产复测确认。

Firefox fixture 故意提供错误的旧混淆属性，只允许页面原生请求携带的正确 Key 与非零 authuser 成功。覆盖 reload、新 context 冷启动、401 后零自动重放、已拒绝 Key 不复用、fetch / XHR 取消；上游固定 Google 域名通过 Playwright 拦截模拟，未联系 Google。

### 7.3 生产复测建议

用户已明确由其在生产环境复测。推送后重点检查：

1. 重启服务后首次调用、多个账号 / 模型普通生成、页面刷新及 context 重建后首次调用。
2. 401 日志的 `authentication state`、`key_source` 与 `page_epoch`；正常记录不包含 Key、Authorization、Cookie 或正文。
3. `key_unavailable` 503 不应对应新的上游生成；`unverified` 401 不应触发自动换号重放或批量标记凭据过期。
4. OpenAI 工具调用 → 不带 name 的 tool 结果 → 第二次生成，检查函数名、id 和签名回放。
5. 已确认失效账号仍应触发正常恢复流程，旧 sessionVersion 的迟到响应不得影响重新登录后的会话。

本次未核对历史生产 401 日志，未执行真实 Google 调用，未部署服务，也未批量恢复此前标记失效的账号。历史账号状态如需恢复，应通过现有会话验证和恢复入口处理，不直接清库或重置额度。

### 7.4 提交与推送

本修复按用户授权完成测试后提交并推送到 `origin/main`；实际提交号以 Git 历史和完成回复为准。生产部署与真实 Google 复测由用户后续执行。
