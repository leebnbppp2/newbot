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

class FakeD1 {
  users = new Map<string, UserRow>();

  conversations: ConversationRow[] = [];

  tradingAccounts = new Map<string, TradingAccountRow>();

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

    throw new Error(`Unsupported first query in test fake: ${this.query}`);
  }
}

function makeEnv(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    TRADE_COORDINATOR: {} as DurableObjectNamespace,
    APP_ENV: 'test',
    NEWBOT_VERSION: '0.2.0',
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleTelegramWebhook phase 2', () => {
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
    expect(db.conversations[1]?.content).toContain('欢迎');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      text: string;
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };

    expect(payload.text).toContain('欢迎来到 NewBot');
    expect(payload.text).toContain('先看市场');
    expect(payload.reply_markup?.inline_keyboard).toEqual([
      [{ text: '我的账户', callback_data: 'account_status' }],
      [{ text: '怎么开始', callback_data: 'getting_started' }],
    ]);
  });

  it('returns account status for unlinked users', async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const response = await handleTelegramWebhook(makeMessageRequest('/account'), env, 'crypto_zh');

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toContain('还没绑定交易账户');
    expect(payload.text).toContain('后面我会带你完成');
    expect(db.conversations).toHaveLength(2);
    expect(db.conversations[0]?.content).toBe('/account');
    expect(db.conversations[1]?.content).toContain('还没绑定交易账户');
  });
});
