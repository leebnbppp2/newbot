/**
 * Telegram webhook route with persona lookup and Phase 3 onboarding/market behavior.
 */

import {
  buildAccountReply,
  buildDefaultReply,
  buildGettingStartedReply,
  buildStartReply,
} from '../agent/replies';
import { appendConversationTurn } from '../db/conversations';
import { getTradingAccountStatus, upsertTelegramUser } from '../db/users';
import { getMarketOverviewReply } from '../lib/markets';
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage } from '../lib/telegram';
import { PERSONAS } from '../agent/personas';
import type { Env, TelegramCallbackQuery, TelegramUpdate } from '../types';

const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export async function handleTelegramWebhook(request: Request, env: Env, personaId: string): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;
  const providedSecret = request.headers.get(TELEGRAM_SECRET_HEADER);
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  const persona = PERSONAS[personaId];
  if (!persona) {
    return new Response('Persona not found', { status: 404 });
  }

  const payload = (await request.json()) as TelegramUpdate;

  try {
    if (payload.callback_query) {
      await handleCallbackQuery(env, persona.id, persona.telegramBotTokenSecretName, payload.callback_query);
    } else if (payload.message?.text?.trim() && typeof payload.message.chat.id !== 'undefined' && typeof payload.message.from?.id !== 'undefined') {
      await upsertTelegramUser(env, persona.id, payload.message);

      const text = payload.message.text.trim();
      const telegramUserId = String(payload.message.from.id);
      const conversationUserId = `${persona.id}:${telegramUserId}`;
      await appendConversationTurn(env, conversationUserId, 'user', text);

      const reply = await resolveReply(env, persona.id, telegramUserId, text);
      await appendConversationTurn(env, conversationUserId, 'assistant', reply.text);
      await sendTelegramMessage(env, persona.telegramBotTokenSecretName, payload.message.chat.id, reply);
    }
  } catch (error) {
    console.error('Telegram webhook processing failed', error);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleCallbackQuery(
  env: Env,
  botId: string,
  secretName: 'BOT_TOKEN_CRYPTO_ZH',
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const data = callbackQuery.data?.trim();
  const chatId = callbackQuery.message?.chat.id;
  const messageId = callbackQuery.message?.message_id;
  const telegramUserId = String(callbackQuery.from.id);

  if (!data || typeof chatId === 'undefined' || typeof messageId === 'undefined') {
    return;
  }

  const conversationUserId = `${botId}:${telegramUserId}`;
  await appendConversationTurn(env, conversationUserId, 'user', `[callback] ${data}`);

  const reply = await resolveCallbackReply(env, botId, telegramUserId, data);
  await appendConversationTurn(env, conversationUserId, 'assistant', reply.text);

  await answerCallbackQuery(env, secretName, callbackQuery.id);
  await editTelegramMessage(env, secretName, chatId, messageId, reply);
}

async function resolveReply(
  env: Env,
  botId: string,
  telegramUserId: string,
  text: string,
) {
  const normalized = text.toLowerCase();

  if (normalized === '/start' || normalized === '/menu') {
    return buildStartReply();
  }

  if (normalized === '/account' || normalized === '/status') {
    const account = await getTradingAccountStatus(env, telegramUserId, botId);
    return buildAccountReply(Boolean(account));
  }

  if (normalized === '/market' || normalized === '/markets') {
    return getMarketOverviewReply(env);
  }

  return buildDefaultReply();
}

async function resolveCallbackReply(
  env: Env,
  botId: string,
  telegramUserId: string,
  data: string,
) {
  switch (data) {
    case 'market_overview':
      return getMarketOverviewReply(env);
    case 'account_status': {
      const account = await getTradingAccountStatus(env, telegramUserId, botId);
      return buildAccountReply(Boolean(account));
    }
    case 'getting_started':
      return buildGettingStartedReply();
    default:
      return buildDefaultReply();
  }
}
