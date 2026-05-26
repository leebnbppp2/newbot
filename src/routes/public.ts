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
      live_trading_allowlist: readiness.liveTradingAllowlist,
      warnings: readiness.warnings,
    },
  });
}

export function handleVersion(env: Env): Response {
  return json({ version: env.NEWBOT_VERSION ?? '0.1.0' });
}

export async function handleSmokeReport(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  const expectedSecret = env.NEWBOT_SMOKE_REPORT_SECRET?.trim();
  const providedSecret = request.headers.get('x-newbot-smoke-report-secret')?.trim();
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const payload = await request.json() as { ok?: unknown; target?: unknown; checks?: unknown };
  if (typeof payload.ok !== 'boolean' || typeof payload.target !== 'string' || !Array.isArray(payload.checks)) {
    return json({ ok: false, error: 'invalid_smoke_report' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO cron_runs (job_name, status, detail)
     VALUES (?, ?, ?)`,
  )
    .bind('smoke', payload.ok ? 'ok' : 'failed', JSON.stringify(payload))
    .run();

  return json({ ok: true, stored: true });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
