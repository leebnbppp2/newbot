import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import {
  getTradingCredentials,
  hasTradingCredentials,
  upsertTradingCredentials,
} from '../src/db/trading_credentials';
import { claimIdempotencyKey, getIdempotencyRecord } from '../src/db/idempotency';
import {
  getTradingAccount,
  markApprovalsSet,
  markSafeDeployed,
  upsertProvisionedWallet,
} from '../src/db/users';
import { createTradeEvent, getTradeEventByClientOrderId } from '../src/db/trade_events';

type Row = Record<string, unknown>;

class FakeD1 {
  credentials = new Map<string, Row>();
  idempotency = new Map<string, Row>();
  accounts = new Map<string, Row>();
  tradeEvents: Row[] = [];
  private seq = 0;

  prepare(query: string) {
    return new FakeStmt(this, query);
  }

  nextId() {
    this.seq += 1;
    return this.seq;
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
    const q = this.query;
    if (q.includes('FROM user_trading_credentials')) {
      const [u, b] = this.values as [string, string];
      return (this.db.credentials.get(`${u}:${b}`) as T) ?? null;
    }
    if (q.includes('FROM idempotency_keys')) {
      const [key] = this.values as [string];
      return (this.db.idempotency.get(key) as T) ?? null;
    }
    if (q.includes('FROM user_trading_accounts')) {
      const [u, b] = this.values as [string, string];
      return (this.db.accounts.get(`${u}:${b}`) as T) ?? null;
    }
    if (q.includes('FROM trade_events') && q.includes('client_order_id = ?')) {
      const [clientOrderId, u, b] = this.values as [string, string, string];
      const row = this.db.tradeEvents.find(
        (e) => e.client_order_id === clientOrderId && e.telegram_user_id === u && e.bot_id === b,
      );
      return (row as T) ?? null;
    }
    throw new Error(`Unsupported first query: ${q}`);
  }

  async run() {
    const q = this.query;

    if (q.includes('INSERT INTO user_trading_credentials')) {
      const [u, b, payload, version] = this.values as [string, string, string, string];
      this.db.credentials.set(`${u}:${b}`, {
        encrypted_payload: payload,
        encryption_version: version,
      });
      return { success: true, meta: {} };
    }

    if (q.includes('INSERT OR IGNORE INTO idempotency_keys')) {
      const [key, action, payloadJson] = this.values as [string, string, string | null];
      if (this.db.idempotency.has(key)) {
        return { success: true, meta: { changes: 0 } };
      }
      this.db.idempotency.set(key, { key, action, payload_json: payloadJson });
      return { success: true, meta: { changes: 1 } };
    }

    if (q.includes('INSERT INTO user_trading_accounts')) {
      const [u, b, status, authMode, signer, funder, deposit, privyUserId, privyWalletId] =
        this.values as [string, string, string, string, string, string, string, string, string];
      const key = `${u}:${b}`;
      const existing = this.db.accounts.get(key) ?? {};
      this.db.accounts.set(key, {
        ...existing,
        status,
        auth_mode: authMode,
        account_label: existing.account_label ?? null,
        signer_address: signer,
        funder_address: funder,
        deposit_address_evm: deposit,
        privy_user_id: privyUserId,
        privy_wallet_id: privyWalletId,
        safe_deployed_at: existing.safe_deployed_at ?? null,
        approvals_set_at: existing.approvals_set_at ?? null,
      });
      return { success: true, meta: {} };
    }

    if (q.includes('UPDATE user_trading_accounts')) {
      const [u, b] = this.values as [string, string];
      const existing = this.db.accounts.get(`${u}:${b}`);
      if (existing) {
        if (q.includes('safe_deployed_at')) existing.safe_deployed_at = '2026-06-29T00:00:00Z';
        if (q.includes('approvals_set_at')) existing.approvals_set_at = '2026-06-29T00:00:00Z';
      }
      return { success: true, meta: {} };
    }

    if (q.includes('INSERT INTO trade_events')) {
      const [u, b, eventType, marketSlug, outcome, tokenId, amount, status, orderId, payloadJson, clientOrderId] =
        this.values as [
          string,
          string,
          string,
          string,
          string,
          string,
          number,
          string,
          string | null,
          string | null,
          string | null,
        ];
      const id = this.db.nextId();
      this.db.tradeEvents.push({
        id,
        telegram_user_id: u,
        bot_id: b,
        event_type: eventType,
        market_slug: marketSlug,
        outcome,
        token_id: tokenId,
        amount_usdc: amount,
        status,
        order_id: orderId,
        payload_json: payloadJson,
        client_order_id: clientOrderId,
      });
      return { success: true, meta: { last_row_id: id } };
    }

    throw new Error(`Unsupported run query: ${q}`);
  }
}

function makeEnv(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    TRADE_COORDINATOR: {} as DurableObjectNamespace,
    APP_ENV: 'test',
    NEWBOT_VERSION: '0.1.0',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    BOT_TOKEN_CRYPTO_ZH: 'bot-token',
  };
}

describe('Phase 44 db modules', () => {
  it('trading credentials: upsert / get / has roundtrip + update', async () => {
    const env = makeEnv(new FakeD1());
    expect(await hasTradingCredentials(env, '1001', 'crypto_zh')).toBe(false);

    await upsertTradingCredentials(env, {
      telegramUserId: '1001',
      botId: 'crypto_zh',
      encryptedPayload: 'CIPHERTEXT',
    });
    expect(await hasTradingCredentials(env, '1001', 'crypto_zh')).toBe(true);
    expect(await getTradingCredentials(env, '1001', 'crypto_zh')).toMatchObject({
      encrypted_payload: 'CIPHERTEXT',
      encryption_version: 'v1',
    });

    await upsertTradingCredentials(env, {
      telegramUserId: '1001',
      botId: 'crypto_zh',
      encryptedPayload: 'CIPHER2',
      encryptionVersion: 'v2',
    });
    expect(await getTradingCredentials(env, '1001', 'crypto_zh')).toMatchObject({
      encrypted_payload: 'CIPHER2',
      encryption_version: 'v2',
    });
  });

  it('idempotency: first claim wins, duplicate is rejected', async () => {
    const env = makeEnv(new FakeD1());
    expect(await claimIdempotencyKey(env, 'nbo-1', 'buy', '{"a":1}')).toBe(true);
    expect(await claimIdempotencyKey(env, 'nbo-1', 'buy', '{"a":1}')).toBe(false);

    expect(await getIdempotencyRecord(env, 'nbo-1')).toMatchObject({ key: 'nbo-1', action: 'buy' });
    expect(await getIdempotencyRecord(env, 'missing')).toBeNull();
  });

  it('provisioned wallet: persist, read back, mark deploy/approvals', async () => {
    const env = makeEnv(new FakeD1());
    await upsertProvisionedWallet(env, {
      telegramUserId: '1001',
      botId: 'crypto_zh',
      privyUserId: 'privy:did:abc',
      privyWalletId: 'wal_123',
      eoaAddress: '0xEOA',
      safeAddress: '0xSAFE',
    });

    let acct = await getTradingAccount(env, '1001', 'crypto_zh');
    expect(acct).toMatchObject({
      status: 'active',
      auth_mode: 'gnosis_safe',
      signer_address: '0xEOA',
      funder_address: '0xSAFE',
      deposit_address_evm: '0xSAFE',
      privy_user_id: 'privy:did:abc',
      privy_wallet_id: 'wal_123',
      safe_deployed_at: null,
      approvals_set_at: null,
    });

    await markSafeDeployed(env, '1001', 'crypto_zh');
    await markApprovalsSet(env, '1001', 'crypto_zh');
    acct = await getTradingAccount(env, '1001', 'crypto_zh');
    expect(acct?.safe_deployed_at).toBeTruthy();
    expect(acct?.approvals_set_at).toBeTruthy();
  });

  it('trade event carries client_order_id and is queryable by it', async () => {
    const env = makeEnv(new FakeD1());
    const id = await createTradeEvent(env, {
      telegramUserId: '1001',
      botId: 'crypto_zh',
      eventType: 'buy',
      marketSlug: 'will-x',
      outcome: 'Yes',
      tokenId: '123',
      amountUsdc: 25,
      status: 'live_submitted',
      orderId: '0xorder',
      payloadJson: null,
      clientOrderId: 'nbo-xyz',
    });
    expect(id).toBe(1);

    expect(await getTradeEventByClientOrderId(env, '1001', 'crypto_zh', 'nbo-xyz')).toMatchObject({
      order_id: '0xorder',
      client_order_id: 'nbo-xyz',
      amount_usdc: 25,
    });
    expect(await getTradeEventByClientOrderId(env, '1001', 'crypto_zh', 'missing')).toBeNull();
  });
});
