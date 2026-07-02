import { describe, expect, it } from 'vitest';

import type { PrivyClient } from '@privy-io/node';
import {
  buildTradingPolicy,
  ensureTradingPolicy,
  provisionPrivyWallet,
  type TradingPolicyContracts,
} from '../src/lib/privy_signer';

const CONTRACTS: TradingPolicyContracts = {
  ctfExchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  conditionalTokens: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  collateral: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
};

// Minimal fake matching the subset of PrivyClient we call.
function fakeClient(captured: Record<string, unknown>): PrivyClient {
  return {
    wallets: () => ({
      create: (params: unknown) => {
        captured.walletParams = params;
        return Promise.resolve({ id: 'wal_1', address: '0xEOA' });
      },
    }),
    policies: () => ({
      create: (params: unknown) => {
        captured.policyParams = params;
        return Promise.resolve({ id: 'pol_1' });
      },
    }),
  } as unknown as PrivyClient;
}

describe('privy_signer (Phase 44)', () => {
  it('buildTradingPolicy: contract allowlist + order signing, no blanket DENY', () => {
    const policy = buildTradingPolicy('newbot-trading', CONTRACTS);
    expect(policy.chain_type).toBe('ethereum');
    expect(policy.version).toBe('1.0');

    const send = policy.rules.find((r) => r.method === 'eth_sendTransaction' && r.action === 'ALLOW');
    expect(send).toBeTruthy();
    const cond = send?.conditions[0] as { field: string; operator: string; value: string[] };
    expect(cond.field).toBe('to');
    expect(cond.operator).toBe('in');
    expect(cond.value).toContain(CONTRACTS.ctfExchange.toLowerCase());
    expect(cond.value).toContain(CONTRACTS.collateral.toLowerCase());

    expect(policy.rules.some((r) => r.method === 'eth_signTypedData_v4' && r.action === 'ALLOW')).toBe(true);
    // Rely on Privy default-deny; a blanket DENY would also block allowlisted sends.
    expect(policy.rules.some((r) => r.action === 'DENY')).toBe(false);
  });

  it('provisionPrivyWallet: creates an ethereum wallet with policy + owner', async () => {
    const captured: Record<string, unknown> = {};
    const res = await provisionPrivyWallet(fakeClient(captured), {
      policyIds: ['pol_1'],
      ownerPublicKey: '0xPUB',
    });
    expect(res).toEqual({ walletId: 'wal_1', address: '0xEOA' });
    const params = captured.walletParams as { chain_type: string; policy_ids: string[]; owner: unknown };
    expect(params.chain_type).toBe('ethereum');
    expect(params.policy_ids).toEqual(['pol_1']);
    expect(params.owner).toEqual({ public_key: '0xPUB' });
  });

  it('ensureTradingPolicy: creates the policy and returns its id', async () => {
    const captured: Record<string, unknown> = {};
    const id = await ensureTradingPolicy(fakeClient(captured), {
      name: 'newbot-trading',
      contracts: CONTRACTS,
      ownerPublicKey: '0xPUB',
    });
    expect(id).toBe('pol_1');
    const params = captured.policyParams as { rules: unknown[]; owner: unknown };
    expect(params.rules.length).toBeGreaterThanOrEqual(2);
    expect(params.owner).toEqual({ public_key: '0xPUB' });
  });
});
