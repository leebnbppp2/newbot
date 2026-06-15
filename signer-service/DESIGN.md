# signer-service — DESIGN

## Purpose & boundary

NewBot uses **Path B** (PHASE_42.md §3): the Cloudflare Worker is a thin
frontend that never holds private keys; a separate Node service does EIP-712
signing and CLOB/Data API I/O. This service is that backend.

```
Telegram → Worker (CF) ──HTTP + HMAC envelope──▶ signer-service (Node) ──SDK──▶ Polymarket CLOB / Data API
                 │                                       │
           non-secret data (D1)                   key custody + per-user L2 creds
```

The Worker identifies a user only by `(bot_id, telegram_user_id)`; the signer
maps that to a custodial wallet and cached L2 creds. The Worker side of this
contract shipped in Phase 42.4 (`order_gateway.ts`); this service is the
matching counterpart.

## Request handling

`createSigner(config, options)` returns `{ handle(req) }`, a pure async
dispatcher over a transport-agnostic `SignerRequest`. `server.ts` is the only
node:http-specific code and merely adapts sockets to that shape, so the core is
trivially testable in-process (and is exercised directly by the Worker↔signer
integration test).

### Auth (`auth.ts`)
Mirrors the Worker's `signPayload`/`buildSignedHeaders` exactly:
- HMAC key = `` `${authMode}:${signingSecret}` ``
- message = `body_sha256=..,timestamp_ms=..,nonce=..,auth_mode=..,protocol_version=polymarket_clob_v2`
- verification: bearer match → recompute body SHA-256 (tamper check) → ±60s
  timestamp window → nonce replay guard → constant-time HMAC compare.

Write routes (`POST /orders`, `POST /orders/:id/cancel`) require the full
envelope; read routes require only the bearer, matching how the Worker actually
calls them today.

### Backends (`backends/`)
`OrderBackend` is the single seam. `dry_run` returns deterministic
`Remote*`-shaped data. `live` is a loud stub: it throws on construction so a
misconfigured `SIGNER_MODE=live` fails fast instead of pretending to trade.

## Live wiring plan (not done — needs funded key + KMS)

When keys/funds exist, implement `OrderBackend` in `backends/live.ts` with
`@polymarket/clob-client` + `ethers` (PHASE_42_2_SIGNER_API.md §5):

| Backend method | SDK call |
|----------------|----------|
| bootstrap | `createOrDeriveApiKey()` → `new ClobClient(host, 137, signer, creds)` |
| `placeOrder` (market) | `createAndPostMarketOrder({tokenID, amount, side, price?, orderType}, {tickSize, negRisk})` |
| `placeOrder` (limit) | `createOrder({tokenID, price, size, side})` + `postOrder(signed, GTC/GTD)` |
| `getOrder` | `getOrder(orderID)` |
| `cancelOrder` | `cancelOrder({orderID})` |
| `openOrders` | `getOpenOrders({market?, asset_id?})` |
| `fills` | `getTrades(...)` |
| `positions` | Data API `GET /positions?user=<funder>` (SDK-external) |
| tickSize | `getTickSize(tokenID)`; negRisk per market |

## Security (must land before `live`)

- **Key custody**: private keys behind KMS / envelope encryption; plaintext key
  only in memory during a signature.
- **Network**: signer accepts inbound only from the Worker; egress only to
  Polygon RPC / CLOB / Data API.
- **Auth already enforced**: bearer + HMAC + body integrity + timestamp window
  + nonce replay guard + constant-time compare (`auth.ts`).
- **Audit**: log who/when/which order for reconciliation against the Worker's
  `trade_events`.
- **Limits**: per-order and daily caps validated on both Worker and signer
  (defense in depth).

## Deferred to later sub-phases
- `POST /accounts/provision`, `GET /accounts/:user/readiness`,
  `POST /accounts/:user/allowance` (§4.7) — onboarding & on-chain allowance.
- These feed the Worker readiness fields (`signerReachable/allowanceReady/
  credsReady`) that 42.4 intentionally left out.
