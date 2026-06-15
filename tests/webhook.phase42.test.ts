import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleTelegramWebhook } from '../src/routes/webhook';
import type { Env } from '../src/types';

/**
 * Phase 42.4 — Worker 侧对齐真实 CLOB 协议：
 * - 下单 payload 字段对齐（bot_id/telegram_user_id/side/order_type/price + 整数 signature_type）
 * - 状态归一化补 delayed/unmatched
 * - signer 统一错误 envelope → 中文文案 + live_failed 审计；撤单同样接住错误
 */

type TradingAccountRow = {
  telegram_user_id: string;
  bot_id: string;
  status: string;
  auth_mode: string;
  account_label: string | null;
  signer_address: string | null;
  funder_address: string | null;
};

type TradeEventRow = {
  id: number;
  telegram_user_id: string;
  bot_id: string;
  event_type: string;
  market_slug: string;
  outcome: string;
  token_id: string;
  amount_usdc: number;
  status: string;
  order_id: string | null;
  payload_json: string | null;
  created_at: string;
};

type ConversationRow = {
  user_id: string;
  turn_id: number;
  role: string;
  content: string;
};

type CacheRow = {
  slug: string;
  data_json: string;
  expires_at: string;
};

type BuilderAttributionRow = {
  id: number;
  telegram_user_id: string;
  bot_id: string;
  trade_event_id: number | null;
  builder_api_key_hint: string | null;
  order_id: string | null;
  amount_usdc: number | null;
};

class FakeD1 {
  tradingAccounts = new Map<string, TradingAccountRow>();

  tradeEvents: TradeEventRow[] = [];

  builderAttributions: BuilderAttributionRow[] = [];

  conversations: ConversationRow[] = [];

  marketCache = new Map<string, CacheRow>();

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }
}

class FakePreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    if (this.query.includes('SELECT status, auth_mode, account_label, signer_address, funder_address')) {
      const [telegramUserId, botId] = this.values as [string, string];
      return (this.db.tradingAccounts.get(`${telegramUserId}:${botId}`) ?? null) as T | null;
    }

    if (this.query.includes('SELECT status FROM user_trading_accounts')) {
      const [telegramUserId, botId] = this.values as [string, string];
      const row = this.db.tradingAccounts.get(`${telegramUserId}:${botId}`);
      return (row ? { status: row.status } : null) as T | null;
    }

    if (this.query.includes('SELECT COALESCE(MAX(turn_id), 0) AS max_turn_id FROM conversations')) {
      const [userId] = this.values as [string];
      const maxTurnId = this.db.conversations
        .filter((row) => row.user_id === userId)
        .reduce((max, row) => Math.max(max, row.turn_id), 0);
      return { max_turn_id: maxTurnId } as T;
    }

    if (this.query.includes('SELECT data_json, expires_at FROM market_cache')) {
      const [slug] = this.values as [string];
      const row = this.db.marketCache.get(slug) ?? null;
      if (!row) {
        return null;
      }
      return { data_json: row.data_json, expires_at: row.expires_at } as T;
    }

    if (this.query.includes('FROM trade_events') && this.query.includes('WHERE order_id = ?')) {
      const [orderId, telegramUserId, botId] = this.values as [string, string, string];
      return (
        this.db.tradeEvents.find((row) => row.order_id === orderId && row.telegram_user_id === telegramUserId && row.bot_id === botId) ?? null
      ) as T | null;
    }

    throw new Error(`Unsupported first query: ${this.query}`);
  }

  async all<T>() {
    if (this.query.includes('FROM trade_events')) {
      const [telegramUserId, botId] = this.values as [string, string];
      const results = this.db.tradeEvents
        .filter((row) => row.telegram_user_id === telegramUserId && row.bot_id === botId)
        .sort((a, b) => (a.id < b.id ? 1 : -1));
      return { results: results as T[] };
    }

    throw new Error(`Unsupported all query: ${this.query}`);
  }

  async run() {
    if (this.query.includes('INSERT INTO conversations')) {
      const [userId, turnId, role, content] = this.values as [string, number, string, string];
      this.db.conversations.push({ user_id: userId, turn_id: turnId, role, content });
      return { success: true };
    }

    if (this.query.includes('UPDATE trade_events')) {
      const [status, payloadJson, orderId, telegramUserId, botId] = this.values as [string, string, string, string, string];
      const existing = this.db.tradeEvents.find((row) => row.order_id === orderId && row.telegram_user_id === telegramUserId && row.bot_id === botId);
      if (existing) {
        existing.status = status;
        existing.payload_json = payloadJson;
      }
      return { success: true };
    }

    if (this.query.includes('INSERT INTO market_cache')) {
      const [slug, dataJson, _fetchedAt, expiresAt] = this.values as [string, string, string, string];
      this.db.marketCache.set(slug, { slug, data_json: dataJson, expires_at: expiresAt });
      return { success: true };
    }

    if (this.query.includes('INSERT INTO builder_attributions')) {
      const [telegramUserId, botId, tradeEventId, builderApiKeyHint, orderId, amountUsdc] = this.values as [
        string,
        string,
        number | null,
        string | null,
        string | null,
        number | null,
      ];
      this.db.builderAttributions.push({
        id: this.db.builderAttributions.length + 1,
        telegram_user_id: telegramUserId,
        bot_id: botId,
        trade_event_id: tradeEventId,
        builder_api_key_hint: builderApiKeyHint,
        order_id: orderId,
        amount_usdc: amountUsdc,
      });
      return { success: true, meta: { last_row_id: this.db.builderAttributions.length } };
    }

    if (this.query.includes('INSERT INTO trade_events')) {
      const [telegramUserId, botId, eventType, marketSlug, outcome, tokenId, amountUsdc, status, orderId, payloadJson] = this.values as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        string,
        string | null,
        string,
      ];
      this.db.tradeEvents.push({
        id: this.db.tradeEvents.length + 1,
        telegram_user_id: telegramUserId,
        bot_id: botId,
        event_type: eventType,
        market_slug: marketSlug,
        outcome,
        token_id: tokenId,
        amount_usdc: amountUsdc,
        status,
        order_id: orderId,
        payload_json: payloadJson,
        created_at: new Date().toISOString(),
      });
      return { success: true, meta: { last_row_id: this.db.tradeEvents.length } };
    }

    if (this.query.includes('INSERT INTO users')) {
      return { success: true };
    }

    throw new Error(`Unsupported run query: ${this.query}`);
  }
}

function makeEnv(db: FakeD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    TRADE_COORDINATOR: {} as DurableObjectNamespace,
    APP_ENV: 'test',
    NEWBOT_VERSION: '0.6.0',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    BOT_TOKEN_CRYPTO_ZH: 'bot-token',
    NEWBOT_TRADING_MODE: 'live',
    POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
    POLYMARKET_ORDER_API_KEY: 'order-key',
    POLYMARKET_ORDER_SIGNING_SECRET: 'signing-secret',
    ...overrides,
  };
}

function makeMessageRequest(text: string, telegramUserId = 1001) {
  return new Request('https://example.com/telegram/webhook/crypto_zh', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'test-secret',
    },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 10,
        text,
        chat: { id: 2001, type: 'private' },
        from: {
          id: telegramUserId,
          is_bot: false,
          first_name: 'Dora',
          last_name: 'Lee',
          username: 'dora',
          language_code: 'zh-hans',
        },
      },
    }),
  });
}

function seedManagedAccount(db: FakeD1, authMode = 'managed_signer') {
  db.tradingAccounts.set('1001:crypto_zh', {
    telegram_user_id: '1001',
    bot_id: 'crypto_zh',
    status: 'active',
    auth_mode: authMode,
    account_label: 'Dora 主账户',
    signer_address: '0x1234567890abcdef1234567890abcdef12345678',
    funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  });
}

const BTC_MARKET = {
  question: 'Will BTC break 120k in 2026?',
  volume: 1234567,
  endDate: '2026-12-31T00:00:00Z',
  slug: 'btc-break-120k-2026',
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.61","0.39"]',
  clobTokenIds: '["111","222"]',
};

function lastTelegramText(fetchMock: ReturnType<typeof vi.spyOn>): string {
  const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return (JSON.parse(String(init.body)) as { text: string }).text;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleTelegramWebhook phase 42 — real CLOB protocol alignment', () => {
  it('sends a CLOB-aligned order payload with bot/user ids, side, order type, price and integer signature type', async () => {
    const db = new FakeD1();
    seedManagedAccount(db);
    const env = makeEnv(db, {
      POLYMARKET_BUILDER_TAG: 'newbot-phase42',
      POLYMARKET_BUILDER_API_KEY: 'builder-secret-key-1234',
    });
    let orderBody: Record<string, unknown> | null = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return new Response(JSON.stringify([BTC_MARKET]), { status: 200 });
      }
      if (url === 'https://orders.example.com/orders') {
        orderBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ orderId: 'live-ord-42', status: 'live' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/buy btc yes 50'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(orderBody).toMatchObject({
      bot_id: 'crypto_zh',
      telegram_user_id: '1001',
      token_id: '111',
      market_slug: 'btc-break-120k-2026',
      amount_usdc: 50,
      side: 'BUY',
      order_type: 'FOK',
      price: 0.61,
      signature_type: 1,
      protocol: 'polymarket_clob_v2',
    });
    // status 'live' 必须归一化为 live_submitted。
    expect(db.tradeEvents).toHaveLength(1);
    expect(db.tradeEvents[0]).toMatchObject({ status: 'live_submitted', order_id: 'live-ord-42' });
    expect(lastTelegramText(fetchMock)).toContain('真实下单请求已经发出');
  });

  it('maps wallet_signature to EOA (0) and gnosis_safe to POLY_GNOSIS_SAFE (2)', async () => {
    for (const [authMode, expectedType] of [['wallet_signature', 0], ['gnosis_safe', 2]] as const) {
      const db = new FakeD1();
      seedManagedAccount(db, authMode);
      const env = makeEnv(db);
      let signatureType: unknown = null;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes('gamma-api.polymarket.com/markets')) {
          return new Response(JSON.stringify([BTC_MARKET]), { status: 200 });
        }
        if (url === 'https://orders.example.com/orders') {
          signatureType = (JSON.parse(String(init?.body)) as Record<string, unknown>).signature_type;
          return new Response(JSON.stringify({ orderId: 'live-ord-x', status: 'submitted' }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const response = await handleTelegramWebhook(makeMessageRequest('/buy btc yes 50'), env, 'crypto_zh');

      expect(response.status).toBe(200);
      expect(signatureType).toBe(expectedType);
      vi.restoreAllMocks();
    }
  });

  it('surfaces INSUFFICIENT_BALANCE as a precise Chinese message and records a live_failed audit event', async () => {
    const db = new FakeD1();
    seedManagedAccount(db);
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return new Response(JSON.stringify([BTC_MARKET]), { status: 200 });
      }
      if (url === 'https://orders.example.com/orders') {
        return new Response(
          JSON.stringify({ error: { code: 'INSUFFICIENT_BALANCE', message: 'balance too low', retryable: false } }),
          { status: 402 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/buy btc yes 50'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    // 审计：失败也要留痕，状态 live_failed、order_id 为空。
    expect(db.tradeEvents).toHaveLength(1);
    expect(db.tradeEvents[0]).toMatchObject({ status: 'live_failed', order_id: null });
    expect(db.tradeEvents[0]?.payload_json).toContain('INSUFFICIENT_BALANCE');
    expect(db.builderAttributions).toHaveLength(0);
    const text = lastTelegramText(fetchMock);
    expect(text).toContain('真实下单没有成功');
    expect(text).toContain('账户余额不足');
    expect(text).toContain('先别急着重复下单');
  });

  it('surfaces a retryable UPSTREAM_TIMEOUT with retry guidance', async () => {
    const db = new FakeD1();
    seedManagedAccount(db);
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return new Response(JSON.stringify([BTC_MARKET]), { status: 200 });
      }
      if (url === 'https://orders.example.com/orders') {
        return new Response(
          JSON.stringify({ error: { code: 'UPSTREAM_TIMEOUT', message: 'timeout', retryable: true } }),
          { status: 504 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/buy btc yes 50'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const text = lastTelegramText(fetchMock);
    expect(text).toContain('下单服务暂时不可用');
    expect(text).toContain('过一会儿可以再试一次');
  });

  it('falls back to a generic message for an unknown error code', async () => {
    const db = new FakeD1();
    seedManagedAccount(db);
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return new Response(JSON.stringify([BTC_MARKET]), { status: 200 });
      }
      if (url === 'https://orders.example.com/orders') {
        return new Response('not json at all', { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/buy btc yes 50'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(db.tradeEvents[0]?.payload_json).toContain('UNKNOWN');
    const text = lastTelegramText(fetchMock);
    expect(text).toContain('真实下单没有成功');
  });

  it('normalizes a delayed live status during /orders refresh', async () => {
    const db = new FakeD1();
    seedManagedAccount(db);
    db.tradeEvents.push({
      id: 1,
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      event_type: 'buy',
      market_slug: 'btc-break-120k-2026',
      outcome: 'Yes',
      token_id: '111',
      amount_usdc: 50,
      status: 'live_submitted',
      order_id: 'live-ord-123',
      payload_json: '{}',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/orders/live-ord-123') {
        return new Response(JSON.stringify({ orderId: 'live-ord-123', status: 'delayed' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/orders'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(db.tradeEvents[0]?.status).toBe('live_delayed');
    expect(lastTelegramText(fetchMock)).toContain('live_delayed');
  });

  it('normalizes an unmatched live status during /orders refresh', async () => {
    const db = new FakeD1();
    seedManagedAccount(db);
    db.tradeEvents.push({
      id: 1,
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      event_type: 'buy',
      market_slug: 'btc-break-120k-2026',
      outcome: 'Yes',
      token_id: '111',
      amount_usdc: 50,
      status: 'live_submitted',
      order_id: 'live-ord-456',
      payload_json: '{}',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/orders/live-ord-456') {
        return new Response(JSON.stringify({ orderId: 'live-ord-456', status: 'unmatched' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/orders'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(db.tradeEvents[0]?.status).toBe('live_unmatched');
    expect(lastTelegramText(fetchMock)).toContain('live_unmatched');
  });

  it('attaches bot/user ids to the cancel request body', async () => {
    const db = new FakeD1();
    seedManagedAccount(db);
    db.tradeEvents.push({
      id: 1,
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      event_type: 'buy',
      market_slug: 'btc-break-120k-2026',
      outcome: 'Yes',
      token_id: '111',
      amount_usdc: 50,
      status: 'live_submitted',
      order_id: 'live-ord-123',
      payload_json: '{}',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const env = makeEnv(db);
    let cancelBody: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://orders.example.com/orders/live-ord-123/cancel') {
        cancelBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ orderId: 'live-ord-123', status: 'cancelled' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/cancel live-ord-123'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(cancelBody).toMatchObject({ bot_id: 'crypto_zh', telegram_user_id: '1001', order_id: 'live-ord-123' });
    expect(db.tradeEvents[0]?.status).toBe('live_cancelled');
  });

  it('surfaces a CREDS_NOT_READY cancel error and leaves the order status unchanged', async () => {
    const db = new FakeD1();
    seedManagedAccount(db);
    db.tradeEvents.push({
      id: 1,
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      event_type: 'buy',
      market_slug: 'btc-break-120k-2026',
      outcome: 'Yes',
      token_id: '111',
      amount_usdc: 50,
      status: 'live_submitted',
      order_id: 'live-ord-123',
      payload_json: '{}',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/orders/live-ord-123/cancel') {
        return new Response(
          JSON.stringify({ error: { code: 'CREDS_NOT_READY', message: 'provisioning', retryable: true } }),
          { status: 409 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/cancel live-ord-123'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    // 撤单失败：状态保持不变，给精准文案。
    expect(db.tradeEvents[0]?.status).toBe('live_submitted');
    const text = lastTelegramText(fetchMock);
    expect(text).toContain('撤单没成功');
    expect(text).toContain('开通中');
  });
});
