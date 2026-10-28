# AIStudioToAPI（二次开发版）

中文文档 | [English](README_EN.md)

将 Google AI Studio Build App 网页端封装为兼容 OpenAI、Gemini 和 Anthropic 格式的 API，通过浏览器自动化转发请求，并提供账号、模型调度、代理节点及用量管理界面。

本仓库是基于 [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI) 二次开发的独立维护版本，非上游官方版本。上游进一步基于 [Ellinav/ais2api](https://github.com/Ellinav/ais2api) 开发。本版本保留上游署名和许可说明，沿用 **CC BY-NC 4.0**，仅限符合许可证的非商业用途。

抗截断文本传输：支持 `anti-` 模型前缀、请求级覆盖及独立全局策略，兼容非流式和 fake/early/real。默认 off，范围及限制见 [使用说明](docs/zh/anti-truncation.md) 和 [实施验证记录](docs/zh/anti-truncation-implementation.md)。

## 功能与本版本改动

继承上游的多协议 API、浏览器自动化、多账号会话、工具调用、图片及语音模型支持，具体可用能力取决于账号权限和上游模型。

本版本的主要扩展：

- **账号管理**：独立账号页面，支持账号凭据、Cookie、CSV 和验证器导入，筛选、批量选择、登录队列、失败诊断及过期会话恢复。
- **模型感知调度**：按账号 × 模型维护额度与冷却，支持并发控制、排队、资源分配、错误重试和每日冷却重置。
- **代理节点池**：集成 Mihomo，管理节点及账号出口绑定，支持在首次登录前指定出口。
- **实时用量统计**：记录请求成功率、模型用量、延迟和调度状态，统计存储于 SQLite。
- **匿名公开看板**：可选的独立端口只读页面，展示聚合用量及分模型时间窗口统计。
- **提前发送空首块**：OpenAI Chat Completions 可立即收到空正文开始块，等待期间保活，结果就绪后整段填充；详见[使用说明](docs/zh/early-empty-chunk-streaming.md)。
- **可视化配置**：控制台保存管理配置，显示生效状态及待重启项，配置随数据目录持久化。
- **界面改进**：账号、节点及状态页面的移动端布局与批量操作体验优化。

## 快速开始

推荐使用 Docker Compose 从本仓库源码构建。本版本的部署示例使用本地镜像 `aistudio-to-api:local`。

### Docker Compose 本地构建

需要 Docker Engine / Docker Desktop 和 Docker Compose v2。容器镜像支持 Linux amd64、arm64；Dockerfile 会下载 Node.js 基础镜像、系统依赖、Camoufox 和 Mihomo，首次构建需要访问对应下载源。

```bash
git clone https://github.com/Naoya666/AIStudioToAPI.git
cd AIStudioToAPI
cp .env.example .env
```

编辑 `.env`，至少设置自己的 API 密钥和控制台密码：

```dotenv
API_KEYS=replace-with-your-api-key
WEB_CONSOLE_USERNAME=admin
WEB_CONSOLE_PASSWORD=replace-with-your-console-password
TZ=Asia/Shanghai
CHECK_UPDATE=false
```

不要使用示例密码。`CHECK_UPDATE=false` 用于关闭继承自上游的版本检查，本版本通过拉取源码和重新构建更新。

```bash
docker compose up -d --build
docker compose logs -f app
```

浏览器访问 `http://localhost:7860`，使用配置的控制台用户名和密码登录，然后添加 Google 账号。

仓库中的 [docker-compose.yml](docker-compose.yml) 会：

- 通过 `build: .` 构建当前源码，使用本地镜像标签。
- 从 `.env` 注入配置，并使用 `init: true` 回收子进程。
- 将 `./configs/auth` 挂载到 `/app/configs/auth`，保存登录会话。
- 将 `./data` 挂载到 `/app/data`，保存账号数据库、统计、调度、节点和管理配置。
- 默认仅将管理/API 端口映射到宿主机 `127.0.0.1:7860`。

远程部署可通过 SSH 隧道访问，或配置 [Nginx 反向代理与 HTTPS](docs/zh/nginx-setup.md)。需要直接通过服务器 IP 访问时，将 Compose 端口映射改为 `7860:7860`。如果修改容器内 `PORT`，需同步修改映射的容器端口。

### 使用 Docker 命令构建

在仓库根目录准备好 `.env` 后执行：

```bash
docker build -t aistudio-to-api:local .
mkdir -p configs/auth data
docker run -d \
  --name aistudio-to-api \
  --init \
  --env-file .env \
  -p 127.0.0.1:7860:7860 \
  -v "$(pwd)/configs/auth:/app/configs/auth" \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  aistudio-to-api:local
```

以上多行命令适用于 Bash；Windows 用户建议使用 Docker Compose。

### 本地源码运行

需要 Node.js **22.13.0 或以上**，建议使用与 Dockerfile 一致的 Node.js 24。完整的自动登录队列依赖 Linux `/proc` 和 POSIX 进程组，建议在 Linux 或 Docker 中运行。

```bash
git clone https://github.com/Naoya666/AIStudioToAPI.git
cd AIStudioToAPI
npm install
cp .env.example .env
```

编辑 `.env` 设置密钥和控制台密码，然后运行认证设置脚本：

```bash
npm run setup-auth
npm start
```

设置脚本会检查依赖、下载 Camoufox，并引导登录，认证文件保存到 `configs/auth/`。已有 Camoufox 时，可通过 `CAMOUFOX_EXECUTABLE_PATH` 指定程序路径。本地源码运行不提供容器内的 VNC 环境；节点池需要自行安装 Mihomo 并设置 `MIHOMO_PATH`，Docker 镜像已包含该程序。

`npm start` 会构建管理界面及公开看板。前端已经构建且源码未变化时，可用 `npm run quick-start` 启动服务。源码运行的数据位于仓库的 `data/`，不是宿主机根目录 `/data`。

## 自建 Build App

想使用自己的 App，可在 Google AI Studio Build 网页端上传与部署版本一致的 [build.js](scripts/client/build.js) 和 [index.html](scripts/client/index.html)，再发送[可直接复制的完整提示词](docs/zh/build-app-prompt.md)。提示词要求复用原客户端协议、保留作者信息，并实际创建项目文件及执行编译检查。

创建后，将 `src/core/BrowserManager.js` 中的 `this.targetUrl` 改为自己的 AI Studio App 页面地址，重建并重启服务。完整步骤见[自建 Build App 教程](docs/zh/build-app-guide.md)。编辑器预览缺少账号身份注入和本地 WebSocket 服务，身份等待或连接失败不等于编译失败；接入后需分别验证握手、真实连接及 API 请求。

## 添加账号

访问控制台的 `/accounts` 页面，可选择：

- **凭据登录**：保存邮箱、密码及可选 TOTP 验证器密钥，通过后台队列登录；支持 CSV 导入和批量重新登录。
- **Cookie 导入**：上传已有的认证 JSON，或将认证文件放入挂载的 `configs/auth/` 目录。
- **VNC 人工登录**：Docker 部署可使用 `/auth` 登录入口，完成人工验证并保存会话。

自动登录不能保证通过 Google 的所有验证；出现验证码或其他人工挑战时，需按控制台提示处理。需要固定出口的账号，可先在节点池保存绑定，再发起登录。

账号密码、TOTP 和 Cookie 属于敏感信息；本版本的凭据采用受限本地明文存储。不要提交或分享 `.env`、`configs/auth/`、`data/`、账号导出文件或登录截图。完整说明见 [账号自动登录与会话恢复](docs/zh/account-auto-login-operations.md)。

## 使用 API

| 协议            | Base URL                       | 常用接口                                                                              |
| --------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| OpenAI 兼容     | `http://localhost:7860/v1`     | `/chat/completions`、`/responses`、`/embeddings`、`/models`                           |
| Gemini 原生格式 | `http://localhost:7860/v1beta` | `/models`、`/models/{model}:generateContent`、`/models/{model}:streamGenerateContent` |
| Anthropic 兼容  | `http://localhost:7860/v1`     | `/messages`、`/messages/count_tokens`                                                 |

先查询当前模型列表：

```bash
curl http://localhost:7860/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

将下面的 `MODEL_ID` 替换为列表中的模型名：

```bash
curl http://localhost:7860/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

更多协议、流式请求、图片、语音和工具调用示例见 [API 使用示例](docs/zh/api-examples.md)。

## 配置

完整环境变量见 [.env.example](.env.example)。常用配置：

| 配置                                                 | 用途                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `API_KEYS`                                           | 客户端访问密钥，多个值用逗号分隔；未设置时会使用上游默认密钥 `123456`，部署时应显式设置 |
| `WEB_CONSOLE_USERNAME` / `WEB_CONSOLE_PASSWORD`      | 控制台登录；均未设置时回退到 API 密钥鉴权                                               |
| `PORT` / `HOST`                                      | 服务监听端口与地址，默认 `7860` / `0.0.0.0`                                             |
| `TZ`                                                 | 日志和显示时区                                                                          |
| `SECURE_COOKIES`                                     | HTTPS 部署时可设为 `true`                                                               |
| `CHECK_UPDATE`                                       | 继承自上游的版本检查，本地构建部署保持 `false`                                          |
| `PUBLIC_DASHBOARD_ENABLED` / `PUBLIC_DASHBOARD_PORT` | 启用独立匿名看板及其端口，默认关闭 / `7861`                                             |
| `CAMOUFOX_EXECUTABLE_PATH` / `MIHOMO_PATH`           | 本地源码运行时的浏览器和代理程序路径                                                    |

控制台已保存的管理配置优先于对应环境值。修改 `.env` 后，如对应设置已在控制台保存，需要在控制台修改或恢复环境值；Compose 环境配置变更需要重新创建容器。管理配置存于 `data/managed-config.json`。

账号层级模型权限可在控制台统一配置中编辑，保存后立即生效。首次初始化仅限制 Free 调用 `gemini-3-flash-preview`、`gemini-3.6-flash` 和 `gemini-4-argon`，其他现有模型默认开放；后续新增目录模型需手动授权。详见 [账号层级模型白名单说明](docs/zh/account-tier-model-allowlist-design.md#11-实现与使用说明)。

模型并发、排队和冷却参数见 [模型感知调度说明](docs/zh/model-aware-scheduling.md)。每日调度冷却重置使用固定的 `America/Los_Angeles` 时区，不随 `TZ` 改变。

### 可选公开看板

在 `.env` 中启用：

```dotenv
PUBLIC_DASHBOARD_ENABLED=true
PUBLIC_DASHBOARD_PORT=7861
```

在 Compose 的 `ports` 中增加：

```yaml
- "127.0.0.1:7861:7861"
```

执行 `docker compose up -d` 重新创建容器，通过 `http://localhost:7861` 访问。此端口提供匿名聚合数据；管理端仍使用 `7860`。部署说明和指标定义见 [公开用量看板说明](docs/zh/public-dashboard-design.md)。

多服务器部署可将公示角色设为 `master`（主控）和 `agent`。Agent 定时生成本机快照，主控定时读取并缓存汇总；公众访问不会触发节点统计或远程采集。各节点必须使用独立账号池，agent 查询接口使用独立 Token。配置方法见 [多节点公示部署与实现说明](docs/zh/public-dashboard-multi-node-design.md#12-部署示例)。默认 `standalone` 保留原有独立公示功能。

渠道控制器应读取 master 和 agent 统一的 `GET /api/internal/model-health`，并发送 `Authorization: Bearer <PUBLIC_DASHBOARD_HEALTH_TOKEN>`。在目标节点配置独立的 `PUBLIC_DASHBOARD_HEALTH_TOKEN` 后重启；留空时拒绝所有查询。该接口与公示服务共用监听地址和端口，只读取已生成的本机缓存，master 不含远程节点汇总。响应仅含 `schema_version: 1`、原始 `generated_at`、持久化 `node_id`、`snapshot_sequence`、`service_status`、`usage_window` 和各模型的 `realtime.available_accounts`，不含账号明细。缺少或错误令牌返回 401；缓存缺失、超过 `PUBLIC_DASHBOARD_STALE_AFTER_MS` 或服务未就绪时返回 503，已有缓存仍保留原始时间戳和身份。原公示与 Agent 采集接口用途保持不变；standalone 不提供该机器接口。

配套控制器设置 `aistudio.status_url: "http://aistudio:7861/api/internal/model-health"` 和 `aistudio.token_env: "AISTUDIO_HEALTH_TOKEN"`，通过环境变量注入与目标节点相同的只读令牌，dry-run 下也需提供。渠道连续两次不可用后禁用、当日锁存和太平洋日期切换时启用的策略保持不变。

## 更新与维护

### Docker Compose

```bash
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 app
```

每次更新都重新构建本仓库源码，无需 `docker compose pull`。更新前备份 `.env`、`configs/auth/` 和 `data/`，备份数据库时先停止服务。

```bash
docker compose stop
# 将 .env、configs/auth/ 和 data/ 复制到安全的备份位置
docker compose up -d
```

停止并移除容器可用 `docker compose down`，宿主机绑定目录仍保留。不要删除这些目录；多个实例不能共享同一套账号、数据库和调度状态。

### 本地源码

```bash
git pull --ff-only
npm install
npm start
```

如使用 `docker run`，更新时重新执行 `docker build`，停止并移除旧容器，再按原启动命令创建新容器，继续挂载原数据目录。

## 开发与文档

```bash
npm run dev
npm test
npm run lint
npm run build:ui
```

自动化测试不替代真实 Google 账号登录和上游请求验收。仓库的 Docker 工作流仅提供手动构建检查，不发布镜像，也不需要上游的仓库凭据。

- [API 示例](docs/zh/api-examples.md)
- [账号登录与恢复](docs/zh/account-auto-login-operations.md)
- [模型调度](docs/zh/model-aware-scheduling.md)
- [Nginx 反向代理](docs/zh/nginx-setup.md)
- [公开用量看板](docs/zh/public-dashboard-design.md)
- [管理端前端统一改造方案（待实施）](docs/zh/frontend-unification-plan.md)

## 来源、致谢与许可证

本项目基于 [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI) 二次开发；该上游项目基于 [ais2api](https://github.com/Ellinav/ais2api)（作者：[Ellinav](https://github.com/Ellinav)）分支开发。感谢原作者、上游维护者及贡献者；源码中的既有作者署名予以保留。

本版本沿用上游 **CC BY-NC 4.0（署名－非商业性使用 4.0 国际）** 许可证。使用、分发与修改均需遵守原有许可证全部条款，完整内容见 [LICENSE](LICENSE) 与 [许可说明](https://creativecommons.org/licenses/by-nc/4.0/)。本仓库已说明二次开发及主要修改，不代表上游作者对本版本的背书。

Docker 中包含的 Node.js、Camoufox、Mihomo 等第三方组件遵循各自许可证。Mihomo 的许可证及源码链接保存在镜像 `/usr/share/licenses/mihomo/` 中。

### Gemini 4 Argon 账号资格

`gemini-4-argon` 默认使用宿主页的 MakerSuite GenerateContent 桥接。账号管理中可设置 Free、Pro、Ultra 5x 或 Ultra 20x；未设置时跟随当前会话的成功权益检测（TIER1/TIER2 均按 Pro 回退）。有效层级为 Pro 或 Ultra 时通过本地层级准入，Free 和未知不准入。`ARGON_VERIFIED_ACCOUNTS` 已废弃，旧值会被忽略，无须迁移白名单。

在账号操作栏点击“检测付费权限”，或跨分页选择账号后批量检测。任务串行执行，可查看逐账号进度并取消；只调用 `GetAiStudioBenefitTier`，不生成内容、不消耗本地模型计数，也不会自动登录。普通浏览器容量满时最多使用一个额外的检测 context。上游没有公开此内部接口的限流承诺。账号新增、导入、轮换和首次 Argon 请求不会强制查询。替换 Cookie 或重新登录后，旧检测保留为历史并标记待复检；查询失败保留同会话最近成功观察。

手动层级优先，仅控制本地准入及额度估算，不授予上游权限、不伪造权益头。手动付费与检测 Free 冲突时提示管理员，但仍允许真实请求；手动 Free 不会被检测付费自动升级。层级修改、检测及恢复模型均保留历史用量；真实模型权限错误和 429 继续按账号 × 模型处理。普通 Cookie 下载与现有 CSV/ZIP 导出格式不包含新增层级或检测元数据；完整元数据由账号 SQLite 数据库保存，兼容缺少字段的旧记录。

本地每模型日额度基数（Flash / Pro / Argon）：未知或 Free 为 100 / 10 / 不准入，Pro 为 100 / 50 / 50，Ultra 5x 为 500 / 100 / 100，Ultra 20x 为 500 / 200 / 200。按各账号当日上游尝试数扣减，失败尝试也计数；采用 America/Los_Angeles 自然日。公开及管理看板逐账号聚合，属于本地预估，并非实时上游余额，估算归零不会新增调度拦截。

Chat Completions、Responses、Anthropic 和 Gemini native 均支持原有 JSON/SSE 响应格式。此模型的流式请求（包括全局 `real`、`-real` 后缀和原生 `alt=sse`）实际使用 unary 并缓冲输出；不是实时增量流。其他模型沿用原有流模式。桥接使用当前宿主页真实权益与认证，为转换后的载荷生成新的 WAA，不自动跨通道回退。Argon 的额度按上述层级预估，实际 429 保留现有限流处理。

离线测试包含真实 Firefox 与本地 TLS/CONNECT fixture，运行 `node --test tests/build-benefit.test.js`（需安装 Playwright Firefox 和 OpenSSL）；测试不访问 Google。代码及 fixture 通过不等同于真实账号已通过上游验收，具体记录见 [适配方案](docs/zh/gemini-4-argon-legacy-build-adaptation-plan-20261017.md)。

Camoufox 生产差异及后续修复见 [生产问题定位](docs/zh/gemini-4-argon-production-diagnosis-20261017.md)。可通过 `BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH=/path/to/camoufox node --test tests/build-benefit.test.js` 运行同一套本地 fixture；Camoufox 使用 BrowserManager 的导航方式验证文档失效，标准 Firefox 保留原生 reload 测试。

### 模型传输兼容

所有模型默认使用 MakerSuite GenerateContent 桥接，保留原始模型 ID。旧版接口已失效，已有显式 `legacy` 配置仍会覆盖默认值，需要改为 `makersuite` 或删除覆盖。可在配置页逐行填写模型 ID 并选择“旧通道 / 桥接通道”，保存后重启生效；环境变量仍支持精确模型映射：

```dotenv
MODEL_TRANSPORT_POLICY={"gemini-3.7-flash":"makersuite","gemini-4-argon":"makersuite"}
```

只接受无指令后缀的精确模型 ID 和 `legacy` / `makersuite`，不支持通配符、自动跨通道重试或模型改名。每个请求固定策略，重试和后续轮次不切换路径。Argon 使用统一账号层级准入，同时保留当前页面的真实认证及权益头；手动层级不授予真实上游权限。

桥接先等待完整结果，再输出 JSON 或 SSE；`-real` 和全局 real 在桥接时转为缓冲，Chat 可选择 early 提前开始并发送心跳，其他入口保留原有缓冲 SSE 行为。桥接生成总预算以面板“桥接生成超时”（`MAKERSUITE_TIMEOUT_MS`，默认 295000 毫秒）为准，覆盖认证、WAA、fetch 和正文读取；不再受默认 300 秒的普通缓冲响应设置限制。响应结算另预留最多 5000 毫秒。`FAKE_STREAM_TIMEOUT_MS`（默认 300000 毫秒）独立控制普通通道的缓冲生成预算。两项均支持 1–2147478647 毫秒，保存后用于新请求，已有请求保留快照；重试、后续轮次、正文块和心跳均不延长固定预算。`STREAM_TIMEOUT_MS` 仍用于 legacy real 的增量空闲等待。排队期限独立；网关及调用方需要覆盖排队、生成与结算时间。

例如，将“桥接生成超时”设置为 `600000` 即可获得十分钟桥接生成预算，无须同时修改“缓冲响应超时”。浏览器端必须使用本版本的 [build.js](scripts/client/build.js)，以接收服务端下发的剩余预算；已保存的自建 Build App 需要同步客户端代码，旧版客户端仍可能在 300 秒时中止。项目不会自动修改已保存的 Build App。内部关联标记仅用于已拦截的桥接请求，不发送给 Google；旧通道出站移除本地标记。日志记录传输与请求/有效模式，不记录认证、权益不透明值、WAA 或载荷。

离线回归使用 `npm test`；浏览器验证使用 `npm run test:transport:browser`；真实超过 60 秒的本地 TLS 验证使用 `npm run test:transport:long`。可用 `BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH` 指向生产 Camoufox 执行同一 TLS fixture；fixture 限制 CONNECT 目的地，不访问 Google 或生产 9998。离线通过不代表真实账号生成验收通过，部署与单账号切换须另行授权。实施记录见 [双通道修复记录](docs/zh/model-transport-compatibility-implementation-20261017.md)。
