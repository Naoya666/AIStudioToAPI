# AIStudioToAPI（二次开发版）

中文文档 | [English](README_EN.md)

将 Google AI Studio Build App 网页端封装为兼容 OpenAI、Gemini 和 Anthropic 格式的 API，通过浏览器自动化转发请求，并提供账号、模型调度、代理节点及用量管理界面。

本仓库是基于 [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI) 二次开发的独立维护版本，非上游官方版本。上游进一步基于 [Ellinav/ais2api](https://github.com/Ellinav/ais2api) 开发。本版本保留上游署名和许可说明，沿用 **CC BY-NC 4.0**，仅限符合许可证的非商业用途。

抗截断文本传输：支持 `anti-` 模型前缀、请求级覆盖及独立全局策略，兼容非流式和 fake/early/real。默认 off，范围及限制见 [使用说明](docs/zh/anti-truncation.md) 和 [实施验证记录](docs/zh/anti-truncation-implementation.md)。

2026-10-16 协议修复：生成请求现通过 MakerSuite `GenerateContent` 桥接，参考 [yunx738/ais2api](https://github.com/yunx738/ais2api/commit/79807728179482509cf1f8a4f5e3e175d9dd6702) 并获作者授权。无需手动更新 Build App 脚本。当前 `real` 响应也会等待上游完成后返回，需持续保活可使用 `early`；尚未实现实时增量传输。文本、系统提示、内联媒体、函数调用和 LOW/HIGH 思考配置已编码；搜索、URL context、代码执行、文件引用、结构化 schema、图片/语音输出配置、非 AUTO 工具选择及其他思考级别会明确返回不支持，不再静默忽略。若启用了全局强制内置工具，需要关闭相应选项后使用基本生成能力。详细支持范围与验证状态见[协议修复记录](docs/zh/makersuite-generate-content-protocol-repair-plan-20261016.md#9-实施记录)。

401 认证修复：生成桥接从当前页面的原生 MakerSuite 请求学习 API Key，不再依赖 `mb.jK` 等混淆字段。Key 未就绪时返回本地 503；上游 401 保留原状态并做有界登录页诊断，证据不足时不禁用账号、不自动重放；确认登录失效后才沿用会话过期处理。历史工具调用使用新的回放签名标记，工具结果可按 `tool_call_id` 找回函数名。实施及生产复测项目见[401 修复记录](docs/zh/makersuite-page-api-key-401-repair-plan.md#7-实施记录)。

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

## 来源、致谢与许可证

本项目基于 [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI) 二次开发；该上游项目基于 [ais2api](https://github.com/Ellinav/ais2api)（作者：[Ellinav](https://github.com/Ellinav)）分支开发。感谢原作者、上游维护者及贡献者；源码中的既有作者署名予以保留。

本版本沿用上游 **CC BY-NC 4.0（署名－非商业性使用 4.0 国际）** 许可证。使用、分发与修改均需遵守原有许可证全部条款，完整内容见 [LICENSE](LICENSE) 与 [许可说明](https://creativecommons.org/licenses/by-nc/4.0/)。本仓库已说明二次开发及主要修改，不代表上游作者对本版本的背书。

Docker 中包含的 Node.js、Camoufox、Mihomo 等第三方组件遵循各自许可证。Mihomo 的许可证及源码链接保存在镜像 `/usr/share/licenses/mihomo/` 中。
