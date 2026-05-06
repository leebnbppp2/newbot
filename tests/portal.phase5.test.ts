import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/durable_objects/trade_coordinator', () => ({
  TradeCoordinator: class {},
}));

import worker from '../src/index';
import type { Env } from '../src/types';

type AccountSessionRow = {
  token_hash: string;
  telegram_user_id: string;
  bot_id: string;
  session_type: string;
  status: string;
  expires_at: string;
};

class FakeD1 {
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

  async first<T>() {
    if (this.query.includes('FROM user_account_sessions')) {
      const [tokenHash] = this.values as [string];
      const row = this.db.accountSessions.get(tokenHash) ?? null;
      if (!row) {
        return null;
      }
      return {
        telegram_user_id: row.telegram_user_id,
        bot_id: row.bot_id,
        status: row.status,
        expires_at: row.expires_at,
        session_type: row.session_type,
      } as T;
    }

    throw new Error(`Unsupported first query: ${this.query}`);
  }
}

function makeEnv(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    TRADE_COORDINATOR: {} as DurableObjectNamespace,
    APP_ENV: 'test',
    NEWBOT_VERSION: '0.5.0',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    BOT_TOKEN_CRYPTO_ZH: 'bot-token',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('phase 5 portal route', () => {
  it('renders account link portal for a valid session token', async () => {
    const db = new FakeD1();
    const token = 'LINKTOKEN123';
    const tokenHash = await sha256Hex(token);
    db.accountSessions.set(tokenHash, {
      token_hash: tokenHash,
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      session_type: 'account_link',
      status: 'open',
      expires_at: '2099-01-01T00:00:00.000Z',
    });

    const response = await worker.fetch(new Request(`https://example.com/portal/link/${token}`), makeEnv(db));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('连接你的交易账户');
    expect(body).toContain(token);
    expect(body).toContain('managed signer');
  });
});

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
