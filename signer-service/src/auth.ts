/**
 * Internal Worker↔signer HMAC envelope verification
 * (PHASE_42_2_SIGNER_API.md §2). This is the symmetric counterpart to the
 * Worker's `signPayload`/`buildSignedHeaders` in `src/lib/order_gateway.ts`:
 * the Worker signs, the signer verifies the exact same bytes with the same key.
 */

import type { SignerRequest } from './types.ts';

const PROTOCOL_VERSION = 'polymarket_clob_v2';
const TIMESTAMP_WINDOW_MS = 60_000;

export interface AuthConfig {
  apiKey: string;
  signingSecret: string;
}

export interface EnvelopeVerifyResult {
  ok: boolean;
  reason?: string;
}

export function hasValidBearer(headers: Record<string, string>, apiKey: string): boolean {
  return headers['authorization'] === `Bearer ${apiKey}`;
}

/**
 * Verifies the full signed envelope required on write endpoints
 * (POST /orders, POST /orders/:id/cancel). Read endpoints only need the bearer.
 *
 * Steps (matching the Worker, mirrored from order_gateway.ts:signPayload):
 *  1. recompute body SHA-256 over the exact raw body, compare to header
 *  2. timestamp within ±60s of `now`
 *  3. nonce not already seen (replay guard)
 *  4. recompute HMAC over the canonical signatureInput, constant-time compare
 */
export async function verifyEnvelope(
  req: SignerRequest,
  config: AuthConfig,
  now: number,
  seenNonces: Set<string>,
): Promise<EnvelopeVerifyResult> {
  const h = req.headers;
  const signature = h['x-order-signature'];
  const bodySha256 = h['x-order-body-sha256'];
  const timestampMs = h['x-order-timestamp-ms'];
  const nonce = h['x-order-nonce'];
  const authMode = h['x-auth-mode'];
  const protocolVersion = h['x-order-protocol-version'];

  if (!signature || !bodySha256 || !timestampMs || !nonce || !authMode) {
    return { ok: false, reason: 'missing_signature_headers' };
  }
  if (protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, reason: 'unexpected_protocol_version' };
  }

  const actualBodySha256 = await sha256Hex(req.rawBody);
  if (!timingSafeEqualHex(actualBodySha256, bodySha256)) {
    return { ok: false, reason: 'body_tampered' };
  }

  const ts = Number(timestampMs);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  if (seenNonces.has(nonce)) {
    return { ok: false, reason: 'replayed_nonce' };
  }

  const signatureInput = [
    `body_sha256=${actualBodySha256}`,
    `timestamp_ms=${timestampMs}`,
    `nonce=${nonce}`,
    `auth_mode=${authMode}`,
    `protocol_version=${PROTOCOL_VERSION}`,
  ].join(',');
  const expected = await hmacHex(`${authMode}:${config.signingSecret}`, signatureInput);
  if (!timingSafeEqualHex(expected, signature)) {
    return { ok: false, reason: 'bad_signature' };
  }

  seenNonces.add(nonce);
  return { ok: true };
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

/** Constant-time hex comparison to avoid leaking signature bytes via timing. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
