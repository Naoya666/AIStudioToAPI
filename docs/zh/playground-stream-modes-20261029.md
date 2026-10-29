# Playground 流式模式保留修正（2026-10-29）

上一轮把“real 的缓冲 SSE 改为真流”误扩大为删除 fake/early。本次恢复 fake/early 的输出路径、环境变量、配置页控件、模型后缀覆盖和原有测试；real 继续使用已实现的 Playground 实时增量读取。三个模式均使用 Camoufox 直连 Playground，不恢复 Build App 或旧 legacy 传输映射。

## 当前行为

| 模式  | Chat Completions                                   | Responses / Anthropic / Gemini |
| ----- | -------------------------------------------------- | ------------------------------ |
| real  | 随上游增量输出正文、思考及工具调用                 | 实时增量输出                   |
| fake  | 等待完整结果后输出 SSE                             | 等待完整结果后输出 SSE         |
| early | 提前输出空首块及空增量心跳，完整结果就绪后填充正文 | 沿用原来的 fake 行为           |

`STREAMING_MODE=real|fake|early` 和 `-real` / `-fake` / `-early` 后缀继续有效。配置热更新和请求快照保留；已保存的 fake/early 设置不再被忽略或删除。`FAKE_STREAM_TIMEOUT_MS` 及对应配置项恢复，Playground 的固定生成总预算仍由 `MAKERSUITE_TIMEOUT_MS` 控制，优先于普通缓冲队列等待超时。

仅 `MODEL_TRANSPORT_POLICY` 与 Build legacy 传输配置继续移除。独立的 legacy 账号轮换策略不变。

## 代码与回归

恢复原有 fake/early 响应函数和调度开始逻辑，并为 native Gemini 的 fake/early 请求选择聚合 JSON 的内部路径；只有 real 使用 `streamGenerateContent` 增量路径。底层认证、WAA、取消和文档隔离继续使用已完成的 Playground 实现。

原有 early 空首块、心跳、调度排队、取消、错误、工具及抗截断测试已恢复。对于无法确定上游是否已经生成正文的缓冲连接中断，保留 Playground 的保守不重放规则。配置页实测了 early/real 热切换和缓冲等待超时保存。此前的真实 TLS 长响应测试仍覆盖未改变的 real 浏览器读取与解码路径。

最终验证：`npm test` 共 710 项，671 通过、39 项可选浏览器用例跳过，0 失败或取消；`npm run test:transport:browser` 11 通过、1 项长时用例默认跳过。前端构建、改动 JavaScript/Vue 的 ESLint 和差异空白检查均通过。

## 真实账号验证

在 bero 独立容器 `aistudio-modes-test` 中，使用隔离账号文件及数据库副本，执行三种模式 × 四协议时序测试。每个请求要求模型逐行输出 1–100，客户端逐条读取 SSE，以正文到达时间及正文事件数区分实时流与缓冲流，而非只检查最终文本。

12 项全部通过：real 的正文分 12–13 段逐步到达，fake 每次仅在完整结果就绪后输出一段正文；early 的 Chat 空首块约 4 毫秒到达，等待期间发送心跳，最后填充完整正文，其他协议保持 fake 行为。

运行时审计显示活动请求及队列均已归零，无 Build iframe、旧 Proxy RPC 或 9998 监听；16 个相关源码文件哈希与本地相同。

- [三模式 × 四协议客户端时序](fixtures/playground-modes-20261029-live.json)
- [运行时和源码审计](fixtures/playground-modes-20261029-audit.json)
- [隔离环境清理及主实例状态](fixtures/playground-modes-20261029-cleanup.json)

测试容器、镜像及复制的账号和数据已清理。主生产容器未替换，原镜像及启动时间保持不变，API 和数据库检查正常。

上一轮 [流式实现记录](playground-streaming-20261029.md) 中删除 fake/early 的结论已被本记录取代；其历史测试与源码哈希不应作为当前版本的模式配置说明。
