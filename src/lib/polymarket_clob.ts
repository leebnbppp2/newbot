/**
 * Polymarket CLOB integration (Phase 44, G4) — migrated to CLOB **V2**.
 *
 * Polymarket's 2026-04-28 exchange upgrade changed the order struct + bumped the
 * EIP-712 Exchange domain version 1→2 AND switched the collateral token from
 * USDC.e to **pUSD**. The legacy `@polymarket/clob-client` (V1) is rejected by
 * the live exchange ("invalid order version"), so this uses
 * `@polymarket/clob-client-v2`: ClobClient takes an options object, the funder is
 * the user's Gnosis Safe (sigType=2), collateral is pUSD, and builder attribution
 * is a public `builderCode`. Market buys go through `createAndPostMarketOrder`
 * (book-crossing) so they fill.
 *
 * The mappable/pure units are unit-tested with a fake ClobClient; real order
 * acceptance is verified by the live e2e (needs Privy creds + a funded Safe).
 */

import {
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  getContractConfig,
  type BuilderConfig,
} from '@polymarket/clob-client-v2';
import type { WalletClient } from 'viem';

import type { Env } from '../types';
import type { L2Creds } from './creds_crypto';
import type { TradingPolicyContracts } from './privy_signer';

/**
 * Polymarket V2 contract addresses for a chain (default Polygon). The approval +
 * funder operators are the **V2** exchanges; collateral is **pUSD**.
 */
export function polymarketContracts(chainId: number = Chain.POLYGON): TradingPolicyContracts {
  const config = getContractConfig(chainId);
  return {
    ctfExchange: config.exchangeV2,
    negRiskExchange: config.negRiskExchangeV2,
    negRiskAdapter: config.negRiskAdapter,
    conditionalTokens: config.conditionalTokens,
    collateral: config.collateral, // pUSD
  };
}

/** Builder attribution for V2 = a public builder code attached to every order. */
export function builderConfigFromEnv(env: Env): BuilderConfig | undefined {
  const builderCode = env.POLYMARKET_BUILDER_CODE?.trim() || env.POLYMARKET_BUILDER_TAG?.trim();
  return builderCode ? { builderCode } : undefined;
}

export interface ClobClientParams {
  host: string;
  signer?: WalletClient | undefined;
  creds?: L2Creds | undefined;
  funderAddress?: string | undefined; // the user's Gnosis Safe (POLY_GNOSIS_SAFE funder)
  builderConfig?: BuilderConfig | undefined;
}

export function makeClobClient(params: ClobClientParams): ClobClient {
  return new ClobClient({
    host: params.host,
    chain: Chain.POLYGON,
    signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
    ...(params.signer ? { signer: params.signer as never } : {}),
    ...(params.creds ? { creds: params.creds } : {}),
    ...(params.funderAddress ? { funderAddress: params.funderAddress } : {}),
    ...(params.builderConfig ? { builderConfig: params.builderConfig } : {}),
  });
}

type CredDerivingClient = Pick<ClobClient, 'createOrDeriveApiKey'>;

/**
 * Create (or derive the existing) L2 API creds. clob-client's bare
 * `deriveApiKey()` silently returns `{key:undefined,...}` when no key exists yet,
 * so we use `createOrDeriveApiKey` and assert completeness — an undefined secret
 * would crash L2 HMAC signing at order time.
 */
export async function deriveL2Creds(client: CredDerivingClient): Promise<L2Creds> {
  const creds = await client.createOrDeriveApiKey();
  if (!creds?.key || !creds?.secret || !creds?.passphrase) {
    throw new Error('CLOB returned incomplete API creds (key/secret/passphrase)');
  }
  return creds;
}

export interface PlaceOrderParams {
  tokenId: string;
  price: number;
  size: number;
  side?: Side;
  orderType?: OrderType;
  feeRateBps?: number;
}

export interface PlacedOrder {
  orderId: string;
  status: string;
  raw: unknown;
}

type OrderPlacingClient = Pick<
  ClobClient,
  'getTickSize' | 'getNegRisk' | 'getFeeRateBps' | 'createOrder' | 'postOrder'
>;

/**
 * Sign (EIP-712 V2, sigType=2) and post a limit order. Kept for completeness; the
 * live one-tap buy uses `placeMarketBuyOrder` (book-crossing market order).
 */
export async function placeOrder(client: OrderPlacingClient, params: PlaceOrderParams): Promise<PlacedOrder> {
  const side = params.side ?? Side.BUY;
  const orderType = params.orderType ?? OrderType.FOK;
  const [tickSize, negRisk, feeRateBps] = await Promise.all([
    client.getTickSize(params.tokenId),
    client.getNegRisk(params.tokenId),
    params.feeRateBps !== undefined ? Promise.resolve(params.feeRateBps) : client.getFeeRateBps(params.tokenId),
  ]);

  const signed = await client.createOrder(
    { tokenID: params.tokenId, price: params.price, size: params.size, side, feeRateBps },
    { tickSize, negRisk },
  );
  const raw = await client.postOrder(signed, orderType);
  return normalizePlacedOrder(raw);
}

export interface PlaceMarketBuyParams {
  tokenId: string;
  amountUsdc: number;
  orderType?: OrderType.FOK | OrderType.FAK;
}

type MarketOrderPlacingClient = Pick<ClobClient, 'createAndPostMarketOrder'>;

/**
 * Sign + post a MARKET buy in one call (V2 `createAndPostMarketOrder`). The client
 * reads the book and computes a crossing price for `amountUsdc` of collateral, so
 * the order fills immediately — a plain limit at the mid would get killed (FOK).
 * For BUYs `amount` is the collateral (pUSD) to spend. Builder attribution rides
 * on the client's `builderConfig`.
 */
export async function placeMarketBuyOrder(
  client: MarketOrderPlacingClient,
  params: PlaceMarketBuyParams,
): Promise<PlacedOrder> {
  const orderType = params.orderType ?? OrderType.FOK;
  const raw = await client.createAndPostMarketOrder(
    { tokenID: params.tokenId, side: Side.BUY, amount: params.amountUsdc, orderType },
    undefined,
    orderType,
  );
  return normalizePlacedOrder(raw);
}

/** Map a CLOB post response into the {orderId,status} the gateway consumes. */
export function normalizePlacedOrder(raw: unknown): PlacedOrder {
  const r = (raw ?? {}) as Record<string, unknown>;
  const orderId = String(r.orderID ?? r.orderId ?? r.id ?? '');
  const status = String(r.status ?? (r.success === true ? 'live' : 'unknown'));
  return { orderId, status, raw };
}
