/**
 * Encrypted Polymarket L2 credential persistence (Phase 44).
 *
 * Stores the AES-GCM encrypted L2 API creds ({key, secret, passphrase}) per
 * (telegram_user_id, bot_id). The plaintext only ever lives in memory during a
 * CLOB call; D1 holds ciphertext only (encryption lives in lib/creds_crypto.ts,
 * added in G4). The table `user_trading_credentials` already exists in 0001.
 */

import type { Env } from '../types';

export interface TradingCredentialsRow {
  encrypted_payload: string;
  encryption_version: string;
}

export interface UpsertTradingCredentialsInput {
  telegramUserId: string;
  botId: string;
  encryptedPayload: string;
  encryptionVersion?: string;
}

export async function getTradingCredentials(
  env: Env,
  telegramUserId: string,
  botId: string,
): Promise<TradingCredentialsRow | null> {
  return env.DB.prepare(
    `SELECT encrypted_payload, encryption_version
       FROM user_trading_credentials
      WHERE telegram_user_id = ? AND bot_id = ?
      LIMIT 1`,
  )
    .bind(telegramUserId, botId)
    .first<TradingCredentialsRow>();
}

export async function hasTradingCredentials(
  env: Env,
  telegramUserId: string,
  botId: string,
): Promise<boolean> {
  const row = await getTradingCredentials(env, telegramUserId, botId);
  return row !== null;
}

export async function upsertTradingCredentials(
  env: Env,
  input: UpsertTradingCredentialsInput,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_trading_credentials (
      telegram_user_id,
      bot_id,
      encrypted_payload,
      encryption_version,
      updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id, bot_id) DO UPDATE SET
      encrypted_payload = excluded.encrypted_payload,
      encryption_version = excluded.encryption_version,
      updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(input.telegramUserId, input.botId, input.encryptedPayload, input.encryptionVersion ?? 'v1')
    .run();
}
