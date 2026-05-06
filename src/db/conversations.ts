/**
 * Conversation history persistence helpers for Phase 2.
 */

import type { Env } from '../types';

export async function appendConversationTurn(
  env: Env,
  userId: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<void> {
  const nextTurnId = await getNextTurnId(env, userId);

  await env.DB.prepare(
    'INSERT INTO conversations (user_id, turn_id, role, content) VALUES (?, ?, ?, ?)',
  )
    .bind(userId, nextTurnId, role, content)
    .run();
}

async function getNextTurnId(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COALESCE(MAX(turn_id), 0) AS max_turn_id FROM conversations WHERE user_id = ?',
  )
    .bind(userId)
    .first<{ max_turn_id: number }>();

  return (row?.max_turn_id ?? 0) + 1;
}
