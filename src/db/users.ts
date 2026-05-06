/**
 * User and account persistence helpers for Phase 2.
 */

import type { Env, TelegramMessage, TelegramUser } from '../types';

export interface TradingAccountStatusRow {
  status: string;
}

export async function upsertTelegramUser(
  env: Env,
  botId: string,
  message: TelegramMessage,
): Promise<void> {
  const telegramUser = message.from;
  if (!telegramUser) {
    return;
  }

  await env.DB.prepare(
    `INSERT INTO users (
      telegram_user_id,
      bot_id,
      telegram_chat_id,
      username,
      first_name,
      last_name,
      language,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id, bot_id) DO UPDATE SET
      telegram_chat_id = excluded.telegram_chat_id,
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      language = excluded.language,
      updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      String(telegramUser.id),
      botId,
      String(message.chat.id),
      telegramUser.username ?? null,
      telegramUser.first_name ?? null,
      telegramUser.last_name ?? null,
      normalizeLanguageCode(telegramUser),
    )
    .run();
}

export async function getTradingAccountStatus(
  env: Env,
  telegramUserId: string,
  botId: string,
): Promise<TradingAccountStatusRow | null> {
  return env.DB.prepare(
    'SELECT status FROM user_trading_accounts WHERE telegram_user_id = ? AND bot_id = ? LIMIT 1',
  )
    .bind(telegramUserId, botId)
    .first<TradingAccountStatusRow>();
}

function normalizeLanguageCode(user: TelegramUser): string {
  const raw = (user.language_code ?? 'zh').toLowerCase();
  if (raw.startsWith('zh')) {
    return 'zh';
  }
  if (raw.startsWith('en')) {
    return 'en';
  }
  return raw.slice(0, 8) || 'zh';
}
