import { describe, expect, it } from 'vitest';

import { verifyEnvelope } from '../src/auth';
import { SIGNING_SECRET, API_KEY, sampleOrderBody, signedRequest } from './sign';

const config = { apiKey: API_KEY, signingSecret: SIGNING_SECRET };
const NOW = 1_000_000;

describe('signer auth — verifyEnvelope', () => {
  it('accepts a correctly signed envelope and records the nonce', async () => {
    const req = await signedRequest({ body: sampleOrderBody(), timestampMs: NOW, nonce: 'n-ok' });
    const seen = new Set<string>();
    const result = await verifyEnvelope(req, config, NOW, seen);
    expect(result.ok).toBe(true);
    expect(seen.has('n-ok')).toBe(true);
  });

  it('rejects a replayed nonce', async () => {
    const req = await signedRequest({ body: sampleOrderBody(), timestampMs: NOW, nonce: 'n-replay' });
    const seen = new Set<string>();
    const first = await verifyEnvelope(req, config, NOW, seen);
    const second = await verifyEnvelope(req, config, NOW, seen);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('replayed_nonce');
  });

  it('rejects a tampered body', async () => {
    const req = await signedRequest({ body: sampleOrderBody(), timestampMs: NOW, nonce: 'n-tamper' });
    const tampered = { ...req, rawBody: req.rawBody.replace('"amount_usdc":50', '"amount_usdc":5000') };
    const result = await verifyEnvelope(tampered, config, NOW, new Set<string>());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('body_tampered');
  });

  it('rejects a bad signature (wrong signing secret)', async () => {
    const req = await signedRequest({ body: sampleOrderBody(), timestampMs: NOW, nonce: 'n-badsig', signingSecret: 'a-different-secret' });
    const result = await verifyEnvelope(req, config, NOW, new Set<string>());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('rejects a stale timestamp outside the ±60s window', async () => {
    const req = await signedRequest({ body: sampleOrderBody(), timestampMs: NOW, nonce: 'n-stale' });
    const result = await verifyEnvelope(req, config, NOW + 120_000, new Set<string>());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale_timestamp');
  });

  it('rejects when signature headers are missing', async () => {
    const req = await signedRequest({ body: sampleOrderBody(), timestampMs: NOW, nonce: 'n-missing' });
    const stripped = { ...req, headers: { ...req.headers } };
    delete stripped.headers['x-order-signature'];
    const result = await verifyEnvelope(stripped, config, NOW, new Set<string>());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_signature_headers');
  });
});
