# Phase 23 live 交易 allowlist

这一步把 NewBot 从“有灰度 runbook”推进到“真实下单入口本身也有一层 per-user allowlist”。

完成内容：

- 新增环境变量：
  - `NEWBOT_LIVE_TRADING_TELEGRAM_IDS`
  - 逗号分隔 Telegram user id，例如：`123456,789012`
- 行为规则：
  - 未配置或空字符串：保持 Phase 22 行为，不锁住现有部署
  - 已配置：只有列表里的 Telegram user id 会走 live order API
  - 不在列表里的已绑定用户，即使 live API / signing secret 已配置，也只会记录模拟单
- 非 allowlist 用户的模拟单会在 `trade_events.payload_json` 里记录：
  - `reason: live_trading_not_allowlisted`
  - 简短中文说明
- Telegram 回复会明确说：
  - “模拟下单已经记录”
  - “live 交易还没对你开放”
- readiness / runbook 面板新增：
  - `Live trading allowlist：已启用 / 未启用`
- `/healthz` readiness 也新增：
  - `live_trading_allowlist`

自动化验证覆盖：

- 扩展 `tests/webhook.phase6.test.ts`
- 覆盖 live API 已配置但用户不在 `NEWBOT_LIVE_TRADING_TELEGRAM_IDS` 时：
  - 不调用 `https://orders.example.com/orders`
  - 只写入 `simulated_submitted` trade event
  - 不写入 builder attribution
  - payload 记录 `live_trading_not_allowlisted`
  - 用户文案提示 live 交易未开放
- 覆盖 runbook 展示 `Live trading allowlist：已启用`
- 保留未配置 allowlist 时的旧 live 下单测试，避免误锁现有部署

还没覆盖：

- 还没有百分比 hash 灰度；目前是明确 user id allowlist。
- 还没有管理后台编辑 allowlist；仍通过 Worker 环境变量配置。
- 还没有对 open orders / cancel 做独立 allowlist；本阶段只控制“新 live 下单”。

一句话总结：

Phase 23 给真实下单加了一道最简单、最稳的用户级闸门：没进 live allowlist 的用户永远只走模拟单，便于按人灰度。