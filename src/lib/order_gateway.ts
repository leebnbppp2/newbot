/**
 * Phase 17 order gateway: lifecycle + portfolio reads + local cache.
 */

import type { RemoteFill, RemoteOpenOrder, RemotePosition, MarketItem, SellablePosition } from '../agent/replies';
import type { TradeEventRow } from '../db/trade_events';
import type { TradingAccountRow } from '../db/users';
import type { Env } from '../types';
import { getTradingCredentials, upsertTradingCredentials } from '../db/trading_credentials';
import { decryptL2Creds, encryptL2Creds } from './creds_crypto';
import { privyClientFromEnv, walletClientForUser } from './privy_signer';
import { builderConfigFromEnv, deriveL2Creds, makeClobClient, placeMarketBuyOrder, type PlaceOrderParams } from './polymarket_clob';

export interface ExecuteBuyOrderInput {
  market: MarketItem;
  outcome: string;
  tokenId: string;
  amountUsdc: number;
  account: TradingAccountRow;
  /** Bot/persona id; signer 据此选密钥与 L2 creds（CLOB v2 协议必填）。 */
  botId: string;
  /** Telegram user id；与 botId 一起定位 signer 侧的用户托管钱包。 */
  telegramUserId: string;
  /** 市价单可接受价上限（滑点保护）/限价单挂单价；缺省时不带。 */
  price?: number;
  /** 首发只用 BUY；预留 SELL（平仓）。 */
  side?: OrderSide;
  /** 市价买入默认 FOK；限价用 GTC/GTD。 */
  orderType?: OrderType;
}

export interface ExecuteBuyOrderResult {
  mode: 'live' | 'simulated';
  status: string;
  orderId: string;
  detail: Record<string, unknown>;
  builderAttribution: BuilderAttributionDetail | null;
}

export interface CancelOrderResult {
  status: string;
  orderId: string;
  detail: Record<string, unknown>;
}

interface LiveOrderConfig {
  baseUrl: string;
  apiKey: string;
  signingSecret: string | null;
  builderTag: string | null;
  builderApiKey: string | null;
}

interface CacheRow {
  data_json: string;
  expires_at: string;
}

export interface BuilderAttributionDetail {
  active: boolean;
  builderTag: string | null;
  builderApiKeyHint: string | null;
  attributionMode: 'builder_program' | 'none';
}

export type RemoteDataSource = 'live' | 'cache' | 'none';

export type TradingMode = 'live' | 'simulated';

export type OrderSide = 'BUY' | 'SELL';

export type OrderType = 'GTC' | 'GTD' | 'FOK' | 'FAK';

/** Polymarket 官方 SignatureType 枚举：0 EOA / 1 POLY_PROXY / 2 POLY_GNOSIS_SAFE。 */
export type SignatureTypeCode = 0 | 1 | 2;

/**
 * signer/CLOB 写类接口返回的结构化错误（对齐 PHASE_42_2_SIGNER_API.md §8 统一 envelope）。
 * 携带可直接展示给用户的中文文案，便于 webhook 区分「资金/授权/签名/拒单」分别提示。
 */
export class LiveOrderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly userMessage: string;

  constructor(detail: { code: string; message: string; retryable: boolean; httpStatus: number; userMessage: string }) {
    super(`Live order failed: ${detail.code} (HTTP ${detail.httpStatus})`);
    this.name = 'LiveOrderError';
    this.code = detail.code;
    this.retryable = detail.retryable;
    this.httpStatus = detail.httpStatus;
    this.userMessage = detail.userMessage;
  }
}

export interface RemoteCollectionResult<T> {
  items: T[];
  source: RemoteDataSource;
  warning: string | null;
}

export interface OrderGatewayReadiness {
  tradingMode: TradingMode;
  liveOrderApi: boolean;
  signing: boolean;
  builderAttribution: 'ready' | 'partial' | 'disabled';
  liveTradingAllowlist: boolean;
  /** Phase 44 Path A:进程内 Privy + CLOB 直连是否就绪(全局配置层面)。 */
  clobLive: boolean;
  privyConfigured: boolean;
  credsEncryption: boolean;
  warnings: string[];
}

interface SignatureEnvelope {
  protocolVersion: string;
  bodySha256: string;
  timestampMs: string;
  nonce: string;
  signatureInput: string;
  signature: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const ORDER_PROTOCOL_VERSION = 'polymarket_clob_v2';

export async function executeBuyOrder(
  env: Env,
  input: ExecuteBuyOrderInput,
  deps: ExecuteBuyOrderDeps = {},
): Promise<ExecuteBuyOrderResult> {
  const tradingMode = getTradingMode(env);
  // 全局主开关优先：未设为 live 时强制模拟单。
  if (tradingMode !== 'live') {
    return simulatedResult('trading_mode_simulated', '交易主开关 NEWBOT_TRADING_MODE 未设为 live，先按模拟单记录。');
  }

  // Path A (Phase 44)：进程内 Privy + CLOB 直连，配置就绪时优先走真实下单。
  if (hasClobLiveConfig(env)) {
    const placeClob = deps.placeClobOrder ?? placeClobOrderLive;
    return placeClob(env, input);
  }

  // Legacy 远端 signer 路径（G8 退役）：CLOB 未配置时回退；都没配置则模拟单。
  const liveConfig = getLiveOrderConfig(env);
  if (!liveConfig) {
    return simulatedResult('missing_live_order_config', '还没接入真实下单（Privy/CLOB 或远端 signer 均未配置），先按模拟单记录。');
  }

  const requestBody = buildLiveOrderPayload(input, liveConfig.builderTag, liveConfig.builderApiKey);
  const signing = await buildSignedHeaders(liveConfig, requestBody, input.account.auth_mode);

  const response = await fetch(`${liveConfig.baseUrl}/orders`, {
    method: 'POST',
    headers: signing.headers,
    body: JSON.stringify(requestBody),
  });

  const payload = (await safeJson(response)) as { orderId?: string; status?: string; [key: string]: unknown };
  if (!response.ok) {
    throw mapLiveOrderError(payload, response.status);
  }

  return {
    mode: 'live',
    status: normalizeLiveStatus(payload.status),
    orderId: payload.orderId ?? String(requestBody.client_order_id),
    detail: {
      ...payload,
      request: requestBody,
      signed: Boolean(liveConfig.signingSecret),
      auth_mode: input.account.auth_mode,
      builder_attribution: buildBuilderAttributionDetail(liveConfig),
      signature_envelope: signing.signatureEnvelope,
    },
    builderAttribution: buildBuilderAttributionDetail(liveConfig),
  };
}

export interface ExecuteBuyOrderDeps {
  /** Injectable for tests; defaults to the real in-Worker Privy + CLOB path. */
  placeClobOrder?: (env: Env, input: ExecuteBuyOrderInput) => Promise<ExecuteBuyOrderResult>;
}

function simulatedResult(reason: string, message: string): ExecuteBuyOrderResult {
  return {
    mode: 'simulated',
    status: 'simulated_submitted',
    orderId: `sim-${Date.now()}`,
    detail: { reason, message },
    builderAttribution: null,
  };
}

/** Phase 44 Path A config gate: Privy app + authorization key + CLOB host all present. */
export function hasClobLiveConfig(env: Env): boolean {
  return Boolean(
    env.PRIVY_APP_ID?.trim() &&
      env.PRIVY_APP_SECRET?.trim() &&
      env.PRIVY_AUTHORIZATION_PRIVATE_KEY?.trim() &&
      env.POLYMARKET_CLOB_HOST?.trim(),
  );
}

/**
 * Map a NewBot buy into CLOB order params. A live buy needs a 0<price<1 (the
 * outcome probability); size = amount_usdc / price shares.
 */
export function buildClobOrderParams(input: ExecuteBuyOrderInput): PlaceOrderParams {
  const price = input.price;
  if (typeof price !== 'number' || price <= 0 || price >= 1) {
    throw new LiveOrderError({
      code: 'ORDER_REJECTED',
      message: 'live CLOB order requires a price in (0,1)',
      retryable: false,
      httpStatus: 400,
      userMessage: '真实下单需要一个 0~1 之间的价格（概率）。请带价格再试，例如 /buy <市场> yes 50 0.62。',
    });
  }
  return { tokenId: input.tokenId, price, size: input.amountUsdc / price };
}

/**
 * Phase 44 (final): place a real Polymarket V2 order via the local order-service
 * sidecar, which runs `@polymarket/client` (SecureClient) with the user's Privy
 * wallet — its deterministic V2 Deposit Wallet is the funder — plus our builder
 * key for commission attribution. (clob-client-v2 was the broken SDK that V2
 * rejects; @polymarket/client is the maintained one but uses node APIs that
 * can't run in workerd, so the Worker calls it over localhost.)
 */
interface SidecarPlaceResult {
  ok?: boolean;
  orderId?: string;
  status?: string;
  raw?: unknown;
  wallet?: string;
  error?: string;
}

/**
 * POST a BUY (amount = USDC) or SELL (amount = shares) to the local order-service
 * sidecar's `/place`, mapping its 402 (auto-wrap can't cover the buy) and generic
 * failures to LiveOrderError. Shared by both the buy and sell paths.
 */
async function postSidecarOrder(
  env: Env,
  account: TradingAccountRow,
  params: { tokenId: string; amount: number; side: OrderSide },
): Promise<SidecarPlaceResult> {
  const url = (env.ORDER_SERVICE_URL ?? 'http://127.0.0.1:8799').replace(/\/$/, '');
  const token = env.ORDER_SERVICE_TOKEN ?? 'local-newbot';
  try {
    const resp = await fetch(`${url}/place`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-order-token': token },
      body: JSON.stringify({
        walletId: account.privy_wallet_id,
        eoaAddress: account.signer_address,
        safeAddress: account.funder_address,
        tokenId: params.tokenId,
        amount: params.amount,
        side: params.side,
      }),
    });
    const data = (await resp.json()) as SidecarPlaceResult;
    if (resp.status === 402) {
      // Sidecar auto-wrap found the user's Safe + deposit wallet can't cover this buy.
      throw new LiveOrderError({
        code: 'INSUFFICIENT_FUNDS',
        message: data.error ?? 'insufficient funds',
        retryable: false,
        httpStatus: 402,
        userMessage: '余额不足。请先向你的充值地址转入 USDC.e（可发 /deposit 查看地址和当前余额），到账后再下单。',
      });
    }
    if (!resp.ok || data.ok === false) {
      throw new LiveOrderError({
        code: 'ORDER_REJECTED',
        message: data.error ?? `order service HTTP ${resp.status}`,
        retryable: false,
        httpStatus: 502,
        userMessage: userMessageForLiveOrderCode('ORDER_REJECTED'),
      });
    }
    return data;
  } catch (error) {
    if (error instanceof LiveOrderError) {
      throw error;
    }
    throw new LiveOrderError({
      code: 'ORDER_REJECTED',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      httpStatus: 502,
      userMessage: userMessageForLiveOrderCode('ORDER_REJECTED'),
    });
  }
}

async function placeClobOrderLive(env: Env, input: ExecuteBuyOrderInput): Promise<ExecuteBuyOrderResult> {
  const account = input.account;
  if (!account.privy_wallet_id || !account.signer_address || !account.funder_address) {
    throw credsNotReady('wallet not provisioned');
  }
  const builderAttribution = builderAttributionFromEnv(env);
  const data = await postSidecarOrder(env, account, { tokenId: input.tokenId, amount: input.amountUsdc, side: 'BUY' });

  return {
    mode: 'live',
    status: normalizeLiveStatus(data.status ?? 'matched'),
    orderId: data.orderId || `clob-${Date.now()}`,
    detail: {
      order: data.raw,
      token_id: input.tokenId,
      amount_usdc: input.amountUsdc,
      funder_address: data.wallet ?? account.funder_address,
      signature_type: 3,
      protocol: ORDER_PROTOCOL_VERSION,
      builder_attribution: builderAttribution,
    },
    builderAttribution,
  };
}

export interface ExecuteSellOrderInput {
  account: TradingAccountRow;
  tokenId: string;
  /** Number of outcome shares to sell (market SELL amount is shares, not USDC). */
  shares: number;
  botId: string;
  telegramUserId: string;
}

/**
 * Sell (close) an outcome position via the sidecar. Mirrors executeBuyOrder's gating
 * (global trading-mode switch + Path A config), but the market SELL amount is shares.
 */
export async function executeSellOrder(env: Env, input: ExecuteSellOrderInput): Promise<ExecuteBuyOrderResult> {
  if (getTradingMode(env) !== 'live') {
    return simulatedResult('trading_mode_simulated', '交易主开关 NEWBOT_TRADING_MODE 未设为 live，先按模拟单记录。');
  }
  if (!hasClobLiveConfig(env)) {
    return simulatedResult('missing_live_order_config', '还没接入真实下单（Privy/CLOB 未配置），先按模拟单记录。');
  }
  const account = input.account;
  if (!account.privy_wallet_id || !account.signer_address || !account.funder_address) {
    throw credsNotReady('wallet not provisioned');
  }
  const builderAttribution = builderAttributionFromEnv(env);
  const data = await postSidecarOrder(env, account, { tokenId: input.tokenId, amount: input.shares, side: 'SELL' });

  return {
    mode: 'live',
    status: normalizeLiveStatus(data.status ?? 'matched'),
    orderId: data.orderId || `clob-sell-${Date.now()}`,
    detail: {
      order: data.raw,
      token_id: input.tokenId,
      shares: input.shares,
      side: 'SELL',
      funder_address: data.wallet ?? account.funder_address,
      signature_type: 3,
      protocol: ORDER_PROTOCOL_VERSION,
      builder_attribution: builderAttribution,
    },
    builderAttribution,
  };
}

/**
 * Read the user's deposit-wallet positions (for selling) via the sidecar's `/positions`,
 * which proxies the Polymarket data API. Returns [] when unavailable / not provisioned.
 */
export async function fetchDepositWalletPositions(env: Env, account: TradingAccountRow): Promise<SellablePosition[]> {
  if (!account.privy_wallet_id) {
    return [];
  }
  const url = (env.ORDER_SERVICE_URL ?? 'http://127.0.0.1:8799').replace(/\/$/, '');
  const token = env.ORDER_SERVICE_TOKEN ?? 'local-newbot';
  try {
    const resp = await fetch(`${url}/positions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-order-token': token },
      body: JSON.stringify({ walletId: account.privy_wallet_id, eoaAddress: account.signer_address }),
    });
    if (!resp.ok) {
      return [];
    }
    const data = (await resp.json()) as { ok?: boolean; positions?: SellablePosition[] };
    return Array.isArray(data.positions) ? data.positions : [];
  } catch {
    return [];
  }
}

/**
 * Weighted-average cost per share from BUY rows, using each buy's recorded `price` (in payload)
 * and USDC spent: avg = Σamount / Σ(amount / price). Returns null when no priced buy is found.
 * Used to reconstruct a cost basis for P&L when the positions feed doesn't carry `avgPrice`.
 */
export function computeAvgCostFromBuys(buys: Array<{ amount_usdc: number; payload_json: string | null }>): number | null {
  let usdc = 0;
  let shares = 0;
  for (const buy of buys) {
    if (!(buy.amount_usdc > 0) || !buy.payload_json) {
      continue;
    }
    let price: number | null = null;
    try {
      const parsed = JSON.parse(buy.payload_json) as { price?: unknown };
      if (typeof parsed.price === 'number' && parsed.price > 0) {
        price = parsed.price;
      }
    } catch {
      // ignore malformed payloads
    }
    if (price === null) {
      continue;
    }
    usdc += buy.amount_usdc;
    shares += buy.amount_usdc / price;
  }
  return shares > 0 ? usdc / shares : null;
}

export interface WalletInfo {
  depositWallet: string;
  safe: string | null;
  balances: { depositPusd: string; depositUsdce: string; safeUsdce: string };
}

/**
 * Read-only balance snapshot for a user's trading wallet, via the local sidecar's
 * `/wallet` endpoint. Powers /deposit so users see their real deposit wallet + balances.
 * Returns null when the sidecar is unavailable or the wallet isn't provisioned.
 */
export async function fetchWalletInfo(env: Env, account: TradingAccountRow): Promise<WalletInfo | null> {
  if (!account.privy_wallet_id) {
    return null;
  }
  const url = (env.ORDER_SERVICE_URL ?? 'http://127.0.0.1:8799').replace(/\/$/, '');
  const token = env.ORDER_SERVICE_TOKEN ?? 'local-newbot';
  try {
    const resp = await fetch(`${url}/wallet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-order-token': token },
      body: JSON.stringify({
        walletId: account.privy_wallet_id,
        eoaAddress: account.signer_address,
        safeAddress: account.funder_address,
      }),
    });
    if (!resp.ok) {
      return null;
    }
    const data = (await resp.json()) as Partial<WalletInfo> & { ok?: boolean };
    if (!data.depositWallet || !data.balances) {
      return null;
    }
    return { depositWallet: data.depositWallet, safe: data.safe ?? null, balances: data.balances };
  } catch {
    return null;
  }
}

function credsNotReady(message: string): LiveOrderError {
  return new LiveOrderError({
    code: 'CREDS_NOT_READY',
    message,
    retryable: false,
    httpStatus: 409,
    userMessage: userMessageForLiveOrderCode('CREDS_NOT_READY'),
  });
}

function builderAttributionFromEnv(env: Env): BuilderAttributionDetail | null {
  const tag = env.POLYMARKET_BUILDER_TAG?.trim() || null;
  const key = env.POLYMARKET_BUILDER_API_KEY?.trim() || null;
  if (!tag && !key) {
    return null;
  }
  const active = Boolean(
    key && env.POLYMARKET_BUILDER_API_SECRET?.trim() && env.POLYMARKET_BUILDER_PASSPHRASE?.trim(),
  );
  return {
    active,
    builderTag: tag,
    builderApiKeyHint: maskBuilderApiKey(key),
    attributionMode: 'builder_program',
  };
}

export async function enrichTradeEventsWithLiveStatus(env: Env, events: TradeEventRow[]): Promise<TradeEventRow[]> {
  const liveConfig = getLiveOrderConfig(env);
  if (!liveConfig) {
    return events;
  }

  const updated = await Promise.all(events.map(async (event) => {
    if (!event.order_id || !event.status.startsWith('live_')) {
      return event;
    }
    const detail = await fetchLiveOrderStatus(liveConfig, event.order_id);
    if (!detail) {
      return event;
    }
    return {
      ...event,
      status: detail.status,
      payload_json: JSON.stringify({
        previous_payload: safeParseJson(event.payload_json),
        live_status_sync: detail.detail,
      }),
    };
  }));

  return updated;
}

export async function cancelLiveOrder(
  env: Env,
  orderId: string,
  authMode: string,
  botId: string,
  telegramUserId: string,
): Promise<CancelOrderResult | null> {
  const liveConfig = getLiveOrderConfig(env);
  if (!liveConfig) {
    return null;
  }

  const requestBody = {
    bot_id: botId,
    telegram_user_id: telegramUserId,
    order_id: orderId,
    timestamp_ms: Date.now(),
    nonce: crypto.randomUUID().replaceAll('-', ''),
    auth_mode: authMode,
    action: 'cancel',
  };
  const signing = await buildSignedHeaders(liveConfig, requestBody, authMode);

  const response = await fetch(`${liveConfig.baseUrl}/orders/${encodeURIComponent(orderId)}/cancel`, {
    method: 'POST',
    headers: signing.headers,
    body: JSON.stringify(requestBody),
  });
  const payload = (await safeJson(response)) as { orderId?: string; status?: string; [key: string]: unknown };
  if (!response.ok) {
    throw mapLiveOrderError(payload, response.status);
  }

  return {
    status: normalizeLiveStatus(payload.status),
    orderId: payload.orderId ?? orderId,
    detail: payload,
  };
}

export async function fetchLiveOpenOrders(env: Env, telegramUserId: string, botId: string): Promise<RemoteCollectionResult<RemoteOpenOrder>> {
  const liveConfig = getLiveOrderConfig(env);
  const cacheKey = `portfolio:openorders:${botId}:${telegramUserId}`;
  if (!liveConfig) {
    return buildCacheOnlyResult(await readCache<RemoteOpenOrder>(env, cacheKey), '当前还没接真实订单接口，先只展示本地缓存。');
  }
  const response = await fetch(`${liveConfig.baseUrl}/orders/open?bot_id=${encodeURIComponent(botId)}&telegram_user_id=${encodeURIComponent(telegramUserId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${liveConfig.apiKey}` },
  });
  if (!response.ok) {
    return buildFallbackResult(await readCache<RemoteOpenOrder>(env, cacheKey), '远端未成交订单暂时拉取失败，先给你上次缓存。');
  }
  const payload = (await safeJson(response)) as { orders?: RemoteOpenOrder[] };
  const orders = payload.orders ?? [];
  await writeCache(env, cacheKey, orders);
  return { items: orders, source: 'live', warning: null };
}

export async function fetchRemotePositions(env: Env, telegramUserId: string, botId: string): Promise<RemoteCollectionResult<RemotePosition>> {
  const liveConfig = getLiveOrderConfig(env);
  const cacheKey = `portfolio:positions:${botId}:${telegramUserId}`;
  if (!liveConfig) {
    return buildCacheOnlyResult(await readCache<RemotePosition>(env, cacheKey), '当前还没接真实持仓接口，先只展示本地缓存。');
  }
  const response = await fetch(`${liveConfig.baseUrl}/portfolio/positions?bot_id=${encodeURIComponent(botId)}&telegram_user_id=${encodeURIComponent(telegramUserId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${liveConfig.apiKey}` },
  });
  if (!response.ok) {
    return buildFallbackResult(await readCache<RemotePosition>(env, cacheKey), '远端持仓暂时拉取失败，先给你上次缓存。');
  }
  const payload = (await safeJson(response)) as { positions?: RemotePosition[] };
  const positions = payload.positions ?? [];
  await writeCache(env, cacheKey, positions);
  return { items: positions, source: 'live', warning: null };
}

export async function fetchRemoteFills(env: Env, telegramUserId: string, botId: string): Promise<RemoteCollectionResult<RemoteFill>> {
  const liveConfig = getLiveOrderConfig(env);
  const cacheKey = `portfolio:fills:${botId}:${telegramUserId}`;
  if (!liveConfig) {
    return buildCacheOnlyResult(await readCache<RemoteFill>(env, cacheKey), '当前还没接真实成交接口，先只展示本地缓存。');
  }
  const response = await fetch(`${liveConfig.baseUrl}/portfolio/fills?bot_id=${encodeURIComponent(botId)}&telegram_user_id=${encodeURIComponent(telegramUserId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${liveConfig.apiKey}` },
  });
  if (!response.ok) {
    return buildFallbackResult(await readCache<RemoteFill>(env, cacheKey), '远端成交记录暂时拉取失败，先给你上次缓存。');
  }
  const payload = (await safeJson(response)) as { fills?: RemoteFill[] };
  const fills = payload.fills ?? [];
  await writeCache(env, cacheKey, fills);
  return { items: fills, source: 'live', warning: null };
}

export function getOrderGatewayReadiness(env: Env): OrderGatewayReadiness {
  const baseUrl = env.POLYMARKET_ORDER_API_BASE?.trim();
  const apiKey = env.POLYMARKET_ORDER_API_KEY?.trim();
  const signingSecret = env.POLYMARKET_ORDER_SIGNING_SECRET?.trim();
  const builderTag = env.POLYMARKET_BUILDER_TAG?.trim();
  const builderApiKey = env.POLYMARKET_BUILDER_API_KEY?.trim();
  const liveTradingAllowlist = env.NEWBOT_LIVE_TRADING_TELEGRAM_IDS?.trim();
  const tradingMode = getTradingMode(env);
  const warnings: string[] = [];

  const clobLive = hasClobLiveConfig(env);
  if (!clobLive && (!baseUrl || !apiKey)) {
    warnings.push('真实下单还没配置（Path A 的 Privy/CLOB 或 legacy live order API 均未就绪）。');
  }
  if (clobLive && tradingMode !== 'live') {
    warnings.push('Path A 已配置，但 NEWBOT_TRADING_MODE 未设为 live：所有下单仍走模拟单，设为 live 才会真实成交。');
  }
  if ((builderTag && !builderApiKey) || (!builderTag && builderApiKey)) {
    warnings.push('Builder Program 配置不完整，归因暂时不会完整生效。');
  }
  if ((baseUrl || apiKey) && !signingSecret) {
    warnings.push('signing secret 还没配置，live 请求暂时不会带 canonical 签名头。');
  }
  if (tradingMode !== 'live' && baseUrl && apiKey) {
    warnings.push('交易主开关 NEWBOT_TRADING_MODE 未设为 live：即使 live API 已配置，所有下单也会强制走模拟单。');
  }

  const privyConfigured = Boolean(env.PRIVY_APP_ID?.trim() && env.PRIVY_APP_SECRET?.trim());
  const credsEncryption = Boolean(env.NEWBOT_CREDS_ENCRYPTION_KEY?.trim());

  if (tradingMode === 'live' && clobLive && !credsEncryption) {
    warnings.push('NEWBOT_CREDS_ENCRYPTION_KEY 未配置：无法解密用户 L2 creds，真实下单会失败。');
  }
  if (tradingMode === 'live' && clobLive && !env.POLYGON_RPC_URL?.trim()) {
    warnings.push('POLYGON_RPC_URL 未配置：Privy 签名 / 链上调用可能失败。');
  }

  const builderAttribution = builderTag && builderApiKey
    ? 'ready'
    : (builderTag || builderApiKey ? 'partial' : 'disabled');

  return {
    tradingMode,
    liveOrderApi: Boolean(baseUrl && apiKey),
    signing: Boolean(baseUrl && apiKey && signingSecret),
    builderAttribution,
    liveTradingAllowlist: Boolean(liveTradingAllowlist),
    clobLive,
    privyConfigured,
    credsEncryption,
    warnings,
  };
}

/**
 * 全局交易主开关:仅当 NEWBOT_TRADING_MODE 显式为 'live' 时才允许真实下单;
 * 未设置或任何其他值都回退为 'simulated'(安全默认)。
 */
export function getTradingMode(env: Env): TradingMode {
  return env.NEWBOT_TRADING_MODE?.trim().toLowerCase() === 'live' ? 'live' : 'simulated';
}

function getLiveOrderConfig(env: Env): LiveOrderConfig | null {
  const baseUrl = env.POLYMARKET_ORDER_API_BASE?.trim();
  const apiKey = env.POLYMARKET_ORDER_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    return null;
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    signingSecret: env.POLYMARKET_ORDER_SIGNING_SECRET?.trim() || null,
    builderTag: env.POLYMARKET_BUILDER_TAG?.trim() || null,
    builderApiKey: env.POLYMARKET_BUILDER_API_KEY?.trim() || null,
  };
}

function buildCacheOnlyResult<T>(items: T[], warning: string): RemoteCollectionResult<T> {
  if (items.length > 0) {
    return { items, source: 'cache', warning };
  }
  return { items, source: 'none', warning: null };
}

function buildFallbackResult<T>(items: T[], warning: string): RemoteCollectionResult<T> {
  if (items.length > 0) {
    return { items, source: 'cache', warning };
  }
  return { items, source: 'none', warning: '远端暂时不可用，而且本地也还没有可展示的缓存。' };
}

async function readCache<T>(env: Env, cacheKey: string): Promise<T[]> {
  const row = await env.DB.prepare('SELECT data_json, expires_at FROM market_cache WHERE slug = ? LIMIT 1')
    .bind(cacheKey)
    .first<CacheRow>();
  if (!row || Date.parse(row.expires_at) <= Date.now()) {
    return [];
  }
  try {
    return JSON.parse(row.data_json) as T[];
  } catch {
    return [];
  }
}

async function writeCache<T>(env: Env, cacheKey: string, data: T[]): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);
  await env.DB.prepare(
    `INSERT INTO market_cache (slug, data_json, fetched_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       data_json = excluded.data_json,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
  )
    .bind(cacheKey, JSON.stringify(data), now.toISOString(), expiresAt.toISOString())
    .run();
}

function buildLiveOrderPayload(input: ExecuteBuyOrderInput, builderTag: string | null, builderApiKey: string | null): Record<string, unknown> {
  const timestampMs = Date.now();
  const clientOrderId = `nbo-${timestampMs}-${crypto.randomUUID().slice(0, 8)}`;
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const signatureType = mapSignatureType(input.account.auth_mode);
  const side: OrderSide = input.side ?? 'BUY';
  const orderType: OrderType = input.orderType ?? 'FOK';

  return {
    bot_id: input.botId,
    telegram_user_id: input.telegramUserId,
    market_slug: input.market.slug ?? input.market.question,
    market_question: input.market.question,
    outcome: input.outcome,
    token_id: input.tokenId,
    amount_usdc: input.amountUsdc,
    side,
    order_type: orderType,
    price: typeof input.price === 'number' ? input.price : null,
    signer_address: input.account.signer_address,
    funder_address: input.account.funder_address,
    auth_mode: input.account.auth_mode,
    account_label: input.account.account_label,
    client_order_id: clientOrderId,
    timestamp_ms: timestampMs,
    nonce,
    builder_tag: builderTag,
    builder_api_key: builderApiKey,
    builder_api_key_hint: maskBuilderApiKey(builderApiKey),
    signature_type: signatureType,
    protocol: ORDER_PROTOCOL_VERSION,
  };
}

/**
 * Worker 的 auth_mode → 官方 SignatureType 整数枚举
 * （PHASE_42_2_SIGNER_API.md §6）：wallet_signature=0 EOA / managed_signer=1 POLY_PROXY / gnosis=2。
 */
function mapSignatureType(authMode: string): SignatureTypeCode {
  switch (authMode) {
    case 'managed_signer':
      return 1;
    case 'gnosis_safe':
    case 'poly_gnosis_safe':
      return 2;
    case 'wallet_signature':
    default:
      return 0;
  }
}

/**
 * 解析 signer 统一错误 envelope `{ error: { code, message, retryable } }`，
 * 映射成带中文用户文案的 LiveOrderError（PHASE_42_2_SIGNER_API.md §8）。
 */
function mapLiveOrderError(payload: unknown, httpStatus: number): LiveOrderError {
  const envelope = (payload as { error?: { code?: unknown; message?: unknown; retryable?: unknown } } | null)?.error;
  const code = typeof envelope?.code === 'string' && envelope.code.length > 0 ? envelope.code : 'UNKNOWN';
  const message = typeof envelope?.message === 'string' ? envelope.message : '';
  const retryable = typeof envelope?.retryable === 'boolean' ? envelope.retryable : false;
  return new LiveOrderError({ code, message, retryable, httpStatus, userMessage: userMessageForLiveOrderCode(code) });
}

function userMessageForLiveOrderCode(code: string): string {
  switch (code) {
    case 'INSUFFICIENT_BALANCE':
      return '账户余额不足，先给交易账户充值后再下单。';
    case 'INSUFFICIENT_ALLOWANCE':
      return '链上授权还没完成。需要先给 USDC / 合约做一次授权，才能真正下单。';
    case 'CREDS_NOT_READY':
      return '你的交易账户还在开通中，稍等一下再发一次。';
    case 'GEOBLOCKED':
      return '当前地区暂时不支持真实下单。';
    case 'ORDER_REJECTED':
      return '这笔订单被拒了（价格、规模或最小变动价位不满足）。可以调整金额或稍后再试。';
    case 'SIGNING_FAILED':
      return '下单签名出了点问题，我已经记录。先别重复下单，稍后再试。';
    case 'UPSTREAM_TIMEOUT':
      return '下单服务暂时不可用，请稍后再试。';
    default:
      return '真实下单没有成功，我已经记录。你可以稍后再试，或发 /health 看系统状态。';
  }
}

async function buildSignedHeaders(
  config: LiveOrderConfig,
  payload: Record<string, unknown>,
  authMode: string,
): Promise<{ headers: Record<string, string>; signatureEnvelope: SignatureEnvelope | null }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
    'x-auth-mode': authMode,
    'x-signature-type': String(payload.signature_type ?? authMode),
  };

  if (config.signingSecret) {
    const signatureEnvelope = await signPayload(payload, config.signingSecret, authMode);
    headers['x-order-signature'] = signatureEnvelope.signature;
    headers['x-order-body-sha256'] = signatureEnvelope.bodySha256;
    headers['x-order-signature-input'] = signatureEnvelope.signatureInput;
    headers['x-order-protocol-version'] = signatureEnvelope.protocolVersion;
    headers['x-order-timestamp-ms'] = signatureEnvelope.timestampMs;
    headers['x-order-nonce'] = signatureEnvelope.nonce;
    return { headers, signatureEnvelope };
  }

  return { headers, signatureEnvelope: null };
}

async function signPayload(payload: Record<string, unknown>, signingSecret: string, authMode: string): Promise<SignatureEnvelope> {
  const canonicalPayload = JSON.stringify(payload);
  const bodySha256 = await sha256Hex(canonicalPayload);
  const timestampMs = String(payload.timestamp_ms ?? Date.now());
  const nonce = String(payload.nonce ?? '');
  const signatureInput = [
    `body_sha256=${bodySha256}`,
    `timestamp_ms=${timestampMs}`,
    `nonce=${nonce}`,
    `auth_mode=${authMode}`,
    `protocol_version=${ORDER_PROTOCOL_VERSION}`,
  ].join(',');
  const encodedSecret = new TextEncoder().encode(`${authMode}:${signingSecret}`);
  const key = await crypto.subtle.importKey('raw', encodedSecret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const encodedPayload = new TextEncoder().encode(signatureInput);
  const signature = await crypto.subtle.sign('HMAC', key, encodedPayload);
  return {
    protocolVersion: ORDER_PROTOCOL_VERSION,
    bodySha256,
    timestampMs,
    nonce,
    signatureInput,
    signature: toHex(signature),
  };
}

async function fetchLiveOrderStatus(config: LiveOrderConfig, orderId: string): Promise<{ status: string; detail: Record<string, unknown> } | null> {
  const response = await fetch(`${config.baseUrl}/orders/${encodeURIComponent(orderId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await safeJson(response)) as { status?: string; [key: string]: unknown };
  return {
    status: normalizeLiveStatus(payload.status),
    detail: payload,
  };
}

function normalizeLiveStatus(status: string | undefined): string {
  // 对齐真实 CLOB 状态机（PHASE_42_2_SIGNER_API.md §7）。
  switch (status) {
    case 'live':
    case 'submitted':
      return 'live_submitted';
    case 'matched':
      return 'live_matched';
    case 'cancelled':
      return 'live_cancelled';
    case 'delayed':
      return 'live_delayed';
    case 'unmatched':
      return 'live_unmatched';
    default:
      return status ?? 'live_submitted';
  }
}

function safeParseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toHex(input: ArrayBuffer): string {
  return Array.from(new Uint8Array(input)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return toHex(digest);
}

function buildBuilderAttributionDetail(config: LiveOrderConfig): BuilderAttributionDetail | null {
  if (!config.builderTag && !config.builderApiKey) {
    return null;
  }
  return {
    active: Boolean(config.builderTag && config.builderApiKey),
    builderTag: config.builderTag,
    builderApiKeyHint: maskBuilderApiKey(config.builderApiKey),
    attributionMode: 'builder_program',
  };
}

function maskBuilderApiKey(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (value.length <= 4) {
    return `****${value}`;
  }
  return `****${value.slice(-4)}`;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
