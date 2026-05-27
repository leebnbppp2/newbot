# Phase 36 smoke dashboard environment filter

Phase 36 在 Phase 35 的受保护 HTML dashboard 上补一个小而实用的运营筛选：通过 query 参数只看某个环境的 smoke summary、趋势和最近运行。

## 已完成

- `/ops/smoke-dashboard` 支持环境过滤：
  - `?env=production`
  - `?env=staging`
  - `?env=canary`
- 过滤后 dashboard 会只展示该环境的：
  - 总 smoke 数、通过数、失败数、通过率
  - 环境表中的该环境行
  - 最近 10 次趋势条
  - 最近 2 次运行窗口
- 环境参数采用保守校验：
  - 仅允许 `a-z`、`0-9`、`_`、`-`
  - 最长 32 字符
  - 不合法参数会回退到未过滤视图
- 继续复用 `cron_runs.detail.environment`，不新增 D1 schema。
- 继续复用 `NEWBOT_SMOKE_REPORT_SECRET` 认证，不展示 secret 或认证 header。
- README 和默认 Phase 文案更新到 Phase 36。

## 自动化验证覆盖

- `tests/public.test.ts` 新增 dashboard 环境过滤测试：
  - 请求 `/ops/smoke-dashboard?env=production`。
  - 断言页面显示 `Environment filter: production`。
  - 断言通过率和趋势只按 production 计算。
  - 断言 production 最新与较旧目标都会出现在过滤后的最近运行里。
  - 断言 staging target 不会泄漏到 production 过滤视图。

## 仍未覆盖

- 没有做 dashboard 上的点击式 tab / dropdown。
- 没有引入图表库或长日志查看器。
- 没有接入 Cloudflare Analytics / Workers Tail。
- 没有新增 D1 environment 索引列；如后续需要更长窗口或高频查询，再考虑 schema 化。

## 成熟度

Phase 36 让 dashboard 更适合灰度上线时单独盯 production / staging / canary，但仍保持低风险、schema-free、只读。