# NewBot

NewBot 是一个部署在 Cloudflare Workers 上的 AI Polymarket Telegram Bot。当前目标已经推进到 Phase 13：
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

如果你要启用 Phase 13 的 live order/portfolio request，还可以额外提供：
- `POLYMARKET_ORDER_API_BASE`
- `POLYMARKET_ORDER_API_KEY`
- `POLYMARKET_ORDER_SIGNING_SECRET`
- `POLYMARKET_BUILDER_TAG`

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
curl https://<your-worker>.workers.dev/healthz
```

## 当前 Phase 13 行为

- `GET /healthz` → `{ ok: true, version: "0.1.0" }`
- `GET /version` → `{ version: "0.1.0" }`
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
    - 有 signing secret 会附带 signed payload 和 `x-order-signature`
    - 没有配置就自动回退到模拟单
  - `/orders` → 返回最近订单记录；如果是 live 订单且配置了 order API，会额外刷新订单状态，并把新状态回写到本地 `trade_events`
  - `/openorders` / `/openorders 2` → 返回远端未成交订单列表，支持基础分页，并在消息里带撤单按钮
  - `/positions` / `/positions 2` → 优先返回远端 portfolio 持仓；远端失败时优先读缓存；会显示总敞口、总浮动盈亏和分页信息
  - `/fills` / `/fills 2` → 返回远端最近成交记录，并支持基础分页
  - `/cancel <orderId>` → 对 live 订单发撤单请求，并把取消后的状态回写到本地 `trade_events`
  - 其他文本 → 先记录对话，再返回 Phase 13 引导文案
- Telegram 菜单 / callback 按钮：
  - `看市场` → callback 后直接刷新成市场概览
  - `我的账户` → callback 后直接刷新成账户状态
  - `怎么开始` → callback 后直接刷新成开始指引
  - `开始绑定` → callback 后创建绑定口令
  - `准备下单` → callback 后进入下单前确认说明；未绑定时会先引导绑定
  - `上一页 / 下一页` → 现在可直接在 open orders / positions / fills 里原地翻页
  - `撤单 <orderId>` → 现在可直接从 open orders 的 callback 按钮撤掉未成交单
- 数据落库：
  - `users` 会 upsert Telegram 用户资料
  - `conversations` 会记录 user / assistant 双向对话
  - `market_cache` 现在也会缓存 open orders / positions / fills 等 portfolio 数据
  - `user_account_sessions` 会生成并完成账户接入会话
  - `user_trading_accounts` 会记录已绑定账户基础信息
  - `trade_events` 会记录 live / simulated 两类订单事件，并持续同步 live 状态；如果能匹配到订单号，也会在 callback 撤单后同步取消状态
