/**
 * Phase 7 order gateway: real API prep with live-or-simulated fallback.
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

  const requestBody = {
    market_slug: input.market.slug ?? input.market.question,
    market_question: input.market.question,
    outcome: input.outcome,
    token_id: input.tokenId,
    amount_usdc: input.amountUsdc,
    signer_address: input.account.signer_address,
    funder_address: input.account.funder_address,
    auth_mode: input.account.auth_mode,
    account_label: input.account.account_label,
  };

  const response = await fetch(`${liveConfig.baseUrl}/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${liveConfig.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  const payload = (await safeJson(response)) as { orderId?: string; status?: string; [key: string]: unknown };
  if (!response.ok) {
    throw new Error(`Live order API failed: ${response.status}`);
  }

  return {
    mode: 'live',
    status: payload.status === 'submitted' ? 'live_submitted' : (payload.status ?? 'live_submitted'),
    orderId: payload.orderId ?? `live-${Date.now()}`,
    detail: payload,
  };
}

function getLiveOrderConfig(env: Env): { baseUrl: string; apiKey: string } | null {
  const baseUrl = env.POLYMARKET_ORDER_API_BASE?.trim();
  const apiKey = env.POLYMARKET_ORDER_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    return null;
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
  };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
