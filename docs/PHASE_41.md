# Phase 41 smoke dashboard check details

Phase 41 在 Phase 40 的 Fresh/Stale 基础上补齐最近 smoke 失败原因展示：operator 打开 dashboard 时，不只看到某次 smoke failed，也能直接看到失败 check 的简短 detail。

## 已完成

- `/ops/smoke-dashboard` 的 `Recent smoke runs` 表格会展示每个 smoke check 的 detail：
  - 原来显示 `rollout_readiness failed`。
  - 现在如果 report detail 里有 `detail` 字段，会显示 `rollout_readiness failed: <detail>`。
  - 没有 detail 时保持原来的 `check_name ok/failed` 简洁格式。
- 只展示每次 smoke 的前 3 个 checks，避免 dashboard 表格过长。
- detail 仍走 HTML escape：
  - 例如 `<secret>` 会渲染成 `&lt;secret&gt;`。
  - 不会把存储里的 HTML-like 文本直接塞进页面。
- 继续复用 `cron_runs.detail.checks[].detail`，不新增 D1 schema。
- 继续复用 `NEWBOT_SMOKE_REPORT_SECRET` 认证，不展示 secret 或认证 header。

## 自动化验证覆盖

- `tests/public.test.ts` 扩展 dashboard HTML 测试：
  - 构造带 `checks[].detail` 的 failed smoke report。
  - 断言页面包含 escape 后的失败详情。
  - 断言页面不包含未 escape 的原始 HTML-like detail。
  - 原有 summary、状态徽章、Freshness、快捷入口、趋势、recent runs 和 secret 不泄漏断言继续保留。

## 仍未覆盖

- 没有新增每环境失败原因摘要卡片；当前 detail 展示在 Recent smoke runs 表格里。
- 没有把失败原因推送到 Telegram 告警；当前仍是只读 dashboard。
- 没有接入 Cloudflare Analytics / Workers Tail。
- 没有新增 D1 schema。

## 成熟度

Phase 41 让 dashboard 从“知道失败了”进到“能直接看到为什么失败”，但保持实现非常轻：只读、escape、安全、schema-free。
