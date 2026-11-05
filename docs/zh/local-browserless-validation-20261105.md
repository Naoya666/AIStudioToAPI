# 双后端本地验证与 bero 真实验收记录（2026-11-05）

实现分支：`feat/local-browserless-backend`。最初本地验证环境为 Linux amd64、Node 22.23.2、Go 1.27.0、Docker 29.8.1，仅使用合成数据、临时目录和隔离容器。下述 Mock / 单元及本地集成检查保留这一验证边界。

后续按用户授权，于 2026-11-05 20:44（Asia/Shanghai）将 bero 生产实例升级至 `d4585bc0b2b5eff152b504b1dc01b399eab672af` 并启用 `CALL_BACKEND=local`，完成真实 Google 调用验收。结论：本次验证范围内的 PG、Build、流式、Build anti 和合成酒馆分段调用可在无浏览器进程下成功；长期 Cookie 续期及其他未测组合仍待验证。部署镜像使用该提交原始 Dockerfile 构建，其 Node 24 运行环境与最初本地验证环境不同。

## 来源核对

- Mag1cFall/AIStudio2API：`591c81f2d2ce4a7f1bf644c4a5e1fd7f0b860e2c`，核对本地仓库与远端 HEAD；作为 WAA、Firefox 环境、认证和网络传输主来源。
- DeconstructedCube/aistudio-api 的 `feat/browserless-waa-engine`：`43adc28cb0a469753c374ee52453f9f99f53003d`，只核对独立服务抽离与生命周期设计，没有复制其特有代码或恢复策略。
- Mag1cFall/firefox：`v152.0.4-aistudio2api.1`，对应源码 `e297ff009d3b9afee0e223c02ae3271ef24d51b6`。原生编译包固定 SHA-256；Go 依赖由 go.mod/go.sum 固定。
- 阅读仓库 CLAUDE.md，并核对当前管理器、PG transport/bridge/resources、Build runtime、调度、配置、重登及重试链。具体适配文件与许可证见 THIRD_PARTY_NOTICES.md。

## Mock / 单元及回归检查

| 检查                                           | 实际结果                                           | 解释                                                                        |
| ---------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| `npm test`                                     | 命令成功；各子进程均零失败，合计 952 通过、47 跳过 | 首组 470 通过；后续最终小改另跑下列相关检查                                 |
| `npm run test:backend`                         | 11 通过、零跳过                                    | Mock 编排与真实本地进程检查混合；下节说明区别                               |
| `node tests/scheduled-request.test.js`         | 209 通过                                           | 最终重试改动回归；保留浏览器原策略，本地内部故障不扩大重试                  |
| `node --test tests/configuration-page.test.js` | 1 通过                                             | 真 Chromium、合成配置服务；local/browser 双向保存、待生效、模拟重启后运行值 |
| `npm run test:transport:browser`               | 16 通过、1 跳过                                    | 真实 Firefox、合成/回环响应；长 fixture 默认跳过                            |
| `npm run build:ui`                             | 成功                                               | 管理端与公开端构建                                                          |
| 源码 ESLint 与 `npm run lint:css`              | 成功                                               | ESLint 范围见下文；未把全仓 lint 记录为成功                                 |
| `git diff --check`                             | 成功                                               | 无补丁空白错误                                                              |

风险相关断言包括：旧配置默认 browser、持久化和 CAS 冲突、双向重启应用、无隐藏浏览器调用、多账号/代理会话隔离、PG/Build 不同签名摘要与字段、动态头与同客户端发送、Cookie 合并及写回、取消和断流、403 冷却、明确认证 401 与内部签名故障分流、Build 读取恢复不重复提交，以及无重复统计的原有回归用例。

全仓 `npm run lint` **失败**：1721 项既有格式/键排序错误，全部位于下列未修改的 fixture。没有为使检查变绿重写这些测试数据：

- `docs/zh/fixtures/bero-flash38-tool-choice-20261028.json`
- `docs/zh/fixtures/bero-flash38-tool-choice-live-20261028.json`
- `docs/zh/fixtures/bero-flash38-tool-choice-restoration-20261028.json`
- `docs/zh/fixtures/bero-flash38-tool-choice-restoration-first-20261028.json`
- `docs/zh/fixtures/context-spread-benchmark-20261024.json`
- `tests/fixtures/mixed-zero-capacity.json`

源码检查实际命令：`npx eslint src scripts tests ui ui-public main.js package.json --ignore-pattern tests/fixtures/mixed-zero-capacity.json`。Vendored Firefox host JS 排除格式化，并用固定内容摘要和语法测试防止修改其属性顺序。

## 本地集成 / 原生检查

- `npm run build:engine` 和 `npm run test:engine` 成功。测试实际链接 SpiderMonkey，执行**合成 challenge**，拦截上游 HTTP，验证 PG 与 Build 的字段、请求头、摘要、Cookie 和代理客户端隔离；不产生 Google 验证过的 proof。
- Go `-race` 检查 `internal/aistudio`、`internal/waa` 成功，使用固定版本的 GNU 原生 SpiderMonkey。另验证解释器无限循环初始化被取消后 context 回收，以及全部 VM 关闭后 JS_ShutDown。
- Node 原生集成测试使用实际 Go 可执行文件：就绪、Unix socket 0600 / 目录 0700、缺凭证拒绝、SIGKILL 故障失效和有限重启、关闭后目录回收。超时/取消测试使用本地 Unix HTTP fixture。
- Linux arm64 静态交叉编译成功。**没有 arm64 原生运行证据**，也未验证其他操作系统。
- Docker 验证镜像名为 `aistudio-to-api:local-browserless-validation`；构建阶段运行 Go 测试。`scripts/ci/image-smoke.sh` 使用 `--network none`、无账号挂载、无公开端口，检查实际 Go 就绪及缺凭证拒绝、退出、Firefox 合成页面、前端资源、鉴权和 Node API 启动。该检查不是 Google 集成测试。

构建和 smoke 的最终结果与镜像 ID 记录如下；原始控制台日志保存在本机 `/tmp/local-backend-*.log`、`/tmp/local-engine-*.log`，属于临时排障文件，不是版本化验收证据。

| Docker 检查          | 结果                                                                               |
| -------------------- | ---------------------------------------------------------------------------------- |
| 最终构建与离线 smoke | 均成功；smoke 输出 `Offline image startup, browser, assets and API checks passed.` |
| 镜像 ID              | `sha256:b5ffd93b56b27d00856adf1b2909c3c79f3d709851ef25dcdcd6ef5facb6b08e`          |

## bero 真实 Google 验收

### 版本、部署与数据保留

- 从 `8689bce` 升级至上述 `d4585bc`；验收结束前再次查询远端，目标分支 HEAD 未变。无源码补丁，完整构建内 Go 测试及无网络镜像 smoke 均通过。
- 镜像 `aistudio-to-api:bero-local-d4585bc`，ID `sha256:49bd5bbb387e23adce351f46666587fc76ee18528219965a356549f6920ea2c2`。这是部署镜像，与上方最初离线验证镜像分别记录。
- 生产目录 `/opt/aistudio-bero`，容器 `aistudio-bero`。Compose 仅更换镜像；持久化配置仅增加 `CALL_BACKEND=local`，版本 16→17。
- 切换前核对 data/auth/models 三个 bind mounts、无命名卷、两份 SQLite 和既有本地/云端备份；确认无在途请求及账号任务后停机快照。快照为 `/srv/backups/aistudio-bero/manual-pre-local-d4585bc-20261105T124438Z`，旧镜像及手动快照保留供回退。
- 7 份认证及身份元数据、模型权限、代理与挂载保留；2 contexts / 2 workers、总并发 10、每 context 5、Build 并发 5 保留。83 条既有 Token 日聚合及其计数未减少，两个 SQLite 均 `quick_check=ok`，111 个运行源码文件匹配固定提交。

先在 bero 的独立 loopback `17860` 实例验收：复制现有 Pro slot 0 的认证和账号元数据至独立目录，使用独立数据、密钥和单账号并发 1；不挂载生产 auth/data，关闭测试实例自动重登及 Cookie 写回。通过后停止测试实例，再升级并切换生产后端。

### 真实调用结果

以下每条通过的请求均使用自建随机标记，返回 HTTP 200、完整预期标记及 `finish_reason=stop`。

| 环境 | 调用 | 数量 | 耗时 |
| --- | --- | --- | --- |
| 隔离实例 | PG `gemini-3.8-flash` 非流式 | 1 | 2.81 秒 |
| 隔离实例 | PG `gemini-3.8-flash` real / fake / early SSE | 3 | 4.97 / 6.27 / 2.31 秒 |
| 隔离实例 | PG `gemini-4-argon` 非流式 | 1 | 3.05 秒 |
| 隔离实例 | `build/gemini-3.8-flash` 非流式 | 1 | 26.40 秒 |
| 隔离实例 | `build/gemini-4-argon-real` SSE | 1 | 31.18 秒 |
| 生产原 HTTPS 入口 | PG `gemini-3.8-flash-real` SSE | 1 | 3.18 秒 |
| 生产实例 loopback API | Build Flash 普通 / anti 非流式 | 2 | 20.11 / 27.24 秒 |
| 生产实例 loopback API | `build-st/gemini-3.8-flash-real`，v2 合成酒馆分段、anti 开启 | 1 | 19.04 秒 |

early 首次使用 128 Token 测试上限，返回 `finish_reason=length`，标记少一个字符；提高至 1024 后通过。首次截断另存 `early-128-token-limit.json`，没有计入上表的 11 条通过请求，也没有将其记为成功验收。

7 条隔离请求和 4 条生产请求均按 request ID 核对 SQLite：每条只有一条 `outcome=success`、HTTP 200 的记录，`attempt_count=1`，11 条均有实际用量。部分 SSE 未请求下游 usage 包，不能据此断言统计缺失。这里证明应用请求无重试、无重复统计；未单独抓取每次底层 RPC，不能将 `attempt_count=1` 扩大为所有 Build RPC 提交次数的独立证明。

### 无浏览器进程、稳定性与备份

- 隔离及生产各连续采样 30 次，实例内浏览器进程始终为 0，Go 引擎始终为 1；运行配置确认为 `local`。这些结果来自实际进程检查，不是从镜像安装内容推断。
- 切换后 273.8 秒，容器 PID 和应用 instanceId 不变，`restart_count=0`，配置 `ready/operational=true`，无待重启项或重启错误。健康、存活、后台、设置、语言包及鉴权模型目录均正常。
- 新备份通过 SQLite / 归档验证、上传及回下载字节校验后再轮换。最终归档 `daily-20261105T124755Z.tar.gz` 为 7,509,416 bytes，含新提交发布元数据；本地完成包 1 份、云端 10 份，备份 timer 正常。
- 测试容器已移除、17860 端口关闭，生产容器 healthy。测试数据只保留在 bero 受限目录，不复制凭证至源码仓库。

脱敏证据位于控制机 `/home/dev/workspace/infra/aistudio-bero/browserless-20261105/`：`acceptance.json`、`usage-verification.json`、`call-*.json`、`production/call-*.json`、两份 `*-process-observation.json`、`backup-check.json` 和 `final-state.json`。部署及回退说明为 `/home/dev/workspace/infra/runbooks/bero-local-browserless-upgrade-20261105.md`；服务器受限工作目录为 `/opt/aistudio-browserless-20261105`。未在此文档记录 Cookie、proof、认证头、账号身份或请求/响应正文。

## 未验收与限制

真实 Google 验收已覆盖上节指定模型的短文本调用、流式、Build anti、合成酒馆分段及用量落库，不能扩大为全部模型或功能均可用。酒馆分段测试直接构造兼容的 v2 封装，没有从实际酒馆浏览器界面执行完整端到端操作；短标记 anti 测试也不等于长文本抗截断效果验证。

仍待真实验收：独立的思考参数、客户端工具往返、结构化输出、多模态、大文件、长文本，文件管理及人工模型/权益查询，多账号并发与不同代理出口，下游断连、取消、真实 403 冷却及明确认证 401 恢复，底层 Build 单次提交和删除状态，以及跨日 Cookie 滚动维护。本版本 Build 清理为 `best_effort`、历史自动恢复已停用；成功生成不等于所有上游项目已删除。

参考版本只有 Set-Cookie 合并、auth_warmup/authcheck 等会话路径，没有独立 RotateCookies 调用。本地实现适配并周期触发这些路径，但长期 Google Cookie 续期尚无真实证据。其他明确限制包括 Linux 平台和私有接口容量上限，见 [运行与切换说明](local-browserless-backend.md)。

软件默认后端仍为 `browser`；bero 经本次验收显式保存并启用了 `local`，没有修改全局默认值。账号交互登录仍可按需使用浏览器。本次没有实际演练生产回退；可按 [运行与切换说明](local-browserless-backend.md) 切回 browser。若同时回退到不识别 `CALL_BACKEND` 的旧版本，应先保留当前数据，再仅撤销相应覆盖并处理 last-good，避免整份恢复旧数据库或 Cookie。后续验收继续只保存脱敏元数据。
