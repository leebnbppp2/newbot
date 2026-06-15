/**
 * Telegram webhook route with persona lookup and Phase 17 onboarding/market behavior.
 */

import {
  buildAccountReply,
  buildBuyConfirmReply,
  buildBuyErrorReply,
  buildDefaultReply,
  buildFillsReply,
  buildGettingStartedReply,
  buildHealthReply,
  buildOperatorOnlyReply,
  buildLinkAccountReply,
  buildOpenOrdersReply,
  buildOrdersReply,
  buildPositionsReply,
  buildRemotePositionsReply,
  buildRunbookReply,
  buildSmokeMetricsReply,
  buildStartReply,
  buildSubmittedBuyReply,
  buildTradeEntryReply,
} from '../agent/replies';
import { createAccountLinkSession } from '../db/account_sessions';
import { createBuilderAttribution } from '../db/builder_attributions';
import {
  getLatestSmokeReportRun,
  getLatestSmokeReportRunForEnvironment,
  getLatestSmokeReportRunsByEnvironment,
  getSmokeReportMetrics,
} from '../db/cron_runs';
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
  getOrderGatewayReadiness,
  LiveOrderError,
} from '../lib/order_gateway';
import type { ExecuteBuyOrderResult } from '../lib/order_gateway';
import { answerCallbackQuery, editTelegramMessage, sendTelegramMessage } from '../lib/telegram';
import type { CallbackToast } from '../lib/telegram';
import { PERSONAS } from '../agent/personas';
import type { Env, TelegramCallbackQuery, TelegramUpdate } from '../types';

interface CallbackReplyResult {
  reply: Awaited<ReturnType<typeof buildDefaultReply>>;
  callbackToast?: CallbackToast;
}

const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

function isTelegramOperator(env: Env, telegramUserId: string): boolean {
  return isIdInOptionalCsvAllowlist(env.NEWBOT_OPERATOR_TELEGRAM_IDS, telegramUserId);
}

function isLiveTradingAllowed(env: Env, telegramUserId: string): boolean {
  return isIdInOptionalCsvAllowlist(env.NEWBOT_LIVE_TRADING_TELEGRAM_IDS, telegramUserId);
}

function isIdInOptionalCsvAllowlist(raw: string | undefined, id: string): boolean {
  const value = raw?.trim();
  if (!value) {
    return true;
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(id);
}

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

  const callbackResult = await resolveCallbackReply(env, botId, telegramUserId, data);
  await appendConversationTurn(env, conversationUserId, 'assistant', callbackResult.reply.text);

  await answerCallbackQuery(env, secretName, callbackQuery.id, callbackResult.callbackToast);
  await editTelegramMessage(env, secretName, chatId, messageId, callbackResult.reply);
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

  if (normalized === '/health' || normalized === '/ops' || normalized === '/readiness') {
    if (!isTelegramOperator(env, telegramUserId)) {
      return buildOperatorOnlyReply();
    }
    return buildHealthReply(getOrderGatewayReadiness(env));
  }

  if (normalized === '/metrics' || normalized === '/smoke-metrics') {
    if (!isTelegramOperator(env, telegramUserId)) {
      return buildOperatorOnlyReply();
    }
    return buildSmokeMetricsReply(await getSmokeReportMetrics(env));
  }

  if (normalized.startsWith('/runbook') || normalized.startsWith('/rollout')) {
    if (!isTelegramOperator(env, telegramUserId)) {
      return buildOperatorOnlyReply();
    }
    const smokeEnvironment = parseRunbookEnvironment(text);
    if (smokeEnvironment) {
      const environmentSmokeReport = await getLatestSmokeReportRunForEnvironment(env, smokeEnvironment);
      return buildRunbookReply(
        getOrderGatewayReadiness(env),
        environmentSmokeReport,
        environmentSmokeReport ? [environmentSmokeReport] : [],
        smokeEnvironment,
      );
    }
    return buildRunbookReply(
      getOrderGatewayReadiness(env),
      await getLatestSmokeReportRun(env),
      await getLatestSmokeReportRunsByEnvironment(env),
    );
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
    const result = await fetchLiveOpenOrders(env, telegramUserId, botId);
    return buildOpenOrdersReply(result.items, page, 2, result.source, result.warning);
  }

  if (normalized.startsWith('/positions')) {
    const page = parseCommandPage(text);
    const positionsResult = await fetchRemotePositions(env, telegramUserId, botId);
    if (positionsResult.items.length > 0) {
      return buildRemotePositionsReply(positionsResult.items, page, 2, positionsResult.source, positionsResult.warning);
    }
    const events = await listRecentTradeEvents(env, telegramUserId, botId);
    return buildPositionsReply(events);
  }

  if (normalized.startsWith('/fills')) {
    const page = parseCommandPage(text);
    const fillsResult = await fetchRemoteFills(env, telegramUserId, botId);
    return buildFillsReply(fillsResult.items, page, 2, fillsResult.source, fillsResult.warning);
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

async function resolveCallbackReply(env: Env, botId: string, telegramUserId: string, data: string): Promise<CallbackReplyResult> {
  if (data.startsWith('openorders_page:')) {
    const page = parseCallbackPage(data);
    const result = await fetchLiveOpenOrders(env, telegramUserId, botId);
    return {
      reply: buildOpenOrdersReply(result.items, page, 2, result.source, result.warning),
      callbackToast: buildPaginationToast('未成交订单', page, result.source, result.warning),
    };
  }

  if (data.startsWith('positions_page:')) {
    const page = parseCallbackPage(data);
    const positionsResult = await fetchRemotePositions(env, telegramUserId, botId);
    if (positionsResult.items.length > 0) {
      return {
        reply: buildRemotePositionsReply(positionsResult.items, page, 2, positionsResult.source, positionsResult.warning),
        callbackToast: buildPaginationToast('持仓', page, positionsResult.source, positionsResult.warning),
      };
    }
    const events = await listRecentTradeEvents(env, telegramUserId, botId);
    return {
      reply: buildPositionsReply(events),
      callbackToast: { text: `持仓第 ${page} 页`, showAlert: false },
    };
  }

  if (data.startsWith('fills_page:')) {
    const page = parseCallbackPage(data);
    const fillsResult = await fetchRemoteFills(env, telegramUserId, botId);
    return {
      reply: buildFillsReply(fillsResult.items, page, 2, fillsResult.source, fillsResult.warning),
      callbackToast: buildPaginationToast('成交记录', page, fillsResult.source, fillsResult.warning),
    };
  }

  if (data.startsWith('cancel_open_order:')) {
    const { orderId, page } = parseCancelOpenOrderCallback(data);
    return cancelOpenOrderCallbackReply(env, telegramUserId, botId, orderId, page);
  }

  if (data.startsWith('ops_runbook_env:')) {
    if (!isTelegramOperator(env, telegramUserId)) {
      return {
        reply: buildOperatorOnlyReply(),
        callbackToast: { text: '只有配置过的操作者可以看灰度 runbook', showAlert: true },
      };
    }

    const smokeEnvironment = parseRunbookCallbackEnvironment(data);
    if (!smokeEnvironment) {
      return {
        reply: buildRunbookReply(
          getOrderGatewayReadiness(env),
          await getLatestSmokeReportRun(env),
          await getLatestSmokeReportRunsByEnvironment(env),
        ),
        callbackToast: { text: '灰度 runbook 已刷新', showAlert: false },
      };
    }

    const environmentSmokeReport = await getLatestSmokeReportRunForEnvironment(env, smokeEnvironment);
    return {
      reply: buildRunbookReply(
        getOrderGatewayReadiness(env),
        environmentSmokeReport,
        environmentSmokeReport ? [environmentSmokeReport] : [],
        smokeEnvironment,
      ),
      callbackToast: { text: `${smokeEnvironment} runbook 已刷新`, showAlert: false },
    };
  }

  switch (data) {
    case 'market_overview':
      return { reply: await getMarketOverviewReply(env), callbackToast: { text: '已切到市场概览', showAlert: false } };
    case 'account_status': {
      const account = await getTradingAccount(env, telegramUserId, botId);
      return { reply: buildAccountReply(account), callbackToast: { text: '已刷新账户状态', showAlert: false } };
    }
    case 'ops_health':
      if (!isTelegramOperator(env, telegramUserId)) {
        return {
          reply: buildOperatorOnlyReply(),
          callbackToast: { text: '只有配置过的操作者可以看系统状态', showAlert: true },
        };
      }
      return { reply: buildHealthReply(getOrderGatewayReadiness(env)), callbackToast: { text: '系统状态已刷新', showAlert: false } };
    case 'ops_smoke_metrics':
      if (!isTelegramOperator(env, telegramUserId)) {
        return {
          reply: buildOperatorOnlyReply(),
          callbackToast: { text: '只有配置过的操作者可以看 smoke metrics', showAlert: true },
        };
      }
      return {
        reply: buildSmokeMetricsReply(await getSmokeReportMetrics(env)),
        callbackToast: { text: 'Smoke metrics 已刷新', showAlert: false },
      };
    case 'ops_runbook':
      if (!isTelegramOperator(env, telegramUserId)) {
        return {
          reply: buildOperatorOnlyReply(),
          callbackToast: { text: '只有配置过的操作者可以看灰度 runbook', showAlert: true },
        };
      }
      return {
        reply: buildRunbookReply(
          getOrderGatewayReadiness(env),
          await getLatestSmokeReportRun(env),
          await getLatestSmokeReportRunsByEnvironment(env),
        ),
        callbackToast: { text: '灰度 runbook 已刷新', showAlert: false },
      };
    case 'getting_started':
      return { reply: buildGettingStartedReply(), callbackToast: { text: '开始说明在这里', showAlert: false } };
    case 'start_link_account':
      return { reply: await createLinkAccountReply(env, telegramUserId, botId), callbackToast: { text: '绑定入口已经准备好', showAlert: false } };
    case 'trade_entry': {
      const account = await getTradingAccountStatus(env, telegramUserId, botId);
      return {
        reply: buildTradeEntryReply(Boolean(account)),
        callbackToast: { text: account ? '可以直接准备下单了' : '先完成账户绑定', showAlert: false },
      };
    }
    default:
      return { reply: buildDefaultReply(), callbackToast: { text: '我先帮你切回主菜单', showAlert: false } };
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

  let cancelled: Awaited<ReturnType<typeof cancelLiveOrder>>;
  try {
    cancelled = await cancelLiveOrder(env, existing.order_id, account.auth_mode, botId, telegramUserId);
  } catch (error) {
    if (error instanceof LiveOrderError) {
      return { text: `这笔订单撤单没成功：${error.userMessage}` };
    }
    throw error;
  }
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
): Promise<CallbackReplyResult> {
  const account = await getTradingAccount(env, telegramUserId, botId);
  if (!account) {
    return {
      reply: buildTradeEntryReply(false),
      callbackToast: { text: '先完成账户绑定', showAlert: false },
    };
  }

  if (!orderId) {
    return {
      reply: { text: '这个撤单按钮没带订单号，你可以重新打开 /openorders 再试一次。' },
      callbackToast: { text: '这次没带上订单号', showAlert: false },
    };
  }

  let cancelled: Awaited<ReturnType<typeof cancelLiveOrder>>;
  try {
    cancelled = await cancelLiveOrder(env, orderId, account.auth_mode, botId, telegramUserId);
  } catch (error) {
    if (error instanceof LiveOrderError) {
      return {
        reply: { text: `这笔未成交单撤单没成功：${error.userMessage}` },
        callbackToast: { text: '撤单没成功', showAlert: false },
      };
    }
    throw error;
  }
  if (!cancelled) {
    return {
      reply: {
        text: '当前还没配置真实下单 API，所以这笔未成交单暂时还不能直接撤。',
      },
      callbackToast: { text: '还没接真实撤单接口', showAlert: false },
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

  const ordersResult = await fetchLiveOpenOrders(env, telegramUserId, botId);
  return {
    reply: buildOpenOrdersReply(ordersResult.items, page, 2, ordersResult.source, ordersResult.warning),
    callbackToast: {
      text: ordersResult.warning ?? `订单 ${cancelled.orderId} 已撤掉`,
      showAlert: false,
    },
  };
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
  const resolvedOutcome = selectedOutcome?.name ?? normalizedOutcome;
  const resolvedTokenId = selectedOutcome?.tokenId ?? 'simulated-token';
  const liveTradingAllowed = isLiveTradingAllowed(env, telegramUserId);

  let execution: ExecuteBuyOrderResult;
  if (liveTradingAllowed) {
    try {
      execution = await executeBuyOrder(env, {
        market,
        outcome: resolvedOutcome,
        tokenId: resolvedTokenId,
        amountUsdc,
        account,
        botId,
        telegramUserId,
        ...(typeof selectedOutcome?.price === 'number' ? { price: selectedOutcome.price } : {}),
      });
    } catch (error) {
      if (error instanceof LiveOrderError) {
        // 真实下单被拒/资金不足/签名失败：落一条审计记录，并给用户精准中文文案。
        await recordFailedLiveOrder(env, {
          telegramUserId,
          botId,
          market,
          outcome: resolvedOutcome,
          tokenId: resolvedTokenId,
          amountUsdc,
          error,
        });
        return buildBuyErrorReply(market, resolvedOutcome, amountUsdc, error);
      }
      throw error;
    }
  } else {
    execution = {
      mode: 'simulated',
      status: 'simulated_submitted',
      orderId: `sim-${Date.now()}`,
      detail: {
        reason: 'live_trading_not_allowlisted',
        message: 'live 交易还没对你开放，先按模拟单记录。',
      },
      builderAttribution: null,
    };
  }

  const tradeEventId = await createTradeEvent(env, {
    telegramUserId,
    botId,
    eventType: 'buy',
    marketSlug: market.slug ?? market.question,
    outcome: resolvedOutcome,
    tokenId: resolvedTokenId,
    amountUsdc,
    status: execution.status,
    orderId: execution.orderId,
    payloadJson: JSON.stringify({
      marketQuestion: market.question,
      outcome: resolvedOutcome,
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

  const simulatedReason = execution.mode === 'simulated'
    ? (execution.detail as { reason?: string }).reason
    : undefined;
  const simulatedNote = !liveTradingAllowed
    ? 'live 交易还没对你开放，所以这笔先按模拟单记录。你现在可以发 /orders 看订单，或者发 /positions 看当前记录里的模拟仓位。'
    : simulatedReason === 'trading_mode_simulated'
      ? '当前系统是模拟交易模式（NEWBOT_TRADING_MODE 未开启 live），这笔先按模拟单记录。你可以发 /orders 看订单，或发 /positions 看模拟仓位。'
      : undefined;

  return buildSubmittedBuyReply(
    market,
    resolvedOutcome,
    amountUsdc,
    execution.orderId,
    execution.mode,
    execution.status,
    simulatedNote,
  );
}

interface FailedLiveOrderInput {
  telegramUserId: string;
  botId: string;
  market: Awaited<ReturnType<typeof findBestMarket>>;
  outcome: string;
  tokenId: string;
  amountUsdc: number;
  error: LiveOrderError;
}

async function recordFailedLiveOrder(env: Env, input: FailedLiveOrderInput): Promise<void> {
  const market = input.market;
  if (!market) {
    return;
  }
  await createTradeEvent(env, {
    telegramUserId: input.telegramUserId,
    botId: input.botId,
    eventType: 'buy',
    marketSlug: market.slug ?? market.question,
    outcome: input.outcome,
    tokenId: input.tokenId,
    amountUsdc: input.amountUsdc,
    status: 'live_failed',
    orderId: null,
    payloadJson: JSON.stringify({
      marketQuestion: market.question,
      outcome: input.outcome,
      mode: 'live',
      error: {
        code: input.error.code,
        message: input.error.message,
        retryable: input.error.retryable,
        http_status: input.error.httpStatus,
      },
    }),
  });
}

function normalizeOutcome(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'yes') return 'Yes';
  if (normalized === 'no') return 'No';
  return null;
}

function parseRunbookEnvironment(text: string): string | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    return null;
  }

  const environment = parts[1]?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9_-]{1,32}$/.test(environment)) {
    return null;
  }
  return environment;
}

function parseRunbookCallbackEnvironment(data: string): string | null {
  const environment = data.replace(/^ops_runbook_env:/, '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(environment)) {
    return null;
  }
  return environment;
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

function buildPaginationToast(label: string, page: number, source: 'live' | 'cache' | 'none', warning: string | null) {
  if (warning) {
    return { text: warning, showAlert: false };
  }
  if (source === 'cache') {
    return { text: `${label}第 ${page} 页（缓存）`, showAlert: false };
  }
  return { text: `${label}第 ${page} 页`, showAlert: false };
}
