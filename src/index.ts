/**
 * Worker entrypoint. Phase 1 wires health, version, and Telegram webhook echo routes.
 */

import { TradeCoordinator } from './durable_objects/trade_coordinator';
import { handleHealthz, handleVersion } from './routes/public';
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

    const webhookMatch = url.pathname.match(/^\/telegram\/webhook\/([a-z0-9_\-]+)$/i);
    if (webhookMatch?.[1]) {
      return handleTelegramWebhook(request, env, webhookMatch[1]);
    }

    return new Response('Not found', { status: 404 });
  },
};
