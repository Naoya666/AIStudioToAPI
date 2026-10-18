# 任务：移植 AIStudioToAPI 浏览器客户端至 Google AI Studio Build Web App

请根据以下两个源码文件，创建一个与现有 AIStudioToAPI 项目兼容的 Google AI Studio Build Web App：

- `build.js`：[上游源码](https://github.com/Naoya666/AIStudioToAPI/blob/main/scripts/client/build.js)
- `index.html`：[上游源码](https://github.com/Naoya666/AIStudioToAPI/blob/main/scripts/client/index.html)

这是已有系统的浏览器客户端移植任务。

请以上述源码为协议依据，保留其原有行为。不要自行设计一套新协议，也不要生成普通聊天应用作为替代。

如果已上传这两个文件的附件，以与当前 AIStudioToAPI 部署版本一致的附件为准；上述链接保留作为上游参考。如果无法读取链接，也没有收到附件，请明确指出缺少哪些源码，不要猜测协议实现。

## 一、应用结构

1. 使用最小化 Web 前端，保留 AI Studio 平台要求的构建与启动配置。
2. 使用附件 `index.html` 作为页面入口。
3. 将附件 `build.js` 作为浏览器端模块执行。可以直接保存为 `build.js`，并修改 `index.html` 中的 module script 路径；也可以将其内容放入 `index.ts`，仅进行必要的编译适配。
4. 必须保留原作者信息和已有注释。
5. 不要添加 React 渲染逻辑覆盖 `document.body`，原客户端需要使用页面 DOM 输出运行日志。
6. 不要新增数据库、账号登录系统、聊天界面或自动生成测试请求。

## 二、账号身份握手必须保持兼容

附件 `index.html` 会创建：

```javascript
window.__authIndexReady;
```

并向父页面发送：

```javascript
{
  type: "requestAuthIndex";
}
```

父页面由现有自动化服务控制，会返回：

```javascript
{
    type: "authIndexResponse",
    authIndex: 非负整数,
    browserGeneration: ...,
    attemptId: ...
}
```

必须保留以下字段的设置：

```javascript
window.chrome._contextId;
window.chrome._browserGeneration;
window.chrome._browserAttemptId;
```

身份握手要求：

1. 收到有效 `authIndex` 后才允许启动连接。
2. 不得将 `authIndex` 固定为 `0`。
3. 不得随机生成身份。
4. 不得伪造父页面响应。

## 三、WebSocket 行为

保留附件客户端原有的 WebSocket 连接地址：

```text
ws://127.0.0.1:9998
```

这里的 `127.0.0.1` 指运行浏览器的机器。正式运行时，浏览器与现有 WebSocket 服务处于同一容器环境。

必须保留：

1. `authIndex`、`generation`、`attemptId` 查询参数的生成逻辑，以及所用源码中已有的其他查询参数。
2. 原有 WebSocket 连接方式。
3. 真实连接成功时的日志文本 `Connection successful`，包括源码已有的日志前后缀。
4. 原有连接失败日志和断线重连行为。

禁止以下修改：

- 不得将连接地址替换为公网服务器地址、Cloud Run 地址或 Build 开发服务器地址。
- 不得改成由服务端 Node.js 发起 WebSocket 连接。
- 不得在 WebSocket 真正打开前打印 `Connection successful`。

## 四、请求处理协议

直接复用附件 `build.js` 的完整实现，包括但不限于：

1. 服务端消息解析和请求派发。
2. 请求 ID 与 `request_attempt_id` 的关联。
3. 多个请求的并发处理。
4. `fetch` 请求构造、请求体和请求头处理。
5. 普通响应和流式响应读取。
6. `response_headers`、`chunk`、`stream_close`、`error` 回传。
7. 取消请求、`AbortController` 和超时清理。
8. 断线重连及旧请求清理。
9. 已有的 URL、上传和错误处理逻辑。

协议兼容性要求：

- 字段名称、消息结构、事件名称和数据编码均以附件源码为准。
- 不要简化成只支持单个请求的演示程序。
- 不要自行重写 Gemini API 调用。
- 不要更换为 SDK 调用。

现有服务端已经实现 MakerSuite 协议桥接。

本次任务只移植浏览器客户端，不要将服务端桥接代码复制进 App，也不要自行实现 Google 内部认证。

## 五、凭据与运行边界

### 凭据安全

- 不要将 Cookie、token、API key 或服务端密钥写入前端。
- 不要读取或输出用户登录凭据。
- 不要创建模拟连接、模拟模型回复或伪造就绪状态，以使预览界面显示成功。

### 运行环境限制

Build 编辑器预览中没有现有服务注入的账号身份，也没有本地 WebSocket 服务。

因此，在预览环境中出现身份等待或连接失败，不代表编译失败。

请明确区分以下四种状态：

1. 编译状态：项目是否成功编译。
2. 身份握手状态：是否成功接收到有效账号身份。
3. WebSocket 连接状态：是否建立真实 WebSocket 连接。
4. 请求处理状态：是否完成真实请求处理。

### 异常处理原则

如果当前 AI Studio 平台限制导致原客户端无法运行：

- 必须准确报告平台限制。
- 必须说明实际错误。
- 不得擅自更换通信架构。
- 不得通过模拟数据掩盖运行失败。

## 六、交付要求

请实际创建完整项目文件并执行编译检查。

完成后，明确说明：

1. 文件变更：创建或修改了哪些文件。
2. 移植差异：相比附件源码进行了哪些必要修改，以及修改原因。
3. 已完成检查：哪些检查已经真实执行并通过。
4. 待验证项目：哪些检查必须接入现有 AIStudioToAPI 服务后才能完成。

最终目标：在 Google AI Studio Build 环境中运行与原 AIStudioToAPI 项目兼容的浏览器客户端，而不是重新实现一个功能相似但协议不兼容的新应用。
