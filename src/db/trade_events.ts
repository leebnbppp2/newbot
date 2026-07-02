/**
 * Trade event helpers for Phase 10 live order sync flow.
 */

import type { Env } from '../types';

export interface TradeEventRow {
  id?: number;
  telegram_user_id?: string;
  bot_id?: string;
  event_type: string;
  market_slug: string;
  outcome: string;
  token_id: string;
  amount_usdc: number;
  status: string;
  order_id: string | null;
  client_order_id?: string | null;
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
  clientOrderId?: string | null;
}

export async function createTradeEvent(env: Env, input: CreateTradeEventInput): Promise<number | null> {
  const result = await env.DB.prepare(
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
      client_order_id,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
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
      input.clientOrderId ?? null,
    )
    .run();

  const meta = (result as { meta?: { last_row_id?: number } }).meta;
  return typeof meta?.last_row_id === 'number' ? meta.last_row_id : null;
}

export async function listRecentTradeEvents(
  env: Env,
  telegramUserId: string,
  botId: string,
  limit = 5,
): Promise<TradeEventRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, telegram_user_id, bot_id, event_type, market_slug, outcome, token_id, amount_usdc, status, order_id, payload_json, created_at
       FROM trade_events
      WHERE telegram_user_id = ? AND bot_id = ?
      ORDER BY id DESC
      LIMIT ${Math.max(1, Math.min(limit, 20))}`,
  )
    .bind(telegramUserId, botId)
    .all<TradeEventRow>();

  return result.results ?? [];
}

export async function updateTradeEventStatus(
  env: Env,
  telegramUserId: string,
  botId: string,
  orderId: string,
  status: string,
  payloadJson: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE trade_events
        SET status = ?,
            payload_json = ?
      WHERE order_id = ?
        AND telegram_user_id = ?
        AND bot_id = ?`,
  )
    .bind(status, payloadJson, orderId, telegramUserId, botId)
    .run();
}

export async function getTradeEventByOrderId(
  env: Env,
  telegramUserId: string,
  botId: string,
  orderId: string,
): Promise<TradeEventRow | null> {
  return env.DB.prepare(
    `SELECT id, telegram_user_id, bot_id, event_type, market_slug, outcome, token_id, amount_usdc, status, order_id, payload_json, created_at
       FROM trade_events
      WHERE order_id = ?
        AND telegram_user_id = ?
        AND bot_id = ?
      LIMIT 1`,
  )
    .bind(orderId, telegramUserId, botId)
    .first<TradeEventRow>();
}

/** Sum today's (UTC) live BUY amount for a user — feeds the daily cap (Phase 44 G7). */
export async function sumTodaysLiveBuyUsdc(env: Env, telegramUserId: string, botId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_usdc), 0) AS total
       FROM trade_events
      WHERE telegram_user_id = ?
        AND bot_id = ?
        AND event_type = 'buy'
        AND status LIKE 'live_%'
        AND created_at >= date('now')`,
  )
    .bind(telegramUserId, botId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Live BUY rows for one token (amount + payload) so the sell view can reconstruct a cost basis. */
export async function listLiveBuysForToken(
  env: Env,
  telegramUserId: string,
  botId: string,
  tokenId: string,
): Promise<Array<Pick<TradeEventRow, 'amount_usdc' | 'payload_json'>>> {
  const result = await env.DB.prepare(
    `SELECT amount_usdc, payload_json
       FROM trade_events
      WHERE telegram_user_id = ? AND bot_id = ? AND token_id = ?
        AND event_type = 'buy' AND status LIKE 'live_%'
      ORDER BY id DESC
      LIMIT 500`,
  )
    .bind(telegramUserId, botId, tokenId)
    .all<Pick<TradeEventRow, 'amount_usdc' | 'payload_json'>>();
  return result.results ?? [];
}

export async function getTradeEventByClientOrderId(
  env: Env,
  telegramUserId: string,
  botId: string,
  clientOrderId: string,
): Promise<TradeEventRow | null> {
  return env.DB.prepare(
    `SELECT id, telegram_user_id, bot_id, event_type, market_slug, outcome, token_id, amount_usdc, status, order_id, client_order_id, payload_json, created_at
       FROM trade_events
      WHERE client_order_id = ?
        AND telegram_user_id = ?
        AND bot_id = ?
      LIMIT 1`,
  )
    .bind(clientOrderId, telegramUserId, botId)
    .first<TradeEventRow>();
}
