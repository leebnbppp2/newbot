/**
 * Signer core: transport-agnostic request dispatch.
 *
 * Routes mirror the Worker's existing calls (PHASE_42_2_SIGNER_API.md §4):
 *   POST /orders                  (signed envelope required)
 *   GET  /orders/open             (bearer only)
 *   GET  /orders/:id              (bearer only)
 *   POST /orders/:id/cancel       (signed envelope required)
 *   GET  /portfolio/positions     (bearer only)
 *   GET  /portfolio/fills         (bearer only)
 */

import { hasValidBearer, verifyEnvelope } from './auth.ts';
import type { AuthConfig } from './auth.ts';
import { createDryRunBackend } from './backends/dry_run.ts';
import { createLiveBackend } from './backends/live.ts';
import { BackendError } from './backends/types.ts';
import type { OrderBackend, PlaceOrderInput } from './backends/types.ts';
import { errorEnvelope, httpStatusForCode } from './errors.ts';
import type { SignerMode, SignerRequest, SignerResponse } from './types.ts';

export interface SignerConfig {
  mode: SignerMode;
  apiKey: string;
  signingSecret: string;
}

export interface SignerOptions {
  backend?: OrderBackend;
  now?: () => number;
}

export interface Signer {
  handle(req: SignerRequest): Promise<SignerResponse>;
}

interface HandleDeps {
  backend: OrderBackend;
  auth: AuthConfig;
  now: () => number;
  seenNonces: Set<string>;
  idempotency: Map<string, SignerResponse>;
}

export function createSigner(config: SignerConfig, options: SignerOptions = {}): Signer {
  const backend = options.backend ?? (config.mode === 'live' ? createLiveBackend() : createDryRunBackend());
  const deps: HandleDeps = {
    backend,
    auth: { apiKey: config.apiKey, signingSecret: config.signingSecret },
    now: options.now ?? (() => Date.now()),
    seenNonces: new Set<string>(),
    idempotency: new Map<string, SignerResponse>(),
  };
  return { handle: (req) => handle(req, deps) };
}

function respond(status: number, body: unknown): SignerResponse {
  return { status, body };
}

function backendErrorResponse(error: unknown): SignerResponse {
  if (error instanceof BackendError) {
    return respond(httpStatusForCode(error.code), errorEnvelope(error.code, error.message, error.retryable));
  }
  return respond(500, errorEnvelope('SIGNING_FAILED', 'internal signer error', false));
}

async function handle(req: SignerRequest, deps: HandleDeps): Promise<SignerResponse> {
  const method = req.method.toUpperCase();
  const path = req.path;

  // Coarse-grained bearer gate on every route.
  if (!hasValidBearer(req.headers, deps.auth.apiKey)) {
    return respond(401, errorEnvelope('UNAUTHORIZED', 'missing or invalid bearer token', false));
  }

  if (method === 'POST' && path === '/orders') {
    const verification = await verifyEnvelope(req, deps.auth, deps.now(), deps.seenNonces);
    if (!verification.ok) {
      return respond(401, errorEnvelope('UNAUTHORIZED', verification.reason ?? 'signature verification failed', false));
    }
    const input = parsePlaceOrder(req.body);
    if (!input) {
      return respond(400, errorEnvelope('BAD_REQUEST', 'missing required order fields', false));
    }
    const cached = deps.idempotency.get(input.clientOrderId);
    if (cached) {
      return cached;
    }
    try {
      const result = await deps.backend.placeOrder(input);
      const response = respond(200, result);
      deps.idempotency.set(input.clientOrderId, response);
      return response;
    } catch (error) {
      return backendErrorResponse(error);
    }
  }

  if (method === 'POST' && /^\/orders\/[^/]+\/cancel$/.test(path)) {
    const verification = await verifyEnvelope(req, deps.auth, deps.now(), deps.seenNonces);
    if (!verification.ok) {
      return respond(401, errorEnvelope('UNAUTHORIZED', verification.reason ?? 'signature verification failed', false));
    }
    const orderId = decodeURIComponent(path.slice('/orders/'.length, path.length - '/cancel'.length));
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = await deps.backend.cancelOrder({
        orderId,
        botId: String(body.bot_id ?? ''),
        telegramUserId: String(body.telegram_user_id ?? ''),
      });
      return respond(200, result);
    } catch (error) {
      return backendErrorResponse(error);
    }
  }

  if (method === 'GET' && path === '/orders/open') {
    const query = parseQuery(req.search);
    try {
      const orders = await deps.backend.openOrders(query);
      return respond(200, { orders });
    } catch (error) {
      return backendErrorResponse(error);
    }
  }

  if (method === 'GET' && path === '/portfolio/positions') {
    const query = parseQuery(req.search);
    try {
      const positions = await deps.backend.positions(query);
      return respond(200, { positions });
    } catch (error) {
      return backendErrorResponse(error);
    }
  }

  if (method === 'GET' && path === '/portfolio/fills') {
    const query = parseQuery(req.search);
    try {
      const fills = await deps.backend.fills(query);
      return respond(200, { fills });
    } catch (error) {
      return backendErrorResponse(error);
    }
  }

  if (method === 'GET' && /^\/orders\/[^/]+$/.test(path) && path !== '/orders/open') {
    const orderId = decodeURIComponent(path.slice('/orders/'.length));
    try {
      const result = await deps.backend.getOrder(orderId);
      return respond(200, result);
    } catch (error) {
      return backendErrorResponse(error);
    }
  }

  return respond(404, errorEnvelope('NOT_FOUND', `no route for ${method} ${path}`, false));
}

function parsePlaceOrder(body: unknown): PlaceOrderInput | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const raw = body as Record<string, unknown>;
  const tokenId = asString(raw.token_id);
  const botId = asString(raw.bot_id);
  const telegramUserId = asString(raw.telegram_user_id);
  const clientOrderId = asString(raw.client_order_id);
  const amountUsdc = asNumber(raw.amount_usdc);
  if (!tokenId || !botId || !telegramUserId || !clientOrderId || amountUsdc === null) {
    return null;
  }
  return {
    botId,
    telegramUserId,
    tokenId,
    marketSlug: asString(raw.market_slug) ?? '',
    marketQuestion: asString(raw.market_question) ?? '',
    outcome: asString(raw.outcome) ?? '',
    amountUsdc,
    side: asString(raw.side) ?? 'BUY',
    orderType: asString(raw.order_type) ?? 'FOK',
    price: asNumber(raw.price),
    authMode: asString(raw.auth_mode) ?? '',
    signatureType: asNumber(raw.signature_type) ?? 0,
    clientOrderId,
  };
}

function parseQuery(search: string): { botId: string; telegramUserId: string } {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return {
    botId: params.get('bot_id') ?? '',
    telegramUserId: params.get('telegram_user_id') ?? '',
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
