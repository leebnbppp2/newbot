/**
 * Builder attribution persistence helpers for Phase 16.
 */

import type { Env } from '../types';

export interface BuilderAttributionRow {
  id?: number;
  telegram_user_id: string;
  bot_id: string;
  trade_event_id: number | null;
  builder_api_key_hint: string | null;
  order_id: string | null;
  amount_usdc: number | null;
  created_at?: string;
}

export interface CreateBuilderAttributionInput {
  telegramUserId: string;
  botId: string;
  tradeEventId: number | null;
  builderApiKeyHint: string | null;
  orderId: string | null;
  amountUsdc: number | null;
}

export async function createBuilderAttribution(env: Env, input: CreateBuilderAttributionInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO builder_attributions (
      telegram_user_id,
      bot_id,
      trade_event_id,
      builder_api_key_hint,
      order_id,
      amount_usdc,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  )
    .bind(
      input.telegramUserId,
      input.botId,
      input.tradeEventId,
      input.builderApiKeyHint,
      input.orderId,
      input.amountUsdc,
    )
    .run();
}
