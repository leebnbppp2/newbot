# NewBot launch checklist

这份清单用于 NewBot 第一阶段收口。目标不是继续加功能，而是确认现有链路可以安全试运行。

## 1. 本地代码检查

```bash
npm run typecheck
npm test
npm run build
```

通过标准：三条命令都成功。`npm run build` 当前是 Wrangler dry-run，不会直接部署。

## 2. Cloudflare / D1 准备

- `wrangler.jsonc` 已配置正确的 D1 database binding：`DB`。
- D1 migration 已应用：

```bash
npm run d1:apply
```

- Worker 可以部署：

```bash
npm run deploy
```

## 3. 必填 secrets

必须配置：

```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put BOT_TOKEN_CRYPTO_ZH
```

用于 smoke report / dashboard / metrics 的共享 secret：

```bash
npx wrangler secret put NEWBOT_SMOKE_REPORT_SECRET
```

## 4. 建议配置的操作者限制

建议配置，只允许指定 Telegram user id 查看内部状态、runbook、metrics：

```bash
npx wrangler secret put NEWBOT_OPERATOR_TELEGRAM_IDS
```

值格式：

```text
123456,789012
```

## 5. Live trading 灰度开关

如果还没准备真实交易，先不要配置 live order API 或 live allowlist。

如果要小范围启用 live trading，需要配置：

```bash
npx wrangler secret put POLYMARKET_ORDER_API_KEY
npx wrangler secret put POLYMARKET_ORDER_SIGNING_SECRET
npx wrangler secret put POLYMARKET_BUILDER_API_KEY
npx wrangler secret put NEWBOT_LIVE_TRADING_TELEGRAM_IDS
```

以及非 secret 配置：

- `POLYMARKET_ORDER_API_BASE`
- `POLYMARKET_BUILDER_TAG`

`NEWBOT_LIVE_TRADING_TELEGRAM_IDS` 必须只放允许真实下单的 Telegram user id。没在列表里的用户会回退模拟单。

## 6. 设置 Telegram webhook

```bash
BOT_TOKEN=<bot token> \
WEBHOOK_URL=https://<your-worker>.workers.dev/telegram/webhook/crypto_zh \
WEBHOOK_SECRET=<same as TELEGRAM_WEBHOOK_SECRET> \
node scripts/set-webhook.mjs
```

## 7. 上线后 smoke

基础 smoke：

```bash
npm run smoke -- https://<your-worker>.workers.dev
```

严格 rollout smoke：

```bash
npm run smoke -- --require-ready https://<your-worker>.workers.dev
```

带报告回传的 production smoke：

```bash
npm run smoke -- --require-ready https://<your-worker>.workers.dev \
  --report-url https://<your-worker>.workers.dev/ops/smoke-report \
  --report-secret "$SMOKE_REPORT_SECRET" \
  --report-env production
```

## 8. 运营入口

Telegram：

- `/health` / `/ops` / `/readiness`
- `/runbook` / `/rollout`
- `/runbook production`
- `/metrics` / `/smoke-metrics`

HTTP：

```bash
curl -H "x-newbot-smoke-report-secret: $SMOKE_REPORT_SECRET" \
  https://<your-worker>.workers.dev/ops/smoke-metrics
```

Dashboard：

```text
https://<your-worker>.workers.dev/ops/smoke-dashboard
https://<your-worker>.workers.dev/ops/smoke-dashboard?env=production
```

Dashboard 需要带 `x-newbot-smoke-report-secret` header；普通浏览器直接打开不会通过认证，建议用带 header 的内部工具或临时受控访问方式查看。

## 9. 可以认为第一阶段完成的标准

- 本地 `typecheck / test / build` 全绿。
- Worker 部署成功。
- Telegram webhook 设置成功。
- `/healthz` 和 `/version` 正常。
- 基础 smoke 成功。
- 严格 smoke 成功，或明确知道阻断项是什么。
- smoke report 成功写入 `cron_runs`。
- `/ops/smoke-metrics` 能读到最新 production smoke。
- `/ops/smoke-dashboard?env=production` 能看到：
  - Overall status
  - Latest smoke
  - Freshness
  - Pass rate
  - Recent smoke runs
  - failed check detail（如果有失败）

如果以上都满足，NewBot 第一阶段可以收口，后续增强再单独排期。
