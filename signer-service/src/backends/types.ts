/**
 * Order backend interface. The signer core (signer.ts) talks only to this;
 * `dry_run` returns deterministic mocks, `live` will wrap @polymarket/clob-client.
 */

import type { RemoteFill, RemoteOpenOrder, RemotePosition } from '../types.ts';

export interface PlaceOrderInput {
  botId: string;
  telegramUserId: string;
  tokenId: string;
  marketSlug: string;
  marketQuestion: string;
  outcome: string;
  amountUsdc: number;
  side: string;
  orderType: string;
  price: number | null;
  authMode: string;
  signatureType: number;
  clientOrderId: string;
}

export interface PlaceOrderResult {
  orderId: string;
  status: string;
  transactionHashes?: string[];
  filled_size?: number;
  avg_price?: number;
  amount_usdc?: number;
}

export interface OrderStatusResult {
  status: string;
  filled_size?: number;
  avg_price?: number;
  remaining_size?: number;
}

export interface CancelResult {
  orderId: string;
  status: string;
}

export interface PortfolioQuery {
  botId: string;
  telegramUserId: string;
}

export interface CancelInput {
  orderId: string;
  botId: string;
  telegramUserId: string;
}

export interface OrderBackend {
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  getOrder(orderId: string): Promise<OrderStatusResult>;
  cancelOrder(input: CancelInput): Promise<CancelResult>;
  openOrders(query: PortfolioQuery): Promise<RemoteOpenOrder[]>;
  positions(query: PortfolioQuery): Promise<RemotePosition[]>;
  fills(query: PortfolioQuery): Promise<RemoteFill[]>;
}

/**
 * Structured backend failure. The signer core maps `code` to an HTTP status
 * (errors.ts) and returns the unified error envelope; the Worker maps the same
 * code to a Chinese user message (order_gateway.ts:userMessageForLiveOrderCode).
 */
export class BackendError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.retryable = retryable;
  }
}
