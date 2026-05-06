/**
 * Minimal Polymarket market overview fetcher for Phase 3.
 */

import { buildMarketOverviewReply, type BotReply, type MarketItem } from '../agent/replies';
import type { Env } from '../types';

const GAMMA_URL = 'https://gamma-api.polymarket.com/markets?limit=3&active=true&closed=false';
const CACHE_KEY = 'frontpage_overview';
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
  const cached = await readCache(env);
  if (cached) {
    return buildMarketOverviewReply(cached);
  }

  const fetched = await fetchMarkets();
  await writeCache(env, fetched);
  return buildMarketOverviewReply(fetched);
}

async function readCache(env: Env): Promise<MarketItem[] | null> {
  const row = await env.DB.prepare(
    'SELECT data_json, expires_at FROM market_cache WHERE slug = ? LIMIT 1',
  )
    .bind(CACHE_KEY)
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

async function writeCache(env: Env, markets: MarketItem[]): Promise<void> {
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
    .bind(CACHE_KEY, JSON.stringify(markets), now.toISOString(), expiresAt.toISOString())
    .run();
}

async function fetchMarkets(): Promise<MarketItem[]> {
  const response = await fetch(GAMMA_URL, {
    headers: {
      'accept': 'application/json',
      'user-agent': 'NewBot/0.3',
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
