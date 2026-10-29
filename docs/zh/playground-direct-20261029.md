# 保留 Camoufox，移除 Build App 中转

日期：2026-10-29（Asia/Shanghai）。本阶段保留浏览器、现有账号池、代理出口、层级准入、API 适配和缓冲 SSE，移除业务链路中的自建 Build App、iframe 转发和浏览器 WebSocket。

## 当前链路

```text
客户端 → RequestHandler / 账号调度
       → PlaygroundConnection.dispatch（进程内）
       → Playwright → 账号的 Playground 页面
       → 官方 WAA proof + 当前 Cookie 签名 → GenerateContent
       → MakerSuiteCodec 解码为 Gemini JSON
       → 原有消息队列 / 协议适配 → 客户端
```

`BrowserManager` 打开 `https://aistudio.google.com/prompts/new_chat?temporary=true`。初始化时 hook 官方 snapshot 函数，填写一次固定初始化提示并通过官方 DOM Run 操作创建 WAA 上下文；临时路由在出站前中止这一次原生生成。捕获服务和认证、实际看到被拦截请求后才发布可用传输。初始化失败时保留拦截保护到 Context 关闭，避免迟到的 snapshot 发送初始化生成。

正常生成不触发旧 `ProxyUnaryCall` / `ProxyStreamedCall`，不包装旧 RPC 响应，不添加关联 URL/JSON 标记。服务端直接提交页面 fetch；同一页面的提示框同步与 proof 创建串行，随后 fetch 可独立执行。每次调用重新签名当前页面的 SAPISID Cookie，不重用初始化时的 Authorization。客户端提供的密钥不成为页面认证来源。

`ConnectionRegistry` 保留账号、连接代际和请求 attempt 的隔离，但登记的是本地 `PlaygroundConnection`。页面导航、关闭及账号替换会取消旧请求、关闭对应队列；重新初始化使用新代际。生成固定预算包含上下文读取、WAA、fetch 和正文读取，重试、续写和心跳不续期。登录验证也使用此路径；清理等待 Context 的实际 close 事件，避免 Playwright 重复 close 提前返回时误报可复用。

参照 [AIStudio2API](https://github.com/Mag1cFall/AIStudio2API/tree/bd6c40f5f8a3a680a19a1ebff67216298d8bae27) 的 `internal/camoufoxnative/worker.go`、`page.go`、`bidi.go` 以及 `docs/protocol.md`，复用本项目已有的认证保护、编解码和调度代码。本阶段没有引入 Go WAA 后端。

## 配置和范围

- 保留 `makersuite` 传输名称和 `MAKERSUITE_TIMEOUT_MS`，兼容已有有效配置；界面名称改为 Playground 直连和 Playground 生成超时。
- `legacy` 映射仍可从旧配置读出，但请求明确返回 400，须删除或改为 `makersuite`。界面不再允许新增旧通道选择。
- 不再启动 9998 服务，不需要重新发布或同步 Build App。原客户端文件、旧桥接适配器及其历史协议测试保留用于历史参考，不参与当前业务请求。
- 支持原有四类生成 API 适配，原生 `generateContent` / `streamGenerateContent`，以及 Playground 原生 `CountTokens`。计数复用内容、系统指令和工具编码，并扣除网页协议额外的系统角色 token。
- SSE 仍为完整响应到达后的缓冲输出，未新增原生增量流式。
- 未扩展原有 Playground 编码器的工具、媒体和模型能力。强制／指定工具选择仍降级 AUTO；禁止工具选择仍受现有编码器限制。
- 旧代理专用的 Files 上传／管理、缓存、embeddings 等未映射到 Playground 的上游方法返回明确的本地 501，不发送旧 RPC，也不因此新增上游失败冷却或账号封禁；请求次数仍按既有调度尝试口径记录。此处不是完整实现 AIStudio2API 的所有上游方法。

## bero 真实账号验收

使用 `aistudio-playground-test` 隔离实例，loopback 端口 17860，沿用生产 Camoufox 镜像的运行环境和授权账号副本。账号目录、管理配置、调度状态和 SQLite 均使用副本；SQLite 通过在线 backup 复制并检查。没有替换、重启或修改原 `aistudio-bero` 实例及其持久配置。

最终冷启动矩阵固定使用 `gemini-3.8-flash`，10 项全部 HTTP 200 且通过内容或协议检查：

| 检查                                         | 结果                         |
| -------------------------------------------- | ---------------------------- |
| Chat / Responses / Anthropic / Gemini 非流式 | 4 项通过；生成有 usage       |
| 四种入口 SSE                                 | 4 项通过；终态／结束事件存在 |
| 原生 CountTokens                             | 通过，返回正整数 totalTokens |
| AUTO 函数调用                                | 通过，调用 get_weather       |

额外验证工具调用结果回传后生成最终回答，以及两个同时到达的 API 请求，3 项全部通过。隔离实例限制账号并发为 1，因此后两项验证排队完成；同页并行请求的 WAA 隔离另由本地真实 Firefox 测试覆盖。

第一轮 Anthropic 非流式曾出现一次上游 `Request contains an invalid argument`（400）；同请求连续三次复测均 200，后续两轮冷启动矩阵也全部通过。保留首次失败，不将其归因于某个未验证原因。初期开发版本也曾因物理点击未触发官方提交而初始化超时，改用参考实现的 DOM Run 路径后完成冷启动验证。

最终运行页审计：Playground 临时对话页、本地 PlaygroundTransport、ready=true；页面资源记录中 GenerateContent 为 14（包含初始化请求记录）、CountTokens 为 2，旧 Proxy RPC 为 0，Build iframe 为 0；容器内 9998 未监听。9 个关键源文件的 SHA-256 与本地工作区一致。最终原生产及隔离实例 `/health` 均为 ok。测试后停止并删除隔离容器，保留脱敏证据和测试脚本；原生产镜像和启动时间保持不变。

证据：

- [最终 10 项矩阵](fixtures/playground-direct-20261029-final.json)
- [工具多轮与同时请求](fixtures/playground-direct-20261029-extra.json)
- [运行页审计与源码哈希](fixtures/playground-direct-20261029-audit.json)
- [首次矩阵及 Anthropic 复测](fixtures/playground-direct-20261029-first.json)
- [清理前两实例健康状态](fixtures/playground-direct-20261029-health.json)
- [隔离环境清理与原生产状态](fixtures/playground-direct-20261029-cleanup.json)

服务器脚本和记录位于 `/opt/aistudio-bero/playground-direct-20261029/`。凭据仅在服务器内读取，没有写入仓库证据。

## 本地验证

- `npm test`：完整回归通过（664 项通过，39 项可选测试跳过）；末组 UI 测试串行运行，避免同一项目的 Vite 资源并行争用。历史用量测试文件本身保持原样。
- `npm run test:transport:browser`：8 项通过、1 项长时用例默认跳过；覆盖直连初始化、原生计数、429／401、取消、固定超时、导航恢复、延迟上下文取消、能力拒绝和并发 proof；同时保留历史桥接兼容测试。
- `MODEL_TRANSPORT_LONG_FIXTURE=1 node --test tests/makersuite-transport-browser.test.js`：本地真实 TLS 正文读取超过 61 秒后成功返回，2 项通过。
- 使用安装的 Firefox 显式启用 `tests/account-login-browser.test.js` 的正常登录、身份／初始化失败、iframe 隔离和伪造成功日志用例，验证 Playground 登录入口和清理。
- `npm run build:ui`、改动文件 ESLint、`git diff --check`：通过。

仓库级 `npm run lint:js` 仍被已有历史 JSON 证据的缩进／排序问题阻断（1694 条），本次未批量重写这些历史证据；改动的代码和新增 JSON 单独检查。
