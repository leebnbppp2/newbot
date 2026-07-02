/**
 * User and account persistence helpers for Phase 6.
 */

import type { Env, TelegramMessage, TelegramUser } from '../types';

export interface TradingAccountStatusRow {
  status: string;
}

export interface TradingAccountRow extends TradingAccountStatusRow {
  auth_mode: string;
  account_label: string | null;
  signer_address: string | null;
  funder_address: string | null;
  // Phase 44 (Privy 托管 C):signer_address=EOA、funder_address=Safe、deposit_address_evm=Safe。
  privy_user_id?: string | null;
  privy_wallet_id?: string | null;
  deposit_address_evm?: string | null;
  safe_deployed_at?: string | null;
  approvals_set_at?: string | null;
}

export interface UpsertProvisionedWalletInput {
  telegramUserId: string;
  botId: string;
  privyUserId: string;
  privyWalletId: string;
  eoaAddress: string; // -> signer_address
  safeAddress: string; // -> funder_address + deposit_address_evm
  authMode?: string; // default 'gnosis_safe'
}

export interface UpsertTradingAccountInput {
  telegramUserId: string;
  botId: string;
  authMode: string;
  accountLabel: string | null;
  signerAddress: string | null;
  funderAddress: string | null;
}

export async function upsertTelegramUser(
  env: Env,
  botId: string,
  message: TelegramMessage,
): Promise<void> {
  const telegramUser = message.from;
  if (!telegramUser) {
    return;
  }

  await env.DB.prepare(
    `INSERT INTO users (
      telegram_user_id,
      bot_id,
      telegram_chat_id,
      username,
      first_name,
      last_name,
      language,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id, bot_id) DO UPDATE SET
      telegram_chat_id = excluded.telegram_chat_id,
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      language = excluded.language,
      updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      String(telegramUser.id),
      botId,
      String(message.chat.id),
      telegramUser.username ?? null,
      telegramUser.first_name ?? null,
      telegramUser.last_name ?? null,
      normalizeLanguageCode(telegramUser),
    )
    .run();
}

export async function getTradingAccountStatus(
  env: Env,
  telegramUserId: string,
  botId: string,
): Promise<TradingAccountStatusRow | null> {
  return env.DB.prepare(
    'SELECT status FROM user_trading_accounts WHERE telegram_user_id = ? AND bot_id = ? LIMIT 1',
  )
    .bind(telegramUserId, botId)
    .first<TradingAccountStatusRow>();
}

export async function getTradingAccount(
  env: Env,
  telegramUserId: string,
  botId: string,
): Promise<TradingAccountRow | null> {
  return env.DB.prepare(
    `SELECT status, auth_mode, account_label, signer_address, funder_address,
            privy_user_id, privy_wallet_id, deposit_address_evm, safe_deployed_at, approvals_set_at
       FROM user_trading_accounts
      WHERE telegram_user_id = ? AND bot_id = ?
      LIMIT 1`,
  )
    .bind(telegramUserId, botId)
    .first<TradingAccountRow>();
}

export async function upsertTradingAccount(env: Env, input: UpsertTradingAccountInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_trading_accounts (
      telegram_user_id,
      bot_id,
      status,
      auth_mode,
      account_label,
      signer_address,
      funder_address,
      last_verified_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id, bot_id) DO UPDATE SET
      status = excluded.status,
      auth_mode = excluded.auth_mode,
      account_label = excluded.account_label,
      signer_address = excluded.signer_address,
      funder_address = excluded.funder_address,
      last_verified_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      input.telegramUserId,
      input.botId,
      'active',
      input.authMode,
      input.accountLabel,
      input.signerAddress,
      input.funderAddress,
    )
    .run();
}

/**
 * Persist a Privy-provisioned wallet + Gnosis Safe for a user (Phase 44, G3/G4).
 * Idempotent: re-provisioning the same user overwrites the wallet fields.
 */
export async function upsertProvisionedWallet(env: Env, input: UpsertProvisionedWalletInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_trading_accounts (
      telegram_user_id,
      bot_id,
      status,
      auth_mode,
      signer_address,
      funder_address,
      deposit_address_evm,
      privy_user_id,
      privy_wallet_id,
      last_verified_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id, bot_id) DO UPDATE SET
      status = excluded.status,
      auth_mode = excluded.auth_mode,
      signer_address = excluded.signer_address,
      funder_address = excluded.funder_address,
      deposit_address_evm = excluded.deposit_address_evm,
      privy_user_id = excluded.privy_user_id,
      privy_wallet_id = excluded.privy_wallet_id,
      last_verified_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      input.telegramUserId,
      input.botId,
      'active',
      input.authMode ?? 'gnosis_safe',
      input.eoaAddress,
      input.safeAddress,
      input.safeAddress,
      input.privyUserId,
      input.privyWalletId,
    )
    .run();
}

/** Mark the user's Gnosis Safe as deployed on-chain (Phase 44, G4 lazy deploy). */
export async function markSafeDeployed(env: Env, telegramUserId: string, botId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE user_trading_accounts
        SET safe_deployed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ? AND bot_id = ?`,
  )
    .bind(telegramUserId, botId)
    .run();
}

/** Mark the user's USDC/CTF/Exchange allowances as set (Phase 44, G4 lazy approvals). */
export async function markApprovalsSet(env: Env, telegramUserId: string, botId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE user_trading_accounts
        SET approvals_set_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ? AND bot_id = ?`,
  )
    .bind(telegramUserId, botId)
    .run();
}

function normalizeLanguageCode(user: TelegramUser): string {
  const raw = (user.language_code ?? 'zh').toLowerCase();
  if (raw.startsWith('zh')) {
    return 'zh';
  }
  if (raw.startsWith('en')) {
    return 'en';
  }
  return raw.slice(0, 8) || 'zh';
}
