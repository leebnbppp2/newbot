# Phase 25 smoke 报告回传落库

这一步把 NewBot 从“CLI 输出 smoke JSON”推进到“部署后 smoke 结果可以认证回传并持久化”。

完成内容：

- 新增 Worker 环境变量：
  - `NEWBOT_SMOKE_REPORT_SECRET`
- 新增认证写入入口：
  - `POST /ops/smoke-report`
  - 请求头：`x-newbot-smoke-report-secret: <secret>`
- 报告入口只接受结构化 smoke JSON：
  - `ok: boolean`
  - `target: string`
  - `checks: array`
- 通过认证后写入既有 `cron_runs` 表：
  - `job_name = smoke`
  - `status = ok / failed`
  - `detail = <完整 smoke JSON>`
- `scripts/smoke.mjs` 新增可选参数：
  - `--report-url <url>`
  - `--report-secret <secret>`
- 也支持环境变量：
  - `SMOKE_REPORT_URL`
  - `SMOKE_REPORT_SECRET`
- smoke 报告回传失败时，会在本次 smoke JSON 里追加：
  - `smoke_report_delivery`
  - 并让脚本非 0 退出，避免“检查成功但结果没落库”被误认为完整成功。
- Telegram `/runbook` 面板新增提示：
  - 可选加 `--report-url /ops/smoke-report` 回传 smoke 结果。

自动化验证覆盖：

- 扩展 `tests/public.test.ts`
  - 认证成功时把 smoke report 写入 `cron_runs`
  - 认证失败时返回 `401` 且不写入
- 扩展 `tests/smoke-script.test.ts`
  - smoke 成功后能 POST 结构化报告到 `/ops/smoke-report`
  - 请求带 `x-newbot-smoke-report-secret`
  - 报告体包含 `ok`、`target` 和 checks
- 扩展 runbook 测试，确认 Telegram 面板提示报告回传入口。

还没覆盖：

- Telegram `/runbook` 还没有直接读取并展示最近一次 `cron_runs` smoke 结果。
- 还没有做多环境标签，比如 production / staging / canary。
- 还没有接 Cloudflare Analytics / Workers Tail 指标。

一句话总结：

Phase 25 先给 smoke 结果一个安全、低风险的落库入口：部署脚本可以把 JSON 回传到 Worker，后面再让 Telegram runbook 读取最近一次结果。