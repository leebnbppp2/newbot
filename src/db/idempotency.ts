/**
 * Idempotency-key persistence (Phase 44).
 *
 * Backs one-tap /buy dedup: `claimIdempotencyKey` atomically reserves a key via
 * INSERT OR IGNORE and reports whether THIS caller won the claim, so a retried or
 * duplicated submission returns the prior result instead of double-trading. The
 * table `idempotency_keys` already exists in 0001.
 */

import type { Env } from '../types';

export interface IdempotencyRecord {
  key: string;
  action: string;
  payload_json: string | null;
}

/**
 * Atomically reserve `key`. Returns true if this call inserted it (caller owns
 * the action), false if it already existed (duplicate — read the prior result
 * via getIdempotencyRecord).
 */
export async function claimIdempotencyKey(
  env: Env,
  key: string,
  action: string,
  payloadJson: string | null,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (key, action, payload_json, created_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
  )
    .bind(key, action, payloadJson)
    .run();

  const meta = (result as { meta?: { changes?: number } }).meta;
  return (meta?.changes ?? 0) > 0;
}

export async function getIdempotencyRecord(env: Env, key: string): Promise<IdempotencyRecord | null> {
  return env.DB.prepare(
    `SELECT key, action, payload_json
       FROM idempotency_keys
      WHERE key = ?
      LIMIT 1`,
  )
    .bind(key)
    .first<IdempotencyRecord>();
}
