/**
 * Phase 17 order gateway: lifecycle + portfolio reads + local cache.
 */

import type { RemoteFill, RemoteOpenOrder, RemotePosition, MarketItem } from '../agent/replies';
import type { TradeEventRow } from '../db/trade_events';
import type { TradingAccountRow } from '../db/users';
import type { Env } from '../types';

export interface ExecuteBuyOrderInput {
  market: MarketItem;
  outcome: string;
  tokenId: string;
  amountUsdc: number;
  account: TradingAccountRow;
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

export async function executeBuyOrder(env: Env, input: ExecuteBuyOrderInput): Promise<ExecuteBuyOrderResult> {
  const liveConfig = getLiveOrderConfig(env);
  const tradingMode = getTradingMode(env);
  // 全局主开关优先：未设为 live 时，即使 live API 已配置也强制模拟单。
  if (tradingMode !== 'live' || !liveConfig) {
    const simulatedByMode = tradingMode !== 'live';
    return {
      mode: 'simulated',
      status: 'simulated_submitted',
      orderId: `sim-${Date.now()}`,
      detail: {
        reason: simulatedByMode ? 'trading_mode_simulated' : 'missing_live_order_config',
        message: simulatedByMode
          ? '交易主开关 NEWBOT_TRADING_MODE 未设为 live，先按模拟单记录。'
          : '还没接入真实下单 API，先按模拟单记录。',
      },
      builderAttribution: null,
    };
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
    throw new Error(`Live order API failed: ${response.status}`);
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

export async function cancelLiveOrder(env: Env, orderId: string, authMode: string): Promise<CancelOrderResult | null> {
  const liveConfig = getLiveOrderConfig(env);
  if (!liveConfig) {
    return null;
  }

  const requestBody = {
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
    throw new Error(`Live cancel API failed: ${response.status}`);
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

  if (!baseUrl || !apiKey) {
    warnings.push('live order API 还没完整配置。');
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

  const builderAttribution = builderTag && builderApiKey
    ? 'ready'
    : (builderTag || builderApiKey ? 'partial' : 'disabled');

  return {
    tradingMode,
    liveOrderApi: Boolean(baseUrl && apiKey),
    signing: Boolean(baseUrl && apiKey && signingSecret),
    builderAttribution,
    liveTradingAllowlist: Boolean(liveTradingAllowlist),
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
  const signatureType = input.account.auth_mode === 'managed_signer' ? 'clob_delegate' : 'clob_wallet';

  return {
    market_slug: input.market.slug ?? input.market.question,
    market_question: input.market.question,
    outcome: input.outcome,
    token_id: input.tokenId,
    amount_usdc: input.amountUsdc,
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
    protocol: 'polymarket_clob_v1',
  };
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
  if (status === 'submitted') return 'live_submitted';
  if (status === 'matched') return 'live_matched';
  if (status === 'cancelled') return 'live_cancelled';
  return status ?? 'live_submitted';
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
