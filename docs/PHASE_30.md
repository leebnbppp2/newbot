# Phase 30 runbook 环境快捷按钮

这一步把 NewBot 从“operator 可以输入 `/runbook production` 筛选环境”推进到“operator 可以直接点 Telegram 按钮切换 production / staging / canary runbook”，减少上线时手打命令的步骤。

完成内容：

- Telegram operator runbook 菜单新增环境快捷按钮：
  - `Production` → `ops_runbook_env:production`
  - `Staging` → `ops_runbook_env:staging`
  - `Canary` → `ops_runbook_env:canary`
- callback 路由新增 `ops_runbook_env:<environment>`：
  - 继续先检查 `NEWBOT_OPERATOR_TELEGRAM_IDS`
  - 非 operator 仍只收到 operator-only 提示，不展示内部 smoke URL
  - 合法环境标签继续限制为 `a-z`、`0-9`、`_`、`-`，最长 32 字符
  - 点击按钮后只展示对应环境最近一次 smoke report
- runbook 标题升级为 Phase 30：
  - 默认视图：`Phase 30 灰度 runbook：`
  - 筛选视图：`Phase 30 灰度 runbook（production）`
- 仍不新增 D1 migration：
  - 继续复用 `cron_runs.detail.environment`
  - 继续用最近 smoke JSON 做环境筛选，保持本阶段低风险

自动化验证覆盖：

- 扩展 `tests/webhook.phase6.test.ts`：
  - 验证 runbook reply markup 包含 Production / Staging / Canary 三个快捷按钮
  - seed production / staging / canary smoke report
  - 点击 `ops_runbook_env:production`
  - 验证只显示 production worker，不泄漏 canary / staging worker
  - 验证 callback 筛选后的 runbook 仍保留回到全局 runbook 和其它环境按钮
- 保留 Phase 29 文本筛选测试，确认 `/runbook production` 仍可用。

还没覆盖：

- 暂未做自定义环境列表配置；先固定 production / staging / canary 三个常用入口。
- 暂未做 smoke metrics dashboard 或趋势图。
- 暂未新增 indexed `environment` column；等趋势查询需要时再做 migration。

一句话总结：

Phase 30 让 operator 在 Telegram 里点一下就能切到 production / staging / canary runbook，保留原来的文本筛选能力，同时继续保持 smoke 数据结构轻量。