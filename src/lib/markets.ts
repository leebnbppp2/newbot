/**
 * Minimal Polymarket market overview + local search/detail for Phase 6.
 */

import {
  buildMarketDetailReply,
  buildMarketOverviewReply,
  buildMarketSearchReply,
  type BotReply,
  type MarketItem,
  type MarketOutcome,
} from '../agent/replies';
import type { Env } from '../types';

const BASE_MARKETS_URL = 'https://gamma-api.polymarket.com/markets?limit=100&order=volume&ascending=false&active=true&closed=false';
const OVERVIEW_CACHE_KEY = 'frontpage_overview';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface MarketCacheRow {
  data_json: string;
  expires_at: string;
}

interface GammaMarket {
  id?: string | number;
  question?: string;
  volume?: number | string;
  endDate?: string;
  slug?: string;
  outcomes?: string | string[];
  outcomePrices?: string | Array<string | number>;
  clobTokenIds?: string | string[];
}

export async function getMarketOverviewReply(env: Env, page = 1): Promise<BotReply> {
  const cached = await readCache(env, OVERVIEW_CACHE_KEY);
  if (cached) {
    return buildMarketOverviewReply(cached, page);
  }

  const fetched = await fetchMarkets();
  await writeCache(env, OVERVIEW_CACHE_KEY, fetched);
  return buildMarketOverviewReply(fetched, page);
}

export async function searchMarketsReply(env: Env, rawQuery: string, page = 1): Promise<BotReply> {
  const query = rawQuery.trim().toLowerCase();
  const cacheKey = `search:${query}`;
  const cached = await readCache(env, cacheKey);
  if (cached) {
    return buildMarketSearchReply(query, cached, page);
  }

  const filtered = await searchMarkets(env, query);
  await writeCache(env, cacheKey, filtered);
  return buildMarketSearchReply(query, filtered, page);
}

export async function getMarketDetailReply(env: Env, rawQuery: string): Promise<BotReply> {
  const query = rawQuery.trim().toLowerCase();
  const matched = await searchMarkets(env, query);
  return buildMarketDetailReply(query, matched[0] ?? null);
}

export async function findBestMarket(env: Env, rawQuery: string): Promise<MarketItem | null> {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return null;
  }
  const matched = await searchMarkets(env, query);
  return matched[0] ?? null;
}

/** Exact-slug lookup, used to re-resolve a market from a buy-button callback. */
export async function findMarketBySlug(env: Env, slug: string): Promise<MarketItem | null> {
  const wanted = slug.trim().toLowerCase();
  if (!wanted) {
    return null;
  }
  const all = await fetchMarkets();
  return all.find((m) => (m.slug ?? '').toLowerCase() === wanted) ?? null;
}

/** Exact numeric-id lookup — the primary re-resolver for buy-button callbacks. */
export async function findMarketById(env: Env, id: string): Promise<MarketItem | null> {
  const wanted = id.trim();
  if (!wanted) {
    return null;
  }
  const all = await fetchMarkets();
  return all.find((m) => m.id === wanted) ?? null;
}

async function searchMarkets(env: Env, query: string): Promise<MarketItem[]> {
  const allMarkets = await fetchMarkets();
  return allMarkets.filter((market) => {
    const haystacks = [market.question, market.slug ?? ''];
    return haystacks.some((value) => value.toLowerCase().includes(query));
  });
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
      'user-agent': 'NewBot/0.6',
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
      if (typeof item.id === 'string' || typeof item.id === 'number') {
        const idText = String(item.id).trim();
        if (idText.length > 0) {
          normalized.id = idText;
        }
      }
      if (typeof item.endDate === 'string' && item.endDate.length > 0) {
        normalized.endDate = item.endDate;
      }
      if (typeof item.slug === 'string' && item.slug.length > 0) {
        normalized.slug = item.slug;
      }
      const outcomes = normalizeOutcomes(item);
      if (outcomes) {
        normalized.outcomes = outcomes;
      }
      return normalized;
    })
    .sort((a, b) => b.volume - a.volume);
}

function normalizeOutcomes(item: GammaMarket): MarketOutcome[] | undefined {
  const names = parseStringArray(item.outcomes);
  const prices = parseNumberArray(item.outcomePrices);
  const tokenIds = parseStringArray(item.clobTokenIds);

  if (names.length === 0) {
    return undefined;
  }

  return names.map((name, index) => {
    const outcome: MarketOutcome = { name };
    if (typeof prices[index] === 'number' && Number.isFinite(prices[index])) {
      outcome.price = prices[index];
    }
    if (typeof tokenIds[index] === 'string' && tokenIds[index].length > 0) {
      outcome.tokenId = tokenIds[index];
    }
    return outcome;
  });
}

function parseStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
    } catch {
      return value.split(',').map((part) => part.trim()).filter(Boolean);
    }
  }
  return [];
}

function parseNumberArray(value: string | Array<string | number> | undefined): number[] {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item));
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((item) => Number(item));
      }
    } catch {
      return value.split(',').map((part) => Number(part.trim()));
    }
  }
  return [];
}
