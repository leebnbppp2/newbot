/**
 * Phase 8 order gateway: signed live payload prep with live-or-simulated fallback.
 */

import type { MarketItem } from '../agent/replies';
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

interface LiveOrderConfig {
  baseUrl: string;
  apiKey: string;
  signingSecret: string | null;
  builderTag: string | null;
}

export async function executeBuyOrder(
  env: Env,
  input: ExecuteBuyOrderInput,
): Promise<ExecuteBuyOrderResult> {
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
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${liveConfig.apiKey}`,
  };

  if (liveConfig.signingSecret) {
    headers['x-order-signature'] = await signPayload(requestBody, liveConfig.signingSecret);
  }

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
    status: payload.status === 'submitted' ? 'live_submitted' : (payload.status ?? 'live_submitted'),
    orderId: payload.orderId ?? String(requestBody.client_order_id),
    detail: {
      ...payload,
      request: requestBody,
      signed: Boolean(liveConfig.signingSecret),
    },
  };
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

function buildLiveOrderPayload(input: ExecuteBuyOrderInput, builderTag: string | null): Record<string, unknown> {
  const timestampMs = Date.now();
  const clientOrderId = `nbo-${timestampMs}-${crypto.randomUUID().slice(0, 8)}`;
  const nonce = crypto.randomUUID().replaceAll('-', '');

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
    signature_type: input.account.auth_mode === 'managed_signer' ? 'delegated_api' : 'wallet_signature',
  };
}

async function signPayload(payload: Record<string, unknown>, signingSecret: string): Promise<string> {
  const encodedSecret = new TextEncoder().encode(signingSecret);
  const key = await crypto.subtle.importKey(
    'raw',
    encodedSecret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const encodedPayload = new TextEncoder().encode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign('HMAC', key, encodedPayload);
  return toHex(signature);
}

function toHex(input: ArrayBuffer): string {
  return Array.from(new Uint8Array(input))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
