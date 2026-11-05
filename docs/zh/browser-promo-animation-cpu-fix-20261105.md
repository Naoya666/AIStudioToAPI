# 浏览器推广卡片动画高 CPU 修复方案

日期：2026-11-05（Asia/Shanghai）。状态：**代码修复已实现，离线 Firefox 验证通过；尚未部署或完成 bero 真实验收**。本文保留根因证据、实施边界和生产验收方案，不能把离线通过视为线上 CPU 问题已经解决。

## 实施记录

- `src/core/PromoAnimationPause.js` 使用下文的定向 CSS 暂停卡片及其伪元素动画。只处理 `aistudio.google.com` 顶层文档，按专属 style ID 去重；兼容文档已就绪和初始无根节点的情况，仅在必要时注册一次性 `DOMContentLoaded` 监听，无轮询或持续 DOM 观察。
- `BrowserManager._initializeContext()` 在业务 context 创建后、`newPage()` 前单独注册该脚本，沿用初始化超时与取消管理。普通装饰脚本注册或插入失败只输出简短诊断；现有 RPC 超时、取消和过期初始化保护仍生效。隐私脚本、登录浏览器和 local 后端未增加该处理。
- `npm run test:browser:promo` 使用实际 Playwright Firefox 和完全拦截的合成页面，不访问 Google 或读取账号。已验证卡片与两个伪元素动画处于 `paused` 且时间不再前进、无关动画继续、计时器继续、布局稳定且可点击，以及延迟插入、重复安装、reload、完整导航、不同域、同域及跨域子 frame、新 context 的行为。
- `tests/browser-recovery.test.js` 增加注册先于页面创建、注册失败仍可 READY 的回归检查。浏览器恢复、重连生命周期、运行时监督和 local 后端相关测试一并回归。

离线测试需要先安装 Playwright Firefox（`npx playwright install firefox`）。本次环境没有 Camoufox 可执行文件，因此没有验证 Camoufox 或真实推广卡片，也没有进行生产切换、真实 CPU 采样、生成链路和权益路径验收。以下 bero 验收与发布步骤仍待执行；修改后需要重建业务 context 才会生效。

## 问题与证据

bero 从 `8689bce` 升级至 `feat/local-browserless-backend` 的 `d4585bc` 后，用户将后端从 local 切回 browser，整机 CPU 持续约 25%～30%，此前约 4%。检查时两个 context 均 READY，PG / Build 无在途或排队请求；主要开销位于 Camoufox 的 Renderer、渲染后端及 Web Content 线程。

新旧镜像的 `camoufox` 和 `libxul.so` SHA256 分别一致，浏览器二进制未改变。当前浏览器配置禁用硬件加速，由 CPU 承担渲染开销。

其中一个账号的 Google AI Studio 页面出现「领取免费 API 赠金」推广卡片，外圈彩色渐变边框无限旋转：

![触发持续重绘的推广卡片](fixtures/bero-promo-card-20261105.png)

- 元素：`DIV.promo-card-wrapper.ng-star-inserted.xap-tour-element-active`。
- 观测动画名：`_ngcontent-ng-c2440170046_rotate-promo-card-border`。
- 周期：40,000 ms；次数：`Infinity`；状态：`running`。
- 另一个 context 没有该动画。

对同一实例仅执行该动画的 `pause()` / `play()`，每阶段采样约 10 秒：

| 状态       | 容器 CPU（100% 为一核） | 折算整机 CPU（4 核） |
| ---------- | ----------------------: | -------------------: |
| 原动画运行 |                 105.52% |               26.38% |
| 动画暂停   |                   9.38% |                2.34% |
| 动画恢复   |                 106.00% |               26.50% |

期间 requests 表新增记录为 0。该可逆对照确认了当前高负荷的直接原因：推广卡片装饰动画触发持续渲染。测试后已恢复动画并关闭临时 Node inspector。

切回 browser 会重建页面，但没有旧版当时页面的动画快照，不能断言旧版没有推广卡片，也不能仅凭时间关联认定新分支源码引入了动画。这里修复的是已经复现的页面渲染开销。

## 修复目标与范围

在 browser 业务 context 中定向停止这张推广卡片的装饰动画，使无业务请求时的 CPU 接近暂停动画后的水平。保留卡片静态显示、页面布局、点击行为、WAA、认证与业务 RPC。

local 后端不创建此业务页面，无需安装该处理。不要把规则推广至账号交互登录浏览器、第三方站点或所有 frame。

## 建议实现

### 1. 使用局部样式停止动画

优先通过浏览器页面样式覆盖处理，无需删除卡片、伪造用户点击或修改 Google 返回的脚本。起始规则可采用：

```css
.promo-card-wrapper,
.promo-card-wrapper::before,
.promo-card-wrapper::after {
  animation-play-state: paused !important;
}
```

选择 paused 是为了接近已经验证的“停止动画、保留元素”行为；不要顺便移除元素的背景、变换或边框。伪元素规则用于覆盖同一卡片的装饰层，实际效果仍须在 Firefox 中验证。

**上面的 CSS 是待验证方案。已有 CPU 对照使用的是 Web Animations API 的 `pause()`，不能直接把对照结果作为 CSS 修复通过的证据。** 实施时检查目标动画确实停止，且 Renderer CPU 随之下降。如果 CSS 未覆盖实际动画来源，再针对观测到的装饰动画采用有边界的 `pause()` 处理，不直接扩大成全站动画禁用。

使用 `.promo-card-wrapper`，避免写死 `_ngcontent-ng-c2440170046` 等 Angular 构建编号，也不按中文广告文案匹配，以免受构建版本或语言影响。该类名仍是上游页面实现细节，未来改名后可能失效，需要保留诊断方法。

### 2. 随每次业务页面初始化安装

建议接入 `src/core/BrowserManager.js` 的 `_initializeContext()`：在业务 browser context 创建后、`context.newPage()` 前注册专用 `context.addInitScript()`。保留现有初始化超时与取消管理，与隐私脚本分开维护。

注入逻辑应满足：

1. 仅在 `location.hostname === "aistudio.google.com"` 且为顶层文档时执行。
2. 使用专属 style ID，例如 `aistudio-promo-animation-pause`；重复安装保持幂等，不新增重复节点。
3. 在 head 或 documentElement 可用时插入规则；若文档结构尚未建立，使用一次性的文档就绪处理。初始化脚本还应覆盖已就绪状态，不能仅等待可能已经发生的事件。
4. CSS 选择器自动匹配稍后由 SPA 插入的卡片，通常不需要持续扫描 DOM。不要为等待卡片设置高频轮询或长期全 DOM MutationObserver。
5. 完整导航、reload、新 context 和重连后由初始化脚本重新安装。若实测页面会移除该 style，再增加针对 style 所在父节点的有限监听，并在页面关闭时释放。
6. 卡片不存在时无副作用，不能影响 context READY、认证判断或账号冷却。装饰样式失败不应单独令账号失效；按现有日志方式记录简短诊断，不输出 DOM 正文或认证信息。

只在导航后调用一次 `page.addStyleTag()` 不足以覆盖后续完整导航；只暂停当前已经存在的动画也不足以覆盖 SPA 稍后插入的卡片。

### 3. 保持修改边界

不要全局禁用 JavaScript、`requestAnimationFrame`、计时器或所有 CSS 动画，也不要修改 WAA 脚本、浏览器指纹及资源请求。避免通过阻断未知 Google 域名、降低全局计时精度或强制后台节流来处理该问题，这些操作扩大了对认证和生成链路的影响。

`prefers-reduced-motion` 只能作为可选补充，上游页面是否遵循尚未验证。CPU 配额限制也不能代替修复：它会同时限制初始化、签名及生成处理能力。

## 验收标准

### 离线页面检查

使用实际 Firefox / Camoufox 和合成页面，验证：

- 与实测结构相同的卡片装饰动画停止；无关元素动画继续运行，页面 JavaScript 与计时器仍工作。
- 初次加载和延迟插入卡片均生效；reload、完整导航及新 context 后规则仍生效。
- 卡片仍显示、布局稳定且可以点击；同一卡片的伪元素装饰被覆盖。
- 重复安装仅产生一个 style；无卡片页面、非目标域和子 frame 不受影响；关闭页面后无遗留轮询或监听任务。

这些测试验证处理范围和生命周期，不能替代真实 Google 的 CPU 与生成验收。

### bero 真实验收

1. 依照生产变更规则先检查挂载、数据库、备份和在途任务，保留当前镜像与独立回退快照；先在隔离实例验证，再切换生产。
2. 固定同一账号、页面及 context 数量，对比修复前后 CPU。初始化结束且队列空闲后，每组采样至少 60 秒，至少重复两组，同时检查进程线程和请求记录，排除业务流量影响。
3. 必须看到推广动画停止、Renderer 持续忙碌消失，并在页面重建后仍有效。以相同条件的暂停动画对照作为基准，不能仅依赖某个瞬时 CPU 值；此前 2.34% 是一次 10 秒观测，不是所有环境的固定承诺。
4. 在 browser 后端复验 PG 非流式 / real SSE、Build 普通及 anti、合成 `build-st`；检查正文、结束原因、用量和请求次数，确认没有新增重试、认证错误或重复统计。另复验受保护模型的权益路径；需要交互登录时单独安排测试，不能由生成成功推断登录已通过。
5. 实际执行 browser→local→browser 切换，确认规则只随业务 browser 页面安装，local 仍无业务浏览器进程，切回 browser 后仍能抑制该装饰动画。
6. 最终确认没有残留调试端口、临时容器或高频诊断任务，记录真实验证范围和未测事项。

## 发布与回退

建议作为独立、范围明确的浏览器页面修复发布，不改变默认后端、账号权限、并发、Cookie、模型映射或备份保留策略。修改初始化代码后需要重建 context 或重启服务才能应用；必须先处理在途请求。

回退时撤销样式注入并重建业务 context，或恢复变更前镜像。仅从当前页面移除 style 不能取消已注册的初始化脚本，后续导航仍可能重新安装。不得为回退装饰样式恢复旧数据库、认证文件或整份配置。

如需验证 CPU 原因，可在隔离环境恢复动画做对照；不要求生产长期恢复高负荷。只有完成上述实现和真实验收后，才能把本方案状态改为“已修复”。

## 证据位置

控制机：`/home/dev/workspace/infra/aistudio-bero/browser-cpu-20261105/`，包含 `comparison.json`、`pages-before.json`、`pages-pause.json`、`pages-restore.json`、截图及诊断脚本。故障记录为 `/home/dev/workspace/infra/issues/bero-browser-renderer-cpu-20261105.md`。

服务器受限目录：`/opt/aistudio-browser-cpu-20261105`。本截图仅截取推广卡片，未包含账号信息或聊天正文；后续记录同样不得包含 Cookie、proof、认证头或业务内容。
