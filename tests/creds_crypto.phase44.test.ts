import { describe, expect, it } from 'vitest';

import { decryptL2Creds, encryptL2Creds, type L2Creds } from '../src/lib/creds_crypto';

const CREDS: L2Creds = { key: 'api-key', secret: 'api-secret', passphrase: 'pass-phrase' };
const KEY = 'super-secret-master-key';

describe('creds_crypto (Phase 44)', () => {
  it('roundtrips encrypt -> decrypt and stores only ciphertext', async () => {
    const payload = await encryptL2Creds(CREDS, KEY);
    expect(payload.startsWith('v1:')).toBe(true);
    expect(payload).not.toContain('api-secret');
    expect(payload).not.toContain('pass-phrase');
    expect(await decryptL2Creds(payload, KEY)).toEqual(CREDS);
  });

  it('uses a random IV so ciphertext differs each time', async () => {
    const a = await encryptL2Creds(CREDS, KEY);
    const b = await encryptL2Creds(CREDS, KEY);
    expect(a).not.toBe(b);
    expect(await decryptL2Creds(b, KEY)).toEqual(CREDS);
  });

  it('fails closed on the wrong key', async () => {
    const payload = await encryptL2Creds(CREDS, KEY);
    await expect(decryptL2Creds(payload, 'wrong-key')).rejects.toThrow();
  });

  it('fails closed on a tampered payload', async () => {
    const payload = await encryptL2Creds(CREDS, KEY);
    const idx = payload.length - 5;
    const flipped = payload[idx] === 'A' ? 'B' : 'A';
    const tampered = payload.slice(0, idx) + flipped + payload.slice(idx + 1);
    await expect(decryptL2Creds(tampered, KEY)).rejects.toThrow();
  });

  it('fails closed when the key material is empty', async () => {
    await expect(encryptL2Creds(CREDS, '')).rejects.toThrow();
    const payload = await encryptL2Creds(CREDS, KEY);
    await expect(decryptL2Creds(payload, '')).rejects.toThrow();
  });
});
