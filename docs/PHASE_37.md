# Phase 37 smoke dashboard environment shortcuts

Phase 37 在 Phase 36 的 `?env=` 过滤能力上补一个更顺手的 dashboard 入口：不用手改 URL，直接在页面顶部切换 All / Production / Staging / Canary。

## 已完成

- `/ops/smoke-dashboard` 顶部新增环境快捷入口：
  - `All` → `/ops/smoke-dashboard`
  - `Production` → `/ops/smoke-dashboard?env=production`
  - `Staging` → `/ops/smoke-dashboard?env=staging`
  - `Canary` → `/ops/smoke-dashboard?env=canary`
- 当前视图会用 `aria-current="page"` 标记并轻量高亮：
  - 未带 `env` 时高亮 `All`。
  - `?env=production` 时高亮 `Production`。
- 过滤、汇总、趋势和最近运行窗口继续沿用 Phase 36 逻辑。
- 继续复用 `cron_runs.detail.environment`，不新增 D1 schema。
- 继续复用 `NEWBOT_SMOKE_REPORT_SECRET` 认证，不展示 secret 或认证 header。
- README 和默认 Phase 文案更新到 Phase 37。

## 自动化验证覆盖

- `tests/public.test.ts` 扩展 dashboard HTML 测试：
  - 未过滤视图包含 All / Production / Staging / Canary 快捷链接。
  - 未过滤视图高亮 All。
  - `?env=production` 过滤视图包含同一组快捷链接。
  - `?env=production` 过滤视图高亮 Production。
  - 原有 summary、趋势、recent runs 和 secret 不泄漏断言继续保留。

## 仍未覆盖

- 没有引入 JS、dropdown 或图表库。
- 没有接入 Cloudflare Analytics / Workers Tail。
- 没有新增 D1 environment 索引列；如后续需要更长窗口或高频查询，再考虑 schema 化。
- 快捷入口是固定常用环境，不会动态枚举所有历史 environment。

## 成熟度

Phase 37 让 dashboard 更适合日常运营和灰度检查：operator 可以点一下切到 production / staging / canary，同时仍保持只读、低风险、schema-free。