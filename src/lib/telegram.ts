/**
 * Minimal Telegram API helpers for sending/editing messages during Phase 1.
 */

import type { Env } from '../types';

const TELEGRAM_HOST = 'https://api.telegram.org';

function getBotToken(env: Env, secretName: 'BOT_TOKEN_CRYPTO_ZH'): string {
  return env[secretName];
}

async function telegramApi(
  env: Env,
  secretName: 'BOT_TOKEN_CRYPTO_ZH',
  method: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${TELEGRAM_HOST}/bot${getBotToken(env, secretName)}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function sendTelegramMessage(
  env: Env,
  secretName: 'BOT_TOKEN_CRYPTO_ZH',
  chatId: number | string,
  text: string,
): Promise<void> {
  const response = await telegramApi(env, secretName, 'sendMessage', {
    chat_id: chatId,
    text,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${detail}`.trim());
  }
}

export async function editTelegramMessage(
  env: Env,
  secretName: 'BOT_TOKEN_CRYPTO_ZH',
  chatId: number | string,
  messageId: number,
  text: string,
): Promise<void> {
  const response = await telegramApi(env, secretName, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Telegram editMessageText failed: ${response.status} ${detail}`.trim());
  }
}

export async function answerCallbackQuery(
  env: Env,
  secretName: 'BOT_TOKEN_CRYPTO_ZH',
  callbackQueryId: string,
): Promise<void> {
  const response = await telegramApi(env, secretName, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Telegram answerCallbackQuery failed: ${response.status} ${detail}`.trim());
  }
}
