# 双通道兼容修复实施记录

日期：2026-10-17（Asia/Shanghai）。运行代码已部署至 bero，完成实际 Camoufox、Google Argon 与 NewAPI 内网验收；生产中发现并修复 RPC 请求关联问题，详见文末生产补充。

## 基线与范围

- 实际开发基线：`f73f26a4d5b815cfa3bbf19d0d17bf6f85276fe7`，开始时工作树干净，`main` 领先远端 4 个提交；保留这些已有提交。
- 开发分支：`feature/model-transport-routing`。
- 选择性恢复归档 `1dc1e306907d6a91a0ba28e561bfce04af88b78f` 的 MakerSuiteBridge、MakerSuiteCodec、MakerSuiteAuth 和四组测试，保留原授权与来源说明。没有整体合并归档或替换 BrowserManager / RequestHandler。
- 参考项目实际 HEAD：`914bc256b3c18f3e1b8ce33b12f3724e09bf18ef`，与方案中的对照版本一致；本次没有修改该项目。
- 未启动本项目服务或生产实例，未修改 Cookie、账号数据库、已保存 Build App、NewAPI 渠道或生产配置，未 commit / push。

## 实现

`ModelTransportPolicy` 统一精确模型路由和能力快照。默认 3.7 与其他模型使用 legacy，Argon 使用 makersuite。`MODEL_TRANSPORT_POLICY` 同时接入环境加载、配置校验、管理界面、持久化和重启生效；拒绝通配、指令后缀、原型键及未知传输。请求沿用接收时的配置快照，后续 attempt 不改变传输，不执行自动跨通道回退。

浏览器宿主页只安装一个生成 RPC 分派 route。legacy 沿用原始 URL、正文、认证与 WAA，并继续支持已授权的权益补头。makerSuite 分派只接受精确 Google origin、RPC pathname、POST、主 frame 及生成路径；模型目录、文件、embedding 和 countTokens 不进入桥接。桥接为转换后的载荷生成新 WAA，GenerateContent 使用当前页面真实认证与 tier/ext，且不从自产请求学习认证。客户端 Key 的排除属于当前调用，不能污染其他请求。

每个桥接请求在发送前登记 request/attempt、策略、页面 epoch 和单调 deadline。请求关联标记放入本地桥接专用的 JSON 字段 `__aistudio_attempt`，在转换 GenerateContent 前校验并移除；仍兼容 query 中保留该标记的客户端。生产证明 Google 宿主页会丢弃自定义 URL query，不能仅依赖 query 关联。转发只修改 wire 副本，重试与抗截断的原始请求体不变。legacy RPC 上的本地取消标记在出站前移除。此兼容方式不要求编辑用户已保存的 App；新版脚本另通过内部 WebSocket 握手报告 `transportVersion=1`，识别策略和剩余预算。

Argon 保留 verified account + 当前页面 paid 的双重资格检查。unknown 只做预检，认证和权益失败受控返回。未确认的桥接认证错误不轮换或禁用账号；确认登录过期仍受 sessionVersion 保护。桥接 403/RPC 7 按模型资格处理；429 保留原错误与既有冷却，不清额度，不改 3.7 历史统计，也不推定 Argon 日额度。

四类入口保留 JSON/SSE 意图，桥接 real 请求走 unary 缓冲；Chat early 保留提前响应与心跳，其他入口保留当前已有的缓冲 SSE 行为。统一缓冲 deadline 覆盖桥接认证、WAA、fetch、正文读取和响应消息队列等待，后续 attempt 不重新起算。默认预算 300000 ms，桥接最多 295000 ms，并扣除已消耗时间和结算余量。心跳与收到的正文块均不续期。超过 300000 ms 的缓冲环境配置明确报不支持，管理配置同样拒绝越界值。

取消会终止对应页面 AbortController、原始 RPC 和 reader。证明生成挂起也会退出桥接等待并清除记录，不会在迟到的 proof 完成后发起生成。导航、context/session 替换和关闭使旧状态失效；页面 document ID 在执行前再次核对，防止旧请求在新文档生成。调度器释放租约前等待取消结算，Playwright 清理等待上限 2 秒，超限记录受控日志。

编解码继续拒绝未知或未支持字段，不静默删除参数。补齐当前转换器中 tool call ID 到函数名的关联，保留工具结果标量包装与真实 snake_case 思考签名。没有迁移账号等级 UI、额度估算、双槽协调器或保活策略，也没有新增静态“可用模型”。

## 验证

- `npm test`：最终结果见下方验收统计；包含新增策略、客户端、认证、编解码和桥接测试及既有 request / scheduler / browser 回归。
- 四入口 JSON/SSE 的可控时钟测试：全局 real / `-real` 进入缓冲，59、61、90 秒仍等待并在预算内输出，只有一次派发，队列与租约清理完成。
- 浏览器客户端测试：旧模式保留五分钟保护；非法预算拒绝；正文持续到达不能延长总 deadline；超时返回 504 并取消 reader 与 fetch。
- 本地真实 TLS/CONNECT：Firefox 148.0.2，Playwright 1.59.1。检查实际出站 URL、body、认证、Cookie、权益和新 proof；3.7 保留原始 streamed RPC；Argon 实际出站 GenerateContent；超时与主动取消观察到 TLS 上游连接关闭；文档重建后重新调用成功。
- 真实长等待 fixture：`npm run test:transport:long`，GenerateContent 在 61 秒后返回正文，处于 75 秒外层预算内。常规浏览器命令跳过此长用例，单独的长命令必须通过，不能用跳过代替。
- TLS fixture 只允许两个预设主机的 CONNECT，并将其映射到回环 TLS 服务；其他目标（包括生产 9998）拒绝。不使用 Google 或生产账号。
- `npm run build:ui`：管理界面与公示页构建通过。
- 改动 JS/Vue ESLint、Prettier（忽略无 parser 的 `.env.example`）与 `git diff --check`：最终结果见验收统计。

## 本地实施阶段记录的发布门槛（本次生产验收已补充）

当前环境未找到 Camoufox 可执行文件，因此没有声称生产 Camoufox 已通过。TLS fixture 支持 `BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH=/path/to/camoufox`；使用与 BrowserManager 一致的 `goto(..., { waitUntil: "domcontentloaded" })` 重建文档。生产版本的 realm、取消和长等待仍须用实际可执行文件验证，不能用标准 Firefox 结果替代。

阶段 D 需要另行部署/切换授权。本次没有读取或切换活跃生产实例，没有真实账号生成验收或 NewAPI 网络验收，没有真实双账号并发结论。将来验收前须重新读取最新活跃实例与数据状态，先备份并停止共享 Cookie 的参考实例，确认浏览器关闭，再按修复方案执行最小范围验收。

离线 fixture 不证明 Google 长期保持模块名或位置协议，也不证明目标账号当前有生成额度。桥接不支持的功能明确返回错误，不能因为恢复 codec 就宣称所有 Gemini 参数均可用。

## 最终验收统计

| 检查                                                                                                                      | 实际结果                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                                                                | 退出码 0；TAP 汇总 465 项，433 通过、0 失败、0 取消、32 条件跳过；跳过来自未设置 `ACCOUNT_LOGIN_BROWSER_TEST_EXECUTABLE` 的既有可选登录浏览器测试 |
| `node --test tests/makersuite-browser.test.js tests/makersuite-transport-browser.test.js tests/makersuite-bridge.test.js` | 24 通过、0 失败、1 条件跳过（61 秒用例另行执行）                                                                                                  |
| `npm run test:transport:long`                                                                                             | 2 通过、0 失败、0 跳过；真实 TLS GenerateContent 等待 **61027 ms**，包含新 proof、权益、原始 legacy query 编码与取消回归                          |
| `npm run build:ui`                                                                                                        | 管理界面和公示页构建通过；仅有已有的 Vite CJS / bundle 大小提示                                                                                   |
| 改动 `.js` / `.vue` ESLint                                                                                                | 通过                                                                                                                                              |
| 改动文件 Prettier，使用 `--ignore-unknown`                                                                                | 通过；`.env.example` 无 parser，另经 diff 检查                                                                                                    |
| `git diff --check`                                                                                                        | 通过                                                                                                                                              |
| 生产 Camoufox / Google / NewAPI / 实例切换                                                                                | 未执行，不作为通过结论                                                                                                                            |
| commit / push                                                                                                             | 未执行；修改保留在开发分支工作树                                                                                                                  |

补充修复：本地取消标记通过原始 query 字符串追加与移除，避免 URLSearchParams 将 legacy URL 中的 `%20`、`%2f`、`~` 重编码。TLS peer 对带这些字符的真实出站 query 做了逐字检查。

## bero 生产补充：892fba7 与 RPC 关联修复

用户授权升级并验证后，先备份原项目及 ais2api 对照实例，停止对照容器并关闭自动重启，再启动本项目。现有账号、密钥、Build App URL、2 contexts、legacy 调度、共享 NewAPI 网络与无内存上限设置保留。Argon 使用 makersuite，3.7 使用 legacy；启用已由同账号 ais2api 实际验证过的 authIndex #0。

初版真实请求报 `Retired MakerSuite request`：实际 Google RPC 形态为 `[path, JSON-string body, proof, method]`，path 不带自定义 query，Node 侧仍有对应 registration。修复将本地 attempt ID 放在 JSON 载荷专用字段，校验 registration、账号页面 epoch、精确模型及 query/body 一致性后剥离。没有按“仅剩一个请求”猜测归属，也没有跳过注册校验。重试原始 body 不变；用户预先设置保留字段、冲突标记、未知注册或旧文档标记均受控拒绝。

新增三组回归覆盖 query 被 Google 丢弃、标记不进入真实 GenerateContent、重试基线保持不变、冲突/未知/旧文档拒绝及保留字段拒绝。实际 Camoufox fixture 的首次导航改用 domcontentloaded；就绪变量通过其 main realm 读取。TLS fixture 使用生产实测的无 query RPC 形态，保留所有原协议/proof/认证/取消断言。

- 完整 `npm test` 退出码 0，TAP 465 项、433 通过、32 既有可选登录浏览器条件跳过，0 失败。
- 实际生产 Camoufox 的 TLS 测试 2/2，通过取消、文档重建与真实 61 秒等待；修复后 GenerateContent 等待 61048 ms，无跳过，不使用 Google 或生产 Cookie。
- Argon 新 context 第一次生成 HTTP 200、严格 OK、stop、usage，9.028 秒。
- Argon Anthropic/Gemini/OpenAI 均通过；Anthropic 110.298 秒仍在总预算内正常完成。
- Argon `-real` 请求按 makersuite 策略输出缓冲 SSE，1 个正文事件、1 个 DONE、0 错误；不声称上游真实增量输出。
- 3.7 legacy real SSE 有 6 个非空正文事件；3.8 普通调用正常。
- Argon AUTO 工具调用两轮通过，包括数字工具结果 `7`；强制命名工具仍因 `allowedFunctionNames` 没有已验证编码而返回 400，不擅自补猜测的协议字段。
- Argon 不在当前抗截断白名单，默认 prefer 请求正常退回普通文本，不能将其计作 Argon 抗截断通过。
- NewAPI 容器内真实 Argon 调用成功。仅在真实生成通过后，部署模型列表追加精确 Argon ID；未填写未知上下文或输出 token 上限。

本次生产补充的本地源码和测试修改未 commit/push；运行镜像在 892fba7 上包含该请求关联补丁。完整配置、数据保护、验收边界与脱敏证据见基础设施仓库 `runbooks/bero-aistudio-892fba7-upgrade-20261017.md`。

## 生产验收后的完善

用户反馈生产环境验收通过，并提出模型目录、策略表单和桥接时限配置三项问题。本轮从 `4ed4cfe` 开始修改，沿用当前开发分支；没有部署、修改生产配置或重新访问 Google 进行验收。

- 在 `configs/models.json` 加入已验收的 `gemini-4-argon`，OpenAI `/v1/models` 与 Gemini `/v1beta/models` 均可列出；不臆造 token 上限或额外支持的方法。
- 模型传输策略改为逐行填写模型 ID、选择旧通道 / 桥接通道、增加或删除模型的表单。继续保存原有映射格式，并保留空模型 / 重复模型校验、默认规则说明和重启生效语义。
- 新增前端“桥接生成超时”及 `MAKERSUITE_TIMEOUT_MS` 环境配置。默认 295000 ms，范围 1–300000 ms；保存后对新请求生效，已接收请求保留配置快照。每次桥接从请求配置计算 deadline，不再受浏览器创建时的旧固定上限约束；同时受剩余缓冲总预算和结算余量限制。当前仍保留五分钟客户端预算上限。
- 增加真实 HTTP 模型目录测试、浏览器表单保存与重复校验测试、超时热更新 / 持久化 / 配置快照测试，以及桥接实际使用新时限和遵守外层预算的测试。

本轮验证：`npm test` 退出码 0，TAP 汇总 468 项，436 通过、0 失败、32 条件跳过（既有登录浏览器可选测试）。`npm run test:transport:browser` 为 2 通过、0 失败、1 跳过（独立的 61 秒长用例本轮未重复运行）；`npm run build:ui`、改动 JS/Vue ESLint、Prettier 和 `git diff --check` 通过。

首次把完整测试与构建、浏览器 fixture 并行执行时，既有公示集群测试在等待 1 秒 freshness 窗口内的三个节点时超时。其他检查结束后单独重跑 `npm test` 全部通过；没有放宽或删除该测试断言。

## 2026-10-18：解除五分钟总等待上限

按管理员要求更新运行代码，取代上文关于“五分钟客户端上限”和“不支持十分钟预算”的描述：

- “桥接生成超时”决定桥接生成总预算，不再取普通缓冲预算与桥接时限的较小值。认证、WAA、fetch 和完整正文读取共用该预算，另保留最多五秒响应结算时间。
- 普通缓冲请求继续使用“缓冲响应超时”。服务端下发剩余预算，消息队列和新版浏览器客户端使用同一固定 deadline；重试、后续轮次及心跳不续期。
- 两项配置均支持 1–2147478647 ms，预留定时器安全余量；默认值仍为桥接 295000 ms、普通缓冲 300000 ms，保存后只影响新请求。
- 自建 Build App 需同步本版本 `scripts/client/build.js`；项目不会自动更新已保存 App。旧客户端的五分钟保护仍可能提前中止，不能只部署服务端便宣称客户端已升级。
- 本地虚拟时钟覆盖十分钟配置、300 秒以后继续等待、到期取消、跨适配器一致性和固定预算不续期；配置页覆盖 600000 ms 保存及持久化。未以真实 Google 生成请求验证长等待。
