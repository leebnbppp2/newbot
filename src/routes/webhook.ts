/**
 * Telegram webhook route with persona lookup and Phase 17 onboarding/market behavior.
 */

import {
  buildAccountReply,
  buildBuyConfirmReply,
  buildDefaultReply,
  buildFillsReply,
  buildGettingStartedReply,
  buildLinkAccountReply,
  buildOpenOrdersReply,
  buildOrdersReply,
  buildPositionsReply,
  buildRemotePositionsReply,
  buildStartReply,
  buildSubmittedBuyReply,
  buildTradeEntryReply,
} from '../agent/replies';
import { createAccountLinkSession } from '../db/account_sessions';
import { createBuilderAttribution } from '../db/builder_attributions';
import { appendConversationTurn } from '../db/conversations';
import {
  createTradeEvent,
  getTradeEventByOrderId,
  listRecentTradeEvents,
  updateTradeEventStatus,
} from '../db/trade_events';
import { getTradingAccount, getTradingAccountStatus, upsertTelegramUser } from '../db/users';
import { findBestMarket, getMarketDetailReply, getMarketOverviewReply, searchMarketsReply } from '../lib/markets';
import {
  cancelLiveOrder,
  enrichTradeEventsWithLiveStatus,
  executeBuyOrder,
  fetchLiveOpenOrders,
  fetchRemoteFills,
  fetchRemotePositions,
} from '../lib/order_gateway';
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

async function resolveReply(env: Env, botId: string, telegramUserId: string, text: string) {
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

  if (normalized.startsWith('/orders')) {
    const events = await listRecentTradeEvents(env, telegramUserId, botId);
    const enrichedEvents = await enrichTradeEventsWithLiveStatus(env, events);
    await persistEnrichedTradeEvents(env, telegramUserId, botId, events, enrichedEvents);
    return buildOrdersReply(enrichedEvents);
  }

  if (normalized.startsWith('/openorders')) {
    const page = parseCommandPage(text);
    const orders = await fetchLiveOpenOrders(env, telegramUserId, botId);
    return buildOpenOrdersReply(orders, page);
  }

  if (normalized.startsWith('/positions')) {
    const page = parseCommandPage(text);
    const remotePositions = await fetchRemotePositions(env, telegramUserId, botId);
    if (remotePositions.length > 0) {
      return buildRemotePositionsReply(remotePositions, page);
    }
    const events = await listRecentTradeEvents(env, telegramUserId, botId);
    return buildPositionsReply(events);
  }

  if (normalized.startsWith('/fills')) {
    const page = parseCommandPage(text);
    const fills = await fetchRemoteFills(env, telegramUserId, botId);
    return buildFillsReply(fills, page);
  }

  if (normalized.startsWith('/cancel ')) {
    const orderId = normalized.replace(/^\/cancel\s+/, '').trim();
    if (orderId.length > 0) {
      return cancelOrderReply(env, telegramUserId, botId, orderId);
    }
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

async function resolveCallbackReply(env: Env, botId: string, telegramUserId: string, data: string) {
  if (data.startsWith('openorders_page:')) {
    const page = parseCallbackPage(data);
    const orders = await fetchLiveOpenOrders(env, telegramUserId, botId);
    return buildOpenOrdersReply(orders, page);
  }

  if (data.startsWith('positions_page:')) {
    const page = parseCallbackPage(data);
    const positions = await fetchRemotePositions(env, telegramUserId, botId);
    if (positions.length > 0) {
      return buildRemotePositionsReply(positions, page);
    }
    const events = await listRecentTradeEvents(env, telegramUserId, botId);
    return buildPositionsReply(events);
  }

  if (data.startsWith('fills_page:')) {
    const page = parseCallbackPage(data);
    const fills = await fetchRemoteFills(env, telegramUserId, botId);
    return buildFillsReply(fills, page);
  }

  if (data.startsWith('cancel_open_order:')) {
    const { orderId, page } = parseCancelOpenOrderCallback(data);
    return cancelOpenOrderCallbackReply(env, telegramUserId, botId, orderId, page);
  }

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

async function cancelOrderReply(env: Env, telegramUserId: string, botId: string, orderId: string) {
  const account = await getTradingAccount(env, telegramUserId, botId);
  if (!account) {
    return buildTradeEntryReply(false);
  }

  const existing = await getTradeEventByOrderId(env, telegramUserId, botId, orderId);
  if (!existing || !existing.order_id) {
    return {
      text: `我没找到订单号 ${orderId} 对应的记录。你可以先发 /orders 看看当前有哪些单。`,
    };
  }

  const cancelled = await cancelLiveOrder(env, existing.order_id, account.auth_mode);
  if (!cancelled) {
    return {
      text: '当前还没配置真实下单 API，所以这笔 live 订单暂时没法撤。',
    };
  }

  await updateTradeEventStatus(
    env,
    telegramUserId,
    botId,
    cancelled.orderId,
    cancelled.status,
    JSON.stringify({
      previous_payload: safeParseJson(existing.payload_json),
      cancel_result: cancelled.detail,
    }),
  );

  return {
    text: `订单 ${cancelled.orderId} 已取消，当前状态：${cancelled.status}。你现在可以再发 /orders 看最新列表。`,
  };
}

async function cancelOpenOrderCallbackReply(
  env: Env,
  telegramUserId: string,
  botId: string,
  orderId: string,
  page: number,
) {
  const account = await getTradingAccount(env, telegramUserId, botId);
  if (!account) {
    return buildTradeEntryReply(false);
  }

  if (!orderId) {
    return { text: '这个撤单按钮没带订单号，你可以重新打开 /openorders 再试一次。' };
  }

  const cancelled = await cancelLiveOrder(env, orderId, account.auth_mode);
  if (!cancelled) {
    return {
      text: '当前还没配置真实下单 API，所以这笔未成交单暂时还不能直接撤。',
    };
  }

  const existing = await getTradeEventByOrderId(env, telegramUserId, botId, cancelled.orderId);
  if (existing?.order_id) {
    await updateTradeEventStatus(
      env,
      telegramUserId,
      botId,
      cancelled.orderId,
      cancelled.status,
      JSON.stringify({
        previous_payload: safeParseJson(existing.payload_json),
        cancel_result: cancelled.detail,
      }),
    );
  }

  const orders = await fetchLiveOpenOrders(env, telegramUserId, botId);
  return buildOpenOrdersReply(orders, page);
}

async function persistEnrichedTradeEvents(
  env: Env,
  telegramUserId: string,
  botId: string,
  originalEvents: Awaited<ReturnType<typeof listRecentTradeEvents>>,
  enrichedEvents: Awaited<ReturnType<typeof enrichTradeEventsWithLiveStatus>>,
) {
  for (const [index, enriched] of enrichedEvents.entries()) {
    const original = originalEvents[index];
    if (!original?.order_id || !enriched.order_id) {
      continue;
    }
    if (original.status === enriched.status && original.payload_json === enriched.payload_json) {
      continue;
    }
    await updateTradeEventStatus(env, telegramUserId, botId, enriched.order_id, enriched.status, enriched.payload_json);
  }
}

async function resolveBuyReply(env: Env, botId: string, telegramUserId: string, rawText: string) {
  const accountStatus = await getTradingAccountStatus(env, telegramUserId, botId);
  if (!accountStatus) {
    return buildTradeEntryReply(false);
  }

  const account = await getTradingAccount(env, telegramUserId, botId);
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
  const execution = await executeBuyOrder(env, {
    market,
    outcome: selectedOutcome?.name ?? normalizedOutcome,
    tokenId: selectedOutcome?.tokenId ?? 'simulated-token',
    amountUsdc,
    account,
  });

  const tradeEventId = await createTradeEvent(env, {
    telegramUserId,
    botId,
    eventType: 'buy',
    marketSlug: market.slug ?? market.question,
    outcome: selectedOutcome?.name ?? normalizedOutcome,
    tokenId: selectedOutcome?.tokenId ?? 'simulated-token',
    amountUsdc,
    status: execution.status,
    orderId: execution.orderId,
    payloadJson: JSON.stringify({
      marketQuestion: market.question,
      outcome: selectedOutcome?.name ?? normalizedOutcome,
      price: selectedOutcome?.price ?? null,
      mode: execution.mode,
      detail: execution.detail,
      builder_attribution: execution.builderAttribution,
    }),
  });

  if (execution.mode === 'live' && execution.builderAttribution) {
    await createBuilderAttribution(env, {
      telegramUserId,
      botId,
      tradeEventId,
      builderApiKeyHint: execution.builderAttribution.builderApiKeyHint,
      orderId: execution.orderId,
      amountUsdc,
    });
  }

  return buildSubmittedBuyReply(
    market,
    selectedOutcome?.name ?? normalizedOutcome,
    amountUsdc,
    execution.orderId,
    execution.mode,
    execution.status,
  );
}

function normalizeOutcome(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'yes') return 'Yes';
  if (normalized === 'no') return 'No';
  return null;
}

function parseCommandPage(text: string): number {
  const parts = text.trim().split(/\s+/);
  const last = (parts.at(-1) ?? '').trim().toLowerCase();
  const page = Number(last);
  if (Number.isFinite(page) && page >= 1) {
    return Math.floor(page);
  }
  const tokenMatch = last.match(/^(?:p|page:)(\d+)$/i);
  if (tokenMatch) {
    return Number(tokenMatch[1]);
  }
  return 1;
}

function parseCallbackPage(data: string): number {
  const pageText = data.split(':').at(-1) ?? '1';
  const page = Number(pageText);
  if (!Number.isFinite(page) || page < 1) {
    return 1;
  }
  return Math.floor(page);
}

function parseCancelOpenOrderCallback(data: string): { orderId: string; page: number } {
  const payload = data.replace('cancel_open_order:', '').trim();
  const parts = payload.split(':');
  if (parts.length >= 2) {
    const page = parseCallbackPage(`page:${parts.at(-1) ?? '1'}`);
    return {
      orderId: parts.slice(0, -1).join(':'),
      page,
    };
  }
  return { orderId: payload, page: 1 };
}

function safeParseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
