# Phase 26 Telegram runbook 展示最近 smoke 结果

这一步把 NewBot 从“smoke 报告已能落库”推进到“操作者在 Telegram runbook 里直接看到最近一次 smoke 状态”。

完成内容：

- 新增 `src/db/cron_runs.ts`：
  - 读取 `cron_runs` 中最新一条 `job_name = smoke` 记录
  - 安全解析 Phase 25 保存的 smoke JSON
  - 解析失败时只显示粗状态，不让 runbook 崩掉
- Telegram `/runbook` / `/rollout`：
  - 继续受 `NEWBOT_OPERATOR_TELEGRAM_IDS` 保护
  - 现在会读取最近一次 smoke 回传记录
  - 展示 smoke 是否通过、目标 worker、回传时间和前 3 个 check 结果
- `灰度 Runbook` callback：
  - 同样读取最新 smoke 记录
  - 原地刷新 runbook，不泄露任何 secret
- 没有 smoke 回传时：
  - runbook 显示“最近 smoke：还没有回传记录”
  - 保留原有 smoke / strict smoke / report-url 操作提示

自动化验证覆盖：

- 扩展 `tests/webhook.phase6.test.ts`
  - 先写 failing test，确认当前 runbook 不展示最新 smoke
  - Fake D1 新增 `cronRuns` 与 `FROM cron_runs` 查询支持
  - 验证 `/runbook` 只展示最新一条 smoke 记录，不误用旧记录
  - 验证文本含 `最近 smoke：通过`、目标 worker 和 check 状态

还没覆盖：

- 暂未做多环境分组，比如 production / staging / canary。
- 暂未做历史 smoke 列表或趋势，只展示最近一次。
- 暂未接 Cloudflare Analytics / Workers Tail 指标。

一句话总结：

Phase 26 让 Telegram runbook 真正闭环：部署脚本把 smoke JSON 写进 `cron_runs` 后，操作者在 bot 内就能看到最近一次上线检查结果。