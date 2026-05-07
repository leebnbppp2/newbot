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

class FakeD1 {
  tradingAccounts = new Map<string, TradingAccountRow>();

  tradeEvents: TradeEventRow[] = [];

  conversations: ConversationRow[] = [];

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
      return { success: true };
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

function makeMessageRequest(text: string) {
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
          id: 1001,
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
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(payload.market_slug).toBe('btc-break-120k-2026');
        expect(payload.token_id).toBe('111');
        expect(payload.amount_usdc).toBe(50);
        expect(payload.builder_tag).toBe('newbot-phase8');
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
    expect(db.tradeEvents[0]).toMatchObject({
      market_slug: 'btc-break-120k-2026',
      outcome: 'Yes',
      amount_usdc: 50,
      status: 'live_submitted',
      order_id: 'live-ord-123',
    });
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('真实下单请求已经发出');
    expect(payload.text).toContain('live-ord-123');
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
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://orders.example.com/orders/live-ord-123/cancel') {
        expect(init?.method).toBe('POST');
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

  it('returns live open orders from the remote order API', async () => {
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
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/openorders'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('当前 2 条未成交订单');
    expect(payload.text).toContain('live-open-1');
    expect(payload.text).toContain('btc-break-120k-2026');
  });

  it('returns live positions summary from the remote portfolio API', async () => {
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
            { marketSlug: 'btc-break-120k-2026', outcome: 'Yes', sizeUsdc: 80, avgPrice: 0.61 },
            { marketSlug: 'eth-etf-inflows', outcome: 'No', sizeUsdc: 24, avgPrice: 0.42 },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/positions'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('当前 2 条持仓');
    expect(payload.text).toContain('btc-break-120k-2026');
    expect(payload.text).toContain('80 USDC');
  });

  it('returns recent fills from the remote portfolio API', async () => {
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
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/fills'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('最近 2 条成交记录');
    expect(payload.text).toContain('btc-break-120k-2026');
    expect(payload.text).toContain('buy');
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
