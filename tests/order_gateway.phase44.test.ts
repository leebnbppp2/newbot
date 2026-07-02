import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LiveOrderError,
  buildClobOrderParams,
  executeBuyOrder,
  executeSellOrder,
  fetchDepositWalletFills,
  fetchDepositWalletPositions,
  hasClobLiveConfig,
  type ExecuteBuyOrderInput,
} from '../src/lib/order_gateway';
import { buildSellPositionsReply, tokenKey, type SellablePosition } from '../src/agent/replies';
import type { Env } from '../src/types';

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown,
    TRADE_COORDINATOR: {} as unknown,
    TELEGRAM_WEBHOOK_SECRET: 's',
    BOT_TOKEN_CRYPTO_ZH: 'b',
    ...over,
  } as Env;
}

const CLOB_ENV = makeEnv({
  NEWBOT_TRADING_MODE: 'live',
  PRIVY_APP_ID: 'app',
  PRIVY_APP_SECRET: 'secret',
  PRIVY_AUTHORIZATION_PRIVATE_KEY: 'authkey',
  POLYMARKET_CLOB_HOST: 'https://clob.polymarket.com',
});

function makeInput(over: Partial<ExecuteBuyOrderInput> = {}): ExecuteBuyOrderInput {
  return {
    market: { question: 'Will X happen?', slug: 'will-x', volume: 0 },
    outcome: 'Yes',
    tokenId: '123',
    amountUsdc: 50,
    account: {
      status: 'active',
      auth_mode: 'gnosis_safe',
      account_label: null,
      signer_address: '0xEOA',
      funder_address: '0xSAFE',
      privy_wallet_id: 'wal_1',
    },
    botId: 'crypto_zh',
    telegramUserId: '1001',
    price: 0.5,
    ...over,
  };
}

describe('order_gateway Phase 44 (Path A routing)', () => {
  it('routes live + CLOB config to the injected CLOB path', async () => {
    let called = false;
    const res = await executeBuyOrder(CLOB_ENV, makeInput(), {
      placeClobOrder: async () => {
        called = true;
        return { mode: 'live', status: 'live_matched', orderId: '0xabc', detail: {}, builderAttribution: null };
      },
    });
    expect(called).toBe(true);
    expect(res).toMatchObject({ mode: 'live', orderId: '0xabc', status: 'live_matched' });
  });

  it('forces simulated when trading mode is not live', async () => {
    const res = await executeBuyOrder(makeEnv(), makeInput());
    expect(res.mode).toBe('simulated');
    expect(res.detail).toMatchObject({ reason: 'trading_mode_simulated' });
  });

  it('falls back to simulated when live but neither CLOB nor legacy is configured', async () => {
    const res = await executeBuyOrder(makeEnv({ NEWBOT_TRADING_MODE: 'live' }), makeInput());
    expect(res.mode).toBe('simulated');
    expect(res.detail).toMatchObject({ reason: 'missing_live_order_config' });
  });

  it('hasClobLiveConfig reflects the required env', () => {
    expect(hasClobLiveConfig(CLOB_ENV)).toBe(true);
    expect(hasClobLiveConfig(makeEnv())).toBe(false);
    expect(hasClobLiveConfig(makeEnv({ PRIVY_APP_ID: 'a', PRIVY_APP_SECRET: 's' }))).toBe(false);
  });

  it('buildClobOrderParams computes share size = amount / price', () => {
    expect(buildClobOrderParams(makeInput({ amountUsdc: 50, price: 0.5 }))).toMatchObject({
      tokenId: '123',
      price: 0.5,
      size: 100,
    });
  });

  it('buildClobOrderParams rejects a missing or out-of-range price', () => {
    expect(() => buildClobOrderParams(makeInput({ price: undefined }))).toThrow(LiveOrderError);
    expect(() => buildClobOrderParams(makeInput({ price: 1.5 }))).toThrow(LiveOrderError);
  });
});

describe('order_gateway sell path', () => {
  const account = makeInput().account;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('executeSellOrder posts side=SELL with amount=shares and maps the fill', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, orderId: '0xsell', status: 'matched', wallet: '0xDW' }), { status: 200 }),
    );
    const res = await executeSellOrder(CLOB_ENV, { account, tokenId: '999', shares: 12.5, botId: 'crypto_zh', telegramUserId: '1001' });
    expect(res).toMatchObject({ mode: 'live', orderId: '0xsell', status: 'live_matched' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/place');
    const body = JSON.parse(String(init.body)) as { side: string; amount: number; tokenId: string };
    expect(body).toMatchObject({ side: 'SELL', amount: 12.5, tokenId: '999' });
  });

  it('executeSellOrder stays simulated when trading mode is not live', async () => {
    const res = await executeSellOrder(makeEnv(), { account, tokenId: '999', shares: 1, botId: 'crypto_zh', telegramUserId: '1001' });
    expect(res.mode).toBe('simulated');
  });

  it('fetchDepositWalletPositions returns the sidecar positions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, positions: [{ tokenId: '5'.repeat(30), title: 'Mkt', outcome: 'Yes', size: 4, curPrice: 0.5 }] }), { status: 200 }),
    );
    const positions = await fetchDepositWalletPositions(CLOB_ENV, account);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ outcome: 'Yes', size: 4 });
  });

  it('fetchDepositWalletFills reads the sidecar /fills endpoint (real trade history)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, depositWallet: '0xDW', fills: [{ marketSlug: 'mkt', outcome: 'Yes', amountUsdc: 2, price: 0.5, side: 'BUY' }] }),
        { status: 200 },
      ),
    );
    const fills = await fetchDepositWalletFills(CLOB_ENV, account);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toContain('/fills');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ side: 'BUY', amountUsdc: 2, price: 0.5, outcome: 'Yes' });
  });

  it('fetchDepositWalletFills returns [] without a provisioned wallet', async () => {
    const noWallet = { ...account, privy_wallet_id: null };
    expect(await fetchDepositWalletFills(CLOB_ENV, noWallet)).toEqual([]);
  });

  it('buildSellPositionsReply renders 卖全部/卖一半 buttons keyed by a short token id', () => {
    const positions: SellablePosition[] = [
      { tokenId: '6'.repeat(70), title: 'Long market', outcome: 'Yes', size: 2000, curPrice: 0.0015 },
    ];
    const reply = buildSellPositionsReply(positions);
    const buttons = reply.replyMarkup!.inline_keyboard.flat();
    const key = tokenKey(positions[0]!.tokenId);
    expect(buttons.some((b) => b.callback_data === `sp:${key}:a`)).toBe(true);
    expect(buttons.some((b) => b.callback_data === `sp:${key}:h`)).toBe(true);
    expect(buttons.every((b) => b.callback_data.length <= 64)).toBe(true);
  });
});
