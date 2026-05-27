import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleTelegramWebhook } from '../src/routes/webhook';
import type { Env } from '../src/types';

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

type ReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
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

type CronRunRow = {
  id: number;
  job_name: string;
  status: string;
  detail: string | null;
  created_at: string;
};

class FakeD1 {
  tradingAccounts = new Map<string, TradingAccountRow>();

  tradeEvents: TradeEventRow[] = [];

  builderAttributions: BuilderAttributionRow[] = [];

  cronRuns: CronRunRow[] = [];

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

    if (this.query.includes('FROM cron_runs')) {
      const [jobName, limit] = this.values as [string, number | undefined];
      const results = this.db.cronRuns
        .filter((row) => row.job_name === jobName)
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .slice(0, limit ?? 1);
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
        string,
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

function makeCallbackRequest(data: string, telegramUserId = 1001) {
  return new Request('https://example.com/telegram/webhook/crypto_zh', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'test-secret',
    },
    body: JSON.stringify({
      update_id: 2,
      callback_query: {
        id: 'cbq-phase13',
        data,
        from: {
          id: telegramUserId,
          is_bot: false,
          first_name: 'Dora',
          last_name: 'Lee',
          username: 'dora',
          language_code: 'zh-hans',
        },
        message: {
          message_id: 77,
          text: 'old portfolio menu',
          chat: { id: 2001, type: 'private' },
        },
      },
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleTelegramWebhook phase 6', () => {
  it('shows richer account status for linked users', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleTelegramWebhook(makeMessageRequest('/account'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('Dora 主账户');
    expect(payload.text).toContain('managed signer');
    expect(payload.text).toContain('0x123456');
  });

  it('submits a simulated buy order for linked users when live order API is not configured', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return new Response(JSON.stringify([
          {
            question: 'Will BTC break 120k in 2026?',
            volume: 1234567,
            endDate: '2026-12-31T00:00:00Z',
            slug: 'btc-break-120k-2026',
            outcomes: '["Yes","No"]',
            outcomePrices: '["0.61","0.39"]',
            clobTokenIds: '["111","222"]',
          },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/buy btc yes 50'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(db.tradeEvents).toHaveLength(1);
    expect(db.tradeEvents[0]).toMatchObject({
      market_slug: 'btc-break-120k-2026',
      outcome: 'Yes',
      amount_usdc: 50,
      status: 'simulated_submitted',
    });
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('模拟下单已经记录');
    expect(payload.text).toContain('50 USDC');
    expect(payload.text).toContain('Yes');
    expect(payload.text).toContain('还没接入真实下单 API');
  });

  it('submits a live buy request with signed payload metadata when order API config is present', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
      POLYMARKET_ORDER_SIGNING_SECRET: 'signing-secret',
      POLYMARKET_BUILDER_TAG: 'newbot-phase8',
      POLYMARKET_BUILDER_API_KEY: 'builder-secret-key-1234',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return new Response(JSON.stringify([
          {
            question: 'Will BTC break 120k in 2026?',
            volume: 1234567,
            endDate: '2026-12-31T00:00:00Z',
            slug: 'btc-break-120k-2026',
            outcomes: '["Yes","No"]',
            outcomePrices: '["0.61","0.39"]',
            clobTokenIds: '["111","222"]',
          },
        ]), { status: 200 });
      }
      if (url === 'https://orders.example.com/orders') {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer order-key',
        });
        const headers = init?.headers as Record<string, string>;
        expect(headers['x-order-signature']).toBeTruthy();
        expect(headers['x-order-body-sha256']).toMatch(/^[a-f0-9]{64}$/);
        expect(headers['x-order-signature-input']).toContain('body_sha256=');
        expect(headers['x-order-signature-input']).toContain('timestamp_ms=');
        expect(headers['x-order-signature-input']).toContain('nonce=');
        expect(headers['x-order-protocol-version']).toBe('polymarket_clob_v2');
        expect(headers['x-order-timestamp-ms']).toMatch(/^\d+$/);
        expect(headers['x-order-nonce']).toMatch(/^[a-f0-9]+$/);
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(payload.market_slug).toBe('btc-break-120k-2026');
        expect(payload.token_id).toBe('111');
        expect(payload.amount_usdc).toBe(50);
        expect(payload.builder_tag).toBe('newbot-phase8');
        expect(payload.builder_api_key).toBe('builder-secret-key-1234');
        expect(payload.builder_api_key_hint).toBe('****1234');
        expect(payload.signature_type).toBe('clob_delegate');
        expect(payload.client_order_id).toMatch(/^nbo-/);
        expect(typeof payload.timestamp_ms).toBe('number');
        expect(typeof payload.nonce).toBe('string');
        return new Response(JSON.stringify({ orderId: 'live-ord-123', status: 'submitted' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/buy btc yes 50'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(db.tradeEvents).toHaveLength(1);
    expect(db.builderAttributions).toHaveLength(1);
    expect(db.builderAttributions[0]).toMatchObject({
      bot_id: 'crypto_zh',
      telegram_user_id: '1001',
      order_id: 'live-ord-123',
      amount_usdc: 50,
      builder_api_key_hint: '****1234',
      trade_event_id: 1,
    });
    expect(db.tradeEvents[0]).toMatchObject({
      market_slug: 'btc-break-120k-2026',
      outcome: 'Yes',
      amount_usdc: 50,
      status: 'live_submitted',
      order_id: 'live-ord-123',
    });
    expect(db.tradeEvents[0]?.payload_json).toContain('builder_attribution');
    expect(db.tradeEvents[0]?.payload_json).toContain('newbot-phase8');
    expect(db.tradeEvents[0]?.payload_json).toContain('signature_envelope');
    expect(db.tradeEvents[0]?.payload_json).toContain('polymarket_clob_v2');
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('真实下单请求已经发出');
    expect(payload.text).toContain('live-ord-123');
  });

  it('keeps live buy requests simulated when a user is outside the live trading allowlist', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
      POLYMARKET_ORDER_SIGNING_SECRET: 'signing-secret',
      NEWBOT_LIVE_TRADING_TELEGRAM_IDS: '9001,9002',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return new Response(JSON.stringify([
          {
            question: 'Will BTC break 120k in 2026?',
            volume: 1234567,
            endDate: '2026-12-31T00:00:00Z',
            slug: 'btc-break-120k-2026',
            outcomes: '["Yes","No"]',
            outcomePrices: '["0.61","0.39"]',
            clobTokenIds: '["111","222"]',
          },
        ]), { status: 200 });
      }
      if (url === 'https://orders.example.com/orders') {
        throw new Error('live order endpoint should not be called for non-allowlisted users');
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/buy btc yes 50', 1001), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(db.tradeEvents).toHaveLength(1);
    expect(db.builderAttributions).toHaveLength(0);
    expect(db.tradeEvents[0]).toMatchObject({
      status: 'simulated_submitted',
      order_id: expect.stringMatching(/^sim-/),
    });
    expect(db.tradeEvents[0]?.payload_json).toContain('live_trading_not_allowlisted');
    const orderCalls = fetchMock.mock.calls.filter(([input]) => String(input) === 'https://orders.example.com/orders');
    expect(orderCalls).toHaveLength(0);
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('模拟下单已经记录');
    expect(payload.text).toContain('live 交易还没对你开放');
  });

  it('submits a live buy request with wallet-signature metadata when wallet mode is present', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'wallet_signature',
      account_label: 'Dora 钱包账户',
      signer_address: '0x9999999990abcdef1234567890abcdef12345678',
      funder_address: '0x88888888abcdefabcdefabcdefabcdefabcdefab',
    });
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
      POLYMARKET_ORDER_SIGNING_SECRET: 'signing-secret',
      POLYMARKET_BUILDER_TAG: 'newbot-phase9',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return new Response(JSON.stringify([
          {
            question: 'Will BTC break 120k in 2026?',
            volume: 1234567,
            endDate: '2026-12-31T00:00:00Z',
            slug: 'btc-break-120k-2026',
            outcomes: '["Yes","No"]',
            outcomePrices: '["0.61","0.39"]',
            clobTokenIds: '["111","222"]',
          },
        ]), { status: 200 });
      }
      if (url === 'https://orders.example.com/orders') {
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(payload.signature_type).toBe('clob_wallet');
        expect(payload.builder_tag).toBe('newbot-phase9');
        return new Response(JSON.stringify({ orderId: 'live-wallet-1', status: 'submitted' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/buy btc yes 50'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(db.tradeEvents).toHaveLength(1);
    expect(db.tradeEvents[0]).toMatchObject({
      status: 'live_submitted',
      order_id: 'live-wallet-1',
    });
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('真实下单请求已经发出');
  });

  it('shows refreshed live order status in /orders when status api config is present', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
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
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/orders/live-ord-123') {
        return new Response(JSON.stringify({ orderId: 'live-ord-123', status: 'matched' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/orders'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('matched');
    expect(payload.text).toContain('live-ord-123');
  });

  it('cancels a live order and persists the cancelled status', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
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
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
      POLYMARKET_ORDER_SIGNING_SECRET: 'signing-secret',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://orders.example.com/orders/live-ord-123/cancel') {
        expect(init?.method).toBe('POST');
        const headers = init?.headers as Record<string, string>;
        expect(headers['x-order-signature']).toBeTruthy();
        expect(headers['x-order-body-sha256']).toMatch(/^[a-f0-9]{64}$/);
        expect(headers['x-order-signature-input']).toContain('body_sha256=');
        expect(headers['x-order-protocol-version']).toBe('polymarket_clob_v2');
        return new Response(JSON.stringify({ orderId: 'live-ord-123', status: 'cancelled' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/cancel live-ord-123'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(db.tradeEvents[0]).toMatchObject({
      status: 'live_cancelled',
      order_id: 'live-ord-123',
    });
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('已取消');
    expect(payload.text).toContain('live-ord-123');
  });

  it('refreshes live order status into persistence during /orders', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
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
      payload_json: '{"before":"submitted"}',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/orders/live-ord-123') {
        return new Response(JSON.stringify({ orderId: 'live-ord-123', status: 'matched' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/orders'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(db.tradeEvents[0]?.status).toBe('live_matched');
    expect(db.tradeEvents[0]?.payload_json).toContain('matched');
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('live_matched');
  });

  it('returns paginated live open orders from the remote order API', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/orders/open?bot_id=crypto_zh&telegram_user_id=1001') {
        return new Response(JSON.stringify({
          orders: [
            { orderId: 'live-open-1', marketSlug: 'btc-break-120k-2026', outcome: 'Yes', amountUsdc: 35, status: 'open' },
            { orderId: 'live-open-2', marketSlug: 'eth-etf-inflows', outcome: 'No', amountUsdc: 20, status: 'open' },
            { orderId: 'live-open-3', marketSlug: 'sol-ath', outcome: 'Yes', amountUsdc: 15, status: 'open' },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/openorders 2'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      text: string;
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(payload.text).toContain('第 2 页');
    expect(payload.text).toContain('live-open-3');
    expect(payload.text).not.toContain('live-open-1');
    expect(payload.reply_markup?.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback_data: 'cancel_open_order:live-open-3:2' }),
        expect.objectContaining({ callback_data: 'openorders_page:1' }),
      ]),
    );
  });

  it('handles open orders pagination callback and edits the message in place', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    db.marketCache.set('portfolio:openorders:crypto_zh:1001', {
      slug: 'portfolio:openorders:crypto_zh:1001',
      data_json: JSON.stringify([
        { orderId: 'live-open-1', marketSlug: 'btc-break-120k-2026', outcome: 'Yes', amountUsdc: 35, status: 'open' },
        { orderId: 'live-open-2', marketSlug: 'eth-etf-inflows', outcome: 'No', amountUsdc: 20, status: 'open' },
        { orderId: 'live-open-3', marketSlug: 'sol-ath', outcome: 'Yes', amountUsdc: 15, status: 'open' },
      ]),
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleTelegramWebhook(makeCallbackRequest('openorders_page:2'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, answerInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const answerPayload = JSON.parse(String(answerInit.body)) as { text?: string };
    expect(answerPayload.text).toContain('当前还没接真实订单接口');
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      text: string;
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(payload.text).toContain('第 2 页 / 共 2 页');
    expect(payload.text).toContain('live-open-3');
    expect(payload.reply_markup?.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback_data: 'cancel_open_order:live-open-3:2' }),
        expect.objectContaining({ callback_data: 'openorders_page:1' }),
      ]),
    );
  });

  it('cancels an open order directly from callback actions', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/orders/live-open-2/cancel') {
        return new Response(JSON.stringify({ orderId: 'live-open-2', status: 'cancelled' }), { status: 200 });
      }
      if (url === 'https://orders.example.com/orders/open?bot_id=crypto_zh&telegram_user_id=1001') {
        return new Response(JSON.stringify({
          orders: [
            { orderId: 'live-open-1', marketSlug: 'btc-break-120k-2026', outcome: 'Yes', amountUsdc: 35, status: 'open' },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeCallbackRequest('cancel_open_order:live-open-2:1'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [, init] = fetchMock.mock.calls[3] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('当前 1 条未成交订单');
    expect(payload.text).toContain('live-open-1');
    expect(payload.text).not.toContain('live-open-2');
  });

  it('returns cached live positions summary with pnl when remote portfolio API is unavailable', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    db.marketCache.set('portfolio:positions:crypto_zh:1001', {
      slug: 'portfolio:positions:crypto_zh:1001',
      data_json: JSON.stringify([
        { marketSlug: 'btc-break-120k-2026', outcome: 'Yes', sizeUsdc: 80, avgPrice: 0.61, currentPrice: 0.7 },
        { marketSlug: 'eth-etf-inflows', outcome: 'No', sizeUsdc: 24, avgPrice: 0.42, currentPrice: 0.38 },
      ]),
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/portfolio/positions?bot_id=crypto_zh&telegram_user_id=1001') {
        return new Response('oops', { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/positions'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('当前 2 条持仓');
    expect(payload.text).toContain('远端持仓暂时拉取失败，先给你上次缓存。');
    expect(payload.text).toContain('总敞口：104 USDC');
    expect(payload.text).toContain('已实现：+$0.00');
    expect(payload.text).toContain('未实现：+$6.24');
    expect(payload.text).toContain('未实现');
    expect(payload.text).toContain('btc-break-120k-2026');
  });

  it('paginates remote positions and adds callback pagination controls', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/portfolio/positions?bot_id=crypto_zh&telegram_user_id=1001') {
        return new Response(JSON.stringify({
          positions: [
            { marketSlug: 'btc-break-120k-2026', outcome: 'Yes', sizeUsdc: 80, avgPrice: 0.61, currentPrice: 0.7 },
            { marketSlug: 'eth-etf-inflows', outcome: 'No', sizeUsdc: 24, avgPrice: 0.42, currentPrice: 0.38 },
            { marketSlug: 'sol-ath', outcome: 'Yes', sizeUsdc: 12, avgPrice: 0.51, currentPrice: 0.55 },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/positions 2'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      text: string;
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(payload.text).toContain('第 2 页 / 共 2 页');
    expect(payload.text).toContain('总敞口：116 USDC');
    expect(payload.text).toContain('已实现：+$0.00');
    expect(payload.text).toContain('未实现：+$6.72');
    expect(payload.text).toContain('分页游标：p2');
    expect(payload.text).toContain('sol-ath');
    expect(payload.text).not.toContain('btc-break-120k-2026');
    expect(payload.reply_markup?.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback_data: 'positions_page:1' }),
      ]),
    );
  });

  it('refreshes open orders after callback cancel and falls back to the previous page when needed', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/orders/live-open-3/cancel') {
        return new Response(JSON.stringify({ orderId: 'live-open-3', status: 'cancelled' }), { status: 200 });
      }
      if (url === 'https://orders.example.com/orders/open?bot_id=crypto_zh&telegram_user_id=1001') {
        return new Response(JSON.stringify({
          orders: [
            { orderId: 'live-open-1', marketSlug: 'btc-break-120k-2026', outcome: 'Yes', amountUsdc: 35, status: 'open' },
            { orderId: 'live-open-2', marketSlug: 'eth-etf-inflows', outcome: 'No', amountUsdc: 20, status: 'open' },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeCallbackRequest('cancel_open_order:live-open-3:2'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [, init] = fetchMock.mock.calls[3] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      text: string;
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(payload.text).toContain('当前 2 条未成交订单');
    expect(payload.text).toContain('第 1 页 / 共 1 页');
    expect(payload.text).toContain('live-open-1');
    expect(payload.text).toContain('live-open-2');
    expect(payload.text).not.toContain('live-open-3');
    expect(payload.reply_markup?.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback_data: 'cancel_open_order:live-open-1:1' }),
        expect.objectContaining({ callback_data: 'cancel_open_order:live-open-2:1' }),
      ]),
    );
  });

  it('cancels an open order directly from callback actions', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/orders/live-open-2/cancel') {
        return new Response(JSON.stringify({ orderId: 'live-open-2', status: 'cancelled' }), { status: 200 });
      }
      if (url === 'https://orders.example.com/orders/open?bot_id=crypto_zh&telegram_user_id=1001') {
        return new Response(JSON.stringify({
          orders: [
            { orderId: 'live-open-1', marketSlug: 'btc-break-120k-2026', outcome: 'Yes', amountUsdc: 35, status: 'open' },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeCallbackRequest('cancel_open_order:live-open-2:1'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [, init] = fetchMock.mock.calls[3] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('当前 1 条未成交订单');
  });

  it('supports page-token style positions command and shows realized/unrealized pnl split', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/portfolio/positions?bot_id=crypto_zh&telegram_user_id=1001') {
        return new Response(JSON.stringify({
          positions: [
            { marketSlug: 'btc-break-120k-2026', outcome: 'Yes', sizeUsdc: 80, avgPrice: 0.61, currentPrice: 0.7, realizedPnl: 3 },
            { marketSlug: 'eth-etf-inflows', outcome: 'No', sizeUsdc: 24, avgPrice: 0.42, currentPrice: 0.38, realizedPnl: -1 },
            { marketSlug: 'sol-ath', outcome: 'Yes', sizeUsdc: 12, avgPrice: 0.51, currentPrice: 0.55, realizedPnl: 0.5 },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/positions p2'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      text: string;
      reply_markup?: ReplyMarkup;
    };
    expect(payload.text).toContain('第 2 页 / 共 2 页');
    expect(payload.text).toContain('已实现：+$2.50');
    expect(payload.text).toContain('未实现：+$6.72');
    expect(payload.text).toContain('分页游标：p2');
    expect(payload.text).toContain('sol-ath');
    expect(payload.reply_markup?.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback_data: 'positions_page:1' }),
      ]),
    );
  });

  it('returns paginated recent fills from the remote portfolio API', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://orders.example.com/portfolio/fills?bot_id=crypto_zh&telegram_user_id=1001') {
        return new Response(JSON.stringify({
          fills: [
            { marketSlug: 'btc-break-120k-2026', outcome: 'Yes', amountUsdc: 25, price: 0.6, side: 'buy' },
            { marketSlug: 'eth-etf-inflows', outcome: 'No', amountUsdc: 15, price: 0.44, side: 'sell' },
            { marketSlug: 'sol-ath', outcome: 'Yes', amountUsdc: 12, price: 0.51, side: 'buy' },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/fills 2'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('第 2 页');
    expect(payload.text).toContain('sol-ath');
    expect(payload.text).not.toContain('btc-break-120k-2026');
  });

  it('shows live readiness from /health in Telegram', async () => {
    const db = new FakeD1();
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
      POLYMARKET_BUILDER_TAG: 'newbot-builder',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleTelegramWebhook(makeMessageRequest('/health'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string; reply_markup?: ReplyMarkup };
    expect(payload.text).toContain('NewBot 当前状态');
    expect(payload.text).toContain('Live order API：已配置');
    expect(payload.text).toContain('Canonical signing：未启用');
    expect(payload.text).toContain('Builder attribution：partial');
    expect(payload.text).toContain('signing secret 还没配置');
    expect(payload.reply_markup?.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback_data: 'ops_health' }),
      ]),
    );
  });

  it('refreshes readiness from the system status callback', async () => {
    const db = new FakeD1();
    const env = makeEnv(db, {
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
      POLYMARKET_ORDER_SIGNING_SECRET: 'signing-secret',
      POLYMARKET_BUILDER_TAG: 'newbot-builder',
      POLYMARKET_BUILDER_API_KEY: 'builder-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleTelegramWebhook(makeCallbackRequest('ops_health'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const answerCall = fetchMock.mock.calls.find(([input]) => String(input).includes('answerCallbackQuery'));
    expect(answerCall).toBeDefined();
    const [, answerInit] = answerCall as [string, RequestInit];
    expect(JSON.parse(String(answerInit.body))).toMatchObject({ text: '系统状态已刷新', show_alert: false });
    const editCall = fetchMock.mock.calls.find(([input]) => String(input).includes('editMessageText'));
    expect(editCall).toBeDefined();
    const [, editInit] = editCall as [string, RequestInit];
    const payload = JSON.parse(String(editInit.body)) as { text: string };
    expect(payload.text).toContain('Live order API：已配置');
    expect(payload.text).toContain('Canonical signing：已启用');
    expect(payload.text).toContain('Builder attribution：ready');
    expect(payload.text).toContain('暂时没有配置告警');
  });

  it('limits Telegram readiness commands to configured operators', async () => {
    const db = new FakeD1();
    const env = makeEnv(db, {
      NEWBOT_OPERATOR_TELEGRAM_IDS: '9001,9002',
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleTelegramWebhook(makeMessageRequest('/health', 1001), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('这个系统状态入口只给配置过的操作者使用');
    expect(payload.text).not.toContain('Live order API：已配置');
  });

  it('allows configured operators to open Telegram readiness commands', async () => {
    const db = new FakeD1();
    const env = makeEnv(db, {
      NEWBOT_OPERATOR_TELEGRAM_IDS: '9001, 9002',
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleTelegramWebhook(makeMessageRequest('/ops', 9002), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('NewBot 当前状态');
    expect(payload.text).toContain('Live order API：已配置');
  });

  it('shows an alert when non-operators tap the system status callback', async () => {
    const db = new FakeD1();
    const env = makeEnv(db, {
      NEWBOT_OPERATOR_TELEGRAM_IDS: '9001',
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleTelegramWebhook(makeCallbackRequest('ops_health', 1001), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const answerCall = fetchMock.mock.calls.find(([input]) => String(input).includes('answerCallbackQuery'));
    expect(answerCall).toBeDefined();
    const [, answerInit] = answerCall as [string, RequestInit];
    expect(JSON.parse(String(answerInit.body))).toMatchObject({ text: '只有配置过的操作者可以看系统状态', show_alert: true });
    const editCall = fetchMock.mock.calls.find(([input]) => String(input).includes('editMessageText'));
    expect(editCall).toBeDefined();
    const [, editInit] = editCall as [string, RequestInit];
    const payload = JSON.parse(String(editInit.body)) as { text: string };
    expect(payload.text).toContain('这个系统状态入口只给配置过的操作者使用');
  });

  it('shows a gated rollout runbook for configured operators', async () => {
    const db = new FakeD1();
    const env = makeEnv(db, {
      NEWBOT_OPERATOR_TELEGRAM_IDS: '9001',
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
      POLYMARKET_ORDER_SIGNING_SECRET: 'signing-secret',
      POLYMARKET_BUILDER_TAG: 'newbot-builder',
      POLYMARKET_BUILDER_API_KEY: 'builder-key',
      NEWBOT_LIVE_TRADING_TELEGRAM_IDS: '9001,9002',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleTelegramWebhook(makeMessageRequest('/runbook', 9001), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string; reply_markup?: ReplyMarkup };
    expect(payload.text).toContain('Phase 29 灰度 runbook');
    expect(payload.text).toContain('npm run smoke -- <worker-url>');
    expect(payload.text).toContain('npm run smoke -- --require-ready <worker-url>');
    expect(payload.text).toContain('--report-url /ops/smoke-report');
    expect(payload.text).toContain('1% / allowlist');
    expect(payload.text).toContain('Live order API：已配置');
    expect(payload.text).toContain('Canonical signing：已启用');
    expect(payload.text).toContain('Live trading allowlist：已启用');
    expect(payload.text).not.toContain('builder-key');
    expect(payload.reply_markup?.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback_data: 'ops_runbook' }),
      ]),
    );
  });

  it('shows the latest persisted smoke report in the operator runbook', async () => {
    const db = new FakeD1();
    db.cronRuns.push(
      {
        id: 1,
        job_name: 'smoke',
        status: 'failed',
        detail: JSON.stringify({
          ok: false,
          target: 'https://old-worker.example.workers.dev',
          checks: [{ name: 'rollout_readiness', ok: false, detail: 'old blocker' }],
        }),
        created_at: '2026-05-26T00:00:00.000Z',
      },
      {
        id: 2,
        job_name: 'smoke',
        status: 'failed',
        detail: JSON.stringify({
          ok: false,
          target: 'https://staging.example.workers.dev',
          environment: 'staging',
          checks: [{ name: 'rollout_readiness', ok: false, detail: 'staging blocker' }],
        }),
        created_at: '2026-05-27T08:00:00.000Z',
      },
      {
        id: 3,
        job_name: 'smoke',
        status: 'ok',
        detail: JSON.stringify({
          ok: true,
          target: 'https://older-production.example.workers.dev',
          environment: 'production',
          checks: [{ name: 'healthz', ok: true }],
        }),
        created_at: '2026-05-27T08:15:00.000Z',
      },
      {
        id: 4,
        job_name: 'smoke',
        status: 'ok',
        detail: JSON.stringify({
          ok: true,
          target: 'https://newbot.example.workers.dev',
          environment: 'production',
          checks: [
            { name: 'healthz', ok: true },
            { name: 'version', ok: true },
            { name: 'webhook_secret', ok: true },
          ],
        }),
        created_at: '2026-05-27T08:30:00.000Z',
      },
      {
        id: 5,
        job_name: 'smoke',
        status: 'ok',
        detail: JSON.stringify({
          ok: true,
          target: 'https://canary.example.workers.dev',
          environment: 'canary',
          checks: [{ name: 'healthz', ok: true }],
        }),
        created_at: '2026-05-27T08:35:00.000Z',
      },
    );
    const env = makeEnv(db, {
      NEWBOT_OPERATOR_TELEGRAM_IDS: '9001',
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
      POLYMARKET_ORDER_SIGNING_SECRET: 'signing-secret',
      POLYMARKET_BUILDER_TAG: 'newbot-builder',
      POLYMARKET_BUILDER_API_KEY: 'builder-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleTelegramWebhook(makeMessageRequest('/runbook', 9001), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('最近 smoke：通过');
    expect(payload.text).toContain('https://canary.example.workers.dev');
    expect(payload.text).toContain('环境：canary');
    expect(payload.text).toContain('各环境 smoke：');
    expect(payload.text).toContain('- canary 通过');
    expect(payload.text).toContain('- production 通过');
    expect(payload.text).toContain('- staging 失败');
    expect(payload.text).toContain('https://newbot.example.workers.dev');
    expect(payload.text).toContain('https://staging.example.workers.dev');
    expect(payload.text).toContain('healthz 通过');
    expect(payload.text).not.toContain('old-worker');
    expect(payload.text).not.toContain('older-production');
  });

  it('filters the operator runbook to one smoke environment when requested', async () => {
    const db = new FakeD1();
    db.cronRuns.push(
      {
        id: 1,
        job_name: 'smoke',
        status: 'failed',
        detail: JSON.stringify({
          ok: false,
          target: 'https://staging.example.workers.dev',
          environment: 'staging',
          checks: [{ name: 'rollout_readiness', ok: false }],
        }),
        created_at: '2026-05-27T08:00:00.000Z',
      },
      {
        id: 2,
        job_name: 'smoke',
        status: 'ok',
        detail: JSON.stringify({
          ok: true,
          target: 'https://production.example.workers.dev',
          environment: 'production',
          checks: [{ name: 'healthz', ok: true }],
        }),
        created_at: '2026-05-27T08:30:00.000Z',
      },
      {
        id: 3,
        job_name: 'smoke',
        status: 'ok',
        detail: JSON.stringify({
          ok: true,
          target: 'https://canary.example.workers.dev',
          environment: 'canary',
          checks: [{ name: 'healthz', ok: true }],
        }),
        created_at: '2026-05-27T08:35:00.000Z',
      },
    );
    const env = makeEnv(db, {
      NEWBOT_OPERATOR_TELEGRAM_IDS: '9001',
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
      POLYMARKET_ORDER_SIGNING_SECRET: 'signing-secret',
      POLYMARKET_BUILDER_TAG: 'newbot-builder',
      POLYMARKET_BUILDER_API_KEY: 'builder-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleTelegramWebhook(makeMessageRequest('/runbook production', 9001), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('Phase 29 灰度 runbook（production）');
    expect(payload.text).toContain('最近 smoke：通过');
    expect(payload.text).toContain('环境：production');
    expect(payload.text).toContain('https://production.example.workers.dev');
    expect(payload.text).toContain('- production 通过');
    expect(payload.text).not.toContain('https://canary.example.workers.dev');
    expect(payload.text).not.toContain('https://staging.example.workers.dev');
  });

  it('keeps the rollout runbook behind the operator allowlist', async () => {
    const db = new FakeD1();
    const env = makeEnv(db, {
      NEWBOT_OPERATOR_TELEGRAM_IDS: '9001',
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleTelegramWebhook(makeCallbackRequest('ops_runbook', 1001), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const answerCall = fetchMock.mock.calls.find(([input]) => String(input).includes('answerCallbackQuery'));
    expect(answerCall).toBeDefined();
    const [, answerInit] = answerCall as [string, RequestInit];
    expect(JSON.parse(String(answerInit.body))).toMatchObject({ text: '只有配置过的操作者可以看灰度 runbook', show_alert: true });
    const editCall = fetchMock.mock.calls.find(([input]) => String(input).includes('editMessageText'));
    expect(editCall).toBeDefined();
    const [, editInit] = editCall as [string, RequestInit];
    const payload = JSON.parse(String(editInit.body)) as { text: string };
    expect(payload.text).toContain('这个系统状态入口只给配置过的操作者使用');
    expect(payload.text).not.toContain('Phase 29 灰度 runbook');
  });

  it('lists recent simulated orders', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    db.tradeEvents.push({
      id: 1,
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      event_type: 'buy',
      market_slug: 'btc-break-120k-2026',
      outcome: 'Yes',
      token_id: '111',
      amount_usdc: 50,
      status: 'simulated_submitted',
      order_id: 'sim-1',
      payload_json: '{}',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await handleTelegramWebhook(makeMessageRequest('/orders'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('最近 1 条订单记录');
    expect(payload.text).toContain('btc-break-120k-2026');
    expect(payload.text).toContain('simulated_submitted');
  });
});
