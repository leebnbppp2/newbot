# Phase 32 Telegram smoke metrics panel

Phase 32 把 Phase 31 的 smoke metrics 数据面接进 Telegram operator 面板，让操作者不用离开 Telegram 就能看最近 smoke 聚合状态。

## 已完成

- 新增 Telegram 文本命令：`/metrics`。
- 新增别名命令：`/smoke-metrics`。
- 新增 operator callback：`ops_smoke_metrics`。
- operator 菜单新增 `Smoke Metrics` 按钮。
- 新增 `buildSmokeMetricsReply(...)`，复用 `getSmokeReportMetrics(env)` 输出：
  - 最近 smoke 总次数
  - 通过数
  - 失败数
  - 通过率
  - 各环境 total / passed / failed / 最新状态 / 最新 target / 最新时间
- 继续复用 `cron_runs.detail` JSON，不新增 D1 migration。
- 继续复用 `NEWBOT_OPERATOR_TELEGRAM_IDS` 保护 Telegram 内部视图；非操作者不会看到 smoke target URL 或内部状态。

## 不包含

- 不做 HTML dashboard。
- 不接 Cloudflare Analytics / Workers Tail。
- 不新增 metrics 表或 D1 schema。
- 不展示任何 secret、token 或认证 header 值。

## Telegram 示例

```text
Phase 32 smoke metrics：
最近 smoke：3 次
通过：2
失败：1
通过率：66.7%
各环境：
- production：2 次 / 通过 2 / 失败 0 / 最新通过
  https://production.example.workers.dev（2026-05-27T08:20:00.000Z）
- staging：1 次 / 通过 0 / 失败 1 / 最新失败
  https://staging.example.workers.dev（2026-05-27T08:10:00.000Z）
```

## 验证

```bash
npm test -- --run tests/webhook.phase6.test.ts -t "smoke metrics"
npm run typecheck
npm test
npm run build
```

## 总结

Phase 32 是 Telegram 内部运营面板的小切片：不引入新存储，不扩大权限面，只把已有 smoke 聚合结果变成操作者可读的短面板。