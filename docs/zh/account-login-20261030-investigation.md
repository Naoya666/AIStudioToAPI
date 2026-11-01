# 2026-10-30 批量登录失败复查

2026-11-01 通过 SSH 只读检查 meow_jp 的任务历史和失败截图，并使用独立浏览器运行合成页面实验。未重启、替换生产服务，未重试真实账号登录。

## 版本与任务

生产容器镜像 revision 为 `b8e3540a6592654c5ec2769e17ca67ec21ce1d11`。`TargetSessionValidator.js`、`LoginPageHandlers.js` 和 `TargetServiceValidation.js` 的 SHA-256 与本次排查开始时的本地文件一致，包含上次 Drive 提示修复及 `termsControls` 诊断。

北京时间 10 月 30 日 22:06:50 左右提交的 8 个任务最终 6 成功、2 失败。尝试历史有 4 次 `ui_click_timeout` 和 1 次 `service_permission_required`；同一个授权误判账号在 22:24 再次登录仍报授权错误，22:36 后重新提交的任务最终成功。

## Drive 提示遗漏变体

两次失败任务分别为 `63a18694-b327-46ea-b4a4-e112b4b525cc`、`6b940927-c4cd-4da6-a900-913deac0aaa2`。截图均显示：

```text
Allow Drive access to see your recent prompts.
```

上次修复只排除 `recent apps`，没有排除 `recent prompts`。因此这次仍是最近项目导航提示触发整页文字匹配，不能据此证明模型调用需要 Drive 授权。

本次本地补丁明确覆盖 `apps` 和 `prompts` 两种已观察到的提示，不扩大到任意 Drive 文案。两个登录验证阶段共用此规则，真正的 `Allow Drive access` 授权要求仍会阻止提交。

使用生产 Camoufox、合成页面验证 5 种情况：apps 提示、prompts 提示、跨行 prompts 提示、真正授权要求、提示与真正授权要求并存。现行代码误判两种 prompts 页面，补丁全部符合预期。新增完整 Worker 回归覆盖 prompts，包含身份核验及目标连接验证。

## 协议点击超时的证据边界

涉及 `33a1728a-6a5b-4a81-84be-40d1c74d1c02`、`c75968f6-82ef-4bc5-87a5-164e44637530`、`6e4f5b80-33ab-4110-a5c1-fc40b0aa2725`。4 次失败的关键诊断一致：

- 必选项 `labelPresent=true`、`recognizedRequired=true`、`checkedBefore=false`，未被可选项规则跳过。
- 执行必选项点击之后、确认点击之前，`checkboxStates[0].checked=false`，`disabled=false`。
- `confirmationEnabled=false`；随后在 `terms_confirm` 阶段等待约 25 秒，返回 `ui_click_timeout`。
- 未遮罩的截图确认必选复选框未勾选，继续按钮仍禁用。

这排除了“必选标签没有被识别”作为本批直接原因。当前逻辑只等待 `click()` 完成，没有以已勾选状态作为动作后置条件，因而仍会继续尝试点击禁用的确认按钮。

现有采集点不能区分“点击未生效”和“点击生效后被页面重置”。在生产 Camoufox 上按现有随机位置点击普通复选框 20 次均成功，不能据此将真实故障归因于 Camoufox、随机位置或某种 Google DOM 结构。最初排查只补齐 Drive 文案，随后按用户要求增加以下协议交互修复。

协议必选项改为 Playwright 幂等 `setChecked(true)`，使用默认点击点并验证结果。确认提交要求已识别必选项保持勾选、按钮启用至少 250 毫秒，并在交互停顿后再次复查；未满足条件时在原步骤期限内最多三轮重新识别与处理，禁止把可选订阅或替换后的未知控件自动勾选。持续失败返回 `terms_or_consent_required`，不再盲等禁用按钮。诊断增加每次勾选前后状态及操作结果。

## 本次验证与交付范围

Drive 修复的 3 项针对性 Firefox 浏览器回归、登录流程与目标验证测试、相关 ESLint、格式和 diff 检查通过。生产同款 Camoufox 的 5 项 Drive 合成页面验证通过。协议修复新增漏点、输入节点替换、提交前状态回退、持续勾选失败、交互停顿期间授权变化/取消/期限耗尽的回归；完整 `npm test` 及 Camoufox 的 8 项针对性用例通过。这些检查没有发起真实模型生成，不代表该批账号的真实模型调用已经验收。

补丁仅修改本地工作区，尚未部署到 meow_jp。
