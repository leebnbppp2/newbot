# NewBot signer-service

Custodial Polymarket CLOB signer/relay for NewBot (Phase 42, Path B). The
Cloudflare Worker stays thin and never holds keys; this separate Node service
verifies the internal HMAC envelope, talks to the real CLOB / Data API via the
official SDK, normalizes responses, and (eventually) custodies user keys.

> **Status: dry-run skeleton.** The `dry_run` backend is complete and tested.
> The `live` backend (real `@polymarket/clob-client` signing + CLOB calls) is
> **not wired yet** — it needs a funded Polygon key and KMS custody, which are
> out of scope until those exist. Booting with `SIGNER_MODE=live` fails fast.

## What works today

- Internal Worker↔signer HMAC envelope verification (`src/auth.ts`), the
  symmetric counterpart to the Worker's `order_gateway.ts` signing: bearer
  check, body-SHA256 integrity, ±60s timestamp window, nonce replay guard,
  constant-time HMAC compare.
- The six routes the Worker already calls (`src/signer.ts`): `POST /orders`,
  `GET /orders/:id`, `POST /orders/:id/cancel`, `GET /orders/open`,
  `GET /portfolio/positions`, `GET /portfolio/fills`.
- Unified error envelope `{error:{code,message,retryable}}` with the status
  mapping from `PHASE_42_2_SIGNER_API.md §8`.
- Idempotency on `client_order_id`.
- `dry_run` backend returning `Remote*`-shaped mock data.

## Run

```bash
# from repo root — reuses the root node_modules (no separate install)
SIGNER_API_KEY=<same as Worker POLYMARKET_ORDER_API_KEY> \
SIGNER_SIGNING_SECRET=<same as Worker POLYMARKET_ORDER_SIGNING_SECRET> \
SIGNER_MODE=dry_run \
SIGNER_PORT=8787 \
npm --prefix signer-service start
```

Point the Worker at it with `POLYMARKET_ORDER_API_BASE=http://<host>:8787`.
The api key and signing secret **must match** the Worker's, or every write is
rejected with 401.

## Test & typecheck

These run as part of the repo-root commands (no separate install):

```bash
npm test          # includes signer-service/tests + the Worker↔signer integration test
npm run typecheck # also typechecks signer-service (tsc -p signer-service/tsconfig.json)
```

## Layout

| File | Role |
|------|------|
| `src/auth.ts` | HMAC envelope verification (pure, Web Crypto) |
| `src/signer.ts` | `createSigner()` + route dispatch (pure) |
| `src/backends/dry_run.ts` | deterministic mock backend |
| `src/backends/live.ts` | live backend stub (throws until wired) |
| `src/errors.ts` | error envelope + code→HTTP map |
| `src/server.ts` | node:http adapter (runtime only) |
| `src/config.ts` / `src/index.ts` | env config + entry |

See `DESIGN.md` for the trust model and the live-wiring plan.
