/**
 * Placeholder Durable Object for Phase 1. Real trade coordination arrives in Phase 5.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';

export class TradeCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ ok: true, placeholder: true }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}
