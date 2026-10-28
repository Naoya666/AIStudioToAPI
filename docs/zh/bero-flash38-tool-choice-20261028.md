# bero gemini-3.8-flash 工具选择实测

时间：2026-10-28 19:26（Asia/Shanghai）。用户授权在 bero 使用 `gemini-3.8-flash` 测试桥接工具调用。

本文记录原版行为。后续授权临时修改生产编码的实验见 [第二轮报告](bero-flash38-tool-choice-live-20261028.md)。

结论：当前生产版本的 AUTO 调用正常；强制与指定调用均在本项目编码阶段返回 400。尚未验证 Google MakerSuite 上游是否支持这两种约束，不能把本地拒绝解释为模型不支持。

## 环境与方法

- 运行实例：`aistudio-bero`；镜像：`aistudio-to-api:bero-887c6ec-appc894`。
- 经服务器 loopback HTTP 入口调用现有实例，没有额外启动浏览器。
- 使用无副作用的声明 `get_weather(city)` 与 `get_time(city)`；测试端模拟天气结果。
- AUTO 提示要求查询上海天气；强制调用提示要求不用工具直接回答 OK；指定天气工具时，提示反向要求调用时间工具。
- Chat 显式关闭抗截断，避免内部合成函数影响判断。
- 脱敏传输日志确认本批请求选择 `makersuite`。日志中的 `rpc=GenerateContent` 是传输策略记录，并不单独证明请求已发往 Google；被编码器拒绝的请求没有进入上游生成。

## 结果

| 入口 | AUTO | 强制调用 | 指定 get_weather |
| --- | --- | --- | --- |
| Chat Completions | 200，get_weather，参数正确 | 400，本地仅支持 AUTO | 400，本地不支持 allowedFunctionNames |
| Responses | 200，get_weather，参数正确 | 400，本地仅支持 AUTO | 400，本地不支持 allowedFunctionNames |
| Anthropic Messages | 200，get_weather，参数正确 | 400，本地仅支持 AUTO | 400，本地不支持 allowedFunctionNames |
| Gemini native | 200，get_weather，参数正确 | 400，本地仅支持 AUTO | 400，本地不支持 allowedFunctionNames |

另有 Chat AUTO 第二轮：工具结果回传后 HTTP 200、finish_reason=stop、无新增工具调用、usage 存在。共 13 项请求：5 项成功，8 项预期的本地能力拒绝；没有完成强制或指定调用的上游能力验收。

## 阻断点与后续

生产 `src/core/MakerSuiteCodec.js` 的 `buildBody()` 对 `functionCallingConfig` 只允许 `mode`，且只接受 AUTO。四类入口已能将强制／指定语义转换为 Gemini ANY／allowedFunctionNames，但后续 MakerSuite 编码不支持。

下一阶段需要取得真实 MakerSuite 协议证据并实现对应编码，再在隔离测试版本验证反向提示、多工具顺序交换、流式、多轮及参数约束。仅移除校验、过滤工具列表或强化提示词，都不足以证明上游执行了强制调用约束。本次没有猜测协议字段、修改生产代码或部署临时补丁。

未执行 SSE、重复稳定性、并发、异常与抗截断组合矩阵：核心约束尚未进入上游，重复这些组合不能证明强制／指定能力。

## 最终状态与证据

生产源码、镜像及配置未修改，无服务重启。最终容器 running/healthy、Docker restart count=0；`/health` HTTP 200、status=ok、browserConnected=true。

服务器保留测试脚本 `/opt/aistudio-bero/tool-choice-probe-20261028.py` 和脱敏结果 `/opt/aistudio-bero/tool-choice-20261028/`。脚本仅在服务器内读取已有 API Key，不输出凭据。结果副本见 [脱敏 JSON](fixtures/bero-flash38-tool-choice-20261028.json)。
