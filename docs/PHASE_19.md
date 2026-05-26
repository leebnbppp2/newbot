# Phase 19 Telegram 内系统状态

这一步把 Phase 18 已经放在 `/healthz` 里的 readiness，接到 Telegram 内部操作入口里。

完成内容：

- 新增 `/health` / `/ops` / `/readiness`
  - 在 Telegram 对话里直接显示：
    - live order API 是否已配置
    - canonical signing 是否启用
    - Builder attribution 是 `ready / partial / disabled`
    - 当前配置 warning
  - 这样灰度时不用切到浏览器或 curl，也能从 bot 里看上线前状态。

- 主菜单新增 `系统状态` 按钮
  - callback data：`ops_health`
  - 点击后原地刷新状态消息
  - 同时通过 `answerCallbackQuery` 给出“系统状态已刷新”的短提示

- 默认引导文案更新到 Phase 19
  - 现在会明确提示 `/health` 已可用

自动化验证覆盖：

- `/health` 文本命令会返回 readiness 文案，并带系统状态按钮
- `ops_health` callback 会：
  - 返回 toast：`系统状态已刷新`
  - 原地 edit message
  - 在完整配置下显示 live API、signing、Builder attribution 都 ready
- 旧的 live buy / cancel / portfolio / cache fallback / callback pagination 测试继续通过

还没覆盖：

- 这一步只做配置状态展示，不做权限控制或真实远端连通性探测。
- `/healthz` 仍然是公开 health endpoint；Telegram 内 `/health` 只是同一份 readiness 的更顺手入口。

一句话总结：

Phase 19 不是加交易功能，而是把上线前最常看的配置状态放进 Telegram 操作面板里，方便灰度和排查。
