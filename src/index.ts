/**
 * Worker entrypoint. Phase 5 wires health, version, Telegram webhook, and link portal routes.
 */

import { TradeCoordinator } from './durable_objects/trade_coordinator';
import { handleHealthz, handleVersion } from './routes/public';
import { handleLinkPortal } from './routes/portal';
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
