/**
 * Privy server-wallet integration (Phase 44, G3).
 *
 * Provisions a per-user Privy embedded wallet (the EOA that controls the user's
 * Gnosis Safe) plus a "trade, don't steal" policy, and exposes a viem
 * WalletClient — usable directly as a ClobClient/RelayClient signer — backed by
 * Privy's enclave. The Worker holds only the P-256 authorization private key
 * (PRIVY_AUTHORIZATION_PRIVATE_KEY); the wallet's signing key never leaves Privy.
 *
 * Live calls need a real Privy app; the pure/mockable units here are unit-tested
 * with a fake PrivyClient. End-to-end verification is G8.
 */

import { PrivyClient } from '@privy-io/node';
import { createViemAccount } from '@privy-io/node/viem';
import { createWalletClient, http, type Hex, type WalletClient } from 'viem';
import { polygon } from 'viem/chains';

import type { Env } from '../types';

type WalletCreateInput = Parameters<ReturnType<PrivyClient['wallets']>['create']>[0];
type PolicyCreateInput = Parameters<ReturnType<PrivyClient['policies']>['create']>[0];

export const POLYGON_CHAIN_ID = 137;

export interface TradingPolicyContracts {
  ctfExchange: string;
  negRiskExchange: string;
  negRiskAdapter: string;
  conditionalTokens: string;
  collateral: string;
}

export function privyClientFromEnv(env: Env): PrivyClient {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
    throw new Error('Privy app credentials (PRIVY_APP_ID / PRIVY_APP_SECRET) are not configured');
  }
  return new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
}

/**
 * "Trade, don't steal" policy: ALLOW on-chain sends only to the allowlisted
 * Polymarket contracts and ALLOW off-chain EIP-712 order signing; everything
 * else is default-DENIED inside Privy's enclave.
 *
 * NOTE: calldata-level hardening (approve-only on the collateral token, and a
 * transfer-recipient allowlist so funds can only move to the user's own address)
 * is a G7 refinement — this baseline restricts the destination contract set.
 */
export function buildTradingPolicy(name: string, contracts: TradingPolicyContracts): PolicyCreateInput {
  const allowlist = [
    contracts.ctfExchange,
    contracts.negRiskExchange,
    contracts.negRiskAdapter,
    contracts.conditionalTokens,
    contracts.collateral,
  ].map((address) => address.toLowerCase());

  return {
    chain_type: 'ethereum',
    name,
    version: '1.0',
    rules: [
      {
        name: 'allow-polymarket-contracts',
        method: 'eth_sendTransaction',
        action: 'ALLOW',
        conditions: [{ field_source: 'ethereum_transaction', field: 'to', operator: 'in', value: allowlist }],
      },
      {
        name: 'allow-order-signing',
        method: 'eth_signTypedData_v4',
        action: 'ALLOW',
        // Privy requires ≥1 condition per rule; restrict EIP-712 order signing to Polygon (chainId 137).
        conditions: [{ field_source: 'ethereum_typed_data_domain', field: 'chainId', operator: 'eq', value: '137' }],
      },
    ],
  };
}

export interface ProvisionWalletParams {
  policyIds: string[];
  ownerPublicKey?: string;
}

export async function provisionPrivyWallet(
  client: PrivyClient,
  params: ProvisionWalletParams,
): Promise<{ walletId: string; address: string }> {
  const createParams: WalletCreateInput = {
    chain_type: 'ethereum',
    policy_ids: params.policyIds,
    ...(params.ownerPublicKey ? { owner: { public_key: params.ownerPublicKey } } : {}),
  };
  const wallet = await client.wallets().create(createParams);
  return { walletId: wallet.id, address: wallet.address };
}

export async function ensureTradingPolicy(
  client: PrivyClient,
  params: { name: string; contracts: TradingPolicyContracts; ownerPublicKey?: string },
): Promise<string> {
  const base = buildTradingPolicy(params.name, params.contracts);
  const policy = await client.policies().create(
    params.ownerPublicKey ? { ...base, owner: { public_key: params.ownerPublicKey } } : base,
  );
  return policy.id;
}

/**
 * A viem WalletClient backed by the user's Privy wallet. Both ClobClient and
 * RelayClient accept a viem WalletClient as their signer, so this plugs into
 * both with no ethers adapter.
 */
export function walletClientForUser(
  client: PrivyClient,
  params: { walletId: string; address: string; authPrivateKey: string; rpcUrl: string },
): WalletClient {
  const account = createViemAccount(client, {
    walletId: params.walletId,
    address: params.address as Hex,
    authorizationContext: { authorization_private_keys: [params.authPrivateKey] },
  });
  return createWalletClient({ account, chain: polygon, transport: http(params.rpcUrl) }) as WalletClient;
}
