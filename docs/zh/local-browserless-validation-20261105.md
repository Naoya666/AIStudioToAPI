# 双后端本地验证记录（2026-11-05 UTC）

实现分支：`feat/local-browserless-backend`。环境：Linux amd64、Node 22.23.2、Go 1.27.0、Docker 29.8.1。测试只使用合成数据、临时目录和隔离容器，没有生产部署、生产实例切换或真实账号 Google 生成。

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

## 未验收与限制

**真实 Google 上游验收未执行。** 没有明确授权的测试账号，不能把编译、合成 proof 或 Mock RPC 成功等同于无浏览器调用成功。

待隔离测试环境验收：PG 流式和非流式、real/fake/early、思考/工具/结构化/多模态/usage，Build/build-st 的创建/提交/读流/取消/清理，文件与模型权益查询，多账号真实代理出口、下游断连、真实 403 冷却及明确认证 401、实际用量与 Build 单次提交，以及跨日 Cookie 滚动维护。

参考版本只有 Set-Cookie 合并、auth_warmup/authcheck 等会话路径，没有独立 RotateCookies 调用。本地实现适配并周期触发这些路径，但长期 Google Cookie 续期尚无真实证据。其他明确限制包括 Linux 平台和私有接口容量上限，见 [运行与切换说明](local-browserless-backend.md)。

升级后默认继续 browser；验收完成前不能据此宣称 local 已获真实 Google 可用性验证。后续验收只保存脱敏元数据，不记录凭证、proof、认证头或正文。
