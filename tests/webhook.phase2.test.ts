import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleTelegramWebhook } from '../src/routes/webhook';
import type { Env } from '../src/types';

type UserRow = {
  telegram_user_id: string;
  bot_id: string;
  telegram_chat_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language: string;
};

type ConversationRow = {
  user_id: string;
  turn_id: number;
  role: string;
  content: string;
};

type TradingAccountRow = {
  telegram_user_id: string;
  bot_id: string;
  status: string;
};

type MarketCacheRow = {
  slug: string;
  data_json: string;
  fetched_at: string;
  expires_at: string;
};

type AccountSessionRow = {
  token_hash: string;
  telegram_user_id: string;
  bot_id: string;
  session_type: string;
  status: string;
  expires_at: string;
};

class FakeD1 {
  users = new Map<string, UserRow>();

  conversations: ConversationRow[] = [];

  tradingAccounts = new Map<string, TradingAccountRow>();

  marketCache = new Map<string, MarketCacheRow>();

  accountSessions = new Map<string, AccountSessionRow>();

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

  async run() {
    if (this.query.includes('INSERT INTO users')) {
      const [telegramUserId, botId, telegramChatId, username, firstName, lastName, language] = this.values as string[];
      this.db.users.set(`${telegramUserId}:${botId}`, {
        telegram_user_id: telegramUserId,
        bot_id: botId,
        telegram_chat_id: telegramChatId,
        username: username ?? null,
        first_name: firstName ?? null,
        last_name: lastName ?? null,
        language,
      });
      return { success: true };
    }

    if (this.query.includes('INSERT INTO conversations')) {
      const [userId, turnId, role, content] = this.values as [string, number, string, string];
      this.db.conversations.push({ user_id: userId, turn_id: turnId, role, content });
      return { success: true };
    }

    if (this.query.includes('INSERT INTO market_cache')) {
      const [slug, dataJson, fetchedAt, expiresAt] = this.values as [string, string, string, string];
      this.db.marketCache.set(slug, {
        slug,
        data_json: dataJson,
        fetched_at: fetchedAt,
        expires_at: expiresAt,
      });
      return { success: true };
    }

    if (this.query.includes('INSERT INTO user_account_sessions')) {
      const [tokenHash, telegramUserId, botId, sessionType, status, expiresAt] = this.values as [string, string, string, string, string, string];
      this.db.accountSessions.set(tokenHash, {
        token_hash: tokenHash,
        telegram_user_id: telegramUserId,
        bot_id: botId,
        session_type: sessionType,
        status,
        expires_at: expiresAt,
      });
      return { success: true };
    }

    throw new Error(`Unsupported run query in test fake: ${this.query}`);
  }

  async first<T>() {
    if (this.query.includes('SELECT status FROM user_trading_accounts')) {
      const [telegramUserId, botId] = this.values as [string, string];
      return (this.db.tradingAccounts.get(`${telegramUserId}:${botId}`) ?? null) as T | null;
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

    throw new Error(`Unsupported first query in test fake: ${this.query}`);
  }
}

function makeEnv(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    TRADE_COORDINATOR: {} as DurableObjectNamespace,
    APP_ENV: 'test',
    NEWBOT_VERSION: '0.4.0',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    BOT_TOKEN_CRYPTO_ZH: 'bot-token',
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

function makeCallbackRequest(data: string) {
  return new Request('https://example.com/telegram/webhook/crypto_zh', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'test-secret',
    },
    body: JSON.stringify({
      update_id: 2,
      callback_query: {
        id: 'cbq-1',
        data,
        from: {
          id: 1001,
          is_bot: false,
          first_name: 'Dora',
          last_name: 'Lee',
          username: 'dora',
          language_code: 'zh-hans',
        },
        message: {
          message_id: 77,
          text: 'old menu',
          chat: { id: 2001, type: 'private' },
        },
      },
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleTelegramWebhook phase 4', () => {
  it('stores user and conversation history, then sends a Chinese start menu', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const response = await handleTelegramWebhook(makeMessageRequest('/start'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(db.users.get('1001:crypto_zh')).toMatchObject({
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      telegram_chat_id: '2001',
      username: 'dora',
      first_name: 'Dora',
      last_name: 'Lee',
      language: 'zh',
    });
    expect(db.conversations).toHaveLength(2);
    expect(db.conversations[0]).toMatchObject({ role: 'user', content: '/start' });
    expect(db.conversations[1]?.role).toBe('assistant');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      text: string;
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };

    expect(payload.text).toContain('欢迎来到 NewBot');
    expect(payload.reply_markup?.inline_keyboard).toEqual([
      [{ text: '看市场', callback_data: 'market_overview' }],
      [{ text: '我的账户', callback_data: 'account_status' }],
      [{ text: '怎么开始', callback_data: 'getting_started' }],
    ]);
  });

  it('returns market overview and caches it', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return new Response(JSON.stringify([
          { question: 'Will BTC break 120k in 2026?', volume: 1234567, endDate: '2026-12-31T00:00:00Z' },
          { question: 'Will ETH ETF inflows beat BTC next quarter?', volume: 456789, endDate: '2026-09-30T00:00:00Z' },
          { question: 'Will SOL hit a new ATH this year?', volume: 222333, endDate: '2026-10-01T00:00:00Z' },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/market'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('gamma-api.polymarket.com/markets');
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('先看 3 个活跃市场');
    expect(payload.text).toContain('BTC break 120k');
    expect(db.marketCache.get('frontpage_overview')).toBeTruthy();
  });

  it('supports keyword market search via /find', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return new Response(JSON.stringify([
          { question: 'Will BTC break 120k in 2026?', volume: 1234567, endDate: '2026-12-31T00:00:00Z' },
          { question: 'Will ETH ETF inflows beat BTC next quarter?', volume: 456789, endDate: '2026-09-30T00:00:00Z' },
          { question: 'Will BTC dominance stay above 55%?', volume: 120000, endDate: '2026-08-01T00:00:00Z' },
          { question: 'Will SOL hit a new ATH this year?', volume: 222333, endDate: '2026-10-01T00:00:00Z' },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/find btc'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('给你找了 3 个和“btc”相关的市场');
    expect(payload.text).toContain('BTC break 120k');
    expect(payload.text).toContain('BTC dominance');
    expect(db.marketCache.get('search:btc')).toBeTruthy();
  });

  it('creates a link session for unbound accounts', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const response = await handleTelegramWebhook(makeMessageRequest('/link'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(db.accountSessions.size).toBe(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('绑定入口已经给你准备好了');
    expect(payload.text).toContain('链接口令');
  });

  it('handles account callback by answering and editing message text', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const response = await handleTelegramWebhook(makeCallbackRequest('account_status'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/answerCallbackQuery');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/editMessageText');
  });

  it('blocks trade entry when account is not linked yet', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const response = await handleTelegramWebhook(makeCallbackRequest('trade_entry'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('下单前要先绑定交易账户');
    expect(payload.text).toContain('我已经把绑定入口给你放好了');
  });

  it('returns a market detail reply for /detail btc', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return new Response(JSON.stringify([
          { question: 'Will BTC break 120k in 2026?', volume: 1234567, endDate: '2026-12-31T00:00:00Z' },
          { question: 'Will ETH ETF inflows beat BTC next quarter?', volume: 456789, endDate: '2026-09-30T00:00:00Z' },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await handleTelegramWebhook(makeMessageRequest('/detail btc'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('你先看这个市场');
    expect(payload.text).toContain('BTC break 120k');
    expect(payload.text).toContain('/buy 50');
  });

  it('returns a buy confirmation placeholder for linked users', async () => {
    const db = new FakeD1();
    db.tradingAccounts.set('1001:crypto_zh', {
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      status: 'active',
    });
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const response = await handleTelegramWebhook(makeMessageRequest('/buy 50'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('下单确认占位');
    expect(payload.text).toContain('50 USDC');
  });

  it('returns 200 instead of crashing when telegram edit fails during callback handling', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response('bad request', { status: 400 }));

    const response = await handleTelegramWebhook(makeCallbackRequest('getting_started'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
