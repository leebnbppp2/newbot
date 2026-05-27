# Phase 31 smoke metrics endpoint

这一步把 NewBot 从“Telegram runbook 展示最近 smoke 状态”推进到“有一个认证 JSON metrics endpoint，可以给后续 dashboard / monitoring 复用”。

完成内容：

- 新增 `GET /ops/smoke-metrics`：
  - 使用和 smoke report 相同的 `NEWBOT_SMOKE_REPORT_SECRET`
  - 请求头仍是 `x-newbot-smoke-report-secret`
  - 未配置 secret 或 secret 不匹配时返回 `401`
- 新增 `getSmokeReportMetrics(env, limit)`：
  - 读取最近 50 条 `cron_runs` 中 `job_name = smoke` 的记录
  - 输出总数、通过数、失败数、通过率
  - 按 `detail.environment` 聚合各环境 smoke 统计
  - 每个环境保留最近一次 status / target / created_at，方便 dashboard 展示当前状态
- 保持 schema-free：
  - 继续解析 `cron_runs.detail` 里的 smoke JSON
  - 不新增 D1 migration
  - 不新增公开 HTML dashboard，先给后续 UI / 监控一个稳定数据接口

返回形状示例：

```json
{
  "ok": true,
  "metrics": {
    "total": 3,
    "passed": 2,
    "failed": 1,
    "pass_rate": 0.667,
    "environments": [
      {
        "environment": "production",
        "total": 2,
        "passed": 2,
        "failed": 0,
        "latest_status": "ok",
        "latest_target": "https://production.example.workers.dev",
        "latest_created_at": "2026-05-27T08:20:00.000Z"
      }
    ]
  }
}
```

自动化验证覆盖：

- 扩展 `tests/public.test.ts`：
  - seed production / staging / 非 smoke cron run
  - 验证 metrics 只统计 smoke job
  - 验证总数、通过数、失败数、通过率
  - 验证环境聚合和最新 target
  - 验证错误 secret 返回 `401`

还没覆盖：

- 暂未做 Telegram 内 metrics 面板。
- 暂未做 HTML dashboard 或趋势图。
- 暂未新增 Cloudflare Analytics / Workers Tail 集成。
- 暂未新增 indexed `environment` column；等 trend query 需要时再做 migration。

一句话总结：

Phase 31 先把 smoke metrics 做成一个受保护的 JSON 数据面，后面要做 dashboard、告警或 Telegram metrics 面板时就不用再改底层聚合逻辑。