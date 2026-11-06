# AIStudioToAPI（二次开发版）

中文 | [English](README_EN.md)

将 Google AI Studio 的 Gemini 模型封装为兼容 OpenAI、Gemini 和 Anthropic 格式的 API，提供账号、模型调度、代理节点与用量管理控制台。

本仓库基于 [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI) 独立维护，沿用 **CC BY-NC 4.0** 许可证，仅限符合许可证的非商业用途。

## 功能

- **多协议接入**：OpenAI Chat Completions / Responses、Gemini 原生格式、Anthropic Messages；支持流式响应。
- **双调用后端**：默认通过 Camoufox 直连 Playground；可切换本机 Go / SpiderMonkey 后端。
- **账号管理**：凭据登录、Cookie / CSV / 验证器导入、批量操作、登录队列、会话恢复与付费权益检测。
- **模型调度**：按账号和模型管理并发、排队、额度、冷却及重试，支持 Context 预热和出口分散。
- **代理节点池**：集成 Mihomo，支持节点管理及账号出口绑定。
- **用量与运维**：SQLite 请求记录、Token 统计、运行状态、可视化配置和可选的独立公开看板。
- **可选生成增强**：抗截断文本传输、尾部修复，以及实验性 Build / SillyTavern 通道。

具体模型、工具、图片和音频能力取决于账号权限、模型及调用通道；模型目录不代表账号一定可用。

## 快速开始

推荐 Docker Compose v2。镜像构建面向 Linux amd64 / arm64，包含 Camoufox、Mihomo 和本地调用引擎。

### 1. 准备配置

```bash
git clone https://github.com/Naoya666/AIStudioToAPI.git
cd AIStudioToAPI
cp .env.example .env
mkdir -p configs/auth data
```

编辑 `.env`，至少设置：

```dotenv
API_KEYS=replace-with-your-api-key
WEB_CONSOLE_USERNAME=admin
WEB_CONSOLE_PASSWORD=replace-with-your-console-password
TZ=Asia/Shanghai
CHECK_UPDATE=false
```

`API_KEYS` 支持逗号分隔的多个密钥。请显式设置：留空会使用默认密钥 `123456`。控制台用户名和密码均未设置时，使用 API 密钥登录。

### 2. 启动服务

**使用预构建镜像**：在仓库根目录新建 `compose.image.yaml`：

```yaml
services:
  app:
    image: ghcr.io/naoya666/aistudiotoapi:main
    init: true
    restart: unless-stopped
    env_file:
      - .env
    ports:
      - "127.0.0.1:7860:7860"
    volumes:
      - ./configs/auth:/app/configs/auth
      - ./data:/app/data
```

```bash
docker compose -f compose.image.yaml pull app
docker compose -f compose.image.yaml up -d --no-build app
docker compose -f compose.image.yaml logs -f app
```

`main` 跟随主分支成功发布的镜像；也可使用 `sha-<完整提交号>` 或已发布的 `v*` 标签。需要固定部署版本时，使用 Actions 发布摘要中的镜像 digest。发布流程见 [容器镜像发布指南（英文）](docs/en/container-publishing.md)。

**从当前源码构建**：完成第一步后，直接使用仓库自带的 [docker-compose.yml](docker-compose.yml)：

```bash
docker compose up -d --build
docker compose logs -f app
```

首次构建需要下载基础镜像、浏览器和原生编译依赖。仓库自带 Compose 使用本地构建，不会自动拉取 GHCR 镜像。

### 3. 登录控制台并添加账号

访问 `http://localhost:7860`，使用配置的控制台凭据登录。在 `/accounts` 页面添加账号：

- **凭据登录**：保存 Google 邮箱、密码和可选 TOTP 密钥，通过后台队列登录；支持 CSV 导入。
- **Cookie 导入**：上传认证 JSON，或将已有认证文件放入 `configs/auth/`。
- **人工登录**：Docker 部署可通过 `/auth` 的 VNC 入口处理人工验证并保存会话。

需要固定代理出口时，先在节点池绑定账号，再发起登录。遇到 Google 验证码或其他挑战时，按控制台提示人工处理。操作说明见 [账号登录与会话恢复](docs/zh/account-auto-login-operations.md)。

默认端口仅绑定宿主机回环地址。远程访问可使用 SSH 隧道，或配置 [Nginx 与 HTTPS](docs/zh/nginx-setup.md)。修改容器内 `PORT` 时，同步调整 Compose 端口映射。

## API 使用

| 协议            | Base URL                       | 常用接口                                                                                                             |
| --------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| OpenAI 兼容     | `http://localhost:7860/v1`     | `/models`、`/chat/completions`、`/responses`                                                                         |
| Gemini 原生格式 | `http://localhost:7860/v1beta` | `/models`、`/models/{model}:generateContent`、`/models/{model}:streamGenerateContent`、`/models/{model}:countTokens` |
| Anthropic 兼容  | `http://localhost:7860/v1`     | `/messages`、`/messages/count_tokens`                                                                                |

先查询模型列表：

```bash
curl http://localhost:7860/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

将 `MODEL_ID` 替换为列表中的模型 ID：

```bash
curl http://localhost:7860/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

将 `stream` 改为 `true` 可请求 SSE 流。`STREAMING_MODE` 支持：

| 模式    | 行为                                                                            |
| ------- | ------------------------------------------------------------------------------- |
| `real`  | 增量转发上游生成内容，默认模式                                                  |
| `fake`  | 缓冲生成结果后输出 SSE                                                          |
| `early` | Chat Completions 提前发送空首块及等待心跳，再输出缓冲内容；其他协议按 fake 处理 |

支持模型能力范围内的内置搜索、代码执行、URL context、函数工具及结构化输出。Playground 会将强制或指定函数选择降级为 `AUTO`，不能保证指定工具执行。Embeddings（包括 `embedContent` / `batchEmbedContents`）当前返回 **501**。

文件 API 支持上传、查询、下载和删除；Playground 文件绑定上传账号，不能跨账号组合使用。Gemini `cachedContents` 是进程内兼容缓存，重启后清空。接口细节见 [Playground 能力与限制](docs/zh/playground-capabilities.md)，其他请求示例见 [API 使用示例](docs/zh/api-examples.md)。

## 配置与后端

完整环境变量参考 [.env.example](.env.example)。日常管理可在控制台配置页完成；已保存的配置覆盖对应环境变量。界面会显示运行值、保存值及待重启项。

| 配置                                            | 用途                                        |
| ----------------------------------------------- | ------------------------------------------- |
| `API_KEYS`                                      | 客户端访问密钥，多个值以逗号分隔            |
| `WEB_CONSOLE_USERNAME` / `WEB_CONSOLE_PASSWORD` | 控制台登录凭据                              |
| `HOST` / `PORT`                                 | 默认 `0.0.0.0` / `7860`                     |
| `CALL_BACKEND`                                  | `browser`（默认）或 `local`，切换后重启生效 |
| `CAMOUFOX_EXECUTABLE_PATH` / `MIHOMO_PATH`      | 自定义浏览器与代理程序路径                  |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`       | 出站代理与绕过规则                          |
| `STREAMING_MODE`                                | `real` / `fake` / `early`                   |
| `TZ` / `SECURE_COOKIES`                         | 显示时区 / HTTPS Cookie 设置                |
| `PUBLIC_DASHBOARD_ENABLED`                      | 启用独立匿名看板，默认关闭                  |

管理配置保存在 `data/managed-config.json`。若环境变量修改后未生效，检查是否存在控制台覆盖；Compose 环境配置变更需要重新创建容器。

### 调用后端

- **browser**：使用 Camoufox 的账号会话直接调用 Playground，适用于默认部署。
- **local**：使用 Node 管理的本机 Go / SpiderMonkey 子进程发送请求；支持 Linux amd64 / arm64，Docker 镜像已内置。本地源码运行需先执行 `npm run build:engine`，要求 Go 1.27.0，其他编译依赖由脚本下载。

在设置页保存调用后端并重启服务后生效。两种后端复用账号、代理、调度和统计，不自动互相回退。local 模式下按需登录仍可使用浏览器。操作及支持范围见 [双后端说明](docs/zh/local-browserless-backend.md)，已完成的真实调用验证及剩余限制见 [验证记录](docs/zh/local-browserless-validation-20261105.md)；长期 Cookie 续期仍待验证。

### 账号权限与调度

账号可设置 Free、Pro、Ultra 5x 或 Ultra 20x 层级，也可跟随当前会话的成功权益检测。手动层级影响本地准入和额度估算，实际调用仍受 Google 权限与限流约束。

模型权限在控制台层级白名单中管理；新增模型后应检查是否已授权。用量和额度展示属于本地统计或估算，不是实时上游余额。调度每日冷却重置固定使用 `America/Los_Angeles` 时区，不随 `TZ` 改变。

详见 [模型调度](docs/zh/model-aware-scheduling.md)、[层级与权益](docs/zh/account-tiers-and-argon-eligibility-design.md)、[模型白名单](docs/zh/account-tier-model-allowlist-design.md) 和 [Token 统计口径](docs/zh/token-statistics.md)。

### 可选功能

- **抗截断**：默认策略为 `off`。OpenAI Chat Completions 可通过 `anti-` 模型前缀或 `anti_truncation` 请求字段启用；仅支持已适配的模型和组合，见 [使用说明](docs/zh/anti-truncation.md)。
- **Build 通道（实验性）**：默认关闭，仅开放 Chat Completions。`build/` 打包完整上下文，`build-st/` 使用配套 SillyTavern 适配器分段；启用后需检查模型权限。配置、媒体输入、工具和清理行为见 [Build 双通道说明](docs/zh/build-dual-channel.md)。
- **尾部修复**：`TAIL_REPAIR_ENABLED` 默认关闭，在最后一轮为模型消息时追加用户续写指令，可在设置页调整。
- **公开看板**：启用 `PUBLIC_DASHBOARD_ENABLED=true` 后，在 Compose 增加 `127.0.0.1:7861:7861` 端口映射并重建容器。提供独立只读聚合数据；集群可使用 master / agent 角色，各节点使用独立账号池。见 [公开看板](docs/zh/public-dashboard-design.md) 和 [多节点部署](docs/zh/public-dashboard-multi-node-design.md)。

## 本地源码运行

要求 **Node.js ≥ 22.13.0**；Node.js 24 与 Docker 镜像一致。完整后台登录功能依赖 Linux `/proc` 和 POSIX 进程组，建议使用 Linux 或 Docker。

```bash
git clone https://github.com/Naoya666/AIStudioToAPI.git
cd AIStudioToAPI
npm ci
cp .env.example .env
# 编辑 .env，设置 API 密钥和控制台密码
npm run setup-auth
npm start
```

认证脚本会下载 Camoufox 并引导登录，会话保存到 `configs/auth/`。已有浏览器可设置 `CAMOUFOX_EXECUTABLE_PATH`。需要节点池时，自行安装 Mihomo 并设置 `MIHOMO_PATH`。

`npm start` 会先构建管理界面和公开看板；前端已构建且未变更时，可用 `npm run quick-start`。源码部署不包含容器内的 VNC 环境。

## 更新与数据

需要持久保存：

| 路径            | 内容                                             |
| --------------- | ------------------------------------------------ |
| `.env`          | 初始环境配置与密钥                               |
| `configs/auth/` | 账号登录会话                                     |
| `data/`         | 账号数据库、请求统计、调度状态、节点池及管理配置 |

账号密码、TOTP 和 Cookie 使用受限本地明文存储。这些目录以及账号导出、登录截图均含敏感信息，请勿提交到公开仓库。数据库备份前停止服务，完整复制并验证备份；多个实例使用独立数据目录和账号池。

**预构建镜像部署**：备份后执行：

```bash
docker compose -f compose.image.yaml pull app
docker compose -f compose.image.yaml up -d --no-deps --no-build app
docker compose -f compose.image.yaml logs --tail=100 app
```

固定 digest 时，先更新 Compose 中的镜像引用。已有部署应沿用原服务名、网络及全部挂载；从本地构建切换镜像时，移除对应服务的 `build` 和 `pull_policy: never`。

**本地构建部署**：备份后执行：

```bash
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 app
```

**源码部署**：停止服务并备份后，执行 `git pull --ff-only`、`npm ci`、`npm start`；使用 local 后端时按需重新构建引擎。

更新后检查启动日志、账号和 API 调用。保留旧镜像引用和升级前数据备份用于回退。

## 开发

```bash
cp .env.example .env.development
# 编辑 .env.development 后启动开发模式
npm run dev
npm test
npm run lint
npm run build:ui
```

生产模式读取 `.env`，开发模式读取 `.env.development`。浏览器集成测试需要 Playwright Firefox / Chromium，部分本地 TLS 测试需要 OpenSSL；local 引擎相关测试需先构建引擎。专项命令见 [package.json](package.json)。

[镜像构建工作流](.github/workflows/docker.yml) 在推送和 PR 时验证，仅在主分支或 `v*` 标签上发布镜像。自动化离线测试不等同于真实 Google 账号或所有模型组合的可用性验收。

## 来源与许可证

本项目基于 [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI)，上游源于 [Ellinav/ais2api](https://github.com/Ellinav/ais2api)。感谢原作者、上游维护者及贡献者，保留原有署名。

项目沿用 **CC BY-NC 4.0（署名－非商业性使用 4.0 国际）**，完整条款见 [LICENSE](LICENSE)。本版本独立维护，不代表上游背书。

第三方组件与适配代码遵循各自许可证，来源及修改说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；本地引擎相关 MIT 许可见 [local-engine/LICENSE.MIT](local-engine/LICENSE.MIT)。
