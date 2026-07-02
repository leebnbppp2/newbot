import { describe, expect, it } from 'vitest';

import { checkTradeLimits, parseTradeLimitsFromEnv } from '../src/lib/trade_limits';
import type { Env } from '../src/types';

function env(over: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown,
    TRADE_COORDINATOR: {} as unknown,
    TELEGRAM_WEBHOOK_SECRET: 's',
    BOT_TOKEN_CRYPTO_ZH: 'b',
    ...over,
  } as Env;
}

describe('trade_limits (Phase 44 G7)', () => {
  it('parseTradeLimitsFromEnv reads positive numbers, ignores junk', () => {
    expect(parseTradeLimitsFromEnv(env())).toEqual({ perTradeMaxUsdc: undefined, dailyMaxUsdc: undefined });
    expect(
      parseTradeLimitsFromEnv(env({ NEWBOT_PER_TRADE_MAX_USDC: '25', NEWBOT_DAILY_MAX_USDC: '100' })),
    ).toEqual({ perTradeMaxUsdc: 25, dailyMaxUsdc: 100 });
    expect(parseTradeLimitsFromEnv(env({ NEWBOT_PER_TRADE_MAX_USDC: 'abc' })).perTradeMaxUsdc).toBeUndefined();
    expect(parseTradeLimitsFromEnv(env({ NEWBOT_PER_TRADE_MAX_USDC: '-5' })).perTradeMaxUsdc).toBeUndefined();
  });

  it('allows when within caps (or no caps set)', () => {
    expect(checkTradeLimits(50, 0, {}).ok).toBe(true);
    expect(checkTradeLimits(25, 40, { perTradeMaxUsdc: 25, dailyMaxUsdc: 100 }).ok).toBe(true);
  });

  it('rejects non-positive amounts', () => {
    expect(checkTradeLimits(0, 0, {}).ok).toBe(false);
    expect(checkTradeLimits(-1, 0, {}).reason).toBe('invalid_amount');
  });

  it('enforces the per-trade cap', () => {
    const r = checkTradeLimits(30, 0, { perTradeMaxUsdc: 25 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('per_trade_cap');
  });

  it('enforces the daily cap against the running total', () => {
    const r = checkTradeLimits(30, 80, { dailyMaxUsdc: 100 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('daily_cap');
    expect(r.userMessage).toContain('20');
  });
});
