# bero 临时修改桥接编码后的工具选择实验

时间：2026-10-28 19:30 起（Asia/Shanghai）。模型固定为 `gemini-3.8-flash`。用户明确授权临时修改生产代码并测试强制和指定工具调用。

结论：本轮测试请求已实际到达 Google MakerSuite，但尚未找到能执行强制／指定调用约束的编码。只取消本地校验会静默退回 AUTO 行为；只过滤工具列表也不能保证发生调用。四种候选编码均被上游返回 HTTP 400。这仅否定本轮候选，不证明 MakerSuite 在所有可能协议形式下都不支持工具选择。

## 临时改动范围

- 原镜像 `aistudio-to-api:bero-887c6ec-appc894`，实例 `aistudio-bero`。
- 备份实际运行的 `MakerSuiteCodec.js`、`MakerSuiteBridge.js`、配置、auth，以及两个 SQLite 的在线一致性副本；两个数据库备份 quick_check 均为 ok。
- 快照：服务器 `/srv/backups/aistudio-bero/manual-pre-toolchoice-20261028T113035Z`。
- 临时编码逻辑仅在目标模型且声明列表由两个专用测试函数组成时启用：`tcprobe_weather`、`tcprobe_time`。正常业务请求继续走原校验。
- 测试配置放在容器 `/tmp/tool-choice-probe.json`；不修改生产持久配置。
- 桥接增加脱敏结果日志，记录实际 fetch 完成及上游 HTTP 状态，不记录认证、Cookie、proof、权益值或生成正文。
- 设置 25 分钟自动回滚定时器；测试结束主动恢复并取消该定时器。实验补丁保留作证据，不作为正式实现交付。

## 方法与结果

所有 19 次实验请求均使用 Gemini native 入口、非流式、temperature=0、maxOutputTokens=512；实际走 MakerSuite GenerateContent。每条记录均有 `fetchCompleted=true` 的桥接返回证据，排除了只看到传输策略日志就误判已经出站的问题。

| 实验 | 请求数 | 观察结果 |
| --- | --- | --- |
| AUTO 基线及实验末尾复验 | 2 | 均 200，正确调用天气工具并传入 Shanghai |
| 取消本地限制，但不编码 ANY | 3 | 均 200，反向提示“不要使用工具，回复 OK”时没有调用工具 |
| 取消本地限制，但不编码指定名称 | 1 | 200，指定天气工具却调用了提示要求的时间工具 |
| 四种候选编码，分别测试 ANY 与指定名称 | 8 | 均上游 HTTP 400，未形成成功生成 |
| 过滤声明为指定天气工具，正向提示 | 1 | 200，正常调用天气工具 |
| 过滤声明为指定天气工具，提示禁止工具 | 3 | 均 200，回复 OK，无工具调用 |
| 过滤声明为指定天气工具，提示要求时间工具 | 1 | 200，无工具调用 |

共 11 次 HTTP 200、8 次 HTTP 400。HTTP 200 不代表满足强制或指定调用语义；反向提示的 7 次成功响应均违反对应的预期调用约束。交换工具声明顺序的用例也未改变这一结论。

## 候选编码的边界

读取当前公开 AI Studio 前端 bundle，确认 GenerateContent 的请求类和已有生成路径，但没有找到可确认的 `functionCallingConfig`／`allowedFunctionNames` 映射。

因此将下面组合明确作为未经验证的有限协议探针，而非已知正确实现：

- 顶层数组 index 8 或 index 9（Proto field 9 或 10）。
- 候选 ToolConfig 为 `[functionConfig]` 或 `[null, functionConfig]`。
- 候选 functionConfig 为 `[2]` 或 `[2, ["tcprobe_weather"]]`。

这四种组合的强制／指定请求均已到达上游，且均返回 HTTP 400；没有证据证明这些位置、嵌套结构或枚举在 MakerSuite 中成立。未继续扫描其他未知字段，也未将失败候选保留在生产。

过滤工具列表实验只缩小可用函数集合，没有编码原生强制模式，也没有注入要求调用工具的额外系统提示。正向提示成功、反向提示失败，说明该方案不能满足调用方所要求的“必须调用指定工具”语义。

## 验收范围

本轮目标是确认桥接下游约束是否生效，因此从 Gemini native 入口隔离测试编码层。没有把本轮结果扩展成四类 API 的新能力验收，也没有执行 SSE、多轮、并发、异常组合或长时间稳定性验收。前一轮四类入口的原版行为见 [首次实测](bero-flash38-tool-choice-20261028.md)。

正式支持仍需要取得正确的 MakerSuite 协议映射并完成约束验收。现阶段应保留原版明确拒绝行为，避免把静默忽略选择配置当成支持。

## 恢复与服务状态

临时修改仅发生在运行容器内的两个源文件。加载补丁和恢复原版各手动重启实例一次；原镜像、Compose、环境配置、模型目录和 managed configuration 均未修改。

恢复后两个文件 SHA-256 与测试前备份完全一致，临时控制文件已删除，自动回滚定时器为 inactive。最终 `/health` HTTP 200、status=ok、browserConnected=true，容器 running/healthy。两个 SQLite quick_check 均为 ok；没有用备份覆盖运行数据，也没有清空调度或账号状态。

首次恢复检查中的 AUTO 请求由账号 #0 处理，出现一次上游 HTTP 403；同轮强制和指定请求已恢复原版的本地 400 保护。没有清额度、修改账号权限或强制轮换，随后经正常调度再次检查，AUTO HTTP 200 且正确调用天气工具，强制和指定仍返回预期的本地 400。本轮未确认该单次 403 的具体原因，不将其隐去或归因于模型不支持工具。

## 证据

- [19 次脱敏实验记录](fixtures/bero-flash38-tool-choice-live-20261028.json)
- [临时实验补丁，已撤销](fixtures/bero-flash38-tool-choice-experimental-20261028.patch)
- [恢复校验](fixtures/bero-flash38-tool-choice-restoration-20261028.json)
- [包含单次 403 的首次恢复检查](fixtures/bero-flash38-tool-choice-restoration-first-20261028.json)

服务器保留 `/opt/aistudio-bero/tool-choice-live-20261028/` 及对应测试脚本。测试脚本在服务器内读取现有凭据，不复制凭据到本地。
