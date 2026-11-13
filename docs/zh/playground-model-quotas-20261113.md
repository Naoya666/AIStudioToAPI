# Playground 模型额度与权限更新（2026-11-13）

依据用户提供的 Playground 额度截图更新。以下均为每日预估，次数与 Token 任一用完即达到额度；未知值保留为空，不推断为无限。截图注明北京时间下午 4 点重置；当前实现仍沿用太平洋时间自然日计数，冬令时对应北京时间下午 4 点。

| 模型                   | Free                  | Pro                    | Ultra 5x / 20x              |
| ---------------------- | --------------------- | ---------------------- | --------------------------- |
| gemini-4-argon         | 不可用                | 50 次 / 1500 万 Token  | 200 次 / Token 未知         |
| gemini-4-carbon        | 不可用                | 不可用                 | 200 次 / Token 未知         |
| gemini-4-hydrogen      | 50 次 / 1000 万 Token | 100 次 / 2500 万 Token | 次数与 Token 未知，允许调用 |
| gemini-3.1-pro-preview | 不可用                | 50 次 / 1300 万 Token  | 100 次 / Token 未知         |
| gemini-3.8-flash       | 50 次 / 500 万 Token  | 150 次 / 2500 万 Token | 200 次 / Token 未知         |
| gemini-3.6-flash       | 50 次 / 500 万 Token  | 150 次 / 2500 万 Token | 200 次 / Token 未知         |
| gemini-3-flash-preview | 50 次 / 500 万 Token  | 150 次 / 2500 万 Token | 200 次 / Token 未知         |
| gemini-3.5-flash-lite  | 50 次 / 500 万 Token  | 150 次 / 2500 万 Token | 200 次 / Token 未知         |
| gemini-3.1-flash-lite  | 50 次 / 500 万 Token  | 150 次 / 2500 万 Token | 200 次 / Token 未知         |

Carbon 与 Hydrogen 已加入模型目录，并沿用通用工具调用与真实 SSE 流式传输，加入现有工具调用抗截断支持列表。依据用户提供的社区测试结论，不增加待验证的模型拦截。

已有安装首次加载时，按本表迁移已登记模型的层级权限，并记录 `playgroundPermissions20261113`；其他模型及 Build 权限保留。迁移后管理员对权限矩阵的修改会在后续重启中保留。新安装使用更新后的默认矩阵，显式提供的初始权限配置继续生效。预估额度仅用于展示，实际限流仍依据上游响应。

本表更新了早期权限设计文档中关于 Free 限制的历史说明。
