# Phase 24 严格 rollout smoke

这一步把 NewBot 从“有上线后只读 smoke”推进到“放量前可以用同一个 smoke 脚本做阻断检查”。

完成内容：

- `scripts/smoke.mjs` 新增可选参数：
  - `--require-ready`
- 普通模式保持 Phase 21 行为：
  - 检查 `/healthz`
  - 检查 `/version`
  - 用无效 secret 确认 Telegram webhook 返回 `401`
  - 不触发真实 Telegram 消息，不写业务数据，不调用 live order endpoint
- 严格模式会额外输出一个 check：
  - `rollout_readiness`
- `rollout_readiness` 会在以下情况失败并让脚本非 0 退出：
  - live order API 未 ready
  - canonical signing 未 ready
  - Builder attribution 是 `partial`
  - `/healthz.readiness.warnings` 里仍有 warning
- `/healthz` smoke schema 现在要求 `live_trading_allowlist` 是 boolean，并在输出 detail 中显示 allowlist enabled / disabled。
- Telegram `/runbook` 面板新增严格 smoke 命令：
  - `npm run smoke -- --require-ready <worker-url>`

自动化验证覆盖：

- 扩展 `tests/smoke-script.test.ts`
- 覆盖普通 smoke 仍然通过，并要求 healthz detail 带 `live allowlist enabled`
- 覆盖 `--require-ready` 在 readiness 有阻断项时：
  - 脚本退出码为 `1`
  - stderr 输出结构化 JSON
  - checks 里包含失败的 `rollout_readiness`
  - detail 暴露阻断原因，但不暴露 secret
- 扩展 runbook 测试，确保 Telegram 面板会展示严格 smoke 命令。

还没覆盖：

- 还没有把真实 smoke 结果持久化到 D1 或 Telegram 面板；本阶段仍是 CLI 输出 JSON。
- 还没有接 Cloudflare Analytics / Workers Tail 指标。
- 还没有自动部署后回传 smoke 结果到 Telegram。

一句话总结：

Phase 24 让上线 smoke 有了“普通健康检查”和“放量前严格阻断检查”两档，方便先上线、再按 readiness 决定能不能放量。