# 管理端前端统一改造记录

日期：2026-10-23。依据 [前端统一改造方案](frontend-unification-plan.md) 实施，第一版采用浅色主题。

## 实现范围

- 新增 `AppShell`、`AppNavigation`：桌面文字侧栏、移动端抽屉、固定位置的语言与退出操作；导航使用本地 20px SVG。
- 新增 `PageHeader`、`PageState`、`MetricCard`，统一页头、初始加载、失败重试与指标展示。账号页将新增账号放在页头；没有选择时收起批量动作，有选择时仍说明跨页范围。
- `variables.less` 是主题变量来源，`element-overrides.less` 映射 Element Plus 的颜色、文字、边框、尺寸、圆角和浮层。保留旧 LESS 变量及暗色定义，管理端继续锁定浅色。
- 新增 `/usage`、`/logs`、`/settings`；保留 `/`、`/accounts`、`/proxy-pool`、`/login`、`/auth`。服务端新增入口沿用原鉴权中间件。路由是当前页面的唯一状态来源。
- 从 `StatusPage.vue` 拆出 `UsagePage.vue` 和 `LogsPage.vue`，保留原统计筛选、分页、导入导出、增量游标及存储说明。用量页保留挂载以保存筛选与页码，只有当前路由的业务数据参与工作区轮询。页面没有另建后台轮询。
- 日志按文本渲染，保留等级提示和下载，新增复制与跟随开关；阅读历史停止跟随，恢复跟随滚到末尾。离开日志页停止请求日志。
- 账号登录设置、节点池设置、系统配置分别使用 `useDraftGuard`，覆盖站内导航、浏览器返回和刷新；取消离开保留草稿，确认离开放弃草稿。查询参数与锚点变化不丢弃草稿。
- 配置页增加分组目录与固定保存操作区，正文限制 1040px；节点池运行操作与可展开设置区域分开。未改动配置版本冲突、密钥保留、独立模型启用提交、重启或代理绑定接口。
- 账号与节点池首次请求失败时显示失败与重试，不展示空列表；后台失败保留已有数据。服务临时失败保留工作区提示，401/403 和认证跳转仍进入登录。
- 登录控件统一为 Element Plus，显式绑定输入状态；原生 `POST /login` 和 `username`、`password`、`apiKey` 字段保持原协议。VNC 仅调整外围主题变量及语言监听清理，保留连接与画布行为。404 使用共同状态组件。
- 清理旧侧栏、浮动操作和内嵌账号列表的无引用样式；保留作者署名。`StatusPage.vue` 从 6,273 行缩减到约 1,800 行。

## 保存与生命周期核对

| 范围     | 保留的边界                                                                   |
| -------- | ---------------------------------------------------------------------------- |
| 系统配置 | 草稿 / 已保存 / 运行值、冲突、放弃、撤销待重启、单独重启                     |
| 模型配置 | 模型启用状态单独应用；层级权限仍随系统配置保存                               |
| 登录队列 | 编辑后单独保存；后台刷新不覆盖草稿；暂停动作独立                             |
| 节点池   | 设置草稿单独保存；节点、订阅和账号绑定仍按原接口操作                         |
| 账号选择 | 跨页选择、筛选全选和导出范围沿用同一状态；手机与桌面共用                     |
| 轮询     | 工作区统一调度及中止；账号列表仍由原组件管理自己的刷新；用量与日志不另启轮询 |

`useI18n` 支持监听注销，拆出的页面和新组件在卸载时清理监听。账号组件也处理了首次请求完成前卸载的场景，避免卸载后再创建定时器。

## 自动验证

| 检查                 | 最终结果                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm test`           | 通过；各 TAP 汇总共 498 个通过、39 个跳过、0 个失败或取消。另有节点池脚本断言通过。                           |
| 新增统一前端用例     | 3 个通过，无跳过。                                                                                            |
| 账号与配置浏览器回归 | 6 个通过，无跳过。                                                                                            |
| `npm run build:ui`   | 管理端及独立公开看板构建成功；仍有 Vite 大包体积提示。                                                        |
| 修改文件 ESLint      | 通过。                                                                                                        |
| `npm run lint:css`   | 通过。                                                                                                        |
| `npm run lint`       | 未通过；原有 `docs/zh/fixtures/argon-production-diagnosis-20261017.json` 存在 32 处键排序错误，该文件未修改。 |
| `git diff --check`   | 通过。                                                                                                        |

39 个跳过项来自未设置 `ACCOUNT_LOGIN_BROWSER_TEST_EXECUTABLE` 的可选登录浏览器用例；跳过不计入验证通过。Chromium 前端用例实际执行。

新增 `tests/frontend-unification.test.js`，验证以下行为：

- 六个管理入口直达、刷新、路由页头唯一；站内导航和浏览器返回。
- 三个编辑区的继续编辑与放弃离开，以及刷新事件保护。
- 日志文本安全、游标续传、手动阅读位置、恢复跟随、离开后停止请求。
- 首次请求失败、重试恢复，以及后台核心请求失败后保留工作区。
- 360、390、768、1280、1440px 无页面整体横向溢出；720px CSS 视口模拟 1440px 屏幕在 200% 缩放下的回流；弹窗 Escape、键盘打开及关闭后焦点返回。
- 中英文导航切换；新的 SPA 入口实际经过 Express 鉴权中间件。
- 服务失败与过期会话分别处理；用户名/密码和 API Key 分支实际发出原生表单 POST。

复用账号、配置、调度及节点池测试。账号测试改为通过可访问名称选择导航，不再依赖棋子图标或按钮序号。配置浏览器测试允许选择空闲端口，避免多文件运行时争用开发端口。

## 截图与视觉基线

截图全部使用模拟接口和合成数据，没有真实账号、密钥、Cookie 或上游请求。改造前截图从基线提交 `dd6e18c` 的原始前端源码在临时目录运行生成；改造后由新增浏览器用例生成。

| 页面   | 改造前桌面 / 手机                                                                                                                 | 改造后桌面 / 手机                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 概览   | [1440](fixtures/frontend-unification/before-overview-1440.png) / [390](fixtures/frontend-unification/before-overview-390.png)     | [1440](fixtures/frontend-unification/after-overview-1440.png) / [390](fixtures/frontend-unification/after-overview-390.png)     |
| 账号   | [1440](fixtures/frontend-unification/before-accounts-1440.png) / [390](fixtures/frontend-unification/before-accounts-390.png)     | [1440](fixtures/frontend-unification/after-accounts-1440.png) / [390](fixtures/frontend-unification/after-accounts-390.png)     |
| 节点池 | [1440](fixtures/frontend-unification/before-proxy-pool-1440.png) / [390](fixtures/frontend-unification/before-proxy-pool-390.png) | [1440](fixtures/frontend-unification/after-proxy-pool-1440.png) / [390](fixtures/frontend-unification/after-proxy-pool-390.png) |
| 用量   | [1440](fixtures/frontend-unification/before-usage-1440.png) / [390](fixtures/frontend-unification/before-usage-390.png)           | [1440](fixtures/frontend-unification/after-usage-1440.png) / [390](fixtures/frontend-unification/after-usage-390.png)           |
| 日志   | [1440](fixtures/frontend-unification/before-logs-1440.png) / [390](fixtures/frontend-unification/before-logs-390.png)             | [1440](fixtures/frontend-unification/after-logs-1440.png) / [390](fixtures/frontend-unification/after-logs-390.png)             |
| 配置   | [1440](fixtures/frontend-unification/before-settings-1440.png) / [390](fixtures/frontend-unification/before-settings-390.png)     | [1440](fixtures/frontend-unification/after-settings-1440.png) / [390](fixtures/frontend-unification/after-settings-390.png)     |

改造前截图为中文，改造后主截图为英文，另附 [中文概览](fixtures/frontend-unification/after-overview-zh-390.png)、[中文账号](fixtures/frontend-unification/after-accounts-zh-390.png)。[配置草稿](fixtures/frontend-unification/settings-draft.png) 与 [账号首次加载失败](fixtures/frontend-unification/accounts-load-error.png) 用于核对提示和保存边界。长列表、长文本及操作可达性由既有账号浏览器测试覆盖。

复现改造后截图：

```bash
FRONTEND_SCREENSHOT_DIR=/tmp/frontend-unification-screenshots node --test tests/frontend-unification.test.js
```

## 验收限制与后续工作

- 本轮浏览器与路由验证使用模拟接口，未验证真实 Google 登录、VNC 连接、Mihomo 进程或上游转发。相关真实服务验收仍需部署环境执行。
- 200% 缩放使用等效 CSS 视口验证布局回流；浏览器原生缩放与手机软键盘需要人工复核。未自动声称所有颜色组合都达到对比度标准。
- 原节点池和配置表单中已有的中文业务文案及后端配置描述仍需后续完整国际化；本轮新增公共框架、状态提示和描述均集中使用语言资源。
- 用量专用表格、筛选与分页内部实现继续保留；后续可在相同行为测试下逐步迁移剩余原生控件。没有为每个表格或表单再建立一套包装框架。
- 公开看板未整体改造，仍独立构建；未引入管理端导航或会话。构建产物由构建命令生成，未手工编辑。
