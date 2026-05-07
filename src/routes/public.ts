/**
 * Public unauthenticated routes exposed by the Worker.
 */

import { getOrderGatewayReadiness } from '../lib/order_gateway';
import type { Env } from '../types';

export function handleHealthz(request: Request, env: Env): Response {
  void request;
  const readiness = getOrderGatewayReadiness(env);
  return json({
    ok: true,
    version: env.NEWBOT_VERSION ?? '0.1.0',
    readiness: {
      live_order_api: readiness.liveOrderApi,
      signing: readiness.signing,
      builder_attribution: readiness.builderAttribution,
      warnings: readiness.warnings,
    },
  });
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
