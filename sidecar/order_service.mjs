// Local order-placement sidecar (node) — runs the PROVEN @polymarket/client recipe,
// now MULTI-USER + AUTO-WRAP. The Cloudflare Worker (/buy, /deposit) calls this over
// localhost since @polymarket/client + the relayer use node APIs that don't run in workerd.
//
// Endpoints (all POST, auth via x-order-token header):
//   /place  { walletId, eoaAddress, safeAddress, tokenId, amount, side? }
//           -> ensures the deposit wallet has enough pUSD (auto-wraps the user's own
//              Safe USDC.e -> pUSD via the relayer, gaslessly), then places a market order.
//   /wallet { walletId, eoaAddress?, safeAddress? }
//           -> read-only: returns the user's deposit wallet + balances (no money moves).
//   /positions { walletId }
//           -> read-only: the deposit wallet's current Polymarket positions (for selling).
//   /fund   { walletId, eoaAddress, safeAddress, amount? }
//           -> explicit wrap of `amount` (or the full Safe balance) USDC.e -> pUSD to the deposit wallet.
//   GET /healthz -> { ok }
//
// Flags: ORDER_SERVICE_DRYRUN=1 (place returns a fake fill; wrap only logs),
//        ORDER_SERVICE_AUTO_WRAP=0 (disable auto-wrap in /place).
import http from 'node:http';
import * as PM from '@polymarket/client';
import { signerFrom } from '@polymarket/client/privy';
import { builderApiKey } from '@polymarket/client/node';
import { PrivyClient } from '@privy-io/node';
import { createViemAccount } from '@privy-io/node/viem';
import { RelayClient, deriveSafe } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { createWalletClient, createPublicClient, http as viemHttp, encodeFunctionData } from 'viem';
import { polygon } from 'viem/chains';
import axios from 'axios';

axios.defaults.adapter = 'fetch';

const PORT = Number(process.env.ORDER_SERVICE_PORT || 8799);
const AUTH_TOKEN = process.env.ORDER_SERVICE_TOKEN || 'local-newbot';
const DRYRUN = process.env.ORDER_SERVICE_DRYRUN === '1';
const AUTO_WRAP = process.env.ORDER_SERVICE_AUTO_WRAP !== '0';
const RELAYER = (process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com').replace(/\/$/, '');
const RPC = process.env.POLYGON_RPC_URL;
const AUTH_KEY = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
// Polymarket Gnosis Safe factory on Polygon (matches src/lib/onboarding.ts).
const SAFE_FACTORY = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b';

// V2 collateral contracts (2026-04-28 upgrade): trade in pUSD, deposits arrive as USDC.e.
const USDCE = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const ONRAMP = '0x93070a847efEf7F70739046A929D47a521F5B8ee';

const ERC20 = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const ONRAMP_ABI = [{ type: 'function', name: 'wrap', stateMutability: 'nonpayable', inputs: [{ name: '_asset', type: 'address' }, { name: '_to', type: 'address' }, { name: '_amount', type: 'uint256' }], outputs: [] }];

const privy = new PrivyClient({ appId: process.env.PRIVY_APP_ID, appSecret: process.env.PRIVY_APP_SECRET });
const apiKey = builderApiKey({
  key: process.env.POLYMARKET_BUILDER_API_KEY,
  secret: process.env.POLYMARKET_BUILDER_API_SECRET,
  passphrase: process.env.POLYMARKET_BUILDER_PASSPHRASE,
});
const pub = createPublicClient({ transport: viemHttp(RPC) });

const toWei = (usd) => BigInt(Math.round(Number(usd) * 1e6));
const fmt = (wei) => (Number(wei) / 1e6).toFixed(6);
const bal = (token, who) => pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] });

// --- caches keyed by walletId ---
const clients = new Map();   // walletId -> SecureClient (trading)
const relayers = new Map();  // walletId:eoa -> RelayClient (gasless wrap)

async function clientFor(walletId) {
  if (clients.has(walletId)) return clients.get(walletId);
  const signer = signerFrom({ privy, walletId, authorizationContext: { authorization_private_keys: [AUTH_KEY] } });
  const sc = await PM.createSecureClient({ signer, apiKey });
  clients.set(walletId, sc);
  return sc;
}

function relayerFor(walletId, eoaAddress) {
  const cacheKey = `${walletId}:${eoaAddress}`;
  if (relayers.has(cacheKey)) return relayers.get(cacheKey);
  const account = createViemAccount(privy, { walletId, address: eoaAddress, authorizationContext: { authorization_private_keys: [AUTH_KEY] } });
  const signer = createWalletClient({ account, chain: polygon, transport: viemHttp(RPC) });
  const builderConfig = new BuilderConfig({ localBuilderCreds: { key: process.env.POLYMARKET_BUILDER_API_KEY, secret: process.env.POLYMARKET_BUILDER_API_SECRET, passphrase: process.env.POLYMARKET_BUILDER_PASSPHRASE } });
  const relay = new RelayClient(RELAYER, 137, signer, builderConfig);
  const inst = relay?.httpClient?.instance;
  if (inst?.defaults) { inst.defaults.adapter = 'fetch'; inst.defaults.withCredentials = false; }
  relayers.set(cacheKey, relay);
  return relay;
}

/** Wrap `wrapWei` of the user's Safe USDC.e into pUSD credited to their deposit wallet (gasless). */
async function wrapToDepositWallet({ walletId, eoaAddress, safeAddress, depositWallet, wrapWei }) {
  if (DRYRUN) {
    console.log(`[wrap][dryrun] would wrap ${fmt(wrapWei)} USDC.e from Safe ${safeAddress} -> pUSD to DW ${depositWallet}`);
    return { wrapped: fmt(wrapWei), dryRun: true };
  }
  const relay = relayerFor(walletId, eoaAddress);
  const txns = [
    { to: USDCE, value: '0', data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [ONRAMP, wrapWei] }) },
    { to: ONRAMP, value: '0', data: encodeFunctionData({ abi: ONRAMP_ABI, functionName: 'wrap', args: [USDCE, depositWallet, wrapWei] }) },
  ];
  console.log(`[wrap] wrapping ${fmt(wrapWei)} USDC.e from Safe ${safeAddress} -> pUSD to DW ${depositWallet} ...`);
  const tx = await relay.execute(txns, 'auto-fund deposit wallet with pUSD');
  await tx.wait();
  await new Promise((r) => setTimeout(r, 4000));
  return { wrapped: fmt(wrapWei), txHash: tx?.hash ?? null };
}

/** Ensure the deposit wallet holds >= needWei pUSD; auto-wrap the user's Safe USDC.e if short. */
async function ensurePusd({ walletId, eoaAddress, safeAddress, depositWallet, needWei }) {
  const dwPusd = await bal(PUSD, depositWallet);
  if (dwPusd >= needWei) return { ok: true, wrapped: null, dwPusd: fmt(dwPusd) };

  const safe = safeAddress || deriveSafe(eoaAddress, SAFE_FACTORY);
  const safeUsdce = await bal(USDCE, safe);
  if (dwPusd + safeUsdce < needWei) {
    return { ok: false, reason: 'insufficient_funds', dwPusd: fmt(dwPusd), safeUsdce: fmt(safeUsdce), need: fmt(needWei) };
  }
  // Convert the whole Safe balance so later buys skip the wrap round-trip.
  const wrap = await wrapToDepositWallet({ walletId, eoaAddress, safeAddress: safe, depositWallet, wrapWei: safeUsdce });
  const dwAfter = DRYRUN ? dwPusd + safeUsdce : await bal(PUSD, depositWallet);
  return { ok: DRYRUN ? true : dwAfter >= needWei, wrapped: wrap.wrapped, dwPusd: fmt(dwAfter), tx: wrap.txHash ?? null };
}

const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, dryRun: DRYRUN, autoWrap: AUTO_WRAP });
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
  if (req.headers['x-order-token'] !== AUTH_TOKEN) return send(res, 401, { error: 'unauthorized' });

  let payload;
  try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }

  try {
    if (req.url === '/wallet') {
      const { walletId, eoaAddress, safeAddress } = payload;
      if (!walletId) return send(res, 400, { error: 'walletId required' });
      const sc = await clientFor(walletId);
      const depositWallet = sc.account?.wallet;
      const safe = safeAddress || (eoaAddress ? deriveSafe(eoaAddress, SAFE_FACTORY) : null);
      const [dwPusd, dwUsdce, safeUsdce] = await Promise.all([
        bal(PUSD, depositWallet),
        bal(USDCE, depositWallet),
        safe ? bal(USDCE, safe) : Promise.resolve(0n),
      ]);
      return send(res, 200, {
        ok: true,
        depositWallet,
        safe,
        balances: { depositPusd: fmt(dwPusd), depositUsdce: fmt(dwUsdce), safeUsdce: fmt(safeUsdce) },
      });
    }

    if (req.url === '/positions') {
      const { walletId } = payload;
      if (!walletId) return send(res, 400, { error: 'walletId required' });
      const sc = await clientFor(walletId);
      const depositWallet = sc.account?.wallet;
      let positions = [];
      try {
        const r = await fetch(`https://data-api.polymarket.com/positions?user=${depositWallet}`, { headers: { accept: 'application/json' } });
        if (r.ok) {
          const raw = await r.json();
          positions = (Array.isArray(raw) ? raw : [])
            .filter((p) => Number(p.size) > 0)
            .map((p) => ({
              tokenId: String(p.asset),
              title: p.title || p.slug || '',
              outcome: p.outcome || '',
              size: Number(p.size),
              curPrice: Number(p.curPrice ?? 0),
              slug: p.slug || null,
              ...(Number.isFinite(p.avgPrice) ? { avgPrice: Number(p.avgPrice) } : {}),
              ...(Number.isFinite(p.cashPnl) ? { cashPnl: Number(p.cashPnl) } : {}),
              ...(Number.isFinite(p.percentPnl) ? { percentPnl: Number(p.percentPnl) } : {}),
            }));
        }
      } catch (e) {
        console.error('[positions] data-api fetch failed:', e?.message || e);
      }
      return send(res, 200, { ok: true, depositWallet, positions });
    }

    if (req.url === '/fills') {
      const { walletId } = payload;
      if (!walletId) return send(res, 400, { error: 'walletId required' });
      const sc = await clientFor(walletId);
      const depositWallet = sc.account?.wallet;
      let fills = [];
      try {
        const r = await fetch(`https://data-api.polymarket.com/trades?user=${depositWallet}&limit=50`, { headers: { accept: 'application/json' } });
        if (r.ok) {
          const raw = await r.json();
          fills = (Array.isArray(raw) ? raw : [])
            .map((t) => ({
              marketSlug: t.slug || t.title || '',
              outcome: t.outcome || '',
              amountUsdc: Number(t.size ?? 0) * Number(t.price ?? 0),
              price: Number(t.price ?? 0),
              side: t.side || '',
            }));
        }
      } catch (e) {
        console.error('[fills] data-api fetch failed:', e?.message || e);
      }
      return send(res, 200, { ok: true, depositWallet, fills });
    }

    if (req.url === '/fund') {
      const { walletId, eoaAddress, safeAddress, amount } = payload;
      if (!walletId || !eoaAddress) return send(res, 400, { error: 'walletId, eoaAddress required' });
      const sc = await clientFor(walletId);
      const depositWallet = sc.account?.wallet;
      const safe = safeAddress || deriveSafe(eoaAddress, SAFE_FACTORY);
      const safeUsdce = await bal(USDCE, safe);
      const wrapWei = amount ? toWei(amount) : safeUsdce;
      if (wrapWei <= 0n) return send(res, 400, { ok: false, error: 'nothing to wrap', safeUsdce: fmt(safeUsdce) });
      if (wrapWei > safeUsdce) return send(res, 400, { ok: false, error: 'wrap amount exceeds Safe USDC.e', safeUsdce: fmt(safeUsdce) });
      const wrap = await wrapToDepositWallet({ walletId, eoaAddress, safeAddress: safe, depositWallet, wrapWei });
      return send(res, 200, { ok: true, depositWallet, safe, ...wrap });
    }

    if (req.url === '/place') {
      const { walletId, eoaAddress, safeAddress, tokenId, amount, side } = payload;
      if (!walletId || !tokenId || !amount) return send(res, 400, { error: 'walletId, tokenId, amount required' });
      if (DRYRUN) {
        return send(res, 200, { ok: true, orderId: 'dry-run', status: 'matched', raw: { dryRun: true, walletId, tokenId, amount }, wallet: 'dry-run' });
      }
      const sc = await clientFor(walletId);
      const depositWallet = sc.account?.wallet;

      // Auto-wrap only makes sense for BUY (amount = USDC to spend). For SELL, amount = shares.
      if (AUTO_WRAP && eoaAddress && side !== 'SELL') {
        const funded = await ensurePusd({ walletId, eoaAddress, safeAddress, depositWallet, needWei: toWei(amount) });
        if (!funded.ok && funded.reason === 'insufficient_funds') {
          return send(res, 402, { ok: false, error: `insufficient funds: deposit pUSD ${funded.dwPusd}, Safe USDC.e ${funded.safeUsdce}, need ${funded.need}` });
        }
        if (funded.wrapped) console.log(`[place] auto-wrapped ${funded.wrapped}; deposit pUSD now ${funded.dwPusd}`);
      }

      try { await sc.setupTradingApprovals(); } catch (e) { /* idempotent; non-fatal if already set */ }
      const resp = await sc.placeMarketOrder({ tokenId, side: (side === 'SELL' ? PM.OrderSide.SELL : PM.OrderSide.BUY), amount: Number(amount) });
      return send(res, 200, { ok: true, orderId: resp.orderId, status: resp.status, raw: resp, wallet: depositWallet });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 502, { ok: false, error: e?.message || String(e), data: e?.response?.data ?? null });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`order-service on 127.0.0.1:${PORT} (dryRun=${DRYRUN}, autoWrap=${AUTO_WRAP})`));
