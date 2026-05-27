# Phase 39 smoke dashboard latest smoke freshness

Phase 39 在 Phase 38 的状态徽章和趋势圆点基础上补一个更实用的时间新鲜度提示：operator 打开 dashboard 时，可以直接看到当前视图最近一次 smoke 是什么时候跑的，避免只看到绿色状态但忽略数据是否陈旧。

## 已完成

- `/ops/smoke-dashboard` summary 卡片新增 `Latest smoke`：
  - 展示当前视图最近一次 smoke report 的 `created_at`。
  - 未过滤视图展示全局最近 smoke 时间。
  - `?env=production` / `?env=staging` 等过滤视图展示该环境最近 smoke 时间。
  - 没有 smoke 数据时显示 `no smoke reports yet`。
- `Latest smoke` 与 Phase 36/37/38 的过滤逻辑共用同一份 `recentRuns`，不会额外查库。
- 保留 Phase 38 的：
  - `Overall status` 徽章。
  - 文本趋势 `ok · failed · ok`。
  - ok / failed 圆点趋势。
- 继续复用 `cron_runs.detail.environment`，不新增 D1 schema。
- 继续复用 `NEWBOT_SMOKE_REPORT_SECRET` 认证，不展示 secret 或认证 header。
- README 和默认 Phase 文案更新到 Phase 39。

## 自动化验证覆盖

- `tests/public.test.ts` 扩展 dashboard HTML 测试：
  - 未过滤视图包含 `Latest smoke`。
  - 未过滤视图显示全局最近 smoke 时间 `2026-05-27T08:20:00.000Z`。
  - production 过滤视图包含 `Latest smoke`。
  - production 过滤视图显示该环境最近 smoke 时间。
  - 原有 summary、状态徽章、快捷入口、趋势文本、趋势圆点、recent runs 和 secret 不泄漏断言继续保留。

## 仍未覆盖

- 没有在 Worker 渲染时计算相对年龄，例如 `5 minutes ago`；当前版本只展示数据库里的绝对时间，避免时钟依赖和测试波动。
- 没有新增 stale 阈值告警；后续如要做，可基于 `Latest smoke` 再加 `stale / fresh` 判定。
- 没有接入 Cloudflare Analytics / Workers Tail。
- 没有新增 D1 environment 索引列。

## 成熟度

Phase 39 让 dashboard 更适合上线后盯盘：状态、趋势和最新 smoke 时间都能一眼看到，同时仍保持只读、低风险、schema-free。