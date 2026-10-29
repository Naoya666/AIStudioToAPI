# 全账号额度冷却时的启动验收修复

对应诊断：`/home/dev/workspace/infra/diagnostics/quota-startup-rollback-20261028/README.md`。

启动入口使用独立的 `startupAcceptable()`：既有 `operational()` 成功，或核心服务已经启动、所有轮换账号均健康且认证未过期、可见且有权限的模型都处于有限额度冷却，并且没有上下文初始化、初始化失败、清理或浏览器恢复任务时，允许发送监督器 `ready`。浏览器尚未按需启动的 STOPPED 状态也可接受；STARTING、FAILED、RECOVERING 不接受。空权限、unsupported、账号禁用或认证异常不能仅凭零候选绕过验收。

监督器仍仅在收到 `ready` 后记录实际运行配置为 last-good；业务冷却不触发 recovery。冷却等待期间的排队请求不计为监督器的无进展任务；真实初始化与其他异常仍保留超时保护。未改变非法配置、监听失败、首次启动失败及 recovery 再次失败的处理机制。

冷却自然到期继续走现有调度唤醒链路，不需要清除账号状态或重启。隔离测试覆盖零 resident 的定时唤醒和预热候选恢复，以及实际 main + supervisor 在有/无旧 last-good 时保留新配置、持续心跳、真实浏览器失败仍退出并至多回退一次。

后续公示修复补充：保留下述启动验收和机器健康语义，公示快照另增可选 `quota_status`，用于区分正常额度等待与真实故障。公示汇总现在纳入正常额度等待节点的新鲜数据，日额度确认耗尽时显示零剩余额度；因此下段关于公示仍显示 null 的说明仅描述当时修复的范围。

启动验收不代表推理容量可用。`operational`、model-health 和公示就绪判定维持既有语义：零就绪上下文的公示节点仍为 unavailable，聚合端仍可显示 null；此变更不将其伪造成 ready 或把展示契约改为 0，也不改变外部控制器的双快照与 MANUAL_OFF 语义。

所有模型的默认请求通道改为 MakerSuite 桥接。已有显式 `legacy` 映射仍优先，需要删除或改成 `makersuite` 并重启；新增配置行默认选择桥接。桥接保留原始模型 ID，real 流式转为缓冲输出，不自动回退到旧接口。

此记录描述源码修复与本地隔离验证范围，不代表已经部署或完成真实账号的上游验收。

验证结果：按 `package.json` 的完整 test 列表执行，为 `node --test` 添加 `--test-concurrency=1` 后全部通过（并发运行的界面测试存在 Vite 5173 端口竞争，相关用量历史测试单独运行也通过）。`npm run build:ui`、修改文件的 ESLint/Prettier 和 `git diff --check` 通过。全仓 `npm run lint` 仍有未修改的 `docs/zh/fixtures/context-spread-benchmark-20261024.json` 中 14 项既有键排序错误。
