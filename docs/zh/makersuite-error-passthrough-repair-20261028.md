# MakerSuite 审核反馈与错误正文解析修复

修复日期：2026-10-28（Asia/Shanghai）。依据交接文件
`/home/dev/workspace/infra/runbooks/meow-build-makersuite-error-diagnostics-20261028.md`。
本次交付为项目源码与离线回归，不包含生产部署或生产冷却配置调整。

## 审核反馈的协议依据

交接记录没有保存真实 MakerSuite 审核响应。本次读取 Google AI Studio **公开、无需登录**的前端脚本核实字段，不发送生成请求。

- 入口：[AI Studio](https://aistudio.google.com/)。
- 脚本版本：`boq-makersuite.MakerSuite.en_US.GArkGzYM5-A.2018.O`，模块 `AgQvWc`。
- [公开脚本地址](https://www.gstatic.com/_/mss/boq-makersuite/_/js/k=boq-makersuite.MakerSuite.en_US.GArkGzYM5-A.2018.O/am=gSgABHM/d=1/excm=_b/ed=1/dg=0/wt=2/ujg=1/rs=AMOXD28zaFsHdaK_EornZb1WVEFukrwqkw/dti=1/m=AgQvWc)。
- 下载脚本 SHA256：`f594f47869a09923a42191664839a9878be60c13ec3764e487ac7a02c56e6409`。

可复核的读取位置：GenerateContent 的 `data` 回调通过 `_.Cc(x,_.Gw,2)` 读取反馈，继而读取其中字段 1 的原因、字段 2 的评级列表和字段 3 的说明。protobuf 字段号从 1 开始，对应 JavaScript 数组下标分别为响应 `[1]` 与反馈 `[0]`、`[1]`、`[2]`。

该脚本将输入原因 1/2/3/4/5 分别映射到界面的 Safety / Other / Blocklist / Prohibited content / Image safety。标准名称也与 [Google GenerateContent 定义](https://ai.google.dev/api/generate-content#BlockReason)一致。评级类 `n2a` 的字段 3 是 category、字段 4 是 probability；界面概率值 0–4 为 Unspecified、Negligible、Low、Medium、High。

这属于上游客户端协议代码证据，**不是实际审核报文采样**。新增审核测试是据此独立构造的位置数组，不宣称复现了真实审核请求，也不把历史缺少 finishReason 的请求统一改标为审核拦截。

## 实现行为

`MakerSuiteCodec` 解码并跨 chunk 保留 promptFeedback、实际 usage 和 responseId。输入原因 0 不构成明确拦截；未来的正整数原因保留为其数字字符串，不猜测其含义。

明确输入拦截先于候选解析、RPC 尾部错误与完成性检查。同块候选不交付；流式桥接在已缓冲的完整上游结果中汇总元数据，将拦截作为标准响应交给已有 `UpstreamBlock` / 请求处理器。客户端最终得到 HTTP 400 或已发头后的流内 `upstream_prompt_blocked` 错误；沿用现有脱敏、禁止重试、禁止切号和账号保护逻辑。桥接内部的 HTTP 200 表示成功交付待检查的标准响应，不表示客户端生成成功。

无明确输入拦截时继续要求候选提供 finishReason。usage-only、空回复或缺少结束标记的部分正文不能变成空 STOP 成功。candidate 的 SAFETY finishReason 仍属于输出结束语义。

错误解析首先使用 JSON.parse；遇到协议数组空项时，仅在字符串外、数组内补 null，然后再次交由 JSON.parse 校验。不使用 eval，不修复对象语法，也不递归搜索未知结构。支持直接 RPC Status、已实测的 `[null, Status]` 错误封装及既有标准 error 对象；无法识别的正文继续安全回退。RPC code、message、opaque details 均保留在桥接 RPC 错误体中，不新增客户端 details 字段。

## 样本与验证

`tests/fixtures/makersuite/daily-quota.json` 来自诊断记录中第 3、4 次日额度响应的脱敏结构，覆盖 Flash limit=100 和 Pro limit=10（上游 quota model 为 gemini-3.1-pro）。将已解析结构重新序列化为带顶层空项的测试报文，不宣称逐字节保存原始响应。

回归覆盖：

- 原始位置数组经过 codec、merge、请求处理器；无候选、带 usage、同时带候选、跨块反馈及实际 responseId。
- legacy / model 调度，普通 / 抗截断，缓冲 / real / fake / early 输出；拦截后的实际发送次数、切号次数、账号健康、冷却及错误终止。
- 桥接真实处理函数的 HTTP 429 和 HTTP 200 内嵌 RPC 错误，以及两种桥接响应封装。
- 实测日额度消息和 details 保真、字符串中的数组符号与转义、禁止执行代码、未知错误安全回退。
- 已有每日重置分类仍能识别透传消息，未知 429 不升级为 daily_quota。

真实临时 429 和真实输入审核响应仍需自然采样验收；本次没有制造临时限流，没有更改限流匹配策略或生产冷却。

## 本地验证结果

- 定向命令 `node --test tests/makersuite-codec.test.js tests/makersuite-bridge.test.js tests/scheduled-request.test.js`：238 项通过，0 失败。
- 本次修改的 JS / JSON 文件 ESLint、全部新增和修改文件的 Prettier、`git diff --check` 通过。
- `npm test` 的前面各组通过；最后一组的 UI 测试并发争用 Vite 严格监听端口 5173，并出现测试进程未退出。本次未修改无关 UI 测试，改用下述串行命令检查最后一组。
- 全仓 `npm run lint` 未通过：既有 `docs/zh/fixtures/bero-flash38-tool-choice*.json` 与 `context-spread-benchmark-20261024.json` 有缩进和键排序问题。本次未改写这些历史证据文件。

最后一组使用的命令：

```sh
node --test --test-concurrency=1 --test-force-exit \
  tests/target-session-validation.test.js tests/account-login-browser.test.js \
  tests/accounts-page.test.js tests/frontend-unification.test.js tests/usage-history-ui.test.js
```

串行检查结果：52 项中 13 项通过、39 项按既有条件跳过，0 失败，退出码 0。
