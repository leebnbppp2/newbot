# Phase 28 runbook 按环境展示 smoke 状态

这一步把 NewBot 从“runbook 能看最近一次带环境标签的 smoke”推进到“runbook 能同时看到各环境最近一次 smoke 状态”，避免 canary / staging / production 混在一起时只看到全局最新一条。

完成内容：

- `src/db/cron_runs.ts`：
  - 保留 `getLatestSmokeReportRun(env)` 返回全局最近一条 smoke
  - 新增 `getLatestSmokeReportRunsByEnvironment(env)`
  - 从最近 20 条 `job_name = smoke` 记录中解析 detail JSON
  - 按 `environment` 去重，只保留每个环境最新一条
  - 忽略没有环境标签或无法解析的旧报告，保持 Phase 26/27 兼容
- Telegram `/runbook` / `/rollout`：
  - 继续展示“最近 smoke”作为全局最新状态
  - 额外展示“各环境 smoke”列表
  - 每行展示：环境、通过/失败、目标 worker、回传时间
- `灰度 Runbook` callback：
  - 同样读取各环境最近状态
  - 仍受 `NEWBOT_OPERATOR_TELEGRAM_IDS` 保护
- 不新增 D1 migration：
  - Phase 28 仍复用 `cron_runs.detail` 中的 `environment`
  - 先满足 operator 可见性，不提前做复杂报表表结构

自动化验证覆盖：

- 扩展 `tests/webhook.phase6.test.ts`
  - seed canary / production / staging 多条 smoke 记录
  - 验证 runbook 展示全局最近 smoke
  - 验证 runbook 展示各环境最近状态
  - 验证 production 只展示最新记录，不误用旧 production worker
- Fake D1 的 `FROM cron_runs` 查询支持 `LIMIT ?`，用于读取最近 20 条 smoke 记录。

还没覆盖：

- 暂未做 `/runbook production` 这类按环境筛选命令。
- 暂未做独立 `environment` 数据库列；后续如果要高效查询或统计趋势，再加 migration。
- 暂未接 Cloudflare Analytics / Workers Tail 指标。

一句话总结：

Phase 28 让 operator 在 Telegram runbook 里同时看到 production / staging / canary 各自最近 smoke 状态，先把多环境上线观察补齐。