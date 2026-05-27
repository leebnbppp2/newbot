# Phase 27 smoke 环境标签

这一步把 NewBot 从“能看到最近一次 smoke”推进到“能区分这次 smoke 属于哪个环境”，先解决 production / staging / canary 混在一起看不清的问题。

完成内容：

- `scripts/smoke.mjs` 新增可选参数：
  - `--report-env <environment>`
- 同时支持环境变量：
  - `SMOKE_REPORT_ENV`
- smoke JSON payload 会在配置后带上：
  - `environment: "production" | "staging" | "canary" | ...`
- `POST /ops/smoke-report` 继续沿用 Phase 25 的最小校验：
  - 必须有 `ok`、`target`、`checks`
  - 额外的 `environment` 会随完整 detail JSON 一起保存到 `cron_runs`
- Telegram `/runbook` / `/rollout`：
  - 读取最近 smoke 时会解析可选 `environment`
  - 有环境标签时显示 `环境：production`
  - 没有环境标签时保持 Phase 26 行为，不强制要求迁移旧报告
- runbook 操作提示更新为：
  - 可选加 `--report-url /ops/smoke-report` 和 `--report-env production` 回传结果

自动化验证覆盖：

- 扩展 `tests/smoke-script.test.ts`
  - 验证 `--report-env production` 会进入 POST 到 `/ops/smoke-report` 的 JSON payload
- 扩展 `tests/webhook.phase6.test.ts`
  - 验证 runbook 会展示最新 smoke report 的 `环境：production`
  - 保持只读取最新一条 smoke 记录，不误用旧记录

还没覆盖：

- 暂未做按环境筛选最近 smoke；目前仍是全局最近一条。
- 暂未给 `cron_runs` 增加单独 environment 字段；先复用 detail JSON，避免迁移风险。
- 暂未做多环境历史列表或趋势图。

一句话总结：

Phase 27 先给 smoke report 加轻量环境标签，让 runbook 可以看出最近一次检查是 production、staging 还是 canary。