/**
 * AES-GCM encryption for Polymarket L2 API credentials (Phase 44, G4).
 *
 * The signer derives per-user L2 creds ({key, secret, passphrase}); we never want
 * them in plaintext at rest. This module encrypts them with a Worker secret
 * (NEWBOT_CREDS_ENCRYPTION_KEY) via WebCrypto AES-GCM (no secp256k1 needed, so it
 * runs natively on Workers) and stores only ciphertext in D1
 * (user_trading_credentials.encrypted_payload). Decryption is fail-closed: a
 * missing key, wrong key, or tampered payload throws rather than returning junk.
 *
 * Payload format: `${version}:${base64(iv(12 bytes) || ciphertext+tag)}`.
 */

export interface L2Creds {
  key: string;
  secret: string;
  passphrase: string;
}

const ENC_VERSION = 'v1';
const IV_BYTES = 12;

export async function encryptL2Creds(creds: L2Creds, keyMaterial: string): Promise<string> {
  const cryptoKey = await deriveAesKey(keyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(creds));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext));

  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return `${ENC_VERSION}:${bytesToBase64(packed)}`;
}

export async function decryptL2Creds(payload: string, keyMaterial: string): Promise<L2Creds> {
  const cryptoKey = await deriveAesKey(keyMaterial);

  const sep = payload.indexOf(':');
  if (sep < 0) {
    throw new Error('malformed creds payload');
  }
  const version = payload.slice(0, sep);
  if (version !== ENC_VERSION) {
    throw new Error(`unsupported creds encryption version: ${version}`);
  }

  const packed = base64ToBytes(payload.slice(sep + 1));
  if (packed.length <= IV_BYTES) {
    throw new Error('malformed creds payload');
  }
  const iv = packed.slice(0, IV_BYTES);
  const cipher = packed.slice(IV_BYTES);

  // Rejects on wrong key or tampered ciphertext (GCM auth tag mismatch) -> fail closed.
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, cipher);
  return JSON.parse(new TextDecoder().decode(plaintext)) as L2Creds;
}

async function deriveAesKey(keyMaterial: string): Promise<CryptoKey> {
  if (!keyMaterial) {
    throw new Error('creds encryption key is not configured');
  }
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyMaterial));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
