/**
 * Trade event helpers for Phase 6 simulated order flow.
 */

import type { Env } from '../types';

export interface TradeEventRow {
  id?: number;
  event_type: string;
  market_slug: string;
  outcome: string;
  token_id: string;
  amount_usdc: number;
  status: string;
  order_id: string | null;
  payload_json: string | null;
  created_at?: string;
}

export interface CreateTradeEventInput {
  telegramUserId: string;
  botId: string;
  eventType: string;
  marketSlug: string;
  outcome: string;
  tokenId: string;
  amountUsdc: number;
  status: string;
  orderId: string | null;
  payloadJson: string | null;
}

export async function createTradeEvent(env: Env, input: CreateTradeEventInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO trade_events (
      telegram_user_id,
      bot_id,
      event_type,
      market_slug,
      outcome,
      token_id,
      amount_usdc,
      status,
      order_id,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  )
    .bind(
      input.telegramUserId,
      input.botId,
      input.eventType,
      input.marketSlug,
      input.outcome,
      input.tokenId,
      input.amountUsdc,
      input.status,
      input.orderId,
      input.payloadJson,
    )
    .run();
}

export async function listRecentTradeEvents(
  env: Env,
  telegramUserId: string,
  botId: string,
  limit = 5,
): Promise<TradeEventRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, event_type, market_slug, outcome, token_id, amount_usdc, status, order_id, payload_json, created_at
       FROM trade_events
      WHERE telegram_user_id = ? AND bot_id = ?
      ORDER BY id DESC
      LIMIT ${Math.max(1, Math.min(limit, 20))}`,
  )
    .bind(telegramUserId, botId)
    .all<TradeEventRow>();

  return result.results ?? [];
}
