# Build quota 模型日轮换实施记录

日期：2026-11-04。实现对应基础设施决策 `build-quota-daily-rotation-decision-20261104.md` 的方案一。本记录只涉及项目代码、测试和文档，未发布生产或修改生产持久化状态。

## 行为

- 真实执行租约必须属于规范 `build/` 模型。主错误必须满足 `source=google_task`、`phase=poll`，且 `upstreamError.message` 去除首尾空白后精确等于 `Quota exceeded. Please try again later.`。
- 不检查已用 Token 或外层 HTTP 状态，不遍历 `secondaryErrors`；BuildError 的上游来源、逻辑 429、usage 和流式失败记录保持原样。
- 复用账号模型 slot 的 `rate_limited`、`rate_limit_type=build_quota_rotation`、`cooldown_until`。这是本地运营轮换策略，不代表上游已经确认日限额。
- 到期为处理错误时所在 `America/Los_Angeles` 日期的下一次本地零点，复用 Pacific 日期计算并正确处理夏令时；不受可配置的批量重置时间影响，也不要求启用每日批量重置。
- 同日重复错误不滚动延长，在途成功不清除。其他并发错误不能缩短已有冷却，较晚的其他冷却仍保留；跨日到达的错误按处理时当前日计算，不复用旧截止时间。
- 普通 / ST / anti / anti-ST 共享规范模型，同账号其他 Build 模型和 PG 不连带冷却。稳定账号身份及 slot 随现有 scheduler state 保存，重启及索引重编号后仍绑定原账号。
- 到期按既有 slot 访问和冷却唤醒恢复资格，不清除手动禁用、真实账号失效或 unsupported。未添加独立恢复任务、探测请求或清理准入限制。

## 模型预算修正

Build Token 预算由旧账号共享池改为“账号 × 规范模型”，既有按模型保存的历史 token_windows 无需重分摊。别名仅归一，不重复计量。

| 层级 | Build 模型       | 日 Token 预估 |
| ---- | ---------------- | ------------- |
| Pro  | gemini-4-argon   | 20,000,000    |
| Pro  | gemini-3.8-flash | 未测试，未知  |
| Free | gemini-3.8-flash | 8,000,000     |

来源为用户 2026-11-04 提供的观测值，仅用于展示。达到预估上限不新增调度拦截。Free Flash 的旧隐藏配置 `BUILD_FREE_DAILY_TOKEN_ESTIMATE` 非零时仍可人工覆盖；0 改为采用 800 万观测值，不作用于其他模型。部署时如有旧 managed-config 覆盖，应核对是否仍需保留。

管理面板改为按 Build 模型展示；节点预算字段采用 `scope=build/model`、`pool=规范模型`。聚合端继续接收旧 `build/account` 节点，但不同 scope / pool 的预算不合并成完整余额。混合版本部署应先更新聚合端。

## 验证

专项覆盖精确匹配与负例、低/缺失 usage、流内 HTTP 200、别名、其他模型及 PG 隔离、重复错误、在途成功、状态重载、账号重编号、Pacific 夏令时、跨日迟到错误、独立禁用/权限状态及预算协议兼容。

验证均使用本地 fixture 和模拟上游，没有真实 Google 额度或生产节点恢复验收。生产部署前仍需按基础设施规则备份持久化状态、逐节点验证并补录发布版本。

本轮实际验证：`npm test` 全量 960 项，913 通过、47 个可选真实账号浏览器用例跳过、0 失败；新增与相关专项 103 项全部通过。`npm run build:ui`（管理端及公示端）、变更文件定向 ESLint、Prettier 和 `git diff --check` 均通过。可选账号浏览器用例未配置 `ACCOUNT_LOGIN_BROWSER_TEST_EXECUTABLE`。
