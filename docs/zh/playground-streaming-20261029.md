# Playground 实时流式改造与验收（2026-10-29）

> 修正说明：本记录描述上一轮误移除 fake/early 时的实现与验收，相关源码哈希和模式结论属于当时版本。fake/early 已恢复，当前行为与验证以 [模式保留修正记录](playground-stream-modes-20261029.md) 为准。

本阶段保留 Camoufox，在已完成的 Playground 直连基础上，删除生成路径中的缓冲 SSE、fake/early 输出分支及旧传输配置。Chat Completions、Responses、Anthropic Messages 和 Gemini native 的流式请求均读取上游增量消息；非流式请求仍返回完整 JSON。本记录取代上一阶段记录中“缓冲 SSE”和“legacy 配置仍可接受”的描述。

## 实现

参考本地 AIStudio2API 的 `internal/aistudio/decoder.go:decodeGenerateItems` 和 Camoufox WAA 初始化流程，参考版本为 [bd6c40f5](https://github.com/Mag1cFall/AIStudio2API/tree/bd6c40f5f8a3a680a19a1ebff67216298d8bae27)。本项目继续使用 Playwright/Camoufox，没有引入参考项目的 Go 或原生 HTTP 传输。

- 浏览器通过 `response.body.getReader()` 与流式 `TextDecoder` 读取正文。通过按请求隔离的拉取接口交给 Node，每次只保留一个待取数据块，不通过 console 传递响应或认证信息。
- `PlaygroundStreamDecoder` 按字符串转义及 JSON 嵌套状态识别完整 JSON+protobuf 消息，兼容稀疏数组、两种已知外层封装、任意网络分片和 UTF-8 分片。已消费的消息被丢弃；不会为 SSE 保存完整生成结果。单消息限制为 16 Mi 个字符，嵌套最多 128 层。
- 完整消息复用现有 Codec，转成 Gemini 语义事件，再交给四类 API 转换器。正文、思考、签名及工具参数随消息转发；完成原因及最终 usage 在正常 EOF 校验后提交，避免尾部 RPC 错误或截断产生成功结束事件。
- 保留请求/attempt/文档 epoch 隔离、WAA 串行生成、取消、固定总预算及清理期限。已有正文的错误携带输出状态，禁止自动重放；尚未输出的可重试错误沿用调度规则。Argon 和非流式连接中断保留保守的不重放规则。
- `STREAM_TIMEOUT_MS` 约束首段正文后的增量空闲等待，同时受固定生成总预算约束。SSE 设置 `X-Accel-Buffering: no`。排队阶段仍可通过独立的响应头/注释保活设置维持连接，不发送旧式空正文开始块。

## 配置迁移

删除配置页、写入接口和环境加载中的 `MODEL_TRANSPORT_POLICY`、`STREAMING_MODE`、`FAKE_STREAM_TIMEOUT_MS`。启动时忽略这些旧环境变量，并从已保存配置的内存视图删除对应字段；下一次保存会清理持久化字段。旧配置不能恢复 Build 通道或缓冲 SSE。已保存配置恢复和 last-good 恢复也不会恢复旧模式。

保留 `MAKERSUITE_TIMEOUT_MS`（默认 295000 毫秒）作为唯一生成总预算，包含认证、WAA、fetch 和正文读取；另预留最多 5000 毫秒结算时间。旧 `-fake` / `-early` 模型后缀保留为名称兼容，实际模式始终为 real。旧的 9998 配置及端口冲突占位也已移除。

账号轮换策略中的 `legacy` 是独立的调度功能，本次没有删除它。历史 Build 协议 fixture 仍可独立运行，但不属于生产生成路径。

## 自动验证

- `npm test`：651 项，612 通过，39 项可选浏览器用例跳过，0 失败或取消。
- `npm run test:transport:browser`：12 项，11 通过，长时用例默认跳过。
- `npm run test:transport:long`：2 项全部通过。真实 TLS/CONNECT 测试首段正文 34 毫秒到达，EOF 在 61030 毫秒到达；同时验证实际网络取消及文档重新初始化。fixture 限定本地目的地，不访问 Google。
- `npm run build:ui`、本次改动的 JavaScript/Vue ESLint、`git diff --check` 通过。
- 新增验证覆盖 EOF 前输出、稀疏及字符分片、长流不累计正文、单消息限制、思考/签名、usage、尾部 RPC 错误、截断、提示词拦截优先级、取消、增量空闲超时及总预算不续期。既有适配器测试继续覆盖流内错误、工具调用、抗截断、并发和资源释放。旧 fake/early 专属行为测试已退役。

## bero 真实账号验收

使用与主实例隔离的 `aistudio-stream-test` 容器、独立复制的账号文件及 SQLite 在线备份。没有共享主实例的可写数据。真实调用使用 `gemini-3.8-flash`，当前文档由账号索引 1 执行。

共 19 项检查全部通过：四协议 JSON/SSE、countTokens、工具自动调用、四协议分段到达时序、工具结果回传、两个并发请求、流式工具参数与 usage、正文后取消及会话复用。共 20 次实际生成调用，包含 1 次主动取消；另有 1 次在发出前拦截的当前文档 WAA 初始化生成。

| API                | 正文段数 | 首段（秒） | 最后一段（秒） | 完整结束（秒） |
| ------------------ | -------: | ---------: | -------------: | -------------: |
| Chat Completions   |       28 |      3.294 |          7.063 |          7.086 |
| Responses          |       29 |      2.720 |          6.274 |          6.294 |
| Anthropic Messages |       28 |      3.561 |          7.353 |          7.374 |
| Gemini native      |       29 |      2.404 |          5.590 |          5.628 |

时序测试读取真实 HTTP SSE，每段记录客户端到达时间；正文包含多次不同时间的增量，首段明显早于请求结束。测试结果不是只对最终收集到的 SSE 文本做断言。

运行时检查确认使用 `PlaygroundTransport`、浏览器 `getReader()` 和增量解码器，活动请求与队列均为 0；旧 Proxy RPC 为 0、Build iframe 为 0、无 9998 监听。16 个相关源码文件的 SHA-256 与本地最终源码相同。

脱敏证据：

- [兼容性检查](fixtures/playground-streaming-20261029-acceptance.json)
- [客户端分段时序](fixtures/playground-streaming-20261029-timing.json)
- [工具回传与并发](fixtures/playground-streaming-20261029-extra.json)
- [流式工具与主动取消](fixtures/playground-streaming-20261029-edge.json)
- [运行时与源码审计](fixtures/playground-streaming-20261029-audit.json)
- [清理及主实例状态](fixtures/playground-streaming-20261029-cleanup.json)

测试容器、测试镜像及复制的账号/数据均已删除。主生产容器仍为 `aistudio-to-api:bero-887c6ec-appc894`，启动时间保持 `2026-10-28T11:36:01.665659356Z`；容器及 API 健康，两个 SQLite 数据库 quick_check 均为 ok。**本次没有替换主生产实例。**
