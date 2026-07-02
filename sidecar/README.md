# sidecar — order-service (runs OFF the Worker, on the VPS)

The Cloudflare Worker cannot place Polymarket V2 orders itself: `@polymarket/client`
(the only SDK that actually works for new deposit-wallet accounts) and the Builder
relayer use Node APIs that don't run in `workerd`. So order placement lives in this
**Node sidecar**, which the Worker calls over localhost.

- **`order_service.mjs`** — the order-service. HTTP on `127.0.0.1:8799`, auth via the
  `x-order-token` header (`ORDER_SERVICE_TOKEN`, default `local-newbot`). Runs the proven
  `@polymarket/client` SecureClient recipe (Privy signer + `builderApiKey` for commission),
  multi-user + auto-wrap. Endpoints (all POST unless noted):
  - `/place {walletId, eoaAddress, safeAddress, tokenId, amount, side?}` — ensures the deposit
    wallet holds enough pUSD (gaslessly auto-wraps the user's own Safe USDC.e → pUSD via the
    relayer), then places a market order. `side: 'SELL'` closes (amount = shares).
  - `/positions {walletId}` — read-only holdings (deposit wallet → Data API `/positions`),
    carries `avgPrice/cashPnl/percentPnl` for P&L.
  - `/fills {walletId}` — read-only trade history (deposit wallet → Data API `/trades`).
  - `/wallet {walletId, …}` — read-only deposit-wallet address + balances.
  - `/fund {walletId, eoaAddress, safeAddress, amount?}` — explicit USDC.e → pUSD wrap.
  - `GET /healthz` — `{ ok }`.
  - Flags: `ORDER_SERVICE_DRYRUN=1` (fake fill, wrap only logs), `ORDER_SERVICE_AUTO_WRAP=0`.
- **`ecosystem.config.cjs`** — pm2 manifest for the whole polybot stack: `osvc` (this sidecar),
  `wgl` (`wrangler dev --local` — the Worker), `ng` (ngrok tunnel → public HTTPS), `hook`
  (webhook_updater). `pm2 start ecosystem.config.cjs && pm2 save` (survives reboot via
  `pm2 startup`).
- **`webhook_updater.mjs`** — polls ngrok's local API and re-points the Telegram webhook
  whenever the free-tier ngrok URL rotates (kills the "URL changed → webhook silently dead" mode).

## Where it runs

`ssh polybot` = an AWS Seoul (KR) box — an allowed Polymarket region outside the GFW.
Deployed at `~/newbot/` alongside a copy of the Worker source. Secrets come from `~/newbot/.dev.vars`
(gitignored) via pm2's `--env-file=.dev.vars`.

## Deploy / update workflow

This directory is the **source of truth**; polybot is a deploy target (it is NOT a git repo).
To ship a change:

```bash
scp sidecar/order_service.mjs polybot:~/newbot/order_service.mjs
ssh polybot 'cd ~/newbot && ~/.nvm/versions/node/v22.23.1/bin/node --check order_service.mjs'
ssh polybot 'export PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH && pm2 restart osvc'
```

Worker source (`src/`) is likewise scp'd to `~/newbot/src/` + `pm2 restart wgl` (hot-reloads).
This is interim (wrangler dev on a VPS + free ngrok); a stable setup would use `wrangler deploy`
or a claimed ngrok domain.

> Note: `@polymarket/client` is installed on polybot (`npm i @polymarket/client@beta
> --legacy-peer-deps`) but is NOT a Worker dependency, so it is intentionally absent from the
> root `package.json`.
