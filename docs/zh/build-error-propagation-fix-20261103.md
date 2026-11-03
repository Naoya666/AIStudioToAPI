# Build 上游错误透传修复与验收

依据 `~/workspace/infra/issues/build-error-propagation-fix-spec-20261103.md` 实施。验收全部使用 mock RPC、临时数据库和脱敏/合成 fixtures，没有访问生产账号或触发生产配额。

## 错误字段与响应

`src/core/codeAssistant/BuildError.js` 统一 RPC、任务错误和 JSON/SSE 序列化。保留 `error.code` 数字状态、`error.message` 和 `error.type`；新增 `semantic_code`、`source`、`phase`、`upstreamError`、`rateLimit`、`taskTerminal`、`truncated`、`request_id`。`type` 保留本地稳定语义码。HTTP、RPC 整数码、上游符号状态分别保存；没有上游符号状态时保持 null，不合成 RESOURCE_EXHAUSTED 或 UNAUTHENTICATED。

支持顶层 Status、单元素包装、双层单元素包装、已知 `[null, Status]` 和 REST error 对象；不在任务正文或任意数组中搜索 RPC 错误。任务只从已验证的模型失败字段提取消息。RPC 1/3/4/5/7/8/16 映射为 499/400/504/404/403/429/401。内部错误为 502，Invalid argument 为 400。

脱敏后消息预算为 4 KiB，结构详情为 16 KiB，显式标记 truncated。详情只接受允许的诊断字段，未知位置式 protobuf details 不落库。Cookie、Authorization、API key、签名、凭据和 URL 被脱敏；不保存完整 RPC body 或全部响应头。桥仅增加 Retry-After 白名单元数据，接受有效且不超过 24 小时的等待值。

明确任务 Quota exceeded、HTTP 429、RPC 8 或 RESOURCE_EXHAUSTED 进入 rate_limited。当前归一化的 Build 限额保守使用 temporary、account_model；没有加入任何未经验证的 Build 日额度规则。沿用 rateLimitCooldownMs 或有效 Retry-After；有效的既有 daily/usage 冷却不会被这种临时错误或并发成功缩短。Build 别名共用规范模型，PG 不受影响。

未发响应头时 JSON 使用语义 HTTP 状态。SSE 已发头时保持实际 HTTP 200，通过 data 帧输出同一 error 对象后结束，不输出成功 stop、成功 usage 或 `[DONE]`。断开时不写 socket、不处罚账号，历史为 aborted。整体 deadline 为本地 504；已知任务仅重读可恢复的传输/HTTP 502、504 或解码中断，结构化 RPC 错误及终态失败不重读，不重新提交生成。

## SQLite 与历史兼容

requests 新增两个可空列，启动时按 PRAGMA table_info 幂等迁移：

| SQLite                | 查询/导出 API      | 含义                                            |
| --------------------- | ------------------ | ----------------------------------------------- |
| status_code（已有）   | statusCode         | 保持已有语义：失败时是服务归一化状态            |
| response_http_status  | responseHttpStatus | 客户端实际响应 HTTP 状态；未发头或旧记录为 null |
| error_message（已有） | errorMessage       | 脱敏后的简明消息                                |
| error_json            | error              | version=1 的结构化诊断                          |

读写、查询、JSONL 导出/导入及使用历史错误详情弹窗均支持新字段。旧记录的新字段保持 null；不推断旧错误、不重写旧 usage 或聚合。只有最终结束请求时插入历史，重复 request_id 不重复计数。

生成失败时，Cancel/Delete 错误保存在 secondaryErrors，主错误不变。成功生成但清理失败时 outcome 仍为 success，statusCode 为实际成功状态，error.phase=cleanup 表示单独的清理诊断，errorMessage 不填生成失败。原 journal 保留，Build recovery block 和有限后台恢复沿用原逻辑；页面可查看清理诊断。

迁移只添加可空列，不删除旧列或改写历史，旧版显式列读写可忽略新增字段。回退旧版后新增字段不再采集，旧版清空/导入数据也不会保留这些未知字段，因此上线和回退前仍需备份数据库。此次仅修改源码与本地验收，未修改 Compose、生产数据库或发布实例；实际发布时需按基础设施规则核对挂载及可恢复备份。

## 端到端示例

以下为 `synthetic end-to-end quota response, SQLite history and scheduler share one request ID and temporary classification` 的一次实际本地运行，错误任务结构是合成 fixture。测试经过 BuildRuntime、BuildRequestHandler、真实 ModelScheduler、UsageStatsService 和临时 SQLite；响应与历史共用 UUID：

```json
{
  "request_id": "51a95a66-0ed4-495e-bbef-44e7f2876666",
  "response_http_status": 200,
  "status_code": 429,
  "outcome": "error",
  "error": {
    "code": "BUILD_QUOTA_EXCEEDED",
    "message": "Build 上游任务失败：Quota exceeded. Please try again later.",
    "source": "google_task",
    "phase": "poll",
    "taskTerminal": true,
    "upstreamError": {
      "httpStatus": 200,
      "rpcCode": null,
      "status": null,
      "message": "Quota exceeded. Please try again later.",
      "details": null
    },
    "rateLimit": {
      "type": "temporary",
      "scope": "account_model",
      "retryAfterMs": null,
      "resetAt": null,
      "metric": null,
      "limit": null
    }
  },
  "usage": { "partial": true },
  "scheduler": { "kind": "rate_limited", "type": "temporary" }
}
```

SSE error.request_id 和 X-Request-ID 均为上述 UUID；error.code=429、error.semantic_code=BUILD_QUOTA_EXCEEDED。SQLite requestId 相同。测试断言 CodeAssistantOffline 仅提交一次、终态任务不 Cancel，清理完成后 journal 为空。这里的 HTTP 200 是本地 mock RPC 真实返回值，并非对历史生产错误 wire 状态的推断。

## 验收覆盖

| 场景                                                         | 验证位置                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| HTTP 429 原文、HTTP 200 RPC 8、RPC 1/3/4/5/7/16、嵌套包装    | build-channel 的状态分离测试；makersuite-bridge 的响应元数据测试 |
| Quota exceeded 无 usage；内部失败有 usage；不重复生成/计量   | build-channel 的任务失败、端到端测试；token-metering             |
| 长消息、结构 details、脱敏、非 JSON、普通数组不误判          | build-channel 的有界诊断测试；makersuite-bridge                  |
| SSE accepted/role/部分正文后失败；JSON 错误；request_id 关联 | build-channel 的 JSON/SSE、部分输出、端到端 SQLite 测试          |
| 真实 RPC 401、本地认证桥、sessionVersion 保护                | build-channel 的真实/本地认证和会话版本测试；model-scheduler     |
| 断开 aborted、整体超时、只恢复已知任务读取、终态不重试       | build-channel 的断开、期限、读取恢复和终态测试                   |
| 主失败与清理失败、成功后的清理待恢复、journal 保留           | build-channel 的次级错误和成功清理诊断测试                       |
| 并发结果不缩短已确认冷却、Build 别名共享、PG 隔离            | build-channel 的并发冷却测试；model-scheduler                    |
| 旧数据库迁移、再次启动、历史 usage 保留、导出/导入           | build-channel 的旧库迁移测试；sqlite-storage；token-metering     |
| 工具、anti、ST 及 Build benefit 回归                         | build-channel、build-anti、build-benefit 和完整 npm test         |

执行命令：`npm test`、`npm run build:ui`，以及修改文件的 ESLint 检查。端到端示例可用 `node --test --test-name-pattern='synthetic end-to-end' tests/build-channel.test.js` 重跑；每次产生新的 request_id，并输出关联诊断。

本地验证结果：

- 完整 `npm test`：871 项通过、47 项由现有测试配置跳过、0 失败。
- 最终调整后的 Build/bridge/token/anti/benefit 回归：131 项通过；另新增的逐请求成功清理诊断与后续恢复测试 1 项通过。
- `npm run build:ui`：管理页面和公共页面均构建成功。
- 修改文件 ESLint、`git diff --check`：通过。
