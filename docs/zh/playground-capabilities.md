# Playground 能力补全

生成仍使用 Camoufox 页面认证、官方 WAA 和 Playground GenerateContent；不会恢复 Build App 或 ProxyUnaryCall。协议位置参考本地 AIStudio2API bd6c40f，许可见根目录 THIRD_PARTY_NOTICES.md。

## 修复

- WAA proof 串行执行，fetch 仍可并行。执行中的 proof 被取消或超时且尚未结算时，停用该文档，并通过现有连接恢复流程导航、重新初始化。不会直接释放输入框锁后启动新 proof。取消尚在排队的 proof 不影响正常请求。
- JSON 与 SSE 错误保留上游消息、details 与 HTTP 状态；Gemini 状态映射包含 RESOURCE_EXHAUSTED、PERMISSION_DENIED、UNAUTHENTICATED 等。HTTP 200 内嵌 RPC 错误和正文后的尾部错误仍作为失败处理。正文输出后禁止重放。
- 支持 googleSearch、urlContext、codeExecution，包含执行代码、执行结果、搜索 grounding 的解码。Gemini 原生保留结构化字段；OpenAI、Responses 和 Anthropic 将执行结果与来源投影为可读文本。混合内置工具与函数声明支持服务端工具步骤。
- 支持 responseSchema / responseJsonSchema 的 Playground Schema 编码、局部引用、可空类型和可表达的组合／数值／长度等约束。无法表达的约束明确返回 400，不使用提示词冒充严格约束。强制或指定函数调用仍降级 AUTO；NONE 通过不发送工具实现。

## 文件

支持：

- OpenAI：POST /v1/files（multipart/form-data），GET /v1/files、GET /v1/files/{id}、GET /v1/files/{id}/content、DELETE /v1/files/{id}。
- Gemini：POST /upload/v1beta/files（multipart/related、raw 或本地 resumable 会话），GET /v1beta/files、GET /v1beta/files/{id}、GET /v1beta/files/{id}/download、DELETE /v1beta/files/{id}。同时接受 v1alpha 与 /proxy 前缀。
- resumable 支持 start、upload、query、finalize、cancel、offset 检查；会话闲置一小时清理。返回的 x-goog-upload-url 为绝对 URL，并识别反向代理的 X-Forwarded-Proto / X-Forwarded-Host。分块暂存于系统临时目录，完成、取消或正常关闭时删除。

文件通过账户网页的 GenerateAccessToken 获取短期授权，经该浏览器访问 Drive。公开文件 ID 与 Drive ID、所属账户、元数据保存于 data/playground-resources.json；凭据不落入该注册表。单文件上限 64 MiB。

生成请求中的 Files API URI 或 files/{id} 会解析成 Drive 引用；调度沿用文件所属账户。多账户文件不能组合使用，所属账户不可用时明确失败。不会自动跨账户复制文件。列表仅包含本服务登记的文件，不枚举账户的其它 Drive 文件。

兼容输入：OpenAI Chat 的 file、Responses 的 input_file、Anthropic 的 document，可携带本服务上传后的 file_id 或内联 Base64；Gemini 使用 fileData。普通外部文件 URI 由 Playground 处理。

## 本地缓存

实现 Gemini cachedContents 的创建、列表、查询、更新过期时间和删除；生成和 countTokens 中的 cachedContent 会在调度前展开，包含缓存系统指令、内容及工具。文件引用仍按所属账户调度。创建时通过上游 CountTokens 计数。

这是进程内兼容缓存，重启后清空；默认 TTL 一小时，上限 1000 个且总内容不超过 64 MiB。缓存不代表上游持久缓存，不承诺降低上游 token 消耗或获得缓存折扣。显式设置 systemInstruction、tools、toolConfig 与 cachedContent 冲突时返回 400。

## 不支持

embeddings（含 embedContent / batchEmbedContents）继续返回本地 501，不访问 Build。其它未映射的上游端点同样返回明确的能力错误。

## 验证

npm test 包含协议编码、兼容转换、错误 JSON/SSE、文件 HTTP 接口、持久注册表、账号亲和性、分块上传及缓存回归。npm run test:transport:browser 包含真实 Firefox 与本地模拟网络的 WAA 挂起恢复、并发隔离、Drive 授权及上传／下载／删除验证。这些测试不调用真实 Google 账号。
