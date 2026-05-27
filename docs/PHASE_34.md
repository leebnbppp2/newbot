# Phase 34 auto-refreshing smoke dashboard window

Phase 34 在 Phase 33 的受保护 HTML dashboard 上加一个很小的运营增强：页面自动刷新，并展示最近 2 次 smoke 运行窗口。

## 已完成

- `/ops/smoke-dashboard` 增加 `<meta http-equiv="refresh" content="60">`，浏览器每 60 秒自动刷新。
- dashboard 顶部说明现在明确提示自动刷新频率。
- 新增 `getRecentSmokeReportRuns(env, limit = 2)`，复用现有 `cron_runs` 查询与 smoke detail 解析逻辑。
- dashboard 新增 `Recent smoke runs` 表格：
  - created_at
  - environment
  - status
  - target
  - 前 3 个 check 的简短结果
- 最近运行窗口只读、schema-free；继续从 `cron_runs.detail` JSON 解析，不新增 D1 migration。
- 最近运行窗口同样 escape report 字符串，不裸渲染 target、environment 或 check name。
- README 和默认 Phase 文案更新到 Phase 34。

## 不包含

- 不做图表库。
- 不做趋势折线图或长期统计窗口。
- 不接 Cloudflare Analytics / Workers Tail。
- 不新增 dashboard 登录态；仍复用 `NEWBOT_SMOKE_REPORT_SECRET` header。
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

Phase 34 仍是低风险运营小切片：不引入新存储和复杂前端，只让已存在的 smoke dashboard 更适合放在浏览器里持续观察。