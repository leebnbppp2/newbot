# NewBot

NewBot 是一个部署在 Cloudflare Workers 上的 AI Polymarket Telegram Bot。当前目标已经推进到 Phase 41：
- D1 schema
- `/healthz` / `/version`
- `/telegram/webhook/:persona_id`
- Telegram 市场浏览 / 搜索 / 详情
- 账户绑定 portal
- auth-mode aware 的 signed live/simulated 双路径下单准备层
- live 订单状态回查 + 本地状态回写
- live 撤单入口
- open orders / positions / fills 读取
- portfolio 数据缓存 / 分页 / 浮盈亏展示
- callback 翻页 + open orders 按钮撤单
- callback 撤单后原地刷新 open orders 当前页
- positions 已实现/未实现盈亏拆分 + page token 解析
- Builder Program attribution 落库与生效校验
- 更正式的 canonical signature header / signature envelope
- Telegram 内 `/health` / `/ops` / 系统状态按钮，直接查看 live API、签名和 Builder 配置 readiness
- 可选 Telegram 操作者白名单，限制系统状态入口只给配置过的操作者使用
- `npm run smoke -- <worker-url>` 上线后 smoke 脚本，检查 `/healthz`、`/version` 和 webhook secret 保护
- `npm run smoke -- --require-ready <worker-url>` 放量前严格 smoke，readiness 有阻断项时直接失败
- `POST /ops/smoke-report` 认证写入 smoke 报告到 `cron_runs`，让部署后 smoke 结果开始有持久化落点
- Telegram 内 `/runbook` / `/rollout` 灰度 runbook 面板，会读取最近一次 `cron_runs` smoke 报告并展示状态
- smoke report 支持 `--report-env` / `SMOKE_REPORT_ENV` 环境标签，runbook 会显示最近一次 smoke 属于 production / staging / canary 等哪个环境
- Telegram runbook 现在会按环境汇总最近 smoke，列出 production / staging / canary 等各自最新状态，避免全局最近一条遮住其他环境
- `/runbook production` / `/rollout staging` 这类命令可以只看指定环境的最近 smoke 状态，方便上线时单独检查 production / staging / canary
- Telegram runbook 增加 Production / Staging / Canary 快捷按钮，operator 可以点按钮直接切换指定环境 smoke 视图
- `GET /ops/smoke-metrics` 认证输出最近 smoke 聚合指标，给后续 dashboard / monitoring 复用
- Telegram 内 `/metrics` / `Smoke Metrics` 按钮可以直接查看最近 smoke 聚合指标和各环境最新状态
- `GET /ops/smoke-dashboard` 认证输出极简 HTML smoke dashboard，复用同一份 smoke 聚合指标，并自动刷新最近 smoke 窗口与短趋势条；也支持 `?env=production` 只看单个环境，并提供 All / Production / Staging / Canary 快捷切换入口、Overall status 徽章、最新 smoke 时间、Fresh/Stale 新鲜度状态、趋势圆点和最近 failed check detail
- `NEWBOT_LIVE_TRADING_TELEGRAM_IDS` 用户级 live 交易 allowlist；不在列表里的用户即使 live API 已配置也只记录模拟单

## 5 步部署

1. 安装依赖
```bash
npm install
```

2. 登录 wrangler
```bash
npx wrangler login
```

3. 创建 D1 数据库并把返回的 `database_id` 写入 `wrangler.jsonc`
```bash
npx wrangler d1 create newbot-db
```

4. 设置 secrets
```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put BOT_TOKEN_CRYPTO_ZH
```

如果你要启用 Phase 18 的 live order/portfolio request，还可以额外提供：
- `POLYMARKET_ORDER_API_BASE`
- `POLYMARKET_ORDER_API_KEY`
- `POLYMARKET_ORDER_SIGNING_SECRET`
- `POLYMARKET_BUILDER_TAG`
- `POLYMARKET_BUILDER_API_KEY`

如果你要启用 Phase 20 的 Telegram 内部状态入口权限限制，可以额外提供：
- `NEWBOT_OPERATOR_TELEGRAM_IDS`：逗号分隔的 Telegram user id，例如 `123456,789012`

如果你要启用 Phase 23 的真实下单用户级灰度，可以额外提供：
- `NEWBOT_LIVE_TRADING_TELEGRAM_IDS`：逗号分隔的 Telegram user id；配置后只有列表里的用户会走 live order API，其他用户继续模拟单

如果你要启用 Phase 25 的 smoke 报告回传，可以额外提供：
- `NEWBOT_SMOKE_REPORT_SECRET`：`POST /ops/smoke-report` 的共享 secret；只用于写入 smoke 结果，不是 Telegram token

5. 应用 schema、部署、设置 webhook
```bash
npm run d1:apply
npm run deploy
BOT_TOKEN=*** bot token> \
WEBHOOK_URL=https://<your-worker>.workers.dev/telegram/webhook/crypto_zh \
WEBHOOK_SECRET=*** as TELEGRAM_WEBHOOK_SECRET> \
node scripts/set-webhook.mjs
```

## 本地验证

```bash
npm run typecheck
npm test
npm run smoke -- https://<your-worker>.workers.dev
npm run smoke -- --require-ready https://<your-worker>.workers.dev
npm run smoke -- --require-ready https://<your-worker>.workers.dev --report-url https://<your-worker>.workers.dev/ops/smoke-report --report-secret "$SMOKE_REPORT_SECRET" --report-env production
curl https://<your-worker>.workers.dev/healthz
```

## 当前 Phase 41 行为

- `GET /healthz` → 返回 `{ ok, version, readiness }`，其中 readiness 会直接告诉你：
  - live order API 是否完整可用
  - canonical signing 是否已启用
  - Builder Program 是 `ready / partial / disabled`
  - live trading allowlist 是否已启用
  - 当前还有哪些上线前 warning
- `GET /version` → `{ version: "0.1.0" }`
- `npm run smoke -- <worker-url>` → 上线后做只读 smoke：检查 `/healthz` readiness 结构、`/version`，并用无效 secret 确认 webhook 返回 401，不会触发真实 Telegram 消息或写入业务数据
- `npm run smoke -- --require-ready <worker-url>` → 放量前严格 smoke：在普通 smoke 基础上增加 `rollout_readiness` 检查；live API、canonical signing、Builder partial 或 readiness warning 有问题时直接非 0 退出
- `npm run smoke -- <worker-url> --report-url <url> --report-secret <secret> [--report-env production]` → smoke 完成后把结构化 JSON 报告 POST 到报告入口；报告入口只校验 `x-newbot-smoke-report-secret`，不需要 Telegram token；环境标签会保存在 report detail 里
- `POST /ops/smoke-report` → 认证写入 smoke 报告到 `cron_runs`：`job_name=smoke`，`status=ok/failed`，`detail` 保存 smoke JSON
- `GET /ops/smoke-metrics` → 使用 `x-newbot-smoke-report-secret` 认证读取最近 smoke 聚合：总数、通过数、失败数、通过率，以及各环境最新状态
- `GET /ops/smoke-dashboard` → 使用同一个 report secret 认证，返回只读 HTML dashboard：Overall status、Latest smoke、Freshness、总数、通过数、失败数、通过率、各环境最新 target / 状态、最近 10 次 smoke 文本趋势和圆点趋势，以及最近 2 次 smoke 运行窗口；Recent smoke runs 会展示 check detail 并做 HTML escape；页面每 60 秒自动刷新，不展示 secret 或认证 header；可用 `?env=production` / `?env=staging` 只看单环境 summary、趋势和最近运行，页面顶部也有 All / Production / Staging / Canary 快捷入口并高亮当前环境
- `GET /portal/link/:token` → 返回账户连接页面，展示口令、有效期和绑定表单
- `POST /portal/link/:token/complete` → 提交后把账户状态写入 `user_trading_accounts`，并把当前会话标记为 `linked`
- Telegram 文本指令：
  - `/start` 或 `/menu` → 中文欢迎词 + 主菜单
  - `/account` 或 `/status` → 返回账户是否已绑定；已绑定时会显示账户备注、接入方式和地址缩略
  - `/link` → 生成账户绑定入口口令并写入 `user_account_sessions`
  - `/market` 或 `/markets` → 拉取并展示 3 个活跃市场
  - `/find <关键词>` / `/search <关键词>` → 在活跃市场里做本地关键词筛选
  - `/detail <关键词>` → 返回更丰富的单市场详情，尽量带上 slug / outcome / price
  - `/buy <金额>` → 继续保留金额入口占位
  - `/buy <关键词> <yes|no> <金额>` → 对已绑定用户执行订单网关：
    - `managed_signer` 会走 `clob_delegate`
    - `wallet_signature` 会走 `clob_wallet`
    - 有 live API 配置就发真实请求
    - 如果配置了 `NEWBOT_LIVE_TRADING_TELEGRAM_IDS`，只有 allowlist 内用户会走真实请求；其他用户会明确回退成模拟单，并在 payload 里记录 `live_trading_not_allowlisted`
    - 有 signing secret 会附带更正式的 canonical signature headers：
      - `x-order-signature`
      - `x-order-body-sha256`
      - `x-order-signature-input`
      - `x-order-protocol-version`
      - `x-order-timestamp-ms`
      - `x-order-nonce`
    - 订单 detail / trade event payload 里会带 `signature_envelope`
    - 有 builder tag + builder api key 时，会把 Builder Program attribution 一起塞进 payload，并落库到 `builder_attributions`
    - 没有配置就自动回退到模拟单
  - `/orders` → 返回最近订单记录；如果是 live 订单且配置了 order API，会额外刷新订单状态，并把新状态回写到本地 `trade_events`
  - `/openorders` / `/openorders 2` → 返回远端未成交订单列表，支持基础分页，并在消息里带撤单按钮；如果远端暂时失败但本地有缓存，会直接告诉你当前看到的是缓存
  - `/positions` / `/positions 2` / `/positions p2` → 优先返回远端 portfolio 持仓；远端失败时优先读缓存；会显示总敞口、已实现/未实现盈亏、分页游标和下一页 token，并标记当前是实时数据还是缓存
  - `/fills` / `/fills 2` → 返回远端最近成交记录，并支持基础分页；如果是缓存回退也会直接提示
  - `/cancel <orderId>` → 对 live 订单发撤单请求；如果有 signing secret，撤单请求也会附带同一套 canonical signature headers
  - `/health` / `/ops` / `/readiness` → 在 Telegram 里直接查看 live order API、canonical signing、Builder attribution、live trading allowlist 和当前配置 warning；如果配置了 `NEWBOT_OPERATOR_TELEGRAM_IDS`，只有白名单里的 Telegram user id 可以查看
  - `/runbook` / `/rollout` → 操作者专用灰度 runbook：先跑 `npm run smoke -- <worker-url>` 和 `npm run smoke -- --require-ready <worker-url>`；如果配置了报告 secret，也可以用 `--report-url` + `--report-env` 回传结果；runbook 会显示全局最近一次 `cron_runs` smoke 结果，并按环境列出最近状态，不展示任何 secret 原文
  - `/runbook production` / `/rollout staging` → 只看指定环境最近一次 smoke，适合上线时单独确认 production / staging / canary
  - `/metrics` / `/smoke-metrics` → 操作者专用 smoke metrics 面板：显示最近 smoke 总数、通过率、失败数，以及各环境最新 target 和状态
  - 其他文本 → 先记录对话，再返回 Phase 41 引导文案
- Telegram 菜单 / callback 按钮：
  - `看市场` → callback 后直接刷新成市场概览
  - `我的账户` → callback 后直接刷新成账户状态
  - `系统状态` → callback 后原地刷新 readiness，并给出简短“系统状态已刷新”提示；如果配置了操作者白名单，非操作者会收到 alert 提示，不展示内部 readiness
  - `灰度 Runbook` → callback 后原地刷新灰度 runbook；同样受 `NEWBOT_OPERATOR_TELEGRAM_IDS` 保护
  - `Smoke Metrics` → callback 后原地刷新 smoke 聚合指标；同样受 `NEWBOT_OPERATOR_TELEGRAM_IDS` 保护
  - `Production` / `Staging` / `Canary` → callback 后原地切到对应环境的 runbook smoke 状态；同样受 operator allowlist 保护
  - `怎么开始` → callback 后直接刷新成开始指引
  - `开始绑定` → callback 后创建绑定口令
  - `准备下单` → callback 后进入下单前确认说明；未绑定时会先引导绑定
  - `上一页 / 下一页` → 现在可直接在 open orders / positions / fills 里原地翻页，并带简短 callback toast
  - `撤单 <orderId>` → 现在可直接从 open orders 的 callback 按钮撤掉未成交单，并在撤单后原地刷新列表；callback 会顺手给出简短状态提示
- 数据落库：
  - `users` 会 upsert Telegram 用户资料
  - `conversations` 会记录 user / assistant 双向对话
  - `market_cache` 现在也会缓存 open orders / positions / fills 等 portfolio 数据
  - `user_account_sessions` 会生成并完成账户接入会话
  - `user_trading_accounts` 会记录已绑定账户基础信息
  - `trade_events` 会记录 live / simulated 两类订单事件，并持续同步 live 状态；payload 里会附带 builder attribution 校验结果和 signature envelope
  - `builder_attributions` 现在会记录 builder api key hint、trade_event_id、order_id 和金额，供后续收益归因校验
  - `cron_runs` 现在可以保存带环境标签的 smoke report，Telegram runbook 会展示全局最近一次结果、各环境最近状态，也支持按环境筛选最近一次结果；`/ops/smoke-metrics`、`/ops/smoke-dashboard` 和 Telegram `/metrics` 会从最近 smoke 记录聚合总量、通过率和各环境最新状态；dashboard 还会展示状态徽章、最新 smoke 时间、Fresh/Stale 新鲜度状态、最近 10 次 smoke 文本趋势与圆点趋势、最近 2 次 smoke 运行窗口和 check detail，并支持 `?env=` 环境过滤和页面快捷切换
