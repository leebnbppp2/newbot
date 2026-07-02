/**
 * On-chain Safe setup (Phase 44, G8 provisioning logic).
 *
 * Deploys the user's Gnosis Safe (gasless via Polymarket's Relayer) and grants the
 * USDC + CTF approvals the exchanges need, then records the state in D1. Idempotent:
 * skips deploy/approvals already done. The RelayClient is dependency-injected so the
 * orchestration is unit-tested with a fake; the actual on-chain execution is verified
 * by the live e2e (needs a real Privy key + relayer).
 */

import axios from 'axios';
import { RelayClient } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { encodeFunctionData, maxUint256, type Hex } from 'viem';

import type { Env } from '../types';
import type { TradingAccountRow } from '../db/users';
import { markApprovalsSet, markSafeDeployed } from '../db/users';
import { polymarketContracts } from './polymarket_clob';

/**
 * Builder auth for the Builder Relayer (Safe deploy/approvals/wrap). This is the
 * HMAC builder config (`@polymarket/builder-signing-sdk`), distinct from the V2
 * CLOB `{builderCode}` used for order attribution.
 */
function relayerBuilderConfig(env: Env): BuilderConfig | undefined {
  if (!env.POLYMARKET_BUILDER_API_KEY || !env.POLYMARKET_BUILDER_API_SECRET || !env.POLYMARKET_BUILDER_PASSPHRASE) {
    return undefined;
  }
  return new BuilderConfig({
    localBuilderCreds: {
      key: env.POLYMARKET_BUILDER_API_KEY,
      secret: env.POLYMARKET_BUILDER_API_SECRET,
      passphrase: env.POLYMARKET_BUILDER_PASSPHRASE,
    },
  });
}
import { POLYGON_CHAIN_ID, privyClientFromEnv, walletClientForUser, type TradingPolicyContracts } from './privy_signer';

// Force axios onto the fetch adapter — it's workerd-native and reliable. The
// builder-relayer-client's default (node http) adapter throws "connection error"
// in the Workers runtime; fetch works (the /deployed endpoint is reachable).
(axios.defaults as { adapter?: unknown }).adapter = 'fetch';

export interface RelayTx {
  to: string;
  data: string;
  value: string;
}

export interface RelayLike {
  getDeployed(address: string, type?: string): Promise<boolean>;
  deploy(): Promise<{ wait: () => Promise<unknown> }>;
  execute(txns: RelayTx[], metadata?: string): Promise<{ wait: () => Promise<unknown> }>;
}

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const ERC1155_SET_APPROVAL_ABI = [
  {
    type: 'function',
    name: 'setApprovalForAll',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

/**
 * USDC `approve(MaxUint256)` + CTF `setApprovalForAll(true)` for each Polymarket
 * exchange/adapter operator — the one-time allowances required before trading.
 */
export function buildApprovalTransactions(contracts: TradingPolicyContracts): RelayTx[] {
  const operators = [contracts.ctfExchange, contracts.negRiskExchange, contracts.negRiskAdapter];
  const txns: RelayTx[] = [];

  for (const operator of operators) {
    txns.push({
      to: contracts.collateral,
      value: '0',
      data: encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [operator as Hex, maxUint256],
      }),
    });
  }
  for (const operator of operators) {
    txns.push({
      to: contracts.conditionalTokens,
      value: '0',
      data: encodeFunctionData({
        abi: ERC1155_SET_APPROVAL_ABI,
        functionName: 'setApprovalForAll',
        args: [operator as Hex, true],
      }),
    });
  }
  return txns;
}

export interface SafeSetupResult {
  deployed: boolean;
  approvalsSet: boolean;
}

/**
 * Ensure the user's Safe is deployed and approvals are set (idempotent, gasless).
 * Throws if the account is not provisioned yet.
 */
export async function ensureSafeReady(
  env: Env,
  account: TradingAccountRow,
  telegramUserId: string,
  botId: string,
  deps: { relay?: RelayLike } = {},
): Promise<SafeSetupResult> {
  const safeAddress = account.funder_address;
  if (!safeAddress || !account.privy_wallet_id || !account.signer_address) {
    throw new Error('account is not provisioned (missing wallet/safe)');
  }

  const relay =
    deps.relay ??
    defaultRelay(env, { walletId: account.privy_wallet_id, eoaAddress: account.signer_address });

  let deployed = Boolean(account.safe_deployed_at);
  if (!deployed) {
    const already = await relay.getDeployed(safeAddress);
    if (!already) {
      const tx = await relay.deploy();
      await tx.wait();
    }
    await markSafeDeployed(env, telegramUserId, botId);
    deployed = true;
  }

  let approvalsSet = Boolean(account.approvals_set_at);
  if (!approvalsSet) {
    const tx = await relay.execute(buildApprovalTransactions(polymarketContracts()), 'Set Polymarket token approvals');
    await tx.wait();
    await markApprovalsSet(env, telegramUserId, botId);
    approvalsSet = true;
  }

  return { deployed, approvalsSet };
}

function defaultRelay(env: Env, wallet: { walletId: string; eoaAddress: string }): RelayLike {
  const client = privyClientFromEnv(env);
  const signer = walletClientForUser(client, {
    walletId: wallet.walletId,
    address: wallet.eoaAddress,
    authPrivateKey: env.PRIVY_AUTHORIZATION_PRIVATE_KEY ?? '',
    rpcUrl: env.POLYGON_RPC_URL ?? '',
  });
  // POLYMARKET_RELAYER_URL is a fixed public endpoint (same across all official
  // builder examples); default it so it's optional to configure.
  const relayerUrl = env.POLYMARKET_RELAYER_URL?.trim() || 'https://relayer-v2.polymarket.com';
  // The Builder Relayer is builder-gated — it REQUIRES builder auth, so pass the
  // builder config. The cast works around builder-relayer-client bundling its own
  // (type-incompatible) copy of builder-signing-sdk; the instances are runtime-compatible.
  const builderConfig = relayerBuilderConfig(env);
  const relay = new RelayClient(
    relayerUrl,
    POLYGON_CHAIN_ID,
    signer,
    builderConfig as unknown as ConstructorParameters<typeof RelayClient>[3],
  );
  // Force the relayer's internal axios instance onto the fetch adapter (workerd-native)
  // and drop withCredentials — its default node-http adapter throws "connection error" here.
  const instance = (relay as unknown as { httpClient?: { instance?: { defaults?: Record<string, unknown> } } })
    .httpClient?.instance;
  if (instance?.defaults) {
    instance.defaults.adapter = 'fetch';
    instance.defaults.withCredentials = false;
  }
  const sdk = relay as unknown as RelayLike;
  const base = relayerUrl.replace(/\/$/, '');
  // getDeployed via native fetch (the SDK's axios throws "connection error" in workerd).
  return {
    getDeployed: async (address: string): Promise<boolean> => {
      const resp = await fetch(`${base}/deployed?address=${address}`);
      if (!resp.ok) {
        throw new Error(`relayer /deployed HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as { deployed?: boolean };
      return Boolean(data.deployed);
    },
    deploy: () => sdk.deploy(),
    execute: (txns, metadata) => sdk.execute(txns, metadata),
  };
}
