# Phase 22 灰度 runbook 面板

这一步把 NewBot 从“部署后有 smoke 脚本”推进到“Telegram 内有一个操作者可刷新的灰度上线 runbook”。

完成内容：

- 新增 Telegram 操作者指令：
  - `/runbook`
  - `/rollout`
- 新增 callback 入口：
  - `灰度 Runbook`
  - callback data：`ops_runbook`
- runbook 面板会显示：
  - live order API 是否已配置
  - canonical signing 是否已启用
  - Builder attribution 是 `ready / partial / disabled`
  - 上线前必须先跑 `npm run smoke -- <worker-url>`
  - 灰度顺序：`1% / allowlist` → `10%` → `100%`
  - 回滚条件：smoke 失败、webhook secret 防护异常、live order API/signing 缺失等
  - 当前 readiness warning 作为阻断项
- 继续沿用 Phase 20 的 `NEWBOT_OPERATOR_TELEGRAM_IDS`：
  - 未配置 allowlist 时保持旧行为，入口可用
  - 配置 allowlist 后，只有白名单 Telegram user id 能查看 runbook
  - 非操作者点击 callback 时只收到 alert，不展示 readiness / runbook 细节
- 不展示 secret 原文：
  - Builder API key、order API key、signing secret 都不会出现在 Telegram 文案里

自动化验证覆盖：

- 扩展 `tests/webhook.phase6.test.ts`
- 覆盖 `/runbook` 对配置过的操作者返回 Phase 22 灰度 runbook
- 覆盖 runbook 里包含 smoke 命令、1% allowlist 放量、live API/signing readiness
- 覆盖 callback `ops_runbook` 仍受操作者 allowlist 保护
- 回归确认旧 `/health`、`ops_health` allowlist 行为仍然保留

还没覆盖：

- 还没有真正自动执行部署或自动放量；Phase 22 只把人工/半自动灰度步骤固定到 Telegram 面板。
- 还没有连接真实指标平台；目前阻断项来自 readiness warning 和 smoke 手动结果。
- 还没有 per-user 流量百分比开关；`1% / allowlist` 仍是运行层面的操作建议。

一句话总结：

Phase 22 是上线前的操作者 runbook：把“先 smoke、再小流量、再观察、再放量、异常就回滚”固定进 Telegram 内部面板，但不做高风险自动化。
