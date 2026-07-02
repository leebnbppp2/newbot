import { describe, expect, it } from 'vitest';

import { Side } from '@polymarket/clob-client-v2';
import {
  builderConfigFromEnv,
  deriveL2Creds,
  normalizePlacedOrder,
  placeOrder,
  polymarketContracts,
} from '../src/lib/polymarket_clob';
import type { Env } from '../src/types';

function baseEnv(over: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown,
    TRADE_COORDINATOR: {} as unknown,
    TELEGRAM_WEBHOOK_SECRET: 's',
    BOT_TOKEN_CRYPTO_ZH: 'b',
    ...over,
  } as Env;
}

describe('polymarket_clob (Phase 44)', () => {
  it('polymarketContracts returns the 5 Polygon contract addresses', () => {
    const c = polymarketContracts();
    for (const addr of [c.ctfExchange, c.negRiskExchange, c.negRiskAdapter, c.conditionalTokens, c.collateral]) {
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('builderConfigFromEnv (V2): undefined without a code, {builderCode} with a code/tag', () => {
    expect(builderConfigFromEnv(baseEnv())).toBeUndefined();
    expect(builderConfigFromEnv(baseEnv({ POLYMARKET_BUILDER_TAG: 'newbot' }))).toEqual({ builderCode: 'newbot' });
    // explicit POLYMARKET_BUILDER_CODE takes precedence over the tag
    expect(
      builderConfigFromEnv(baseEnv({ POLYMARKET_BUILDER_CODE: '0xcode', POLYMARKET_BUILDER_TAG: 'newbot' })),
    ).toEqual({ builderCode: '0xcode' });
  });

  it('deriveL2Creds: returns complete creds via createOrDeriveApiKey', async () => {
    const creds = await deriveL2Creds({
      createOrDeriveApiKey: async () => ({ key: 'ck', secret: 'cs', passphrase: 'cp' }),
    } as never);
    expect(creds).toMatchObject({ key: 'ck', secret: 'cs', passphrase: 'cp' });
  });

  it('deriveL2Creds: throws on incomplete creds (guards the silent-undefined bug)', async () => {
    await expect(
      deriveL2Creds({
        createOrDeriveApiKey: async () => ({ key: undefined, secret: undefined, passphrase: undefined }),
      } as never),
    ).rejects.toThrow(/incomplete/);
  });

  it('placeOrder: signs BUY/FOK with fetched tick/negRisk/fee and normalizes', async () => {
    const calls: Record<string, unknown> = {};
    const client = {
      getTickSize: async () => '0.01',
      getNegRisk: async () => false,
      getFeeRateBps: async () => 0,
      createOrder: async (order: unknown, opts: unknown) => {
        calls.order = order;
        calls.opts = opts;
        return { signed: true };
      },
      postOrder: async (_signed: unknown, orderType: unknown) => {
        calls.orderType = orderType;
        return { orderID: '0xabc', status: 'matched' };
      },
    };
    const res = await placeOrder(client as never, { tokenId: '123', price: 0.62, size: 40 });
    expect(res).toMatchObject({ orderId: '0xabc', status: 'matched' });
    expect(calls.order).toMatchObject({ tokenID: '123', price: 0.62, size: 40, side: Side.BUY });
    expect(calls.opts).toMatchObject({ tickSize: '0.01', negRisk: false });
    expect(calls.orderType).toBe('FOK');
  });

  it('normalizePlacedOrder handles id/status variants', () => {
    expect(normalizePlacedOrder({ orderId: '0x1', status: 'live' })).toMatchObject({ orderId: '0x1', status: 'live' });
    expect(normalizePlacedOrder({ id: '0x2', success: true })).toMatchObject({ orderId: '0x2', status: 'live' });
    expect(normalizePlacedOrder(null)).toMatchObject({ orderId: '', status: 'unknown' });
  });
});
