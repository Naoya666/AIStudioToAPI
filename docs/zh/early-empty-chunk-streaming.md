# 提前发送空首块

在控制台的「流式响应模式」中选择「提前发送空首块」，或设置 `STREAMING_MODE=early`。默认仍为 `real`；原有 `real`、`fake` 配置保持兼容。控制台保存后，新请求使用新配置，已经接收的请求继续使用原来的配置快照。

也可以在模型名末尾添加 `-early` 覆盖全局模式。组合后缀顺序为「思考级别 → 流式模式 → 内置工具」，例如 `gemini-3-flash-preview-high-early-search`。服务会剥离这些后缀，再执行模型调度和隐藏检查。

## 响应行为

空首块适用于 `/v1/chat/completions` 且 `stream: true` 的请求，覆盖 legacy 和模型感知调度。完成本地准入检查后，服务立即建立 SSE，发送 `delta: { role: "assistant", content: "" }` 的合法 JSON；首块后立即补发一个 `delta: { content: "" }` 的无 role 空增量，使暂存一条事件的 NewAPI 立即释放首块；等待浏览器、账号、调度队列及上游结果时，每 1000 ms 发送同样的空增量并 flush。上游使用 `fake` 缓冲策略，完整结果返回后直接交付正文、推理内容和工具调用，随后发送结束块和一次 `[DONE]`，不增加播放延迟。

首块与后续 completion 块使用相同的 `id`、`created`、`model`，内部换账号重试不会重复首块。空首块与等待空增量不计为模型首次输出，也不携带结束原因、usage 或工具调用。需要用量信息时，设置 `stream_options.include_usage: true`；usage 沿用现有转换器的结束块格式。

`stream: false` 始终返回完整 JSON。Responses、Anthropic、Gemini 接口选择 `early` 时回退为 `fake`，请求记录也显示实际生效的 `fake`。状态页及 OpenAI 流式请求记录会显示「提前发送空首块」。

## 心跳、错误和取消

`early` 始终发送响应头和空首块，即使 `STREAM_EARLY_HEADERS=false`。该开关继续控制其他模式的原有行为。legacy 和模型感知模式的 early 空增量均固定为 1000 ms，不使用 `STREAM_KEEPALIVE_INTERVAL_MS`；该配置继续控制其他模式的原有保活行为。每个 early 请求仅有一个心跳来源，真实正文、推理内容或工具调用开始交付时停止。

鉴权失败、请求格式错误、隐藏模型拒绝等可在本地判断的错误，在首块之前保留普通 HTTP 错误。首块之后 HTTP 状态已经是 200，调度超时、上游失败和重试耗尽通过 OpenAI 流内错误返回并关闭连接，不发送成功 `[DONE]`。真实模型内容尚未交付时，仍按原有策略执行允许的重试；有效非空 `promptFeedback.blockReason` 是明确例外，立即以 `upstream_prompt_blocked` 终止，不能重试、换账号或换出口重放，也不处罚账号。anti 模式同样保留上游错误码、错误信息及有效错误类型，不统一替换为抗截断通用提示，也不增加代理前缀；字符串业务错误码保留原始类型，与 HTTP 状态独立。上游缺失有效字段时使用明确回退值。本地解码/协议错误返回具体内部错误码和安全信息。允许的重试期间不向下游发送中间错误，最终失败才返回终止错误。

完成、失败或客户端断连会停止心跳。排队取消通过现有调度器撤销，上游工作通过现有浏览器取消机制处理。legacy 等待共享浏览器恢复期间，断连立即结束当前请求的等待，恢复工作完成后也不会再转发该请求。

## 观察与验证

模型感知调度指标提供 `http_headers_ms`、`stream_start_ms`、`model_first_output_ms` 和 `request_complete_ms`，分别观察响应头、空首块、实际模型内容交付和请求终结。legacy 模式通过 debug 日志观察空首块、模型内容交付及终结耗时。空首块和等待空增量不产生 token 用量。SillyTavern 可能将空事件计入 TTFT/TPS，界面指标不能直接作为真实模型首 token 时间或生成速率。

自动化检查包含阻塞上游、浏览器等待、账号排队、单一心跳来源、换账号重试、缓冲内容重置、流身份、工具调用、usage、流内错误、取消清理、后缀优先级、协议回退以及配置保存和重载。运行：

```bash
node tests/scheduled-request.test.js
node --test tests/unified-configuration.test.js
npm run build:ui
```

自动化测试不能替代酒馆和实际网关入口的验证。部署时记录酒馆版本、连接方式和网关配置，确认 AI 楼层尽快出现、等待期间计时器是否按约一秒刷新、结果是否完整填充，以及停止生成和错误提示是否正确。位于本服务下游的网关必须即时透传显式空 `content` JSON 首块和心跳；仅透传 SSE 注释不能触发 NewAPI 转发或酒馆进度刷新。NewAPI 仍暂存一条事件，等待期间转发会落后约一个空包间隔，网络阻塞时酒馆计时器也不会独立走时。缓冲整个响应的网关会消除提前反馈效果。服务使用 `X-Accel-Buffering: no` 并 flush 响应头，实际代理仍需检查其缓冲配置。

原始方案见 [设计文档](early-empty-chunk-streaming-design.md)。
