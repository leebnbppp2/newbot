# Phase 38 smoke dashboard status badge and trend dots

Phase 38 在 Phase 37 的 dashboard 快捷切换基础上做一次轻量视觉增强：operator 打开页面时可以更快看出当前视图是否健康，以及最近 smoke 趋势里哪几次失败。

## 已完成

- `/ops/smoke-dashboard` summary 卡片新增 `Overall status`：
  - 当前过滤视图没有失败时显示 `Healthy`。
  - 当前过滤视图存在失败时显示 `Attention`。
  - 没有 smoke 数据时保留 `No data` 语义。
- `Smoke trend (last 10)` 保留原来的文本趋势：
  - `ok · failed · ok`
- 同时新增圆点趋势：
  - 绿色圆点代表 `ok`。
  - 红色圆点代表 `failed`。
  - 圆点带 `title` / `aria-label`，不只依赖颜色。
- 继续复用 Phase 36/37 的 `?env=` 过滤和 All / Production / Staging / Canary 快捷入口。
- 继续复用 `cron_runs.detail.environment`，不新增 D1 schema。
- 继续复用 `NEWBOT_SMOKE_REPORT_SECRET` 认证，不展示 secret 或认证 header。
- README 和默认 Phase 文案更新到 Phase 38。

## 自动化验证覆盖

- `tests/public.test.ts` 扩展 dashboard HTML 测试：
  - 未过滤视图包含 `Overall status` 和 `Attention`。
  - production 过滤视图包含 `Overall status` 和 `Healthy`。
  - 趋势区域包含 ok / failed 两类圆点 HTML。
  - 原有 summary、快捷入口、趋势文本、recent runs 和 secret 不泄漏断言继续保留。

## 仍未覆盖

- 没有引入 JS、SVG 图表库或外部 CSS。
- 没有接入 Cloudflare Analytics / Workers Tail。
- 没有新增 D1 environment 索引列；如后续需要更长窗口或高频查询，再考虑 schema 化。
- Overall status 只基于当前视图内最近聚合窗口是否存在 failed，不做 SLA 或时间窗口告警判定。

## 成熟度

Phase 38 让 smoke dashboard 更适合一眼扫状态，但仍保持只读、低风险、schema-free。