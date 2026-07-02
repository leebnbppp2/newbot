import { describe, expect, it } from 'vitest';

import { buildApprovalTransactions, ensureSafeReady, type RelayLike } from '../src/lib/safe_setup';
import { polymarketContracts } from '../src/lib/polymarket_clob';
import type { Env } from '../src/types';
import type { TradingAccountRow } from '../src/db/users';

class FakeD1 {
  marks: string[] = [];
  prepare(query: string) {
    return {
      bind: () => ({
        run: async () => {
          if (query.includes('safe_deployed_at')) this.marks.push('safe');
          if (query.includes('approvals_set_at')) this.marks.push('approvals');
          return { success: true };
        },
      }),
    };
  }
}

function makeEnv(db: FakeD1): Env {
  return {
    DB: db as unknown,
    TRADE_COORDINATOR: {} as unknown,
    TELEGRAM_WEBHOOK_SECRET: 's',
    BOT_TOKEN_CRYPTO_ZH: 'b',
  } as Env;
}

function account(over: Partial<TradingAccountRow> = {}): TradingAccountRow {
  return {
    status: 'active',
    auth_mode: 'gnosis_safe',
    account_label: null,
    signer_address: '0xEOA',
    funder_address: '0xSAFE',
    privy_wallet_id: 'wal_1',
    safe_deployed_at: null,
    approvals_set_at: null,
    ...over,
  } as TradingAccountRow;
}

function fakeRelay(state: Record<string, unknown>): RelayLike {
  return {
    getDeployed: async () => Boolean(state.alreadyDeployed),
    deploy: async () => {
      state.deployCalled = true;
      return { wait: async () => undefined };
    },
    execute: async (txns) => {
      state.executed = txns;
      return { wait: async () => undefined };
    },
  };
}

describe('safe_setup (Phase 44 G8 provisioning)', () => {
  it('buildApprovalTransactions: 3 USDC approves + 3 CTF setApprovalForAll', () => {
    const contracts = polymarketContracts();
    const txns = buildApprovalTransactions(contracts);
    expect(txns).toHaveLength(6);
    expect(txns.filter((t) => t.to === contracts.collateral)).toHaveLength(3);
    expect(txns.filter((t) => t.to === contracts.conditionalTokens)).toHaveLength(3);
    for (const t of txns) {
      expect(t.data.startsWith('0x')).toBe(true);
      expect(t.value).toBe('0');
    }
  });

  it('ensureSafeReady (fresh): deploys, sets approvals, marks both', async () => {
    const db = new FakeD1();
    const state: Record<string, unknown> = {};
    const res = await ensureSafeReady(makeEnv(db), account(), '1001', 'crypto_zh', { relay: fakeRelay(state) });
    expect(res).toEqual({ deployed: true, approvalsSet: true });
    expect(state.deployCalled).toBe(true);
    expect((state.executed as unknown[]).length).toBe(6);
    expect(db.marks).toEqual(['safe', 'approvals']);
  });

  it('ensureSafeReady: skips deploy() when the Safe is already on-chain', async () => {
    const db = new FakeD1();
    const state: Record<string, unknown> = { alreadyDeployed: true };
    await ensureSafeReady(makeEnv(db), account(), '1001', 'crypto_zh', { relay: fakeRelay(state) });
    expect(state.deployCalled).toBeUndefined();
    expect(db.marks).toContain('safe');
    expect(db.marks).toContain('approvals');
  });

  it('ensureSafeReady: fully provisioned account short-circuits (no relay calls)', async () => {
    const db = new FakeD1();
    const state: Record<string, unknown> = {};
    const res = await ensureSafeReady(
      makeEnv(db),
      account({ safe_deployed_at: '2026-06-29T00:00:00Z', approvals_set_at: '2026-06-29T00:00:00Z' }),
      '1001',
      'crypto_zh',
      { relay: fakeRelay(state) },
    );
    expect(res).toEqual({ deployed: true, approvalsSet: true });
    expect(state.deployCalled).toBeUndefined();
    expect(state.executed).toBeUndefined();
    expect(db.marks).toEqual([]);
  });

  it('ensureSafeReady: throws when the account is not provisioned', async () => {
    const db = new FakeD1();
    await expect(
      ensureSafeReady(makeEnv(db), account({ funder_address: null }), '1001', 'crypto_zh', { relay: fakeRelay({}) }),
    ).rejects.toThrow();
  });
});
