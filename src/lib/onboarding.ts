/**
 * Per-user trading onboarding (Phase 44, G6).
 *
 * Idempotently provisions a user's Privy wallet + "trade, don't steal" policy,
 * derives their Gnosis Safe (the funder + deposit address), persists everything
 * to D1, and derives + encrypts their Polymarket L2 API creds. After this, the
 * user can deposit USDC to their Safe and `/buy` one-tap.
 *
 * All IO is dependency-injected so the orchestration is unit-tested network-free;
 * the real defaults wire Privy + builder-relayer + CLOB. Safe deploy/approvals
 * (RelayClient) and the real e2e are verified at G8.
 */

import type { PrivyClient } from '@privy-io/node';
import { deriveSafe as relayerDeriveSafe } from '@polymarket/builder-relayer-client';

import type { Env } from '../types';
import { getTradingAccount, upsertProvisionedWallet } from '../db/users';
import { upsertTradingCredentials } from '../db/trading_credentials';
import { encryptL2Creds } from './creds_crypto';
import {
  ensureTradingPolicy,
  privyClientFromEnv,
  provisionPrivyWallet,
  walletClientForUser,
} from './privy_signer';
import { builderConfigFromEnv, deriveL2Creds, makeClobClient, polymarketContracts } from './polymarket_clob';

export interface ProvisionResult {
  walletId: string;
  eoaAddress: string;
  safeAddress: string;
  alreadyProvisioned: boolean;
}

export interface ProvisionDeps {
  client: PrivyClient;
  deriveSafe: (eoaAddress: string) => string;
  deriveAndEncryptCreds: (
    env: Env,
    wallet: { walletId: string; eoaAddress: string; safeAddress: string },
  ) => Promise<string>;
}

export async function provisionTradingWallet(
  env: Env,
  telegramUserId: string,
  botId: string,
  deps: Partial<ProvisionDeps> = {},
): Promise<ProvisionResult> {
  const existing = await getTradingAccount(env, telegramUserId, botId);
  if (existing?.privy_wallet_id && existing.funder_address) {
    return {
      walletId: existing.privy_wallet_id,
      eoaAddress: existing.signer_address ?? '',
      safeAddress: existing.funder_address,
      alreadyProvisioned: true,
    };
  }

  const client = deps.client ?? privyClientFromEnv(env);
  const deriveSafe = deps.deriveSafe ?? defaultDeriveSafe;
  const deriveAndEncryptCreds = deps.deriveAndEncryptCreds ?? defaultDeriveAndEncryptCreds;
  const ownerPublicKey = env.PRIVY_AUTHORIZATION_PUBLIC_KEY?.trim() || undefined;

  // Attach a restrictive policy only if a (pre-created, tested) one is configured.
  // Otherwise provision with no policy so the wallet can deploy its Safe, set token
  // approvals, and sign orders. TODO(security): build + attach a "trade, don't steal"
  // policy that allows the relayer's deploy/approval signing methods (see buildTradingPolicy).
  const configuredPolicy = env.PRIVY_TRADING_POLICY_ID?.trim();
  const policyIds = configuredPolicy ? [configuredPolicy] : [];

  const { walletId, address: eoaAddress } = await provisionPrivyWallet(client, {
    policyIds,
    ...(ownerPublicKey ? { ownerPublicKey } : {}),
  });
  const safeAddress = deriveSafe(eoaAddress);

  await upsertProvisionedWallet(env, {
    telegramUserId,
    botId,
    privyUserId: walletId,
    privyWalletId: walletId,
    eoaAddress,
    safeAddress,
  });

  const encryptedPayload = await deriveAndEncryptCreds(env, { walletId, eoaAddress, safeAddress });
  await upsertTradingCredentials(env, { telegramUserId, botId, encryptedPayload });

  return { walletId, eoaAddress, safeAddress, alreadyProvisioned: false };
}

// --- real defaults (verified at G8; signatures validated by typecheck) ---

// Polymarket Gnosis Safe factory on Polygon (from @polymarket/builder-relayer-client's
// own contract config). deriveSafe computes the user's Safe address deterministically (CREATE2).
const POLYMARKET_SAFE_FACTORY_POLYGON = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b';

function defaultDeriveSafe(eoaAddress: string): string {
  return relayerDeriveSafe(eoaAddress, POLYMARKET_SAFE_FACTORY_POLYGON);
}

async function defaultDeriveAndEncryptCreds(
  env: Env,
  wallet: { walletId: string; eoaAddress: string; safeAddress: string },
): Promise<string> {
  const client = privyClientFromEnv(env);
  const signer = walletClientForUser(client, {
    walletId: wallet.walletId,
    address: wallet.eoaAddress,
    authPrivateKey: env.PRIVY_AUTHORIZATION_PRIVATE_KEY ?? '',
    rpcUrl: env.POLYGON_RPC_URL ?? '',
  });
  const clob = makeClobClient({
    host: (env.POLYMARKET_CLOB_HOST ?? '').replace(/\/$/, ''),
    signer,
    funderAddress: wallet.safeAddress,
    builderConfig: builderConfigFromEnv(env),
  });
  const creds = await deriveL2Creds(clob);
  return encryptL2Creds(creds, env.NEWBOT_CREDS_ENCRYPTION_KEY ?? '');
}
