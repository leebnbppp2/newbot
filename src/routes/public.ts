/**
 * Public unauthenticated routes exposed by the Worker.
 */

import type { Env } from '../types';

export function handleHealthz(request: Request, env: Env): Response {
  void request;
  return json({ ok: true, version: env.NEWBOT_VERSION ?? '0.1.0' });
}

export function handleVersion(env: Env): Response {
  return json({ version: env.NEWBOT_VERSION ?? '0.1.0' });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
