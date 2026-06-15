import { describe, expect, it } from 'vitest';

import { createSigner } from '../src/signer';
import { BackendError } from '../src/backends/types';
import type { OrderBackend } from '../src/backends/types';
import type { SignerRequest } from '../src/types';
import { API_KEY, SIGNING_SECRET, sampleOrderBody, signedRequest } from './sign';

const NOW = 1_000_000;

function dryRunSigner(options: { backend?: OrderBackend } = {}) {
  return createSigner(
    { mode: 'dry_run', apiKey: API_KEY, signingSecret: SIGNING_SECRET },
    { now: () => NOW, ...(options.backend ? { backend: options.backend } : {}) },
  );
}

function bearerGet(path: string, search = ''): SignerRequest {
  return { method: 'GET', path, search, rawBody: '', body: null, headers: { authorization: `Bearer ${API_KEY}` } };
}

describe('signer handler — routing and dispatch', () => {
  it('rejects any route without a valid bearer token', async () => {
    const signer = dryRunSigner();
    const res = await signer.handle({ method: 'GET', path: '/orders/open', search: '', rawBody: '', body: null, headers: {} });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('places a dry-run order for a correctly signed request', async () => {
    const signer = dryRunSigner();
    const req = await signedRequest({ body: sampleOrderBody(), timestampMs: NOW, nonce: 'place-1' });
    const res = await signer.handle(req);
    expect(res.status).toBe(200);
    const body = res.body as { orderId: string; status: string; amount_usdc: number };
    expect(body.orderId.startsWith('dry-')).toBe(true);
    expect(body.status).toBe('matched');
    expect(body.amount_usdc).toBe(50);
  });

  it('rejects an order whose signature does not verify', async () => {
    const signer = dryRunSigner();
    const req = await signedRequest({ body: sampleOrderBody(), timestampMs: NOW, nonce: 'bad', signingSecret: 'wrong' });
    const res = await signer.handle(req);
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('is idempotent on client_order_id (same id, fresh nonce → one backend call)', async () => {
    let placeCalls = 0;
    const countingBackend: OrderBackend = {
      async placeOrder(input) {
        placeCalls += 1;
        return { orderId: `dry-${input.clientOrderId}`, status: 'matched' };
      },
      async getOrder() { return { status: 'matched' }; },
      async cancelOrder(input) { return { orderId: input.orderId, status: 'cancelled' }; },
      async openOrders() { return []; },
      async positions() { return []; },
      async fills() { return []; },
    };
    const signer = dryRunSigner({ backend: countingBackend });
    const body = sampleOrderBody({ client_order_id: 'nbo-dup-1' });
    const first = await signer.handle(await signedRequest({ body, timestampMs: NOW, nonce: 'dup-a' }));
    const second = await signer.handle(await signedRequest({ body, timestampMs: NOW, nonce: 'dup-b' }));
    expect(first).toEqual(second);
    expect(placeCalls).toBe(1);
  });

  it('maps a BackendError to the unified error envelope with the right HTTP status', async () => {
    const failingBackend: OrderBackend = {
      async placeOrder() { throw new BackendError('INSUFFICIENT_BALANCE', 'balance too low', false); },
      async getOrder() { return { status: 'matched' }; },
      async cancelOrder(input) { return { orderId: input.orderId, status: 'cancelled' }; },
      async openOrders() { return []; },
      async positions() { return []; },
      async fills() { return []; },
    };
    const signer = dryRunSigner({ backend: failingBackend });
    const res = await signer.handle(await signedRequest({ body: sampleOrderBody(), timestampMs: NOW, nonce: 'err-1' }));
    expect(res.status).toBe(402);
    expect((res.body as { error: { code: string; retryable: boolean } }).error).toMatchObject({ code: 'INSUFFICIENT_BALANCE', retryable: false });
  });

  it('returns Remote-shaped open orders / positions / fills', async () => {
    const signer = dryRunSigner();
    const open = await signer.handle(bearerGet('/orders/open', '?bot_id=crypto_zh&telegram_user_id=1001'));
    expect((open.body as { orders: unknown[] }).orders).toEqual([
      { orderId: 'dry-open-1', marketSlug: 'dry-market', outcome: 'Yes', amountUsdc: 10, status: 'live' },
    ]);
    const positions = await signer.handle(bearerGet('/portfolio/positions', '?bot_id=crypto_zh&telegram_user_id=1001'));
    expect((positions.body as { positions: unknown[] }).positions).toHaveLength(1);
    const fills = await signer.handle(bearerGet('/portfolio/fills', '?bot_id=crypto_zh&telegram_user_id=1001'));
    expect((fills.body as { fills: Array<{ side: string }> }).fills[0]?.side).toBe('BUY');
  });

  it('reads a single order status and cancels a signed order', async () => {
    const signer = dryRunSigner();
    const status = await signer.handle(bearerGet('/orders/live-ord-123'));
    expect((status.body as { status: string }).status).toBe('matched');

    const cancel = await signer.handle(await signedRequest({
      method: 'POST',
      path: '/orders/live-ord-123/cancel',
      body: { bot_id: 'crypto_zh', telegram_user_id: '1001', order_id: 'live-ord-123', action: 'cancel' },
      timestampMs: NOW,
      nonce: 'cancel-1',
    }));
    expect(cancel.status).toBe(200);
    expect(cancel.body as { orderId: string; status: string }).toMatchObject({ orderId: 'live-ord-123', status: 'cancelled' });
  });

  it('returns 404 for an unknown route', async () => {
    const signer = dryRunSigner();
    const res = await signer.handle(bearerGet('/nope'));
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('throws when constructed in live mode (live backend not wired yet)', () => {
    expect(() => createSigner({ mode: 'live', apiKey: API_KEY, signingSecret: SIGNING_SECRET })).toThrow(/not wired/i);
  });
});
