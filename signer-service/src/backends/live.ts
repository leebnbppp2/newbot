/**
 * Live backend — NOT WIRED YET.
 *
 * This is the only piece that genuinely needs a funded Polygon key and the
 * official SDK, so it cannot be verified in-repo (no keys/funds available).
 * It is intentionally a loud stub: constructing it throws, so booting with
 * SIGNER_MODE=live fails fast with a clear message instead of silently
 * pretending to trade. Flipping to live is a deliberate follow-up.
 *
 * When wiring it (PHASE_42_2_SIGNER_API.md §5), implement OrderBackend with
 * `@polymarket/clob-client` + `ethers`:
 *   - bootstrap: createOrDeriveApiKey() -> new ClobClient(host, 137, signer, creds)
 *   - placeOrder (market): createAndPostMarketOrder({tokenID, amount, side, price?, orderType}, {tickSize, negRisk})
 *   - placeOrder (limit):  createOrder({tokenID, price, size, side}) + postOrder(signed, GTC/GTD)
 *   - getOrder:    getOrder(orderID)
 *   - cancelOrder: cancelOrder({orderID})
 *   - openOrders:  getOpenOrders({market?, asset_id?})
 *   - fills:       getTrades(...)
 *   - positions:   Data API GET /positions?user=<funder>  (SDK-external)
 *   - tickSize:    getTickSize(tokenID); negRisk per-market
 * Custody: private keys must live behind KMS / envelope encryption (DESIGN.md §security).
 */

import { BackendError } from './types.ts';
import type { OrderBackend } from './types.ts';

export function createLiveBackend(): OrderBackend {
  throw new BackendError(
    'SIGNER_LIVE_NOT_IMPLEMENTED',
    'live signer backend is not wired yet — it needs @polymarket/clob-client, a funded Polygon key and KMS custody. Run with SIGNER_MODE=dry_run.',
    false,
  );
}
