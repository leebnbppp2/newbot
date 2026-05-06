/**
 * Account-link session helpers for Phase 4.
 */

import type { Env } from '../types';

export interface AccountLinkSession {
  token: string;
  expiresAt: string;
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

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
