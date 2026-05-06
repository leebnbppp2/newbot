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
  used_at?: string | null;
};

type TradingAccountRow = {
  telegram_user_id: string;
  bot_id: string;
  status: string;
  auth_mode: string;
  account_label: string | null;
  signer_address: string | null;
  funder_address: string | null;
};

class FakeD1 {
  accountSessions = new Map<string, AccountSessionRow>();

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

  async run() {
    if (this.query.includes('UPDATE user_account_sessions')) {
      const [status, usedAt, tokenHash] = this.values as [string, string, string];
      const existing = this.db.accountSessions.get(tokenHash);
      if (existing) {
        this.db.accountSessions.set(tokenHash, {
          ...existing,
          status,
          used_at: usedAt,
        });
      }
      return { success: true };
    }

    if (this.query.includes('INSERT INTO user_trading_accounts')) {
      const [telegramUserId, botId, status, authMode, accountLabel, signerAddress, funderAddress] = this.values as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
      ];
      this.db.tradingAccounts.set(`${telegramUserId}:${botId}`, {
        telegram_user_id: telegramUserId,
        bot_id: botId,
        status,
        auth_mode: authMode,
        account_label: accountLabel,
        signer_address: signerAddress,
        funder_address: funderAddress,
      });
      return { success: true };
    }

    throw new Error(`Unsupported run query: ${this.query}`);
  }
}

function makeEnv(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    TRADE_COORDINATOR: {} as DurableObjectNamespace,
    APP_ENV: 'test',
    NEWBOT_VERSION: '0.6.0',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    BOT_TOKEN_CRYPTO_ZH: 'bot-token',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('portal routes', () => {
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
      used_at: null,
    });

    const response = await worker.fetch(new Request(`https://example.com/portal/link/${token}`), makeEnv(db));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('连接你的交易账户');
    expect(body).toContain(token);
    expect(body).toContain('managed signer');
  });

  it('completes account linking from portal form submission', async () => {
    const db = new FakeD1();
    const token = 'LINKTOKEN456';
    const tokenHash = await sha256Hex(token);
    db.accountSessions.set(tokenHash, {
      token_hash: tokenHash,
      telegram_user_id: '1001',
      bot_id: 'crypto_zh',
      session_type: 'account_link',
      status: 'open',
      expires_at: '2099-01-01T00:00:00.000Z',
      used_at: null,
    });

    const response = await worker.fetch(
      new Request(`https://example.com/portal/link/${token}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          auth_mode: 'managed_signer',
          account_label: 'Dora 主账户',
          signer_address: '0x1234567890abcdef1234567890abcdef12345678',
          funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        }),
      }),
      makeEnv(db),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('账户已经绑定完成');
    expect(db.accountSessions.get(tokenHash)?.status).toBe('linked');
    expect(db.tradingAccounts.get('1001:crypto_zh')).toMatchObject({
      status: 'active',
      auth_mode: 'managed_signer',
      account_label: 'Dora 主账户',
      signer_address: '0x1234567890abcdef1234567890abcdef12345678',
      funder_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
  });
});

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
