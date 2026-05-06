/**
 * Account-link session helpers for Phase 6.
 */
import type { Env } from '../types';
import { upsertTradingAccount } from './users';

export interface AccountLinkSession {
  token: string;
  expiresAt: string;
}

export interface AccountLinkSessionLookup {
  token_hash?: string;
  telegram_user_id: string;
  bot_id: string;
  session_type: string;
  status: string;
  expires_at: string;
}

export interface CompleteAccountLinkInput {
  authMode: string;
  accountLabel: string | null;
  signerAddress: string | null;
  funderAddress: string | null;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

export async function createAccountLinkSession(
  env: Env,
  telegramUserId: string,
  botId: string,
): Promise<AccountLinkSession> {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await env.DB.prepare(
    `INSERT INTO user_account_sessions (
      token_hash,
      telegram_user_id,
      bot_id,
      session_type,
      status,
      expires_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  )
    .bind(tokenHash, telegramUserId, botId, 'account_link', 'open', expiresAt)
    .run();

  return { token, expiresAt };
}

export async function getAccountLinkSessionByToken(
  env: Env,
  token: string,
): Promise<AccountLinkSessionLookup | null> {
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(
    `SELECT token_hash, telegram_user_id, bot_id, status, expires_at, session_type
       FROM user_account_sessions
      WHERE token_hash = ?
      LIMIT 1`,
  )
    .bind(tokenHash)
    .first<AccountLinkSessionLookup>();
}

export async function completeAccountLinkSession(
  env: Env,
  token: string,
  input: CompleteAccountLinkInput,
): Promise<AccountLinkSessionLookup | null> {
  const session = await getAccountLinkSessionByToken(env, token);
  if (!session || session.status !== 'open' || Date.parse(session.expires_at) <= Date.now()) {
    return null;
  }

  await upsertTradingAccount(env, {
    telegramUserId: session.telegram_user_id,
    botId: session.bot_id,
    authMode: input.authMode,
    accountLabel: input.accountLabel,
    signerAddress: input.signerAddress,
    funderAddress: input.funderAddress,
  });

  await env.DB.prepare(
    `UPDATE user_account_sessions
        SET status = ?,
            used_at = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE token_hash = ?`,
  )
    .bind('linked', new Date().toISOString(), session.token_hash ?? (await sha256Hex(token)))
    .run();

  return {
    ...session,
    status: 'linked',
  };
}

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
