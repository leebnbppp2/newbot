import { describe, expect, it } from 'vitest';

import type { PrivyClient } from '@privy-io/node';
import { provisionTradingWallet } from '../src/lib/onboarding';
import type { Env } from '../src/types';

type Row = Record<string, unknown>;

class FakeD1 {
  accounts = new Map<string, Row>();
  credentials = new Map<string, Row>();
  prepare(query: string) {
    return new FakeStmt(this, query);
  }
}

class FakeStmt {
  private values: unknown[] = [];
  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes('FROM user_trading_accounts')) {
      const [u, b] = this.values as [string, string];
      return (this.db.accounts.get(`${u}:${b}`) as T) ?? null;
    }
    throw new Error(`Unsupported first: ${this.query}`);
  }

  async run() {
    if (this.query.includes('INSERT INTO user_trading_accounts')) {
      const [u, b, status, authMode, signer, funder, deposit, privyUserId, privyWalletId] =
        this.values as [string, string, string, string, string, string, string, string, string];
      this.db.accounts.set(`${u}:${b}`, {
        status,
        auth_mode: authMode,
        account_label: null,
        signer_address: signer,
        funder_address: funder,
        deposit_address_evm: deposit,
        privy_user_id: privyUserId,
        privy_wallet_id: privyWalletId,
        safe_deployed_at: null,
        approvals_set_at: null,
      });
      return { success: true, meta: {} };
    }
    if (this.query.includes('INSERT INTO user_trading_credentials')) {
      const [u, b, payload, version] = this.values as [string, string, string, string];
      this.db.credentials.set(`${u}:${b}`, { encrypted_payload: payload, encryption_version: version });
      return { success: true, meta: {} };
    }
    throw new Error(`Unsupported run: ${this.query}`);
  }
}

function makeEnv(db: FakeD1, over: Partial<Env> = {}): Env {
  return {
    DB: db as unknown,
    TRADE_COORDINATOR: {} as unknown,
    TELEGRAM_WEBHOOK_SECRET: 's',
    BOT_TOKEN_CRYPTO_ZH: 'b',
    NEWBOT_CREDS_ENCRYPTION_KEY: 'master',
    PRIVY_AUTHORIZATION_PUBLIC_KEY: '0xPUB',
    ...over,
  } as Env;
}

function fakePrivy(calls: Record<string, number>): PrivyClient {
  return {
    policies: () => ({
      create: () => {
        calls.policyCreate = (calls.policyCreate ?? 0) + 1;
        return Promise.resolve({ id: 'pol_1' });
      },
    }),
    wallets: () => ({
      create: () => {
        calls.walletCreate = (calls.walletCreate ?? 0) + 1;
        return Promise.resolve({ id: 'wal_1', address: '0xEOA' });
      },
    }),
  } as unknown as PrivyClient;
}

describe('onboarding.provisionTradingWallet (Phase 44 G6)', () => {
  it('provisions wallet + safe + creds and persists them', async () => {
    const db = new FakeD1();
    const calls: Record<string, number> = {};
    let derived = 0;
    let credsBuilt = 0;

    const res = await provisionTradingWallet(makeEnv(db), '1001', 'crypto_zh', {
      client: fakePrivy(calls),
      deriveSafe: () => {
        derived += 1;
        return '0xSAFE';
      },
      deriveAndEncryptCreds: async () => {
        credsBuilt += 1;
        return 'CIPHER';
      },
    });

    expect(res).toEqual({ walletId: 'wal_1', eoaAddress: '0xEOA', safeAddress: '0xSAFE', alreadyProvisioned: false });
    expect(derived).toBe(1);
    expect(credsBuilt).toBe(1);
    expect(db.accounts.get('1001:crypto_zh')).toMatchObject({
      privy_wallet_id: 'wal_1',
      signer_address: '0xEOA',
      funder_address: '0xSAFE',
      deposit_address_evm: '0xSAFE',
    });
    expect(db.credentials.get('1001:crypto_zh')).toMatchObject({ encrypted_payload: 'CIPHER' });
  });

  it('is idempotent — a provisioned user short-circuits without re-provisioning', async () => {
    const db = new FakeD1();
    db.accounts.set('1001:crypto_zh', {
      status: 'active',
      privy_wallet_id: 'wal_existing',
      signer_address: '0xEOA',
      funder_address: '0xSAFE',
    });
    const calls: Record<string, number> = {};
    let derived = 0;

    const res = await provisionTradingWallet(makeEnv(db), '1001', 'crypto_zh', {
      client: fakePrivy(calls),
      deriveSafe: () => {
        derived += 1;
        return '0xNEW';
      },
      deriveAndEncryptCreds: async () => 'CIPHER',
    });

    expect(res).toEqual({
      walletId: 'wal_existing',
      eoaAddress: '0xEOA',
      safeAddress: '0xSAFE',
      alreadyProvisioned: true,
    });
    expect(derived).toBe(0);
    expect(calls.walletCreate ?? 0).toBe(0);
  });

  it('reuses a configured PRIVY_TRADING_POLICY_ID instead of creating one', async () => {
    const db = new FakeD1();
    const calls: Record<string, number> = {};

    await provisionTradingWallet(makeEnv(db, { PRIVY_TRADING_POLICY_ID: 'pol_env' }), '1001', 'crypto_zh', {
      client: fakePrivy(calls),
      deriveSafe: () => '0xSAFE',
      deriveAndEncryptCreds: async () => 'CIPHER',
    });

    expect(calls.policyCreate ?? 0).toBe(0);
    expect(calls.walletCreate).toBe(1);
  });
});
