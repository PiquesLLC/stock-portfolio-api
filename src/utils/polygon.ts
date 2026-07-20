import axios, { AxiosError } from 'axios';
import * as fs from 'fs';
import NodeCache from 'node-cache';
import * as path from 'path';
import { Quote, MarketSession } from '../types';
import { config } from '../config';
import { getMarketSession } from './market-hours';

const POLYGON_BASE_URL = 'https://api.polygon.io';

// Primary cache with configurable TTL (default 30 seconds)
const cache = new NodeCache({ stdTTL: config.quoteCacheTtlSeconds });

// Backup cache with longer TTL (1 hour) - NEVER loses valid prices
const backupCache = new NodeCache({ stdTTL: 3600 });
// Reference market cap cache (changes slowly)
const marketCapCache = new NodeCache({ stdTTL: 12 * 60 * 60 }); // 12h

const QUOTE_SNAPSHOT_PATH = process.env.NODE_ENV === 'production'
  ? '/data/quote-cache-snapshot.json'
  : path.join(process.cwd(), 'prisma', 'quote-cache-snapshot.json');

interface QuoteSnapshotEntry {
  key: string;
  quote: Quote;
}

// Rate limit backoff tracking
let rateLimitBackoffUntil: number = 0;
const RATE_LIMIT_BACKOFF_MS = 60000; // 1 minute backoff on 429

// Track if we have access to premium endpoints. A 403 (payment lapse, plan
// downgrade) records "no access" only until premiumRecheckAt — after that the
// snapshot endpoint is probed again, so restored billing heals a running
// process. A permanent false here kept every process in free-tier crawl mode
// after the 2026-07 payment lapse until it was manually restarted.
let hasPremiumAccess: boolean | null = null;
let premiumRecheckAt = 0;
const PREMIUM_RECHECK_MS = 10 * 60 * 1000; // re-probe snapshot access every 10 min while unauthorized

// Free-tier sequential crawl ceiling: at 1.2s/ticker a large batch (the
// 500-ticker heatmap) would stall the request for minutes and trip 429s.
const FREE_TIER_MAX_FETCHES = 8;

// Track last successful Polygon response (ms since epoch)
let lastPolygonSuccessMs = 0;


function markPolygonSuccess(): void {
  lastPolygonSuccessMs = Date.now();
}

// Track tickers that matter (holdings + watchlists) to avoid persisting random searched tickers
const activeTickersSet = new Set<string>();
export function setActiveQuoteTickers(tickers: string[]): void {
  activeTickersSet.clear();
  for (const t of tickers) activeTickersSet.add(t.toUpperCase());
}

export function persistQuoteCache(): void {
  try {
    const entries: QuoteSnapshotEntry[] = [];

    for (const key of backupCache.keys()) {
      const ticker = key.slice('polygon:'.length);
      // Only persist active holdings/watchlist tickers (bounded size)
      if (activeTickersSet.size > 0 && !activeTickersSet.has(ticker)) continue;
      const quote = backupCache.get<Quote>(key);
      if (quote && quote.currentPrice > 0) {
        entries.push({ key, quote });
      }
    }

    if (entries.length === 0) return;

    // Atomic write: temp file + rename prevents corrupt snapshots on crash
    const dir = path.dirname(QUOTE_SNAPSHOT_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = QUOTE_SNAPSHOT_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(entries), 'utf-8');
    fs.renameSync(tmpPath, QUOTE_SNAPSHOT_PATH);
    console.log(`[QuoteCache] Persisted ${entries.length} quotes to disk`);
  } catch (err) {
    console.warn('[QuoteCache] Failed to persist:', (err as Error).message);
  }
}

export function restoreQuoteCache(): void {
  try {
    if (!fs.existsSync(QUOTE_SNAPSHOT_PATH)) return;

    const raw = fs.readFileSync(QUOTE_SNAPSHOT_PATH, 'utf-8');
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return;

    const maxAgeMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let restored = 0;

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;

      const { key, quote } = entry as QuoteSnapshotEntry;
      if (typeof key !== 'string' || !key.startsWith('polygon:') || !quote || typeof quote !== 'object') {
        continue;
      }

      if (typeof quote.currentPrice !== 'number' || !Number.isFinite(quote.currentPrice) || quote.currentPrice <= 0) {
        continue;
      }

      const updatedAtMs =
        typeof quote.updatedAt === 'number' && Number.isFinite(quote.updatedAt) && quote.updatedAt > 0
          ? quote.updatedAt
          : typeof quote.timestamp === 'number' && Number.isFinite(quote.timestamp) && quote.timestamp > 0
            ? quote.timestamp * 1000
            : 0;

      if (updatedAtMs <= 0 || now - updatedAtMs > maxAgeMs) continue;

      const upperTicker = key.slice('polygon:'.length).toUpperCase();
      const normalizedKey = `polygon:${upperTicker}`;
      const normalizedQuote: Quote = { ...quote, ticker: upperTicker };

      cache.set(normalizedKey, normalizedQuote);
      backupCache.set(normalizedKey, normalizedQuote);
      restored++;
    }

    if (restored > 0) {
      console.log(`[QuoteCache] Restored ${restored} quotes from disk`);
    }
  } catch (err) {
    console.warn('[QuoteCache] Failed to restore snapshot:', (err as Error).message);
  }
}

// Polygon Previous Day response type (free tier)
interface PolygonPrevDayResult {
  T: string; // ticker
  v: number; // volume
  vw: number; // volume weighted average
  o: number; // open
  c: number; // close
  h: number; // high
  l: number; // low
  t: number; // timestamp (milliseconds)
  n: number; // number of transactions
}

interface PolygonPrevDayResponse {
  status: string;
  ticker: string;
  resultsCount: number;
  results: PolygonPrevDayResult[];
}

// Polygon Snapshot API response types (requires paid plan)
interface PolygonTickerSnapshot {
  ticker: string;
  todaysChangePerc: number;
  todaysChange: number;
  updated: number; // nanoseconds timestamp
  day: {
    o: number; // open
    h: number; // high
    l: number; // low
    c: number; // close
    v: number; // volume
    vw: number; // volume weighted average price
  };
  min?: {
    av: number;
    t: number;
    n: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    vw: number;
  };
  prevDay: {
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    vw: number;
  };
  lastQuote?: {
    P: number; // ask price
    S: number; // ask size
    p: number; // bid price
    s: number; // bid size
    t: number; // timestamp
  };
  lastTrade?: {
    c: number[]; // conditions
    i: string; // trade ID
    p: number; // price
    s: number; // size
    t: number; // timestamp (nanoseconds)
    x: number; // exchange
  };
}

interface PolygonSnapshotResponse {
  status: string;
  count: number;
  tickers: PolygonTickerSnapshot[];
}

interface PolygonTickerDetailsResponse {
  status: string;
  results?: {
    ticker: string;
    market_cap?: number;
    weighted_shares_outstanding?: number;
  };
}

interface PolygonEarningsValueField {
  value?: number | string | null;
}

interface PolygonEarningsResult {
  fiscal_period?: string | null;
  fiscal_date?: string | null;
  fiscal_date_ending?: string | null;
  fiscalDateEnding?: string | null;
  filing_date?: string | null;
  report_date?: string | null;
  reported_date?: string | null;
  reportedDate?: string | null;
  reported_eps?: number | string | null | PolygonEarningsValueField;
  actual_eps?: number | string | null | PolygonEarningsValueField;
  estimated_eps?: number | string | null | PolygonEarningsValueField;
  estimate_eps?: number | string | null | PolygonEarningsValueField;
  surprise?: number | string | null | PolygonEarningsValueField;
  surprise_percent?: number | string | null | PolygonEarningsValueField;
  surprise_percentage?: number | string | null | PolygonEarningsValueField;
  report_time?: string | null;
  time_of_day?: string | null;
  [key: string]: unknown;
}

interface PolygonEarningsResponse {
  status?: string;
  results?: PolygonEarningsResult[];
}

export interface PolygonParsedQuarterlyEarning {
  fiscalDateEnding: string;
  reportedDate: string;
  reportedEPS: number | null;
  estimatedEPS: number | null;
  surprise: number | null;
  surprisePercentage: number | null;
  reportTime: string;
  beat: boolean | null;
}

function parsePolygonNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object' && 'value' in value) {
    return parsePolygonNumber((value as PolygonEarningsValueField).value);
  }
  return null;
}

function normalizePolygonReportTime(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'bmo' || normalized === 'before market open') return 'Before Market Open';
  if (normalized === 'amc' || normalized === 'after market close') return 'After Market Close';
  return '';
}

function mapPolygonEarningsResult(result: PolygonEarningsResult): PolygonParsedQuarterlyEarning | null {
  const fiscalDateEnding =
    result.fiscal_date ||
    result.fiscal_date_ending ||
    result.fiscalDateEnding ||
    result.fiscal_period ||
    '';
  const reportedDate =
    result.report_date ||
    result.reported_date ||
    result.reportedDate ||
    result.filing_date ||
    fiscalDateEnding;

  if (!fiscalDateEnding && !reportedDate) return null;

  const reportedEPS = parsePolygonNumber(result.reported_eps ?? result.actual_eps);
  const estimatedEPS = parsePolygonNumber(result.estimated_eps ?? result.estimate_eps);
  let surprise = parsePolygonNumber(result.surprise);
  let surprisePercentage = parsePolygonNumber(result.surprise_percent ?? result.surprise_percentage);

  if (surprise == null && reportedEPS != null && estimatedEPS != null) {
    surprise = reportedEPS - estimatedEPS;
  }
  if (surprisePercentage == null && surprise != null && estimatedEPS != null && estimatedEPS !== 0) {
    surprisePercentage = (surprise / Math.abs(estimatedEPS)) * 100;
  }

  return {
    fiscalDateEnding,
    reportedDate,
    reportedEPS,
    estimatedEPS,
    surprise,
    surprisePercentage,
    reportTime: normalizePolygonReportTime(result.report_time ?? result.time_of_day),
    beat: surprise != null ? surprise > 0 : null,
  };
}

export async function fetchPolygonEarnings(ticker: string): Promise<PolygonParsedQuarterlyEarning[] | null> {
  const upperTicker = ticker.toUpperCase();
  if (!config.polygonApiKey) return null;

  try {
    const response = await axios.get<PolygonEarningsResponse>(
      `${POLYGON_BASE_URL}/vX/reference/tickers/${encodeURIComponent(upperTicker)}/earnings`,
      {
        params: {
          apiKey: config.polygonApiKey,
          limit: 20,
        },
        timeout: 10000,
      }
    );

    if (!Array.isArray(response.data.results)) {
      return null;
    }

    markPolygonSuccess();

    const parsed = response.data.results
      .map(mapPolygonEarningsResult)
      .filter((item): item is PolygonParsedQuarterlyEarning => Boolean(item))
      .sort((a, b) => b.fiscalDateEnding.localeCompare(a.fiscalDateEnding));

    return parsed;
  } catch (error) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;
    const message = axiosError.message || 'Unknown Polygon earnings error';

    if (status === 429) {
      console.warn(`[Polygon Earnings] Rate limited for ${upperTicker}`);
    } else {
      console.warn(`[Polygon Earnings] Fetch failed for ${upperTicker}: ${message}`);
    }

    return null;
  }
}

/**
 * Fetches per-ticker volume from Polygon snapshot endpoint.
 * Returns day volume when available, otherwise prevDay volume, otherwise 0.
 * This function is best-effort and never throws.
 */
export async function getPolygonSnapshotVolumes(tickers: string[]): Promise<Map<string, number>> {
  const volumes = new Map<string, number>();
  if (tickers.length === 0) return volumes;

  const uniqueTickers = Array.from(new Set(tickers.map(t => t.toUpperCase())));
  const BATCH_SIZE = 200;

  for (let i = 0; i < uniqueTickers.length; i += BATCH_SIZE) {
    const batch = uniqueTickers.slice(i, i + BATCH_SIZE);
    try {
      const response = await axios.get<PolygonSnapshotResponse>(
        `${POLYGON_BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers`,
        {
          params: {
            tickers: batch.join(','),
            apiKey: config.polygonApiKey,
          },
          timeout: 10000,
        }
      );

      if (response.data.status !== 'OK' && response.data.status !== 'DELAYED') {
        continue;
      }

      for (const snapshot of response.data.tickers || []) {
        const upperTicker = snapshot.ticker.toUpperCase();
        const dayVolume = typeof snapshot.day?.v === 'number' ? snapshot.day.v : 0;
        const prevDayVolume = typeof snapshot.prevDay?.v === 'number' ? snapshot.prevDay.v : 0;
        volumes.set(upperTicker, dayVolume || prevDayVolume || 0);
      }
    } catch {
      // Best effort: leave missing tickers at default 0 in caller
      continue;
    }
  }

  return volumes;
}

/**
 * Fetches per-ticker market cap (billions) from Polygon v3 ticker details endpoint.
 * Uses per-ticker calls with 12h cache (shares outstanding barely change).
 * Processes in concurrent batches of 20 to stay within rate limits.
 */
export async function getPolygonMarketCaps(tickers: string[]): Promise<Map<string, number>> {
  const marketCapsB = new Map<string, number>();
  if (tickers.length === 0 || !config.polygonApiKey) return marketCapsB;

  const uniqueTickers = Array.from(new Set(tickers.map(t => t.toUpperCase())));
  const uncached: string[] = [];

  for (const ticker of uniqueTickers) {
    const cached = marketCapCache.get<number>(`polygon:mcap:${ticker}`);
    if (typeof cached === 'number' && Number.isFinite(cached) && cached > 0) {
      marketCapsB.set(ticker, cached);
    } else {
      uncached.push(ticker);
    }
  }

  if (uncached.length === 0) return marketCapsB;

  // Fetch in concurrent batches of 20
  const BATCH_SIZE = 20;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        const response = await axios.get<PolygonTickerDetailsResponse>(
          `${POLYGON_BASE_URL}/v3/reference/tickers/${encodeURIComponent(ticker)}`,
          { params: { apiKey: config.polygonApiKey }, timeout: 8000 }
        );
        const res = response.data.results;
        if (!res) return null;
        const mcRaw = res.market_cap;
        if (typeof mcRaw === 'number' && Number.isFinite(mcRaw) && mcRaw > 0) {
          return { ticker: ticker.toUpperCase(), marketCapB: mcRaw / 1_000_000_000 };
        }
        return null;
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        marketCapsB.set(r.value.ticker, r.value.marketCapB);
        marketCapCache.set(`polygon:mcap:${r.value.ticker}`, r.value.marketCapB);
      }
    }
  }

  return marketCapsB;
}

/**
 * Gets the best available "current" price from Polygon snapshot data.
 * Priority: lastTrade.p > min.c > day.c
 * This handles pre-market and after-hours where day.c might not be updated.
 */
function getBestPrice(snapshot: PolygonTickerSnapshot): { price: number; timestamp: number } {
  // Most recent trade is best for extended hours
  if (snapshot.lastTrade?.p && snapshot.lastTrade.p > 0) {
    return {
      price: snapshot.lastTrade.p,
      timestamp: Math.floor(snapshot.lastTrade.t / 1_000_000), // nanoseconds to milliseconds
    };
  }

  // Minute bar close
  if (snapshot.min?.c && snapshot.min.c > 0) {
    return {
      price: snapshot.min.c,
      timestamp: snapshot.min.t,
    };
  }

  // Day close
  if (snapshot.day?.c && snapshot.day.c > 0) {
    return {
      price: snapshot.day.c,
      timestamp: Math.floor(snapshot.updated / 1_000_000),
    };
  }

  // Fallback to previous close (should rarely happen)
  return {
    price: snapshot.prevDay?.c || 0,
    timestamp: Math.floor(snapshot.updated / 1_000_000),
  };
}

function getPolygonRegularClose(snapshot: PolygonTickerSnapshot, session: MarketSession, currentPrice: number): number | undefined {
  if (session === 'POST') {
    if (snapshot.day?.c && snapshot.day.c > 0) return snapshot.day.c;
    if (snapshot.prevDay?.c && snapshot.prevDay.c > 0) return snapshot.prevDay.c;
    return currentPrice > 0 ? currentPrice : undefined;
  }

  if (session === 'PRE') {
    if (snapshot.prevDay?.c && snapshot.prevDay.c > 0) return snapshot.prevDay.c;
    return currentPrice > 0 ? currentPrice : undefined;
  }

  return undefined;
}

/**
 * Fetch a single ticker using the free tier previous day endpoint.
 * Returns the previous day's close price.
 */
async function fetchPrevDayQuote(ticker: string): Promise<Quote | null> {
  const session = getMarketSession();
  const now = Date.now();

  try {
    const response = await axios.get<PolygonPrevDayResponse>(
      `${POLYGON_BASE_URL}/v2/aggs/ticker/${ticker}/prev`,
      {
        params: { apiKey: config.polygonApiKey },
        timeout: 10000,
      }
    );

    if (response.data.status !== 'OK' || !response.data.results?.length) {
      return null;
    }

    markPolygonSuccess();

    const result = response.data.results[0];
    const price = result.c; // close price
    const prevClose = result.c; // For prev day, close IS the prev close
    const timestamp = result.t;

    if (price <= 0) {
      return null;
    }

    // Day change is 0 since we're using previous day's close as current price
    // This is a limitation of the free tier
    const change = 0;
    const changePercent = 0;
    const quoteAge = Math.floor((now - timestamp) / 1000);

    const quote: Quote = {
      ticker,
      currentPrice: price,
      change,
      changePercent,
      high: result.h || price,
      low: result.l || price,
      open: result.o || price,
      previousClose: prevClose,
      timestamp: Math.floor(timestamp / 1000),
      updatedAt: timestamp,
      isStale: true, // Always stale since it's previous day data
      isRepricing: true, // Mark as repricing since data is delayed
      quoteAgeSeconds: quoteAge,
      session,
    };

    return quote;
  } catch (error) {
    const axiosError = error as AxiosError;
    const responseData = axiosError.response?.data as { status?: string; error?: string } | undefined;

    // Handle rate limiting
    if (axiosError.response?.status === 429 || responseData?.error?.includes('exceeded')) {
      console.warn(`[Polygon] Rate limited on ${ticker}, entering backoff mode`);
      rateLimitBackoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      return null;
    }

    console.error(`[Polygon] Failed to fetch prev day for ${ticker}:`, responseData?.error || error);
    return null;
  }
}

/**
 * Fetches batch quotes from Polygon Snapshot API.
 * Uses caching and "never return 0" logic.
 * Falls back to free tier individual requests if snapshot endpoint is not available.
 */
export async function getPolygonQuotes(tickers: string[]): Promise<PolygonQuotesResult> {
  const quotes = new Map<string, Quote>();
  const failedTickers: string[] = [];
  let staleCount = 0;
  let repricingCount = 0;
  const now = Date.now();
  const session = getMarketSession();

  // Check if we're in rate limit backoff
  if (now < rateLimitBackoffUntil) {
    console.log('[Polygon] In rate limit backoff, using cache only');
    return getCachedQuotesForTickers(tickers, session);
  }

  // Check cache first for all tickers
  const uncachedTickers: string[] = [];
  for (const ticker of tickers) {
    const upperTicker = ticker.toUpperCase();
    const cached = cache.get<Quote>(`polygon:${upperTicker}`);
    if (cached) {
      // Polygon Developer plan has ~15min delay; only stale if >30 min old
      const POLYGON_SNAPSHOT_THRESHOLD = 1800;
      const quoteAge = Math.floor((now - (cached.updatedAt || cached.timestamp * 1000)) / 1000);
      const isRepricing = quoteAge > POLYGON_SNAPSHOT_THRESHOLD;
      quotes.set(upperTicker, {
        ...cached,
        quoteAgeSeconds: quoteAge,
        isRepricing,
        isStale: isRepricing,
      });
      if (isRepricing) {
        repricingCount++;
        staleCount++;
      }
    } else {
      uncachedTickers.push(upperTicker);
    }
  }

  // If all tickers are cached, return early
  if (uncachedTickers.length === 0) {
    return {
      quotes,
      staleCount,
      repricingCount,
      failedTickers,
      provider: 'polygon',
    };
  }

  // Try snapshot endpoint if we haven't determined access level, know we have
  // premium access, or the earlier "no access" verdict is due a re-probe.
  if (hasPremiumAccess !== false || now >= premiumRecheckAt) {
    // Arm the throttle up front: if this is a re-probe while unauthorized, a
    // transient failure below must not leave the gate re-firing every request.
    if (hasPremiumAccess === false) {
      premiumRecheckAt = now + PREMIUM_RECHECK_MS;
    }
    try {
      const tickerList = uncachedTickers.join(',');
      const response = await axios.get<PolygonSnapshotResponse>(
        `${POLYGON_BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers`,
        {
          params: {
            tickers: tickerList,
            apiKey: config.polygonApiKey,
          },
          timeout: 10000,
        }
      );

      if (response.data.status === 'OK' || response.data.status === 'DELAYED') {
        markPolygonSuccess();
        hasPremiumAccess = true;
        console.log('[Polygon] Using premium snapshot endpoint');

        // Process response tickers
        const tickerMap = new Map<string, PolygonTickerSnapshot>();
        for (const snapshot of response.data.tickers || []) {
          tickerMap.set(snapshot.ticker.toUpperCase(), snapshot);
        }

        // Build quotes for each requested ticker
        for (const ticker of uncachedTickers) {
          const snapshot = tickerMap.get(ticker);

          if (!snapshot) {
            // Ticker not found in response - try backup cache
            const backup = backupCache.get<Quote>(`polygon:${ticker}`);
            if (backup && backup.currentPrice > 0) {
              const quoteAge = Math.floor((now - (backup.updatedAt || backup.timestamp * 1000)) / 1000);
              quotes.set(ticker, {
                ...backup,
                isRepricing: true,
                isStale: true,
                quoteAgeSeconds: quoteAge,
              });
              repricingCount++;
              staleCount++;
            } else {
              failedTickers.push(ticker);
            }
            continue;
          }

          const { price, timestamp } = getBestPrice(snapshot);
          const prevClose = snapshot.prevDay?.c || price;

          // If timestamp is 0, Polygon has no actual current data (e.g. pre-market
          // just started and no trades yet). Mark as failed so fallback providers
          // (Finnhub/Yahoo) can provide real-time pre-market data.
          if (timestamp <= 0 && price === prevClose) {
            failedTickers.push(ticker);
            continue;
          }

          // CRITICAL: Never use 0 as a valid price
          if (price <= 0) {
            const backup = backupCache.get<Quote>(`polygon:${ticker}`);
            if (backup && backup.currentPrice > 0) {
              const quoteAge = Math.floor((now - (backup.updatedAt || backup.timestamp * 1000)) / 1000);
              quotes.set(ticker, {
                ...backup,
                isRepricing: true,
                isStale: true,
                quoteAgeSeconds: quoteAge,
              });
              repricingCount++;
              staleCount++;
            } else {
              failedTickers.push(ticker);
            }
            continue;
          }

          const change = price - prevClose;
          const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
          const quoteAge = Math.floor((now - timestamp) / 1000);
          // Polygon Developer plan has ~15min delay — fresh API responses are not repricing.
          // Only mark as repricing if data is over 30 minutes old (truly stale).
          const POLYGON_SNAPSHOT_THRESHOLD = 1800;
          const isRepricing = quoteAge > POLYGON_SNAPSHOT_THRESHOLD;

          const quote: Quote = {
            ticker,
            currentPrice: price,
            change,
            changePercent,
            high: snapshot.day?.h || price,
            low: snapshot.day?.l || price,
            open: snapshot.day?.o || price,
            previousClose: prevClose,
            timestamp: Math.floor(timestamp / 1000),
            updatedAt: timestamp,
            isStale: isRepricing,
            isRepricing,
            quoteAgeSeconds: quoteAge,
            session,
          };

          const regularClose = getPolygonRegularClose(snapshot, session, price);
          if (regularClose && (session === 'PRE' || session === 'POST')) {
            quote.regularClose = regularClose;
            quote.extendedPrice = price;
            quote.extendedChange = price - regularClose;
            quote.extendedChangePercent = regularClose > 0
              ? (quote.extendedChange / regularClose) * 100
              : 0;
          }

          quotes.set(ticker, quote);
          // Store copies — consumers (market.service's Yahoo overlay) mutate the
          // returned objects in place; sharing refs would let that rewrite the
          // cached entries (resetting updatedAt/isStale for later cache readers).
          cache.set(`polygon:${ticker}`, { ...quote });
          backupCache.set(`polygon:${ticker}`, { ...quote });

          if (isRepricing) {
            repricingCount++;
            staleCount++;
          }
        }

        return {
          quotes,
          staleCount,
          repricingCount,
          failedTickers,
          provider: 'polygon',
        };
      }
    } catch (error) {
      const axiosError = error as AxiosError;
      const responseData = axiosError.response?.data as { status?: string } | undefined;

      if (axiosError.response?.status === 403 || responseData?.status === 'NOT_AUTHORIZED') {
        console.log('[Polygon] Snapshot endpoint not authorized, falling back to free tier');
        hasPremiumAccess = false;
        premiumRecheckAt = Date.now() + PREMIUM_RECHECK_MS;
      } else if (axiosError.response?.status === 429) {
        console.warn('[Polygon] Rate limited, entering backoff mode');
        rateLimitBackoffUntil = now + RATE_LIMIT_BACKOFF_MS;
        return getCachedQuotesForTickers(tickers, session);
      } else {
        console.error('[Polygon] Snapshot API error:', error);
      }
    }
  }

  // Fall back to free tier: individual previous day requests
  // Free tier is limited to 5 requests/minute, so we need to be careful
  if (hasPremiumAccess === false && uncachedTickers.length > FREE_TIER_MAX_FETCHES) {
    // Batch too large to crawl sequentially — serve backup cache and report the
    // rest failed so callers' fallback providers (Finnhub/Yahoo/candles) take over.
    console.log(`[Polygon] Free tier: batch of ${uncachedTickers.length} exceeds crawl cap (${FREE_TIER_MAX_FETCHES}), serving cache only`);
    for (const ticker of uncachedTickers) {
      const backup = backupCache.get<Quote>(`polygon:${ticker}`);
      if (backup && backup.currentPrice > 0) {
        const quoteAge = Math.floor((Date.now() - (backup.updatedAt || backup.timestamp * 1000)) / 1000);
        quotes.set(ticker, {
          ...backup,
          isRepricing: true,
          isStale: true,
          quoteAgeSeconds: quoteAge,
        });
        repricingCount++;
        staleCount++;
      } else {
        failedTickers.push(ticker);
      }
    }
  } else if (hasPremiumAccess === false) {
    console.log(`[Polygon] Using free tier for ${uncachedTickers.length} tickers`);

    // Fetch sequentially with delay to avoid rate limits
    // Free tier allows ~5 requests/minute
    const DELAY_BETWEEN_REQUESTS_MS = 1200; // 1.2 seconds between requests

    for (const ticker of uncachedTickers) {
      // Check if we're rate limited
      if (Date.now() < rateLimitBackoffUntil) {
        // Use backup cache for remaining tickers
        const backup = backupCache.get<Quote>(`polygon:${ticker}`);
        if (backup && backup.currentPrice > 0) {
          const quoteAge = Math.floor((Date.now() - (backup.updatedAt || backup.timestamp * 1000)) / 1000);
          quotes.set(ticker, {
            ...backup,
            isRepricing: true,
            isStale: true,
            quoteAgeSeconds: quoteAge,
          });
          repricingCount++;
          staleCount++;
        } else {
          failedTickers.push(ticker);
        }
        continue;
      }

      const quote = await fetchPrevDayQuote(ticker);

      if (quote && quote.currentPrice > 0) {
        quotes.set(ticker, quote);
        cache.set(`polygon:${ticker}`, quote);
        backupCache.set(`polygon:${ticker}`, quote);
        // Free tier data is always considered repricing/stale
        repricingCount++;
        staleCount++;
      } else {
        // Try backup cache
        const backup = backupCache.get<Quote>(`polygon:${ticker}`);
        if (backup && backup.currentPrice > 0) {
          const quoteAge = Math.floor((Date.now() - (backup.updatedAt || backup.timestamp * 1000)) / 1000);
          quotes.set(ticker, {
            ...backup,
            isRepricing: true,
            isStale: true,
            quoteAgeSeconds: quoteAge,
          });
          repricingCount++;
          staleCount++;
        } else {
          failedTickers.push(ticker);
        }
      }

      // Delay between requests to avoid rate limiting
      if (uncachedTickers.indexOf(ticker) < uncachedTickers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS_MS));
      }
    }
  } else {
    // hasPremiumAccess is null/true yet the snapshot attempt above didn't
    // return — it failed transiently (timeout/5xx/non-OK). Report the uncached
    // tickers as failed so callers' fallback providers (Finnhub/Yahoo/candles)
    // still cover them this request instead of silently dropping them.
    failedTickers.push(...uncachedTickers);
  }

  return {
    quotes,
    staleCount,
    repricingCount,
    failedTickers,
    provider: 'polygon',
  };
}

/**
 * Helper to get cached quotes for all tickers (used during rate limit backoff)
 */
function getCachedQuotesForTickers(tickers: string[], session: MarketSession): PolygonQuotesResult {
  const quotes = new Map<string, Quote>();
  const failedTickers: string[] = [];
  let staleCount = 0;
  let repricingCount = 0;
  const now = Date.now();

  for (const ticker of tickers) {
    const upperTicker = ticker.toUpperCase();

    // Try primary cache first, then backup
    let cached = cache.get<Quote>(`polygon:${upperTicker}`);
    if (!cached) {
      cached = backupCache.get<Quote>(`polygon:${upperTicker}`);
    }

    if (cached && cached.currentPrice > 0) {
      const quoteAge = Math.floor((now - (cached.updatedAt || cached.timestamp * 1000)) / 1000);
      quotes.set(upperTicker, {
        ...cached,
        isRepricing: true, // All cached quotes during backoff are repricing
        isStale: true,
        quoteAgeSeconds: quoteAge,
        session,
      });
      repricingCount++;
      staleCount++;
    } else {
      failedTickers.push(upperTicker);
    }
  }

  return {
    quotes,
    staleCount,
    repricingCount,
    failedTickers,
    provider: 'polygon',
  };
}

/**
 * Fetches a single quote from Polygon
 */
export async function getPolygonQuote(ticker: string): Promise<Quote> {
  const result = await getPolygonQuotes([ticker]);
  const upperTicker = ticker.toUpperCase();
  const quote = result.quotes.get(upperTicker);

  if (!quote) {
    // Check backup cache one more time
    const backup = backupCache.get<Quote>(`polygon:${upperTicker}`);
    if (backup && backup.currentPrice > 0) {
      const now = Date.now();
      const quoteAge = Math.floor((now - (backup.updatedAt || backup.timestamp * 1000)) / 1000);
      return {
        ...backup,
        isRepricing: true,
        isStale: true,
        quoteAgeSeconds: quoteAge,
      };
    }

    throw new Error(`No quote available for ${upperTicker}`);
  }

  return quote;
}

export interface PolygonQuotesResult {
  quotes: Map<string, Quote>;
  staleCount: number;
  repricingCount: number;
  failedTickers: string[];
  provider: string;
}

/**
 * Clear primary cache (for testing)
 */
export function clearPolygonCache(): void {
  cache.flushAll();
}

/**
 * Clear all caches (for testing)
 */
export function clearAllPolygonCaches(): void {
  cache.flushAll();
  backupCache.flushAll();
  hasPremiumAccess = null;
  premiumRecheckAt = 0;
}

/**
 * Get cache stats (for debugging)
 */
export function getPolygonCacheStats(): { primary: number; backup: number } {
  return {
    primary: cache.keys().length,
    backup: backupCache.keys().length,
  };
}

export function getPolygonStatus(): { lastSuccessMs: number; rateLimitedUntil: number; hasPremiumAccess: boolean | null; cache: { primary: number; backup: number } } {
  return {
    lastSuccessMs: lastPolygonSuccessMs,
    rateLimitedUntil: rateLimitBackoffUntil,
    hasPremiumAccess,
    cache: getPolygonCacheStats(),
  };
}

/**
 * Upsert quote into Polygon caches (primary + backup).
 * Used by background refresh overlays (e.g., Yahoo extended-hours updates).
 */
export function upsertPolygonQuoteCache(ticker: string, quote: Quote): void {
  const upperTicker = ticker.toUpperCase();
  const normalizedQuote: Quote = { ...quote, ticker: upperTicker };
  cache.set(`polygon:${upperTicker}`, normalizedQuote);
  backupCache.set(`polygon:${upperTicker}`, normalizedQuote);
}
