# Playground 移除鼠标保活实施要求

日期：2026-10-30（Asia/Shanghai）。状态：源码已实现，离线回归通过，静态检查限制见文末；尚未生产部署，也未完成线上观察和长期空闲验证。

## 目标与决定

在 Playground 运行路径中去除模拟鼠标保活及随机滚动，并取消鼠标动作成功作为 context 就绪、初始化成功和重连成功的必要条件。

保留页面初始化、必要弹窗处理、WAA 初始化、Cookie 保存、真实传输故障检测与恢复。鼠标动作超时不再成为关闭 context、强制结束消息队列或重建浏览器上下文的原因。

这项改动解决的是旧保活机制主动打断业务的问题，不承诺同时解决 RPM、日额度耗尽、预热替换周转、生成超时或缺少 finish reason。

## 背景与证据

旧 Build App 路径为处理遮罩及相关会话问题引入定时输入动作。迁移 Playground 后，这套动作仍在运行，但其必要性尚未得到验证。

当前审查基线为 AIStudioToAPI `2caf8f0`：

- `_startHealthMonitor` 每4秒执行一次，30%概率滚动及随机鼠标移动，每15个 tick 再移动到 `(1,1)`。
- Playground 的提前返回位于输入动作和认证保存之后、旧遮罩清理之前。它跳过遮罩清理，却继续执行鼠标保活。
- `_handleRequiredMouseFailure` 在动作失败后设置 RECONNECTING/draining，等待约5秒再关闭 context；在途队列未结束时会被强制关闭。
- 初始化在 Playground bootstrap 和传输注册后，仍执行 `required_mouse`；`isContextReady` 还读取 `mouseReady`。

meow_us 在北京时间22:32:31改为12 contexts、每账号/context并发7、总并发84之后，截至22:41:53出现17次保活失败、1次 `required_mouse / mouse.move.3` 初始化超时，以及14次强制关闭队列事件、合计62个队列条目。队列条目不是去重后的失败请求数。这些证据证明当前保活失败处理会损害业务，尚不能单独证明12 contexts是页面超时的根本原因。

证据：[12×7复查记录](../../../../../infra/diagnostics/meow-us-12x7-watch-20261030/README.md)。本机规范路径为 `/home/dev/workspace/infra/diagnostics/meow-us-12x7-watch-20261030/README.md`；迁移文档时可用该路径定位。

## AIStudio2API 参考

审查本地 `../AIStudio2API` 的 `bd6c40f`，参考其原生 Camoufox 路径，而非仅参考不依赖浏览器的其他运行模式：

| 功能         | 参考实现                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| 启动遮罩     | `internal/camoufoxnative/page.go` 的 `dismissKnownOverlays`，由 bootstrap 调用，处理已知欢迎、引导和 Cookie 提示 |
| 生成所需交互 | `proofFunction` 按请求更新提示词并触发 input/change，调用已取得的官方 WAA service；没有后台鼠标定时器            |
| Cookie 维护  | `internal/aistudio/service.go` 的 `doBrowserPrepared` 读取浏览器 Cookie，并写回账号持久状态                      |
| 空闲回收     | `internal/app/runtime.go` 仅回收超过热池目标的空闲 worker，并非定期重建所有驻留页面                              |
| 鼠标输入     | 登录及人工控制路径仍有鼠标动作，与后台保活分开                                                                   |

参考项目没有定时鼠标保活，支持移除这项要求；它不是当前部署长期空闲会话有效性的实测证明。两项目的浏览器进程组织和并发方式不同，不照搬全部生命周期实现。

## 实现范围

主要文件为 `src/core/BrowserManager.js`，同时审查 `PlaygroundTransport.js`、连接生命周期和相关测试。

### 1. 后台任务

- 去除 Playground 的 `monitor.scroll`、随机 `_simulateHumanMovement` 和每分钟移到 `(1,1)` 的动作。
- 去除 Playground 因保活输入动作失败而进入 `_handleRequiredMouseFailure` 的路径。
- 不用周期性 `bringToFront`、focus、点击、键盘输入、刷新页面或探测生成替代鼠标保活。
- 将认证保存与输入动作分离，保留现有约24小时认证保存功能及生命周期清理。不能简单把 Playground 的 return 提到函数开头，连同认证保存一起跳过。
- 如果拆分定时器，确保重连、重复启动、关闭 context、浏览器恢复和整体退出都会清理旧 owner 的定时器，避免重复保存或旧任务影响替换 context。

### 2. 初始化与就绪判定

- 去除前台初始化 `page_wakeup` 内的模拟鼠标移动。
- 去除 bootstrap 后的 `required_mouse` 阶段及其强制动作。
- 取消 Playground 的 `mouseReady` 就绪门槛及相关状态传递；不以硬编码 `mouseReady=true` 掩盖遗留依赖。
- READY 仍要求页面有效、bootstrap成功、当前 owner/generation 有效、传输已注册且可用，并通过现有发布前资格校验。
- 原有前台 focus/bringToFront 是否必要应单独核对调用目的；本任务不增加后台焦点争抢，也不将它们设为新的保活门槛。

### 3. 重连与遗留入口

- 去除 Playground 轻量重连成功之前的强制鼠标移动，保留导航、页面/认证检查、bootstrap、传输注册和 owner/资格复核。
- 搜索所有 `_simulateHumanMovement`、`required_mouse`、`mouseReady` 和后台唤醒入口，覆盖前台/后台初始化、重连和浏览器整体恢复。
- 旧 WebSocket 初始化等待、Rocket/Launch 唤醒等兼容路径若仍存在，应明确其可达条件，保证 Playground 无法间接执行旧保活动作；仅用于旧路径且已不可达的死代码可随本任务清理。
- 登录、必要按钮点击、用户主动操作不属于本次去除范围。

### 4. 保留的会话维护与恢复

- 保留 Playground bootstrap 的已知启动弹窗处理和官方页面所需输入/提交行为。
- 保留 Cookie/origins 保存及真实认证失效处理，不把 Cookie 提示等同于登录失效。
- 保留页面关闭、传输断开、WAA运行环境失效等实际故障的检测和恢复，沿用 owner/generation、冷却资格及取消校验。
- 真实故障的恢复继续遵守现有请求和消息队列生命周期约束；本次不通过放开所有 READY 校验来消除报错。
- 现阶段没有证据要求新增 Playground 周期遮罩清理；若后续确实观测到阻塞业务的遮罩，按具体页面条件处理并记录原因。

## 验收标准

### 离线回归

更新原来强制要求 `mouseReady=true` 或鼠标动作成功的测试，重点验证行为：

1. Playground 前台/后台初始化、轻量重连和整体浏览器恢复不调用鼠标移动或保活滚动；可将这些动作设置为调用即报错，确保测试确实覆盖路径。
2. bootstrap失败、页面关闭、传输未就绪、owner/generation过期时仍不能发布READY；删除鼠标要求不削弱这些约束。
3. 后台任务不因模拟输入而关闭context、取消传输或强制结束队列；独立的认证保存仍可执行，关闭/替换后旧任务停止。
4. 真实连接故障、认证失效、额度排空及重连取消行为保持正确；旧异步回调不能影响替换context。

优先更新 `browser-recovery.test.js`、`browser-workers.test.js`、`context-reconnect-lifecycle.test.js` 和相关传输测试。先跑针对性回归，再按项目要求完成完整测试及修改文件的格式、静态检查。无需为纯注释或文档镜像实现细节增加测试。

### 运行验证

部署前检查当前挂载、数据、数据库和备份，保存可回退镜像/版本及配置。验证期间固定实际生效的context数、并发、预热目标和代理策略，记录应用实例及配置应用时间。

- 在正常业务下观察至少30分钟：确认没有新的鼠标保活调用、`required_mouse` 初始化阶段或由该路径触发的强制关闭队列。
- 统计READY+BUSY、DRAINING、INITIALIZING、关闭原因、初始化耗时、队列等待及请求结果，与原窗口比较。鼠标报错消失本身不等于吞吐改善。
- 分开记录RPM、长期额度限制、504、缺少finish reason及真实传输故障，避免把全部重建或失败归因于同一原因。
- 对隔离测试账号验证至少2小时完全无业务后首次请求；条件允许继续观察24小时。记录是否跳转登录、Cookie状态变化、WAA可用性和恢复结果，输出聚合结果，不导出Cookie值或请求原文。
- 真实故障恢复不得依赖重新开启鼠标保活。若长时间空闲确实失效，先识别认证、WAA或页面状态原因，再确定针对性恢复策略。

## 交付与回退

实现交付应包含源码变更、针对性回归结果、完整检查结果及部署后的固定观察窗口。文档编写与源码实现、生产部署分别记录状态。

若部署后出现可复现的会话或传输回归，保留日志、配置、当前账号/冷却状态并回退镜像；不恢复旧数据库覆盖持续写入的数据，不清空冷却，也不通过高频重试消耗账号额度。

完成标准：Playground所有运行入口不再依赖鼠标保活，认证保存和真实故障恢复继续工作，回归检查通过，并明确记录长期空闲验证的已完成范围和剩余不确定性。

## 实施记录（2026-10-30，Asia/Shanghai）

源码变更：

- Playground 前台/后台初始化和轻量重连均已移除模拟鼠标动作；不再设置、传递或读取 `mouseReady`，也不再进入 `required_mouse` 初始化阶段。
- Playground 使用独立的24小时认证保存定时任务，复用原 `healthMonitorInterval` 清理槽位；不运行4秒输入保活或周期遮罩清理。定时回调检查 owner、generation 和当前定时器身份，避免重复启动或旧回调操作替换 context。重连会停止所有目标账号的旧定时器，成功后重新启动。
- READY 发布增加页面、bootstrap 后传输状态、连接 OPEN 状态及注册连接身份校验；保留原初始化 attempt、generation、取消和池资格检查。就绪查询也检查 Playground 传输状态及连接身份。
- 旧 WebSocket 等待仅由非 Playground 轻量重连分支调用，并显式拒绝 Playground 页面；旧 Rocket 后台入口在启动及每轮执行前排除 Playground。保留旧路径鼠标辅助方法，旧鼠标失败处理也明确排除 Playground，防止迟到回调关闭其 context。
- 原前台 `bringToFront`/focus 仅用于用户切换账号时的页面激活，继续只在前台初始化执行；没有新增后台焦点或输入任务。Playground bootstrap 的必要弹窗、输入和提交逻辑保持原有实现。
- 初始化后的异步认证保存补充 owner 检查；认证快照完成后的原有 owner 检查继续阻止旧凭据写入。

离线检查：

- 初始化/恢复/连接生命周期回归：`node --test --test-concurrency=1 tests/browser-recovery.test.js tests/context-reconnect-lifecycle.test.js`，60项通过。
- Worker 回归：`node tests/browser-workers.test.js`，93项通过。
- 传输及桥接回归：上述初始化/生命周期测试与 `tests/playground-transport.test.js`、`tests/makersuite-bridge.test.js` 联合执行，104项通过；随后新增的旧入口守卫另经60项初始化/生命周期回归验证。
- 本次修改的 JS 文件通过 ESLint；CSS 全量检查 `npm run lint:css` 通过。
- `npm run lint` 被6个未修改的 JSON fixture 中既有的1721项格式及键排序错误阻挡，文件位于 `docs/zh/fixtures/bero-flash38-tool-choice*.json`、`docs/zh/fixtures/context-spread-benchmark-20261024.json` 和 `tests/fixtures/mixed-zero-capacity.json`。
- 完整测试 `npm test` 返回0：累计800项，758项通过、42项跳过、0项失败。跳过项为未设置 `ACCOUNT_LOGIN_BROWSER_TEST_EXECUTABLE` 的可选真实浏览器登录测试。
- 本次修改的源码、测试及本文通过 Prettier 格式检查；`git diff --check` 通过。

部署及运行验证：未部署，没有修改实际实例配置、账号状态或数据库。正常业务至少30分钟观察、隔离账号至少2小时完全无业务后首请求以及可选24小时观察均未执行；长期空闲后认证和 WAA 可用性仍需按上文固定配置窗口验证。离线回归通过不代表线上吞吐已改善。
