/**
 * Worker entrypoint. Phase 6 wires health, version, Telegram webhook, and link portal routes.
 */

import { TradeCoordinator } from './durable_objects/trade_coordinator';
import { handleHealthz, handleSmokeDashboard, handleSmokeMetrics, handleSmokeReport, handleVersion } from './routes/public';
import { handleLinkPortal, handleLinkPortalComplete } from './routes/portal';
import { handleTelegramWebhook } from './routes/webhook';
import type { Env } from './types';

export { TradeCoordinator };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return handleHealthz(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/version') {
      return handleVersion(env);
    }

    if (request.method === 'POST' && url.pathname === '/ops/smoke-report') {
      return handleSmokeReport(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/ops/smoke-metrics') {
      return handleSmokeMetrics(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/ops/smoke-dashboard') {
      return handleSmokeDashboard(request, env);
    }

    const portalCompleteMatch = url.pathname.match(/^\/portal\/link\/([A-Z0-9]+)\/complete$/i);
    if (request.method === 'POST' && portalCompleteMatch?.[1]) {
      return handleLinkPortalComplete(request, env, portalCompleteMatch[1]);
    }

    const portalMatch = url.pathname.match(/^\/portal\/link\/([A-Z0-9]+)$/i);
    if (request.method === 'GET' && portalMatch?.[1]) {
      return handleLinkPortal(env, portalMatch[1]);
    }

    const webhookMatch = url.pathname.match(/^\/telegram\/webhook\/([a-z0-9_\-]+)$/i);
    if (webhookMatch?.[1]) {
      return handleTelegramWebhook(request, env, webhookMatch[1]);
    }

    return new Response('Not found', { status: 404 });
  },
};
