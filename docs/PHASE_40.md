# Phase 40 smoke dashboard freshness status

Phase 40 在 Phase 39 的 `Latest smoke` 时间卡片基础上补一个明确的新鲜度状态：operator 不只看到最近 smoke 的时间，也能一眼判断这份数据是不是已经过期。

## 已完成

- `/ops/smoke-dashboard` summary 卡片新增 `Freshness`：
  - 最近一次 smoke 在 2 小时内显示 `Fresh`。
  - 超过 2 小时显示 `Stale`。
  - 当前视图没有 smoke 数据时显示 `No data`。
  - 时间无法解析时显示 `Unknown`。
- `Freshness` 跟随当前 dashboard 视图：
  - 未过滤视图基于全局最近 smoke。
  - `?env=production` / `?env=staging` 等过滤视图基于该环境最近 smoke。
- `Freshness` 复用 dashboard 已经查询出的 `recentRuns`，不额外查库。
- 继续复用 `cron_runs.detail.environment`，不新增 D1 schema。
- 继续复用 `NEWBOT_SMOKE_REPORT_SECRET` 认证，不展示 secret 或认证 header。

## 自动化验证覆盖

- `tests/public.test.ts` 扩展 dashboard HTML 测试：
  - 未过滤视图包含 `Freshness`。
  - 未过滤视图在固定旧时间样本下显示 `Stale`。
  - production 过滤视图包含 `Freshness`。
  - production 过滤视图在固定旧时间样本下显示 `Stale`。
  - 原有 summary、状态徽章、快捷入口、趋势文本、趋势圆点、recent runs 和 secret 不泄漏断言继续保留。

## 仍未覆盖

- 没有显示相对时间，例如 `5 minutes ago`，避免测试依赖当前时钟格式。
- 没有做自动告警或 Telegram 推送；当前只在 dashboard 上展示状态。
- 没有接入 Cloudflare Analytics / Workers Tail。
- 没有新增 D1 environment 索引列。

## 成熟度

Phase 40 让 dashboard 更适合上线后快速判断“状态是否可信”：绿色状态、最近时间和 Fresh/Stale 能放在一起看，同时仍保持只读、低风险、schema-free。
