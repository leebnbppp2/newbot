/**
 * Test helper: produce a valid signed envelope the same way the Worker does
 * (mirror of order_gateway.ts:signPayload). Used by the signer unit tests to
 * craft accepted/rejected requests. NOT a test file (excluded by the runner glob).
 */

import type { SignerRequest } from '../src/types';

export const API_KEY = 'order-key';
export const SIGNING_SECRET = 'signing-secret';
export const PROTOCOL_VERSION = 'polymarket_clob_v2';

export interface SignOptions {
  method?: string;
  path?: string;
  body: Record<string, unknown>;
  authMode?: string;
  nonce?: string;
  timestampMs?: number;
  apiKey?: string;
  signingSecret?: string;
}

export async function signedRequest(options: SignOptions): Promise<SignerRequest> {
  const authMode = options.authMode ?? 'managed_signer';
  const nonce = options.nonce ?? 'nonce-1';
  const timestampMs = options.timestampMs ?? 1_000_000;
  const apiKey = options.apiKey ?? API_KEY;
  const signingSecret = options.signingSecret ?? SIGNING_SECRET;
  const rawBody = JSON.stringify(options.body);
  const bodySha256 = await sha256Hex(rawBody);
  const signatureInput = [
    `body_sha256=${bodySha256}`,
    `timestamp_ms=${timestampMs}`,
    `nonce=${nonce}`,
    `auth_mode=${authMode}`,
    `protocol_version=${PROTOCOL_VERSION}`,
  ].join(',');
  const signature = await hmacHex(`${authMode}:${signingSecret}`, signatureInput);
  return {
    method: options.method ?? 'POST',
    path: options.path ?? '/orders',
    search: '',
    rawBody,
    body: options.body,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-auth-mode': authMode,
      'x-order-signature': signature,
      'x-order-body-sha256': bodySha256,
      'x-order-signature-input': signatureInput,
      'x-order-protocol-version': PROTOCOL_VERSION,
      'x-order-timestamp-ms': String(timestampMs),
      'x-order-nonce': nonce,
    },
  };
}

export function sampleOrderBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bot_id: 'crypto_zh',
    telegram_user_id: '1001',
    token_id: '111',
    market_slug: 'btc-break-120k-2026',
    market_question: 'Will BTC break 120k in 2026?',
    outcome: 'Yes',
    amount_usdc: 50,
    side: 'BUY',
    order_type: 'FOK',
    price: 0.61,
    auth_mode: 'managed_signer',
    signature_type: 1,
    client_order_id: 'nbo-1000000-abc12345',
    timestamp_ms: 1_000_000,
    nonce: 'nonce-1',
    protocol: 'polymarket_clob_v2',
    ...overrides,
  };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(digest);
}

async function hmacHex(keyMaterial: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toHex(signature);
}

function toHex(input: ArrayBuffer): string {
  return Array.from(new Uint8Array(input))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
