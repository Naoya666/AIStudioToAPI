# 浏览器 / 本地无浏览器双后端

实现分支：`feat/local-browserless-backend`。本次没有部署生产、读取测试账号的生产凭证或切换线上实例。真实 Google 验收未执行。

## 切换和回退

受保护的管理页面 → 设置 →「调用后端」：

- **浏览器**（`browser`）：原 Camoufox 调用链，升级默认值。
- **本地无浏览器**（`local`）：Node 子进程中的本机 Go / SpiderMonkey 服务，直接请求 Google。

保存使用现有配置版本校验、原子持久化和冲突检测。设置显示当前运行值、已保存值和待重启差异；点击现有服务重启操作后生效。重启沿用服务监督器的在途请求处理、连接关闭和清理流程。没有无缝热切换，没有自动跨后端回退。修改设置不会清空账号、用量或额度状态。

尚未配置持久化覆盖时可以用 `.env` 中的 `CALL_BACKEND=browser|local`。设置页保存的覆盖优先。回退：保存「浏览器」并重启；如管理页面因其他问题不可用，可停服备份 `data/managed-config.json` 后仅删除 `overrides.CALL_BACKEND`，保留其余字段和文件，再以 `CALL_BACKEND=browser` 启动。不要清空 data 或账号文件。已有 last-good 恢复机制继续适用。

## 本地运行和 Docker

本地无浏览器后端支持 **Linux amd64 / arm64**；本次运行测试为 amd64，arm64 交叉编译通过，仍需 arm64 原生运行验证。其他系统继续使用浏览器后端，选择 local 会明确报错。

```bash
# Go 1.27.0；还需 bash、curl、tar、xz、sha256sum。
npm ci --ignore-scripts
npm run build:engine
npm run build:ui
npm start
```

构建脚本固定 Go 1.27.0、Zig 0.15.2、SpiderMonkey `v152.0.4-aistudio2api.1`；原生依赖下载校验 SHA-256，Go 模块及校验在 `go.mod` / `go.sum`。产物为 `local-engine/bin/local-engine`，可用 `LOCAL_ENGINE_BINARY` 指定绝对本地路径；不接受远程签名地址。第一次构建需要网络下载编译依赖，正常运行的签名全部在本地。

```bash
docker compose build
# 保留原有 auth 和 data 挂载，不增加签名端口。
docker compose up -d
```

Docker 多阶段构建内置静态 Go 产物；镜像仍保留 Camoufox，供浏览器后端和按需登录使用。仅安装浏览器文件不代表启动浏览器。Compose 只管理 Node 容器；Node 是 Go 子进程的唯一监督者，不另加 systemd/Compose 签名服务。未选 local 时不会启动 Go；local 生成及权益探测不调用登录浏览器。

## 传输与身份

Node 继续处理协议、工具、SillyTavern/build-st、抗截断、调度、并发、冷却、额度和统计。两后端共享 PG 编解码器、流解析和下游 real/fake/early 处理，Build 共享任务生命周期。

Go 负责每个账号独立的 Cookie、authUser、权益头、动态 API key/visit/logging 头、Firefox 指纹、UA、代理网络客户端和 SpiderMonkey VM。它同时完成 proof 和发送，Node 不拿 proof 后另用 fetch 拼头。每次普通 RPC 重新生成 SAPISID Authorization；账号导入的单账号隔离会话沿用 authuser=0，有显式 `authUser` 时固定绑定。代理沿用现有黏性出口和代理池规划；改变账号会话或代理时重建其独立 runtime。

私有能力只有会话创建/激活/删除、允许列表 RPC、固定 Drive 文件操作、Cookie 状态和健康检测。没有 mint 或任意 URL 转发接口。外部入口只接受方法标识；原生 HTTP 还限制 HTTPS Google 域，Build 可续传地址限制为 `https://aistudio.google.com/_/upload`。服务使用权限 0700 的随机私有目录和 0600 Unix socket，没有 TCP 签名端口。Go 普通日志不包含上游内容；Node 只记录后端、账号索引、状态和错误类别。不要把私有状态接口接到公共路由。

PG 绑定摘要从最终 wire 的所有内容 part 派生；最后一轮文本作为页面提示词，有文本时按 Mag1cFall 的 RunProof 顺序触发输入和 Run。PG proof 写入第 5 字段。Build 先上传大附件，按最终 parts 重算绑定摘要，以上下文 prompt 作为页面提示词，proof 写入第 2 字段；不能复用 PG 字段位置。

## 支持范围

| 能力                              | local 实现                                                                   | 验证边界                                   |
| --------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| PG GenerateContent，流式/非流式   | 共享编解码和输出队列，Go 连续传输响应                                        | 合成 RPC/单元测试；真实 Google 未验收      |
| real / fake / early               | 沿用现有请求处理和等待保活                                                   | 现有测试与编解码回归；真实时序未验收       |
| 思考、工具、结构化、多模态、usage | 保留原 wire 字段和既有工具策略                                               | 现有协议测试；新后端真实组合未验收         |
| CountTokens、本地缓存资源         | 允许列表 RPC；原有资源语义                                                   | 单元测试；真实计数未验收                   |
| Drive 上传、下载、删除            | 同账号 Go 网络客户端内获取 token 并操作固定端点                              | 已实现；真实文件链路未验收                 |
| 模型与权益                        | ListModels/权益/日志上下文启动 RPC；人工权益检测不启动浏览器                 | 合成与调度回归；真实查询未验收             |
| Build / build-st                  | 原上下文和附件、CreateApplet、CodeAssistantOffline、任务快照、取消和尽力清理 | 共享生命周期及读取恢复测试；真实任务未验收 |
| Build anti                        | 维持原有门控，不扩大已公开能力                                               | 不宣称因更换后端得到新支持                 |

不能将以上实现表视作 Google 可用性证明。具体模型和参数仍受项目原有校验和账号模型权限限制，不引入其他参考网关开放的额外能力。

本地私有接口的 JSON 请求体上限为 100 MiB（包含 base64 膨胀），超过时返回明确的 413，不丢弃字段。Build 单次 RPC 响应上限为 16 MiB，与原浏览器路径一致；其他缓冲响应上限为 100 MiB。Drive 文件沿用 64 MiB 限制。PG 生成流按块转发；伴随 CountTokens 沿用参考实现的延迟触发，并与所属生成一起取消，不另设重试预算。这些保护上限和真实大附件行为应纳入上游验收。

## Cookie 和进程维护

核对 Mag1cFall 固定版本后确认：`runtime_go.go` 合并所有响应 Set-Cookie，`page_resources.go` 在页面初始化调用 Cloud Console `onboarding/auth_warmup` 并跟随 authcheck；有 10 分钟 ListIncidentsHistory 和 12 小时 WAA challenge 刷新。这个版本没有独立 RotateCookies 调用；WAA 刷新不等于 Cookie 续期。

本地后端保留这些路径，并为存活会话每 10 分钟执行一次同出口 auth_warmup，单次最多 30 秒；Cookie 变化每 30 秒及会话关闭前通过现有 `refreshSession`、会话版本检查和原子账号存储写回（遵循 `ENABLE_AUTH_UPDATE`）。不会覆写新登录替换的凭证。12 小时 WAA 刷新和 Cookie 维护分别运行；不因 403 触发其中任何一个恢复分支。

Cookie 滚动的请求及写回有离线验证；**长期运行能否持续获得所需 Google Cookie 尚未真实验收**，尤其不同来源凭证或未来设备绑定变化。不要把合成 Set-Cookie 测试当作实际长期续期证明。

Node 启动服务后最多等 10 秒就绪。异常退出令旧会话失效，最多自动重启两次；连续启动失败三次打开故障断路，重启主服务才能重置预算。调用失败不会无限等待或切去浏览器。正常退出发送 SIGTERM，5 秒后强制清理；父进程异常退出通过 stdin 管道关闭触发 Go 清理。丢失创建响应而没有激活的会话在 30 秒内回收。

生成取消直接关闭 Unix HTTP 请求及 Google context，保留现有总超时和重试预算。403 仍归为 risk_controlled，沿用退避冷却，不重签、不删凭证、不永久禁用。只有明确认证失效的 401 使用原重登流程；本地签名器内部错误归 transport，显式禁止重试及账号惩罚。Build 提交后仅读同一个任务；读取恢复不会再次 CreateApplet/CodeAssistantOffline，也不会重复记账。

## 验证与真实验收

```bash
npm test
npm run lint
npm run build:ui
npm run test:backend
npm run test:engine
# 构建隔离验证镜像后，无凭证/无外网检查：
bash scripts/ci/image-smoke.sh aistudio-to-api:local-browserless-validation
```

`local-backend.test.js` 是 Mock/单元测试。`local-engine-integration.test.js` 使用真实 Go 二进制验证本机进程、socket、故障和取消；不连接 Google。Go 测试使用真实 SpiderMonkey 解释器执行**合成 challenge**并拦截上游 HTTP，验证字段、摘要、动态头、Cookie 与账号隔离；其 proof 不是 Google proof。

本次实际运行结果、已知基线检查问题和验收缺口见 [本地验证记录](local-browserless-validation-20261105.md)。

真实 Google 的 PG、Build/build-st、文件、模型、权益、多账号代理出口、流式断连、真实 403 恢复和长周期 Cookie 维护均仍待授权测试账号验收。没有使用现有生产账号补齐这一层，不应直接切生产。验收应在隔离实例记录模型、请求类别、后端、脱敏状态、用量与 Build 单次提交次数；不保存 proof、Cookie、认证头或请求正文。

## 来源

- 主来源 [Mag1cFall/AIStudio2API](https://github.com/Mag1cFall/AIStudio2API/tree/591c81f2d2ce4a7f1bf644c4a5e1fd7f0b860e2c)，`591c81f2d2ce4a7f1bf644c4a5e1fd7f0b860e2c`。
- 独立服务抽离设计核对 [DeconstructedCube/aistudio-api](https://github.com/DeconstructedCube/aistudio-api/tree/43adc28cb0a469753c374ee52453f9f99f53003d)，`43adc28cb0a469753c374ee52453f9f99f53003d`。没有复制 Cube 特有实现或 403 策略。
- 详细文件、修改和许可证记录见 `THIRD_PARTY_NOTICES.md`、`local-engine/LICENSE.MIT`。
