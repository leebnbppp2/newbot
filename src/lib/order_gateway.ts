/**
 * Phase 12 order gateway: lifecycle + portfolio reads + local cache.
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
}

interface CacheRow {
  data_json: string;
  expires_at: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export async function executeBuyOrder(env: Env, input: ExecuteBuyOrderInput): Promise<ExecuteBuyOrderResult> {
  const liveConfig = getLiveOrderConfig(env);
  if (!liveConfig) {
    return {
      mode: 'simulated',
      status: 'simulated_submitted',
      orderId: `sim-${Date.now()}`,
      detail: {
        reason: 'missing_live_order_config',
        message: '还没接入真实下单 API，先按模拟单记录。',
      },
    };
  }

  const requestBody = buildLiveOrderPayload(input, liveConfig.builderTag);
  const headers = await buildSignedHeaders(liveConfig, requestBody, input.account.auth_mode);

  const response = await fetch(`${liveConfig.baseUrl}/orders`, {
    method: 'POST',
    headers,
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
    },
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
  const headers = await buildSignedHeaders(liveConfig, requestBody, authMode);

  const response = await fetch(`${liveConfig.baseUrl}/orders/${encodeURIComponent(orderId)}/cancel`, {
    method: 'POST',
    headers,
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

export async function fetchLiveOpenOrders(env: Env, telegramUserId: string, botId: string): Promise<RemoteOpenOrder[]> {
  const liveConfig = getLiveOrderConfig(env);
  const cacheKey = `portfolio:openorders:${botId}:${telegramUserId}`;
  if (!liveConfig) {
    return readCache<RemoteOpenOrder>(env, cacheKey);
  }
  const response = await fetch(`${liveConfig.baseUrl}/orders/open?bot_id=${encodeURIComponent(botId)}&telegram_user_id=${encodeURIComponent(telegramUserId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${liveConfig.apiKey}` },
  });
  if (!response.ok) {
    return readCache<RemoteOpenOrder>(env, cacheKey);
  }
  const payload = (await safeJson(response)) as { orders?: RemoteOpenOrder[] };
  const orders = payload.orders ?? [];
  await writeCache(env, cacheKey, orders);
  return orders;
}

export async function fetchRemotePositions(env: Env, telegramUserId: string, botId: string): Promise<RemotePosition[]> {
  const liveConfig = getLiveOrderConfig(env);
  const cacheKey = `portfolio:positions:${botId}:${telegramUserId}`;
  if (!liveConfig) {
    return readCache<RemotePosition>(env, cacheKey);
  }
  const response = await fetch(`${liveConfig.baseUrl}/portfolio/positions?bot_id=${encodeURIComponent(botId)}&telegram_user_id=${encodeURIComponent(telegramUserId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${liveConfig.apiKey}` },
  });
  if (!response.ok) {
    return readCache<RemotePosition>(env, cacheKey);
  }
  const payload = (await safeJson(response)) as { positions?: RemotePosition[] };
  const positions = payload.positions ?? [];
  await writeCache(env, cacheKey, positions);
  return positions;
}

export async function fetchRemoteFills(env: Env, telegramUserId: string, botId: string): Promise<RemoteFill[]> {
  const liveConfig = getLiveOrderConfig(env);
  const cacheKey = `portfolio:fills:${botId}:${telegramUserId}`;
  if (!liveConfig) {
    return readCache<RemoteFill>(env, cacheKey);
  }
  const response = await fetch(`${liveConfig.baseUrl}/portfolio/fills?bot_id=${encodeURIComponent(botId)}&telegram_user_id=${encodeURIComponent(telegramUserId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${liveConfig.apiKey}` },
  });
  if (!response.ok) {
    return readCache<RemoteFill>(env, cacheKey);
  }
  const payload = (await safeJson(response)) as { fills?: RemoteFill[] };
  const fills = payload.fills ?? [];
  await writeCache(env, cacheKey, fills);
  return fills;
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
  };
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

function buildLiveOrderPayload(input: ExecuteBuyOrderInput, builderTag: string | null): Record<string, unknown> {
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
    signature_type: signatureType,
    protocol: 'polymarket_clob_v1',
  };
}

async function buildSignedHeaders(config: LiveOrderConfig, payload: Record<string, unknown>, authMode: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
    'x-auth-mode': authMode,
    'x-signature-type': String(payload.signature_type ?? authMode),
  };

  if (config.signingSecret) {
    headers['x-order-signature'] = await signPayload(payload, config.signingSecret, authMode);
  }

  return headers;
}

async function signPayload(payload: Record<string, unknown>, signingSecret: string, authMode: string): Promise<string> {
  const encodedSecret = new TextEncoder().encode(`${authMode}:${signingSecret}`);
  const key = await crypto.subtle.importKey('raw', encodedSecret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const encodedPayload = new TextEncoder().encode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign('HMAC', key, encodedPayload);
  return toHex(signature);
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

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
