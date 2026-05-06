# NewBot

NewBot 是一个部署在 Cloudflare Workers 上的 AI Polymarket Telegram Bot。当前目标已经推进到 Phase 6：
- D1 schema
- `/healthz` / `/version`
- `/telegram/webhook/:persona_id`
- Telegram 市场浏览 / 搜索 / 详情
- 账户绑定 portal
- 模拟下单 / 订单 / 仓位视图

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

## 当前 Phase 6 行为

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
  - `/buy <关键词> <yes|no> <金额>` → 对已绑定用户写入一笔模拟订单到 `trade_events`
  - `/orders` → 返回最近订单记录
  - `/positions` → 返回当前记录里的模拟仓位视图
  - 其他文本 → 先记录对话，再返回 Phase 6 引导文案
- Telegram 菜单按钮：
  - `看市场` → callback 后直接刷新成市场概览
  - `我的账户` → callback 后直接刷新成账户状态
  - `怎么开始` → callback 后直接刷新成开始指引
  - `开始绑定` → callback 后创建绑定口令
  - `准备下单` → callback 后进入下单前确认说明；未绑定时会先引导绑定
- 数据落库：
  - `users` 会 upsert Telegram 用户资料
  - `conversations` 会记录 user / assistant 双向对话
  - `market_cache` 会缓存市场概览和搜索结果
  - `user_account_sessions` 会生成并完成账户接入会话
  - `user_trading_accounts` 会记录已绑定账户基础信息
  - `trade_events` 会记录模拟订单
