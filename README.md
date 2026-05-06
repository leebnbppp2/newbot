# NewBot

NewBot 是一个部署在 Cloudflare Workers 上的 AI Polymarket Telegram Bot。当前 Phase 1 目标是跑通：
- D1 schema
- `/healthz` / `/version`
- `/telegram/webhook/:persona_id`
- Telegram echo 模式

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
BOT_TOKEN=<telegram bot token> \
WEBHOOK_URL=https://<your-worker>.workers.dev/telegram/webhook/crypto_zh \
WEBHOOK_SECRET=<same as TELEGRAM_WEBHOOK_SECRET> \
node scripts/set-webhook.mjs
```

## 本地验证

```bash
npm run typecheck
npm test
curl https://<your-worker>.workers.dev/healthz
```

## 当前 Phase 3 行为

- `GET /healthz` → `{ ok: true, version: "0.1.0" }`
- `GET /version` → `{ version: "0.1.0" }`
- Telegram 文本指令：
  - `/start` 或 `/menu` → 中文欢迎词 + 主菜单
  - `/account` 或 `/status` → 返回账户是否已绑定
  - `/market` 或 `/markets` → 拉取并展示 3 个活跃市场
  - 其他文本 → 先记录对话，再返回 Phase 3 引导文案
- Telegram 菜单按钮：
  - `看市场` → callback 后直接刷新成市场概览
  - `我的账户` → callback 后直接刷新成账户状态
  - `怎么开始` → callback 后直接刷新成开始指引
- 数据落库：
  - `users` 会 upsert Telegram 用户资料
  - `conversations` 会记录 user / assistant 双向对话
  - `market_cache` 会缓存市场概览，减少重复请求
