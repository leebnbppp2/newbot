import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleTelegramWebhook } from '../src/routes/webhook';
import type { Env } from '../src/types';
import { createSigner } from '../signer-service/src/signer';

/**
 * End-to-end contract test: the real Worker buy flow signs an order with
 * order_gateway.ts, and the real signer service verifies it with auth.ts and
 * responds from the dry-run backend. `fetch` is stubbed to dispatch
 * `https://signer.local/...` into `signer.handle` in-process — no network, no
 * keys, no funds. This proves the HMAC envelope round-trips between the two
 * independent implementations and that the response shapes line up.
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

type ConversationRow = { user_id: string; turn_id: number; role: string; content: string };
type CacheRow = { slug: string; data_json: string; expires_at: string };

class FakeD1 {
  tradingAccounts = new Map<string, TradingAccountRow>();
  tradeEvents: TradeEventRow[] = [];
  conversations: ConversationRow[] = [];
  marketCache = new Map<string, CacheRow>();

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }
}

class FakePreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly db: FakeD1, private readonly query: string) {}

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
      const maxTurnId = this.db.conversations.filter((row) => row.user_id === userId).reduce((max, row) => Math.max(max, row.turn_id), 0);
      return { max_turn_id: maxTurnId } as T;
    }
    if (this.query.includes('SELECT data_json, expires_at FROM market_cache')) {
      const [slug] = this.values as [string];
      const row = this.db.marketCache.get(slug) ?? null;
      return (row ? { data_json: row.data_json, expires_at: row.expires_at } : null) as T | null;
    }
    throw new Error(`Unsupported first query: ${this.query}`);
  }

  async run() {
    if (this.query.includes('INSERT INTO conversations')) {
      const [userId, turnId, role, content] = this.values as [string, number, string, string];
      this.db.conversations.push({ user_id: userId, turn_id: turnId, role, content });
      return { success: true };
    }
    if (this.query.includes('INSERT INTO market_cache')) {
      const [slug, dataJson, _fetchedAt, expiresAt] = this.values as [string, string, string, string];
      this.db.marketCache.set(slug, { slug, data_json: dataJson, expires_at: expiresAt });
      return { success: true };
    }
    if (this.query.includes('INSERT INTO trade_events')) {
      const [telegramUserId, botId, eventType, marketSlug, outcome, tokenId, amountUsdc, status, orderId, payloadJson] = this.values as [
        string, string, string, string, string, string, number, string, string | null, string,
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
    POLYMARKET_ORDER_API_BASE: 'https://signer.local',
    POLYMARKET_ORDER_API_KEY: 'order-key',
    POLYMARKET_ORDER_SIGNING_SECRET: 'signing-secret',
    ...overrides,
  };
}

function makeBuyRequest(text = '/buy btc yes 50') {
  return new Request('https://example.com/telegram/webhook/crypto_zh', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'test-secret' },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 10,
        text,
        chat: { id: 2001, type: 'private' },
        from: { id: 1001, is_bot: false, first_name: 'Dora', username: 'dora', language_code: 'zh-hans' },
      },
    }),
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

function seedAccount(db: FakeD1) {
  db.tradingAccounts.set('1001:crypto_zh', {
    telegram_user_id: '1001',
    bot_id: 'crypto_zh',
    status: 'active',
    auth_mode: 'managed_signer',
    account_label: 'Dora 主账户',
    signer_address: '0x1234567890abcdef1234567890abcdef12345678',
    funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  });
}

/** Route fetch: gamma → market, signer.local → the real signer, telegram → ok. */
function routeFetchToSigner(signer: ReturnType<typeof createSigner>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'gamma-api.polymarket.com') {
      return new Response(JSON.stringify([BTC_MARKET]), { status: 200 });
    }
    if (url.hostname === 'signer.local') {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = String(value);
      }
      const rawBody = init?.body ? String(init.body) : '';
      let body: unknown = null;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = null;
        }
      }
      const result = await signer.handle({ method: init?.method ?? 'GET', path: url.pathname, search: url.search, headers, rawBody, body });
      return new Response(JSON.stringify(result.body), { status: result.status });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Worker ↔ signer-service dry-run integration', () => {
  it('signs a buy in the Worker, verifies it in the signer, and records a live_matched order', async () => {
    const db = new FakeD1();
    seedAccount(db);
    const signer = createSigner({ mode: 'dry_run', apiKey: 'order-key', signingSecret: 'signing-secret' });
    const fetchMock = routeFetchToSigner(signer);

    const response = await handleTelegramWebhook(makeBuyRequest(), makeEnv(db), 'crypto_zh');

    expect(response.status).toBe(200);
    // Signer accepted the HMAC envelope and the dry-run fill flowed back through the Worker.
    expect(db.tradeEvents).toHaveLength(1);
    expect(db.tradeEvents[0]?.status).toBe('live_matched');
    expect(db.tradeEvents[0]?.order_id?.startsWith('dry-')).toBe(true);
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { text: string }).text).toContain('真实下单请求已经发出');
  });

  it('rejects the order when the signer is configured with a different signing secret', async () => {
    const db = new FakeD1();
    seedAccount(db);
    // Signer verifies with the WRONG secret → HMAC mismatch → 401.
    const signer = createSigner({ mode: 'dry_run', apiKey: 'order-key', signingSecret: 'a-different-secret' });
    const fetchMock = routeFetchToSigner(signer);

    const response = await handleTelegramWebhook(makeBuyRequest(), makeEnv(db), 'crypto_zh');

    expect(response.status).toBe(200);
    expect(db.tradeEvents).toHaveLength(1);
    expect(db.tradeEvents[0]?.status).toBe('live_failed');
    expect(db.tradeEvents[0]?.payload_json).toContain('UNAUTHORIZED');
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { text: string }).text).toContain('真实下单没有成功');
  });
});
