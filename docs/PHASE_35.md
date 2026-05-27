# Phase 35 smoke dashboard trend strip

Phase 35 在 Phase 34 的受保护 HTML dashboard 上继续做一个低风险运营增强：保留自动刷新和最近运行窗口，同时补一条最近 10 次 smoke 的短趋势条。

## 已完成

- 新增 `getSmokeReportTrend(env, limit = 10)`：
  - 继续复用 `cron_runs.detail` 里的 smoke report JSON。
  - 不新增 D1 schema，也不引入 chart library。
  - 统计最近 N 次 smoke 的通过数、失败数、通过率，并保留最新优先的 run 列表。
- `/ops/smoke-dashboard` 新增 `Smoke trend (last 10)` 区块：
  - 展示最近 10 次 smoke 的短趋势序列，例如 `ok · failed · ok`。
  - 展示趋势窗口通过率与通过/失败数量。
  - 页面仍每 60 秒自动刷新。
- 继续保持 dashboard 只读、认证访问：
  - 仍复用 `NEWBOT_SMOKE_REPORT_SECRET`。
  - 不展示 secret、认证 header 或原始报告 JSON。
  - dashboard 中来自 report 的字符串仍会做 HTML escape。
- README 和默认 Phase 文案更新到 Phase 35。

## 自动化验证覆盖

- `tests/public.test.ts` 覆盖认证 dashboard 输出：
  - meta refresh 仍存在。
  - 环境汇总仍存在。
  - 新的 `Smoke trend (last 10)` 区块存在。
  - 趋势序列按最新优先输出。
  - 非 smoke cron row 不会出现在 dashboard。

## 仍未覆盖

- 没有接入 Cloudflare Analytics / Workers Tail 指标。
- 没有新增图表库、交互式筛选或长日志查看器。
- 没有新增 D1 schema；趋势窗口仍从最近 `cron_runs` smoke 记录即时计算。

## 成熟度

Phase 35 仍是安全的运营可视化小切片：dashboard 已能常驻观察最近状态和短趋势，但还不是完整监控系统。