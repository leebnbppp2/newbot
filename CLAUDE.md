# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NewBot is an AI Polymarket Telegram bot running on Cloudflare Workers with D1 (SQLite) storage. It lets Telegram users browse/search Polymarket markets, link trading accounts via a web portal, and place buy orders through a dual-path order gateway (live API or simulated). Development proceeds in numbered phases (currently Phase 41); each phase adds a `docs/PHASE_N.md` and updates `README.md`.

## Commands

```bash
npm run typecheck                 # tsc --noEmit (strict mode, workers-types)
npm test                          # vitest run (all tests)
npx vitest run tests/public.test.ts   # run a single test file
npm run test:watch                # vitest watch mode
npm run build                     # wrangler deploy --dry-run (validation only)
npm run deploy                    # real wrangler deploy via scripts/deploy.mjs
npm run d1:apply                  # apply migrations/0001_init.sql to D1
npm run smoke -- <worker-url>     # post-deploy smoke (healthz/version/webhook secret)
npm run smoke -- --require-ready <worker-url>   # strict smoke, fails on readiness blockers
```

Note: `scripts/deploy.mjs` (used by both `build` and `deploy`) fails if any required secret name (`TELEGRAM_WEBHOOK_SECRET`, `BOT_TOKEN_CRYPTO_ZH`) is not mentioned in `README.md` — keep README secret docs in sync.

## Architecture

Single Worker entrypoint `src/index.ts` does manual URL routing (no router framework) to handlers in `src/routes/`:

- `routes/public.ts` — `/healthz` (includes readiness report), `/version`, and ops endpoints: `POST /ops/smoke-report` (authed by `NEWBOT_SMOKE_REPORT_SECRET`, persists to `cron_runs` table), `GET /ops/smoke-metrics`, `GET /ops/smoke-dashboard` (HTML).
- `routes/webhook.ts` — `/telegram/webhook/:persona_id`, the largest module. Authenticates via the `x-telegram-bot-api-secret-token` header against `TELEGRAM_WEBHOOK_SECRET`, resolves the persona from `src/agent/personas.ts` (persona id → bot token secret name; only `crypto_zh` exists), then dispatches commands (`/start`, `/markets`, `/buy`, `/orders`, `/positions`, `/health`, `/runbook`, `/metrics`, …) and inline-keyboard `callback_query` actions (pagination, cancel order, runbook env switching).
- `routes/portal.ts` — `/portal/link/:token` account-binding web portal (GET form, POST complete).

Layers below routes:

- `src/agent/replies.ts` — pure reply builders returning `BotReply` (`text` + optional `replyMarkup` inline keyboard). All Telegram message formatting lives here.
- `src/lib/order_gateway.ts` — the live/simulated dual path. If the live config (`POLYMARKET_ORDER_API_BASE` + API key) is absent, orders return `mode: 'simulated'`. Handles canonical signed headers (HMAC signature envelope, auth-mode aware), Builder Program attribution, order status sync/cancel, and open-orders/positions/fills reads with D1 `market_cache`-style caching and `live | cache | none` source labeling. `getOrderGatewayReadiness()` feeds `/healthz` and the Telegram `/health` panel.
- `src/lib/markets.ts` — Polymarket Gamma API (`gamma-api.polymarket.com`) market browse/search/detail with D1 caching.
- `src/lib/telegram.ts` — Telegram Bot API client (send/edit message, answer callback).
- `src/db/*.ts` — one module per D1 table group (users + trading accounts, account sessions, conversations, trade_events, builder_attributions, cron_runs). Schema is a single file: `migrations/0001_init.sql`.
- `src/durable_objects/trade_coordinator.ts` — placeholder DO, bound as `TRADE_COORDINATOR` in `wrangler.jsonc` but not yet doing real coordination.

## Access-control gates (all optional CSV env vars)

- `NEWBOT_OPERATOR_TELEGRAM_IDS` — restricts Telegram ops commands (`/health`, `/ops`, `/runbook`, `/metrics`) to listed user ids; unset means open.
- `NEWBOT_LIVE_TRADING_TELEGRAM_IDS` — user-level live-trading allowlist; users not listed get simulated orders even when the live API is configured. Checked in `routes/webhook.ts` and reflected in readiness.

## Testing conventions

Tests in `tests/` use vitest with hand-rolled in-memory fakes of the D1 `Env` (no miniflare/wrangler test harness) and `vi`-stubbed `fetch` for Telegram/Polymarket calls. Test files are named by route and phase (e.g. `webhook.phase6.test.ts`). `tests/smoke-script.test.ts` covers `scripts/smoke.mjs`.

## Conventions

- TypeScript is maximally strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) — use type-only imports and handle possibly-undefined index access.
- User-facing bot text and docs are in Chinese; code identifiers and comments in English.
- Commit messages follow `feat: add NewBot Phase N <summary>` / `docs: sync ...` patterns.
- `docs/LAUNCH_CHECKLIST.md` is the pre-launch verification runbook; new env vars/secrets must be documented in README's deploy section.
