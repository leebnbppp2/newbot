import { describe, expect, it } from 'vitest';
import {
  buildSellConfirmReply,
  buildSellPositionsReply,
  buildSellSubmittedReply,
  formatPnl,
  formatRealizedPnl,
  positionPnl,
  type SellablePosition,
} from '../src/agent/replies';
import { computeAvgCostFromBuys } from '../src/lib/order_gateway';

function position(overrides: Partial<SellablePosition> = {}): SellablePosition {
  return {
    tokenId: '1'.repeat(77),
    title: 'BTC 会突破 12 万吗',
    outcome: 'Yes',
    size: 100,
    curPrice: 0.55,
    ...overrides,
  };
}

describe('computeAvgCostFromBuys', () => {
  it('weights cost by USDC spent across buys', () => {
    // 60 USDC @ 0.6 => 100 shares; 40 USDC @ 0.4 => 100 shares; avg = 100/200 = 0.5
    const avg = computeAvgCostFromBuys([
      { amount_usdc: 60, payload_json: JSON.stringify({ price: 0.6 }) },
      { amount_usdc: 40, payload_json: JSON.stringify({ price: 0.4 }) },
    ]);
    expect(avg).toBeCloseTo(0.5, 6);
  });

  it('returns null when no buy carries a usable price', () => {
    expect(computeAvgCostFromBuys([{ amount_usdc: 50, payload_json: JSON.stringify({ price: null }) }])).toBeNull();
    expect(computeAvgCostFromBuys([])).toBeNull();
  });

  it('skips malformed payloads and non-positive amounts', () => {
    const avg = computeAvgCostFromBuys([
      { amount_usdc: 50, payload_json: '{not json' },
      { amount_usdc: 0, payload_json: JSON.stringify({ price: 0.5 }) },
      { amount_usdc: 30, payload_json: JSON.stringify({ price: 0.6 }) },
    ]);
    expect(avg).toBeCloseTo(0.6, 6);
  });
});

describe('positionPnl', () => {
  it('prefers the feed cashPnl / percentPnl when present', () => {
    const pnl = positionPnl(position({ avgPrice: 0.4, cashPnl: 12.5, percentPnl: 30 }));
    expect(pnl).toMatchObject({ known: true, pnl: 12.5, pct: 30, estimated: false });
  });

  it('derives P&L from avgPrice vs curPrice when the feed omits it', () => {
    const pnl = positionPnl(position({ size: 100, curPrice: 0.55, avgPrice: 0.5, costEstimated: true }));
    expect(pnl.known).toBe(true);
    expect(pnl.pnl).toBeCloseTo(5, 6); // (0.55 - 0.5) * 100
    expect(pnl.pct).toBeCloseTo(10, 6);
    expect(pnl.estimated).toBe(true);
  });

  it('is unknown without any cost basis', () => {
    expect(positionPnl(position()).known).toBe(false);
  });
});

describe('formatPnl / formatRealizedPnl', () => {
  it('shows profit, loss, flat, and unknown', () => {
    expect(formatPnl({ known: true, pnl: 13, pct: 30.9, estimated: false })).toContain('📈 浮盈 +$13.00 (+30.9%)');
    expect(formatPnl({ known: true, pnl: -4.1, pct: -9.5, estimated: false })).toContain('📉 浮亏 -$4.10 (-9.5%)');
    expect(formatPnl({ known: true, pnl: 0, pct: 0, estimated: true })).toBe('持平 (估算)');
    expect(formatPnl({ known: false, pnl: 0, pct: 0, estimated: false })).toBe('盈亏:成本未知');
  });

  it('marks estimated cost basis', () => {
    expect(formatPnl({ known: true, pnl: 5, pct: 10, estimated: true })).toContain('(估算)');
  });

  it('realized P&L reflects only the shares sold; null without cost', () => {
    const realized = formatRealizedPnl(position({ curPrice: 0.55, avgPrice: 0.5 }), 50);
    expect(realized).toBe('📈 赚 +$2.50'); // (0.55 - 0.5) * 50
    expect(formatRealizedPnl(position(), 50)).toBeNull();
  });
});

describe('sell replies render P&L', () => {
  it('list shows a cost + P&L line when cost basis is known, and hides it otherwise', () => {
    const withCost = buildSellPositionsReply([position({ avgPrice: 0.5, costEstimated: true })]);
    expect(withCost.text).toContain('成本 0.500');
    expect(withCost.text).toContain('浮盈');
    expect(withCost.text).toContain('(估算)');

    const noCost = buildSellPositionsReply([position()]);
    expect(noCost.text).not.toContain('成本');
    expect(noCost.text).not.toContain('浮盈');
  });

  it('confirm shows realized P&L for the shares being sold', () => {
    const reply = buildSellConfirmReply(position({ curPrice: 0.55, avgPrice: 0.5 }), 'h', 50);
    expect(reply.text).toContain('成本价 0.500');
    expect(reply.text).toContain('这笔预计 📈 赚 +$2.50');
  });

  it('submitted shows realized P&L and hides it when cost unknown', () => {
    const withCost = buildSellSubmittedReply(position({ curPrice: 0.55, avgPrice: 0.5 }), 50, 'order-1', 'live_matched', 'live');
    expect(withCost.text).toContain('预计盈亏:');
    expect(withCost.text).toContain('成本 0.500 → 现价 0.550');

    const noCost = buildSellSubmittedReply(position(), 50, 'order-1', 'sim', 'simulated');
    expect(noCost.text).not.toContain('预计盈亏');
  });
});
