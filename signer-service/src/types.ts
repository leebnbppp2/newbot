/**
 * Shared types for the NewBot signer service.
 *
 * The Remote* shapes here MUST stay byte-compatible with the Worker's
 * `src/agent/replies.ts` (RemoteOpenOrder / RemotePosition / RemoteFill),
 * so the Worker can render signer responses without any reshaping.
 */

export type SignerMode = 'dry_run' | 'live';

export interface RemoteOpenOrder {
  orderId: string;
  marketSlug: string;
  outcome: string;
  amountUsdc: number;
  status: string;
}

export interface RemotePosition {
  marketSlug: string;
  outcome: string;
  sizeUsdc: number;
  avgPrice?: number;
  currentPrice?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
}

export interface RemoteFill {
  marketSlug: string;
  outcome: string;
  amountUsdc: number;
  price?: number;
  side: string;
}

/**
 * Transport-agnostic request handed to the signer core. The node:http
 * server (server.ts) and the in-process test harness both build this shape.
 * `rawBody` is the exact body string the client sent — it is what the body
 * SHA-256 in the auth envelope is computed over, so it must not be re-serialized.
 */
export interface SignerRequest {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  rawBody: string;
  body: unknown;
}

export interface SignerResponse {
  status: number;
  body: unknown;
}
