# Phase 20 Telegram 操作者白名单

这一步把 Phase 19 的 Telegram 内系统状态面板，从“所有能点到的人都能看”推进到“可以只给配置过的操作者看”。

完成内容：

- 新增可选环境变量 `NEWBOT_OPERATOR_TELEGRAM_IDS`
  - 格式是逗号分隔的 Telegram user id，例如 `123456,789012`
  - 没配置时保持 Phase 19 行为，避免部署时突然挡住现有使用
  - 配置后，只有白名单里的 user id 可以打开 `/health` / `/ops` / `/readiness`

- `系统状态` callback 也走同一套限制
  - 操作者点击后继续原地刷新 readiness
  - 非操作者点击后会收到 Telegram alert：`只有配置过的操作者可以看系统状态`
  - 正文不会展示 live API、signing、Builder readiness 等内部状态

- 默认引导文案更新到 Phase 20
  - 明确说明系统状态入口在配置白名单后只给操作者看

自动化验证覆盖：

- 配置了 `NEWBOT_OPERATOR_TELEGRAM_IDS` 后，非操作者发 `/health` 不会看到内部 readiness
- 配置了 `NEWBOT_OPERATOR_TELEGRAM_IDS` 后，白名单操作者发 `/ops` 可以正常看到 readiness
- 非操作者点击 `系统状态` callback 会收到 alert，并且不会看到内部 readiness
- Phase 19 已有的 `/health`、`ops_health` readiness 测试继续通过

还没覆盖：

- 这一步只做 Telegram 内状态入口权限限制，不做真实远端连通性探测。
- `/healthz` 仍然是公开 Worker health endpoint，用于外部监控和部署探针；Phase 20 只限制 Telegram 内部操作入口。
- 白名单仍是 env 配置，不做后台 UI 动态管理。

一句话总结：

Phase 20 是上线前的低风险安全收口：内部 readiness 仍然顺手，但配置白名单后不会随便暴露给普通用户。
