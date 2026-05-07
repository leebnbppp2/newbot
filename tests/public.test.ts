import { describe, expect, it } from 'vitest';

import { handleHealthz, handleVersion } from '../src/routes/public';
import type { Env } from '../src/types';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    TRADE_COORDINATOR: {} as DurableObjectNamespace,
    APP_ENV: 'test',
    NEWBOT_VERSION: '0.6.0',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    BOT_TOKEN_CRYPTO_ZH: 'bot-token',
    ...overrides,
  };
}

describe('public routes', () => {
  it('returns readiness details from /healthz for partial live config', async () => {
    const env = makeEnv({
      POLYMARKET_ORDER_API_BASE: 'https://orders.example.com',
      POLYMARKET_ORDER_API_KEY: 'order-key',
      POLYMARKET_BUILDER_TAG: 'newbot-phase18',
    });

    const response = handleHealthz(new Request('https://example.com/healthz'), env);
    const payload = await response.json() as {
      ok: boolean;
      version: string;
      readiness: {
        live_order_api: boolean;
        signing: boolean;
        builder_attribution: string;
        warnings: string[];
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.version).toBe('0.6.0');
    expect(payload.readiness.live_order_api).toBe(true);
    expect(payload.readiness.signing).toBe(false);
    expect(payload.readiness.builder_attribution).toBe('partial');
    expect(payload.readiness.warnings).toEqual(expect.arrayContaining([
      'Builder Program 配置不完整，归因暂时不会完整生效。',
      'signing secret 还没配置，live 请求暂时不会带 canonical 签名头。',
    ]));
  });

  it('returns only version from /version', async () => {
    const response = handleVersion(makeEnv());
    const payload = await response.json() as { version: string };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ version: '0.6.0' });
  });
});
