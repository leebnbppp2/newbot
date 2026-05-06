/**
 * Telegram webhook route with persona lookup and Phase 2 onboarding/account behavior.
 */

import { buildAccountReply, buildDefaultReply, buildStartReply } from '../agent/replies';
import { appendConversationTurn } from '../db/conversations';
import { getTradingAccountStatus, upsertTelegramUser } from '../db/users';
import { sendTelegramMessage } from '../lib/telegram';
import { PERSONAS } from '../agent/personas';
import type { Env, TelegramUpdate } from '../types';

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
  const text = payload.message?.text?.trim();
  const chatId = payload.message?.chat.id;
  const telegramUserId = payload.message?.from?.id;

  if (payload.message && typeof telegramUserId !== 'undefined') {
    await upsertTelegramUser(env, persona.id, payload.message);
  }

  if (typeof text === 'string' && typeof chatId !== 'undefined' && typeof telegramUserId !== 'undefined') {
    const conversationUserId = `${persona.id}:${telegramUserId}`;
    await appendConversationTurn(env, conversationUserId, 'user', text);

    const reply = await resolveReply(env, persona.id, String(telegramUserId), text);
    await appendConversationTurn(env, conversationUserId, 'assistant', reply.text);
    await sendTelegramMessage(env, persona.telegramBotTokenSecretName, chatId, reply);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
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

  return buildDefaultReply();
}
