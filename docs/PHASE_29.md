# Phase 29 runbook 按环境筛选 smoke

这一步把 NewBot 从“runbook 同时展示各环境最近 smoke”推进到“operator 可以只看一个环境的最近 smoke”，方便上线时单独确认 production、staging 或 canary。

完成内容：

- Telegram 文本命令：
  - `/runbook` / `/rollout` 保持原行为：展示全局最近 smoke + 各环境最近状态
  - `/runbook production` / `/rollout staging` 会只展示指定环境最近一次 smoke
  - 环境参数只接受短标签：`a-z`、`0-9`、`_`、`-`，最长 32 字符
- `src/db/cron_runs.ts`：
  - 新增 `getLatestSmokeReportRunForEnvironment(env, environment)`
  - 从最近 50 条 smoke 里找指定环境最新一条
  - 继续复用 `cron_runs.detail.environment`，不新增 D1 migration
- `src/agent/replies.ts`：
  - runbook 标题升级到 Phase 29
  - 筛选时标题显示为 `Phase 29 灰度 runbook（production）`
  - 筛选结果只传入该环境的 smoke 行，避免 canary / staging URL 混进 production 视图
- operator allowlist 不变：
  - 仍先检查 `NEWBOT_OPERATOR_TELEGRAM_IDS`
  - 非操作者不会触发 smoke DB 读取，也不会看到内部目标 URL

自动化验证覆盖：

- 扩展 `tests/webhook.phase6.test.ts`
  - seed production / staging / canary 三个 smoke report
  - 请求 `/runbook production`
  - 验证只显示 production worker
  - 验证不显示 canary / staging worker
  - 验证标题带指定环境
- 保留 Phase 28 全局 runbook 测试，确认 `/runbook` 仍展示各环境摘要。

还没覆盖：

- 暂未给 callback 增加“production / staging / canary”快捷按钮。
- 暂未做 `/runbook all` 别名；不带环境参数就是全局视图。
- 暂未新增独立 metrics dashboard 或趋势图。

一句话总结：

Phase 29 让 operator 可以用 `/runbook production` 这类命令只看一个环境的 smoke 状态，先把上线排查路径做得更直接。