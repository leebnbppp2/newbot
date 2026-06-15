/**
 * Runtime config from environment variables.
 *
 * SIGNER_API_KEY / SIGNER_SIGNING_SECRET MUST match the Worker's
 * POLYMARKET_ORDER_API_KEY / POLYMARKET_ORDER_SIGNING_SECRET, otherwise the
 * HMAC envelope check will reject every write request.
 */

import type { SignerMode } from './types.ts';

export interface LoadedConfig {
  mode: SignerMode;
  apiKey: string;
  signingSecret: string;
  port: number;
}

export function loadConfig(env: Record<string, string | undefined>): LoadedConfig {
  const mode: SignerMode = env.SIGNER_MODE?.trim().toLowerCase() === 'live' ? 'live' : 'dry_run';
  const apiKey = env.SIGNER_API_KEY?.trim();
  const signingSecret = env.SIGNER_SIGNING_SECRET?.trim();
  if (!apiKey || !signingSecret) {
    throw new Error('SIGNER_API_KEY and SIGNER_SIGNING_SECRET are required.');
  }
  const port = Number(env.SIGNER_PORT ?? '8787');
  return {
    mode,
    apiKey,
    signingSecret,
    port: Number.isFinite(port) && port > 0 ? port : 8787,
  };
}
