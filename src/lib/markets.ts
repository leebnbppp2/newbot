/**
 * Minimal Polymarket market overview + local keyword search for Phase 4.
 */

import {
  buildMarketOverviewReply,
  buildMarketSearchReply,
  type BotReply,
  type MarketItem,
} from '../agent/replies';
import type { Env } from '../types';

const BASE_MARKETS_URL = 'https://gamma-api.polymarket.com/markets?limit=60&active=true&closed=false';
const OVERVIEW_CACHE_KEY = 'frontpage_overview';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface MarketCacheRow {
  data_json: string;
  expires_at: string;
}

interface GammaMarket {
  question?: string;
  volume?: number | string;
  endDate?: string;
}

export async function getMarketOverviewReply(env: Env): Promise<BotReply> {
  const cached = await readCache(env, OVERVIEW_CACHE_KEY);
  if (cached) {
    return buildMarketOverviewReply(cached);
  }

  const fetched = await fetchMarkets();
  await writeCache(env, OVERVIEW_CACHE_KEY, fetched);
  return buildMarketOverviewReply(fetched);
}

export async function searchMarketsReply(env: Env, rawQuery: string): Promise<BotReply> {
  const query = rawQuery.trim().toLowerCase();
  const cacheKey = `search:${query}`;
  const cached = await readCache(env, cacheKey);
  if (cached) {
    return buildMarketSearchReply(query, cached);
  }

  const allMarkets = await fetchMarkets();
  const filtered = allMarkets.filter((market) => market.question.toLowerCase().includes(query));
  await writeCache(env, cacheKey, filtered);
  return buildMarketSearchReply(query, filtered);
}

async function readCache(env: Env, cacheKey: string): Promise<MarketItem[] | null> {
  const row = await env.DB.prepare(
    'SELECT data_json, expires_at FROM market_cache WHERE slug = ? LIMIT 1',
  )
    .bind(cacheKey)
    .first<MarketCacheRow>();

  if (!row || Date.parse(row.expires_at) <= Date.now()) {
    return null;
  }

  try {
    return JSON.parse(row.data_json) as MarketItem[];
  } catch {
    return null;
  }
}

async function writeCache(env: Env, cacheKey: string, markets: MarketItem[]): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);

  await env.DB.prepare(
    `INSERT INTO market_cache (slug, data_json, fetched_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       data_json = excluded.data_json,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
  )
    .bind(cacheKey, JSON.stringify(markets), now.toISOString(), expiresAt.toISOString())
    .run();
}

async function fetchMarkets(): Promise<MarketItem[]> {
  const response = await fetch(BASE_MARKETS_URL, {
    headers: {
      accept: 'application/json',
      'user-agent': 'NewBot/0.4',
    },
  });

  if (!response.ok) {
    throw new Error(`Polymarket markets fetch failed: ${response.status}`);
  }

  const payload = (await response.json()) as GammaMarket[];
  return payload
    .filter((item) => typeof item.question === 'string' && item.question.trim().length > 0)
    .map((item) => {
      const normalized: MarketItem = {
        question: item.question!.trim(),
        volume: typeof item.volume === 'number' ? item.volume : Number(item.volume ?? 0),
      };
      if (typeof item.endDate === 'string' && item.endDate.length > 0) {
        normalized.endDate = item.endDate;
      }
      return normalized;
    });
}
