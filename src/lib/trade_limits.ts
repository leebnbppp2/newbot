/**
 * App-layer trade limits (Phase 44, G7).
 *
 * Defense-in-depth on top of the Privy enclave policy: per-trade and per-day
 * USDC caps enforced in the Worker before a live order is placed. Pure logic so
 * it is fully unit-testable; the daily total is supplied by the caller (summed
 * from today's trade_events) and the wiring into /buy lives in the webhook.
 */

import type { Env } from '../types';

export interface TradeLimitConfig {
  perTradeMaxUsdc?: number | undefined;
  dailyMaxUsdc?: number | undefined;
}

export interface LimitCheck {
  ok: boolean;
  reason?: string | undefined;
  userMessage?: string | undefined;
}

export function parseTradeLimitsFromEnv(env: Env): TradeLimitConfig {
  return {
    perTradeMaxUsdc: positiveNumber(env.NEWBOT_PER_TRADE_MAX_USDC),
    dailyMaxUsdc: positiveNumber(env.NEWBOT_DAILY_MAX_USDC),
  };
}

/**
 * Check a prospective buy against the caps. `todaysTotalUsdc` is the user's
 * already-spent total for the current day (caller-supplied).
 */
export function checkTradeLimits(
  amountUsdc: number,
  todaysTotalUsdc: number,
  config: TradeLimitConfig,
): LimitCheck {
  if (!(amountUsdc > 0)) {
    return { ok: false, reason: 'invalid_amount', userMessage: '下单金额需要大于 0。' };
  }
  if (config.perTradeMaxUsdc !== undefined && amountUsdc > config.perTradeMaxUsdc) {
    return {
      ok: false,
      reason: 'per_trade_cap',
      userMessage: `单笔上限是 ${config.perTradeMaxUsdc} USDC，这笔 ${amountUsdc} 超了。`,
    };
  }
  if (config.dailyMaxUsdc !== undefined && todaysTotalUsdc + amountUsdc > config.dailyMaxUsdc) {
    const remaining = Math.max(0, config.dailyMaxUsdc - todaysTotalUsdc);
    return {
      ok: false,
      reason: 'daily_cap',
      userMessage: `今日累计上限 ${config.dailyMaxUsdc} USDC，今天还能下 ${remaining} USDC。`,
    };
  }
  return { ok: true };
}

function positiveNumber(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
