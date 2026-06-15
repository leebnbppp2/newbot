/**
 * Dry-run backend: deterministic, fund-free mock that returns Remote*-shaped
 * data so the Worker can be exercised end-to-end without keys, funds or a
 * deployed CLOB. Used when SIGNER_MODE=dry_run (the default).
 */

import type {
  CancelInput,
  CancelResult,
  OrderBackend,
  OrderStatusResult,
  PlaceOrderInput,
  PlaceOrderResult,
} from './types.ts';
import type { RemoteFill, RemoteOpenOrder, RemotePosition } from '../types.ts';

export function createDryRunBackend(): OrderBackend {
  return {
    async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
      // A market FOK buy is reported as immediately matched, mirroring a real fill.
      return {
        orderId: `dry-${input.clientOrderId}`,
        status: 'matched',
        transactionHashes: [`0xdry${input.clientOrderId.slice(-8)}`],
        filled_size: input.amountUsdc,
        avg_price: input.price ?? 0.5,
        amount_usdc: input.amountUsdc,
      };
    },

    async getOrder(orderId: string): Promise<OrderStatusResult> {
      void orderId;
      return { status: 'matched', filled_size: 10, avg_price: 0.5, remaining_size: 0 };
    },

    async cancelOrder(input: CancelInput): Promise<CancelResult> {
      return { orderId: input.orderId, status: 'cancelled' };
    },

    async openOrders(): Promise<RemoteOpenOrder[]> {
      return [
        { orderId: 'dry-open-1', marketSlug: 'dry-market', outcome: 'Yes', amountUsdc: 10, status: 'live' },
      ];
    },

    async positions(): Promise<RemotePosition[]> {
      return [
        { marketSlug: 'dry-market', outcome: 'Yes', sizeUsdc: 10, avgPrice: 0.5, currentPrice: 0.55, realizedPnl: 0, unrealizedPnl: 0.5 },
      ];
    },

    async fills(): Promise<RemoteFill[]> {
      return [
        { marketSlug: 'dry-market', outcome: 'Yes', amountUsdc: 10, price: 0.5, side: 'BUY' },
      ];
    },
  };
}
