# Phase 33 authenticated smoke dashboard

Phase 33 把 Phase 31/32 已经沉淀出来的 smoke metrics 做成一个受保护的极简 HTML 页面，方便在浏览器里快速看 production / staging / canary 的最近 smoke 状态。

## 已完成

- 新增 `GET /ops/smoke-dashboard`。
- 复用 `NEWBOT_SMOKE_REPORT_SECRET` 和 `x-newbot-smoke-report-secret` 认证；未配置或 header 不匹配时返回 `401`。
- 复用 `getSmokeReportMetrics(env, 50)` 聚合逻辑，不在 route 里重新计算指标。
- 页面展示：
  - 最近 smoke 总数
  - 通过数
  - 失败数
  - 通过率
  - 各环境 total / passed / failed / 最新状态 / 最新 target / 最新时间
- HTML 输出会 escape target / environment / timestamp，避免把 report detail 里的字符串直接裸渲染。
- `src/index.ts` 接入 `/ops/smoke-dashboard` 路由。
- README 和默认 Phase 文案更新到 Phase 33。

## 不包含

- 不做图表库、趋势图或自动刷新。
- 不接 Cloudflare Analytics / Workers Tail。
- 不新增 D1 migration；继续复用 `cron_runs.detail` JSON。
- 不展示任何 secret、token 或认证 header 值。

## 调用示例

```bash
curl -H "x-newbot-smoke-report-secret: $SMOKE_REPORT_SECRET" \
  https://<your-worker>.workers.dev/ops/smoke-dashboard
```

## 验证

```bash
npm test -- tests/public.test.ts -t "smoke dashboard"
npm run typecheck
npm test
npm run build
```

## 总结

Phase 33 是 dashboard 前的最小可用运营页面：它只读、受同一个 smoke report secret 保护、复用既有聚合数据，不扩大存储和部署复杂度。