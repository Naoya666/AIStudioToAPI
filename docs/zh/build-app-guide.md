# 自己创建兼容的 Build App

通过 Google AI Studio Build 网页端，将本项目的浏览器客户端移植到自己的 App。服务端仍使用 AIStudioToAPI；App 负责接收服务端请求、执行浏览器端 fetch 并回传结果。

## 准备源码

从**正在部署的同一版本**取出这两个文件，下载原始文件，或从本地源码目录直接上传：

- [scripts/client/build.js](../../scripts/client/build.js)：浏览器客户端完整实现。
- [scripts/client/index.html](../../scripts/client/index.html)：页面入口与账号身份握手。

保留作者署名、注释和许可证。不要把 `.env`、Cookie、账号导出文件或服务端密钥当作附件。

[可直接复制的 Build 提示词](build-app-prompt.md) 保留了用户提供的上游源码链接。本仓库包含后续协议兼容修复，实际移植应优先上传与你部署版本一致的两个文件，避免混用不同版本。

## 在 Build 网页端创建 App

1. 登录 Google AI Studio，进入 Build 创建自己的 Web App。
2. 上传上述 `build.js` 和 `index.html`，将[提示词全文](build-app-prompt.md)复制到 Build 对话中发送。
3. 保存 App，点击右上角 Share，设置权限为向所有人开放，复制浏览器地址的 **AI Studio App 页面URL**，用于服务端打开宿主页。

编辑器预览通常没有自动化服务注入的身份，也没有 `127.0.0.1:9998` 服务。身份等待或连接失败可以发生在编译成功的 App 中；不代表实际错误，应接入服务后再验证连接。

## 让服务使用自己的 App

当前服务入口由 [src/core/BrowserManager.js](../../src/core/BrowserManager.js) 构造器中的 `this.targetUrl` 指定。将该值改为自己的 App 页面地址，例如：

```javascript
this.targetUrl = "https://ai.studio/apps/YOUR_APP_ID";
```

这里填写你实际取得的 App 页面地址。自动登录队列和目标会话验证会使用 BrowserManager 的目标地址。若另外运行 [scripts/auth/testAccountLogin.js](../../scripts/auth/testAccountLogin.js) 诊断脚本，也将脚本中的 `targetUrl` 改为同一个地址。

修改源码后，Docker Compose 部署需要重建并重启：

```bash
docker compose up -d --build
docker compose logs -f app
```

源码部署则停止原服务，再运行 `npm start`。仅重启旧 Docker 镜像不会加载源码里修改的地址。

保持客户端 `ws://127.0.0.1:9998` 不变：这里是**运行自动化浏览器的机器/容器**的回环地址，与远程访问管理页面时所用的域名不同。服务端 MakerSuite 桥接继续由现有服务安装，不需要放进 App。

## 接入后的检查

| 状态      | 检查依据                                                                     |
| --------- | ---------------------------------------------------------------------------- |
| 编译      | Build 实际执行编译，并报告真实结果与必要适配                                 |
| 身份握手  | 接收到服务父页面返回的有效 authIndex，同时保留 browserGeneration / attemptId |
| WebSocket | 真实连接打开后，原客户端输出包含 `Connection successful` 的日志              |
| 请求处理  | 手动通过 API 发起请求，确认返回真实正文、正确结束事件；再检查流式与取消      |

先用 `/v1/models` 选择账号实际可调用的模型，再按 [API 示例](api-examples.md) 手动调用。模型列表可读取、App 可编译或 WebSocket 已连接，都不单独代表模型生成已成功。预览中的错误不能靠固定 authIndex、伪造成功日志或模拟回复来消除。
