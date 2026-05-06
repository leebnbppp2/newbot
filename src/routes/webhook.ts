/**
 * Telegram webhook route with persona lookup and Phase 6 onboarding/market behavior.
 */

import {
  buildAccountReply,
  buildBuyConfirmReply,
  buildDefaultReply,
  buildGettingStartedReply,
  buildLinkAccountReply,
  buildOrdersReply,
  buildPositionsReply,
  buildStartReply,
  buildSubmittedBuyReply,
  buildTradeEntryReply,
} from '../agent/replies';
import { createAccountLinkSession } from '../db/account_sessions';
import { appendConversationTurn } from '../db/conversations';
import { createTradeEvent, listRecentTradeEvents } from '../db/trade_events';
import { getTradingAccount, getTradingAccountStatus, upsertTelegramUser } from '../db/users';
import { findBestMarket, getMarketDetailReply, getMarketOverviewReply, searchMarketsReply } from '../lib/markets';
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
    const account = await getTradingAccount(env, telegramUserId, botId);
    return buildAccountReply(account);
  }

  if (normalized === '/link') {
    return createLinkAccountReply(env, telegramUserId, botId);
  }

  if (normalized === '/market' || normalized === '/markets') {
    return getMarketOverviewReply(env);
  }

  if (normalized === '/orders') {
    const events = await listRecentTradeEvents(env, telegramUserId, botId);
    return buildOrdersReply(events);
  }

  if (normalized === '/positions') {
    const events = await listRecentTradeEvents(env, telegramUserId, botId);
    return buildPositionsReply(events);
  }

  if (normalized.startsWith('/find ') || normalized.startsWith('/search ')) {
    const query = normalized.replace(/^\/(find|search)\s+/, '').trim();
    if (query.length > 0) {
      return searchMarketsReply(env, query);
    }
  }

  if (normalized.startsWith('/detail ')) {
    const query = normalized.replace(/^\/detail\s+/, '').trim();
    if (query.length > 0) {
      return getMarketDetailReply(env, query);
    }
  }

  if (normalized.startsWith('/buy ')) {
    return resolveBuyReply(env, botId, telegramUserId, text.trim());
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
      const account = await getTradingAccount(env, telegramUserId, botId);
      return buildAccountReply(account);
    }
    case 'getting_started':
      return buildGettingStartedReply();
    case 'start_link_account':
      return createLinkAccountReply(env, telegramUserId, botId);
    case 'trade_entry': {
      const account = await getTradingAccountStatus(env, telegramUserId, botId);
      return buildTradeEntryReply(Boolean(account));
    }
    default:
      return buildDefaultReply();
  }
}

async function createLinkAccountReply(env: Env, telegramUserId: string, botId: string) {
  const session = await createAccountLinkSession(env, telegramUserId, botId);
  return buildLinkAccountReply(session.token, session.expiresAt);
}

async function resolveBuyReply(env: Env, botId: string, telegramUserId: string, rawText: string) {
  const account = await getTradingAccountStatus(env, telegramUserId, botId);
  if (!account) {
    return buildTradeEntryReply(false);
  }

  const argumentText = rawText.replace(/^\/buy\s+/i, '').trim();
  const segments = argumentText.split(/\s+/).filter(Boolean);

  if (segments.length === 1) {
    return buildBuyConfirmReply(segments[0] ?? argumentText);
  }

  if (segments.length < 3) {
    return buildBuyConfirmReply(argumentText);
  }

  const amountText = segments.at(-1) ?? '';
  const outcomeRaw = segments.at(-2) ?? '';
  const marketQuery = segments.slice(0, -2).join(' ');
  const amountUsdc = Number(amountText);
  const normalizedOutcome = normalizeOutcome(outcomeRaw);

  if (!marketQuery || !Number.isFinite(amountUsdc) || amountUsdc <= 0 || !normalizedOutcome) {
    return buildBuyConfirmReply(argumentText);
  }

  const market = await findBestMarket(env, marketQuery);
  if (!market) {
    return getMarketDetailReply(env, marketQuery);
  }

  const selectedOutcome = market.outcomes?.find((outcome) => outcome.name.toLowerCase() === normalizedOutcome.toLowerCase());
  const orderId = `sim-${Date.now()}`;
  await createTradeEvent(env, {
    telegramUserId,
    botId,
    eventType: 'buy',
    marketSlug: market.slug ?? market.question,
    outcome: selectedOutcome?.name ?? normalizedOutcome,
    tokenId: selectedOutcome?.tokenId ?? 'simulated-token',
    amountUsdc,
    status: 'simulated_submitted',
    orderId,
    payloadJson: JSON.stringify({
      marketQuestion: market.question,
      outcome: selectedOutcome?.name ?? normalizedOutcome,
      price: selectedOutcome?.price ?? null,
      simulated: true,
    }),
  });

  return buildSubmittedBuyReply(market, selectedOutcome?.name ?? normalizedOutcome, amountUsdc, orderId);
}

function normalizeOutcome(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'yes') {
    return 'Yes';
  }
  if (normalized === 'no') {
    return 'No';
  }
  return null;
}
