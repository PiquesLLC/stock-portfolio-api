/**
 * Candle Cache with Gradual Fetching
 *
 * Features:
 * - 24-hour in-memory cache for candle data
 * - Tracks fetch progress across tickers
 * - Fetches only N tickers per request (gradual fill)
 * - Returns what's available + status info
 * - Uses Polygon.io primary, Yahoo Finance fallback
 */

import NodeCache from 'node-cache';
import { fetchPolygonAggs, yahooGet } from './yahoo-http';
import { etDate } from './date';
import * as fs from 'fs';
import * as path from 'path';

// Historical candle data interface
export interface HistoricalCandles {
  ticker: string;
  closes: number[];
  dates: Date[];
  returns: number[];
  fetchedAt: number;
  partial: boolean;
  daysAvailable: number;
}

// Candle fetch result
export interface CandleFetchResult {
  data: Map<string, HistoricalCandles>;
  tickersWithData: string[];
  tickersPending: string[];
  tickersFailed: string[];
  allCached: boolean;
  progress: number; // 0-100
  message: string;
}

// 24-hour cache
const candleCache = new NodeCache({ stdTTL: 86400 });

// ── Persistent candle cache (survives deploys) ──────────────────
const CANDLE_SNAPSHOT_PATH = process.env.NODE_ENV === 'production'
  ? '/data/candle-cache-snapshot.json'
  : path.join(process.cwd(), 'prisma', 'candle-cache-snapshot.json');

interface CandleSnapshot {
  ticker: string;
  closes: number[];
  dates: string[]; // ISO strings
  fetchedAt: number;
  daysAvailable: number;
}

/** Save current candle cache to disk */
export function persistCandleCache(): void {
  try {
    const keys = candleCache.keys();
    const entries: CandleSnapshot[] = [];
    for (const key of keys) {
      const data = candleCache.get<HistoricalCandles>(key);
      if (data && !data.partial && data.closes.length >= 5) {
        entries.push({
          ticker: data.ticker,
          closes: data.closes,
          dates: data.dates.map(d => (d instanceof Date ? d.toISOString() : String(d))),
          fetchedAt: data.fetchedAt,
          daysAvailable: data.daysAvailable,
        });
      }
    }
    if (entries.length === 0) return;
    fs.writeFileSync(CANDLE_SNAPSHOT_PATH, JSON.stringify(entries), 'utf-8');
    console.log(`[CandleCache] Persisted ${entries.length} tickers to disk`);
  } catch (err) {
    console.warn('[CandleCache] Failed to persist:', (err as Error).message);
  }
}

/** Restore candle cache from disk on startup */
export function restoreCandleCache(): void {
  try {
    if (!fs.existsSync(CANDLE_SNAPSHOT_PATH)) return;
    const raw = fs.readFileSync(CANDLE_SNAPSHOT_PATH, 'utf-8');
    const entries: CandleSnapshot[] = JSON.parse(raw);
    const maxAge = 48 * 60 * 60 * 1000; // Skip entries older than 48 hours
    const now = Date.now();
    let loaded = 0;
    for (const entry of entries) {
      if (now - entry.fetchedAt > maxAge) continue;
      const cacheKey = `candles:${entry.ticker}`;
      if (candleCache.has(cacheKey)) continue;
      const returns: number[] = [];
      for (let i = 1; i < entry.closes.length; i++) {
        if (entry.closes[i - 1] > 0) {
          returns.push((entry.closes[i] - entry.closes[i - 1]) / entry.closes[i - 1]);
        }
      }
      candleCache.set(cacheKey, {
        ticker: entry.ticker,
        closes: entry.closes,
        dates: entry.dates.map(d => new Date(d)),
        returns,
        fetchedAt: entry.fetchedAt,
        partial: false,
        daysAvailable: entry.daysAvailable,
      });
      loaded++;
    }
    if (loaded > 0) console.log(`[CandleCache] Restored ${loaded} tickers from disk`);
  } catch (err) {
    console.warn('[CandleCache] Failed to restore:', (err as Error).message);
  }
}

// Track failed tickers (don't retry too often)
const failedTickers = new Map<string, { time: number; reason: string }>(); // ticker -> { time, reason }
const FAILED_RETRY_DELAY_MS = 3600000; // 1 hour before retrying failed tickers
const PLAN_LIMIT_RETRY_DELAY_MS = 86400000; // 24 hours for plan limitation errors

// Maximum tickers to fetch per request
const MAX_TICKERS_PER_REQUEST = 2;

// Default trading days (reduced from 252 to 180 for faster caching)
const DEFAULT_TRADING_DAYS = 180;

/**
 * Get cached candle data for a ticker
 */
export function getCachedCandles(ticker: string): HistoricalCandles | null {
  const cached = candleCache.get<HistoricalCandles>(`candles:${ticker.toUpperCase()}`);
  return cached ?? null;
}

/**
 * Check if ticker has valid cached data with minimum days
 */
export function hasCachedCandles(ticker: string, minDays: number = 20): boolean {
  const cached = getCachedCandles(ticker);
  return cached !== null && !cached.partial && cached.daysAvailable >= minDays;
}

/**
 * Fetch candles for a single ticker (using the queue)
 */
async function fetchSingleTickerCandles(ticker: string, tradingDays: number): Promise<HistoricalCandles> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `candles:${upperTicker}`;

  // Check cache first
  const cached = candleCache.get<HistoricalCandles>(cacheKey);
  if (cached && !cached.partial) {
    return cached;
  }

  const now = Date.now();

  // Check if recently failed
  const failedInfo = failedTickers.get(upperTicker);
  if (failedInfo) {
    const retryDelay = failedInfo.reason === 'PLAN_LIMIT' ? PLAN_LIMIT_RETRY_DELAY_MS : FAILED_RETRY_DELAY_MS;
    if (now - failedInfo.time < retryDelay) {
      console.log(`[CandleCache] Skipping ${upperTicker} (${failedInfo.reason})`);
      return {
        ticker: upperTicker,
        closes: [],
        dates: [],
        returns: [],
        fetchedAt: now,
        partial: true,
        daysAvailable: 0,
      };
    }
  }

  try {
    // Calculate date range — add buffer for weekends/holidays
    const calendarDays = Math.ceil(tradingDays * 1.5);
    const toDateStr = etDate();
    const fromDateStr = etDate(new Date(now - calendarDays * 86400000));

    console.log(`[CandleCache] Fetching ${upperTicker} via Polygon (${tradingDays} trading days)`);

    // Polygon.io primary
    const pg = await fetchPolygonAggs(upperTicker, 1, 'day', fromDateStr, toDateStr);
    if (pg && pg.closes.length >= 2) {
      const returns: number[] = [];
      for (let i = 1; i < pg.closes.length; i++) {
        if (pg.closes[i - 1] > 0) {
          returns.push((pg.closes[i] - pg.closes[i - 1]) / pg.closes[i - 1]);
        }
      }

      const result: HistoricalCandles = {
        ticker: upperTicker,
        closes: pg.closes,
        dates: pg.timestamps.map(t => new Date(t * 1000)),
        returns,
        fetchedAt: now,
        partial: false,
        daysAvailable: pg.closes.length,
      };

      candleCache.set(cacheKey, result);
      failedTickers.delete(upperTicker);
      console.log(`[CandleCache] Cached ${upperTicker} with ${pg.closes.length} days (Polygon)`);
      return result;
    }

    // Yahoo Finance fallback
    console.log(`[CandleCache] Polygon no data for ${upperTicker}, trying Yahoo`);
    const toTs = Math.floor(now / 1000);
    const fromTs = toTs - calendarDays * 86400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${upperTicker}?period1=${fromTs}&period2=${toTs}&interval=1d`;
    const resp = await yahooGet(url);
    const yResult = resp.data?.chart?.result?.[0];
    if (yResult?.timestamp && yResult?.indicators?.quote?.[0]) {
      const q = yResult.indicators.quote[0];
      const closes: number[] = [];
      const dates: Date[] = [];
      for (let i = 0; i < yResult.timestamp.length; i++) {
        if (q.close[i] != null) {
          closes.push(q.close[i]);
          dates.push(new Date(yResult.timestamp[i] * 1000));
        }
      }
      if (closes.length >= 2) {
        const returns: number[] = [];
        for (let i = 1; i < closes.length; i++) {
          if (closes[i - 1] > 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
        }
        const result: HistoricalCandles = {
          ticker: upperTicker, closes, dates, returns,
          fetchedAt: now, partial: false, daysAvailable: closes.length,
        };
        candleCache.set(cacheKey, result);
        failedTickers.delete(upperTicker);
        console.log(`[CandleCache] Cached ${upperTicker} with ${closes.length} days (Yahoo)`);
        return result;
      }
    }

    // No data from either source
    console.warn(`[CandleCache] No data for ${upperTicker} from Polygon or Yahoo`);
    failedTickers.set(upperTicker, { time: now, reason: 'NO_DATA' });
    return {
      ticker: upperTicker, closes: [], dates: [], returns: [],
      fetchedAt: now, partial: true, daysAvailable: 0,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[CandleCache] Failed to fetch ${upperTicker}: ${errorMessage}`);
    failedTickers.set(upperTicker, { time: now, reason: 'ERROR' });
    return {
      ticker: upperTicker, closes: [], dates: [], returns: [],
      fetchedAt: now, partial: true, daysAvailable: 0,
    };
  }
}

/**
 * Get candles for multiple tickers with gradual fetching
 *
 * This function:
 * 1. Returns immediately cached data for all tickers
 * 2. Fetches up to MAX_TICKERS_PER_REQUEST new tickers
 * 3. Returns status info about what's cached vs pending
 */
export async function getMultipleCandlesGradual(
  tickers: string[],
  tradingDays: number = DEFAULT_TRADING_DAYS
): Promise<CandleFetchResult> {
  const data = new Map<string, HistoricalCandles>();
  const tickersWithData: string[] = [];
  const tickersPending: string[] = [];
  const tickersFailed: string[] = [];

  const now = Date.now();
  const upperTickers = tickers.map(t => t.toUpperCase());

  // First pass: collect cached data and identify what needs fetching
  const needFetch: string[] = [];

  for (const ticker of upperTickers) {
    const cached = getCachedCandles(ticker);

    if (cached && !cached.partial && cached.daysAvailable >= 20) {
      data.set(ticker, cached);
      tickersWithData.push(ticker);
    } else {
      // Check if recently failed
      const failedInfo = failedTickers.get(ticker);
      if (failedInfo) {
        const retryDelay = failedInfo.reason === 'PLAN_LIMIT' ? PLAN_LIMIT_RETRY_DELAY_MS : FAILED_RETRY_DELAY_MS;
        if (now - failedInfo.time < retryDelay) {
          tickersFailed.push(ticker);
          continue;
        }
      }
      needFetch.push(ticker);
    }
  }

  // Second pass: fetch up to MAX_TICKERS_PER_REQUEST new tickers
  const toFetch = needFetch.slice(0, MAX_TICKERS_PER_REQUEST);
  const remaining = needFetch.slice(MAX_TICKERS_PER_REQUEST);

  // Fetch new tickers sequentially (queue handles rate limiting)
  for (const ticker of toFetch) {
    const result = await fetchSingleTickerCandles(ticker, tradingDays);

    if (!result.partial && result.daysAvailable >= 20) {
      data.set(ticker, result);
      tickersWithData.push(ticker);
    } else {
      tickersFailed.push(ticker);
    }
  }

  // Mark remaining as pending
  tickersPending.push(...remaining);

  // Calculate progress
  const total = upperTickers.length;
  const completed = tickersWithData.length + tickersFailed.length;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 100;

  // Check if failures are due to plan limitation
  const planLimitCount = Array.from(failedTickers.entries())
    .filter(([ticker, info]) => tickersFailed.includes(ticker) && info.reason === 'PLAN_LIMIT')
    .length;

  // Build message
  let message: string;
  if (tickersPending.length === 0 && tickersFailed.length === 0) {
    message = 'All historical data cached';
  } else if (planLimitCount > 0 && planLimitCount === tickersFailed.length) {
    message = 'Historical candle data temporarily unavailable. Using alternative analysis.';
  } else if (tickersPending.length > 0) {
    message = `Caching historical data: ${tickersWithData.length}/${total} tickers ready. Refresh to continue.`;
  } else if (tickersFailed.length > 0) {
    message = `Historical data unavailable for ${tickersFailed.length} ticker(s). Using available data.`;
  } else {
    message = 'Processing historical data...';
  }

  return {
    data,
    tickersWithData,
    tickersPending,
    tickersFailed,
    allCached: tickersPending.length === 0,
    progress,
    message,
  };
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  cachedTickers: number;
  failedTickers: number;
  provider: string;
} {
  const keys = candleCache.keys();
  const candleKeys = keys.filter(k => k.startsWith('candles:'));

  return {
    cachedTickers: candleKeys.length,
    failedTickers: failedTickers.size,
    provider: 'polygon',
  };
}

/**
 * Clear all candle caches
 */
export function clearCandleCache(): void {
  const keys = candleCache.keys();
  keys.filter(k => k.startsWith('candles:')).forEach(k => candleCache.del(k));
  failedTickers.clear();
}

// ============================================================================
// BENCHMARK CANDLE CACHING
// ============================================================================

const BENCHMARK_TICKERS = ['SPY', 'QQQ', 'DIA'];
const benchmarkCache = new NodeCache({ stdTTL: 86400 }); // 24h

export interface BenchmarkCandles {
  ticker: string;
  closes: number[];
  dates: string[];
  returns: number[];
  fetchedAt: number;
}

async function fetchBenchmarkCandles(ticker: string): Promise<BenchmarkCandles | null> {
  // Polygon.io primary
  const today = etDate();
  const fromDate = etDate(new Date(Date.now() - 400 * 86400000));
  const pg = await fetchPolygonAggs(ticker, 1, 'day', fromDate, today);
  if (pg && pg.closes.length >= 2) {
    const dates = pg.timestamps.map(t => new Date(t * 1000).toISOString().slice(0, 10));
    const returns: number[] = [];
    for (let i = 1; i < pg.closes.length; i++) {
      if (pg.closes[i - 1] > 0) returns.push((pg.closes[i] - pg.closes[i - 1]) / pg.closes[i - 1]);
    }
    return { ticker, closes: pg.closes, dates, returns, fetchedAt: Date.now() };
  }

  // Yahoo Finance fallback
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 400 * 24 * 60 * 60;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${from}&period2=${now}&interval=1d`;
    const resp = await yahooGet(url);
    const result = resp.data?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]) return null;

    const timestamps: number[] = result.timestamp;
    const q = result.indicators.quote[0];
    const closes: number[] = [];
    const dates: string[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (q.close[i] != null) {
        closes.push(q.close[i]);
        dates.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
      }
    }
    if (closes.length < 2) return null;
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1] > 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    return { ticker, closes, dates, returns, fetchedAt: Date.now() };
  } catch (err) {
    console.warn(`[BenchmarkCache] Failed to fetch ${ticker}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Fetch and cache benchmark candles for SPY, QQQ, DIA.
 * Call on startup and periodically (every 6h).
 */
export async function ensureBenchmarksCached(): Promise<void> {
  console.log('[BenchmarkCache] Fetching benchmarks: SPY, QQQ, DIA');
  for (const ticker of BENCHMARK_TICKERS) {
    const existing = benchmarkCache.get<BenchmarkCandles>(`benchmark:${ticker}`);
    if (existing) continue;

    const data = await fetchBenchmarkCandles(ticker);
    if (data) {
      benchmarkCache.set(`benchmark:${ticker}`, data);
      console.log(`[BenchmarkCache] Cached ${ticker}: ${data.closes.length} days`);
    }
  }
}

/**
 * Get cached benchmark candles for a ticker.
 */
export function getBenchmarkCandles(ticker: string): BenchmarkCandles | null {
  return benchmarkCache.get<BenchmarkCandles>(`benchmark:${ticker.toUpperCase()}`) ?? null;
}

/**
 * Get benchmark daily returns for the last N trading days.
 */
export function getBenchmarkReturns(ticker: string, days: number): number[] | null {
  const data = getBenchmarkCandles(ticker);
  if (!data || data.returns.length === 0) return null;
  return data.returns.slice(-days);
}

/**
 * Get benchmark total return over the last N trading days.
 * Returns as fraction (e.g., 0.05 = 5%).
 */
export function getBenchmarkTotalReturn(ticker: string, days: number): number | null {
  const data = getBenchmarkCandles(ticker);
  if (!data || data.closes.length < days + 1) return null;
  const startClose = data.closes[data.closes.length - 1 - days];
  const endClose = data.closes[data.closes.length - 1];
  if (startClose <= 0) return null;
  return (endClose - startClose) / startClose;
}

/**
 * Get benchmark total return from a specific start date.
 * Finds the closest trading day on or after the given date.
 * Returns as fraction (e.g., 0.05 = 5%).
 *
 * NOTE: This uses cached historical data. For real-time accuracy,
 * use getBenchmarkReturnWithQuote() which combines candles + live quote.
 */
export function getBenchmarkTotalReturnFromDate(ticker: string, startDate: Date): number | null {
  const data = getBenchmarkCandles(ticker);
  if (!data || data.closes.length < 2) return null;

  const startStr = startDate.toISOString().slice(0, 10);

  // Find the first close ON or AFTER the cutoff date (matches chart behavior)
  let startIdx = -1;
  for (let i = 0; i < data.dates.length; i++) {
    if (data.dates[i] >= startStr) {
      startIdx = i;
      break;
    }
  }

  // If startDate is before all data, use first available
  if (startIdx === -1) return null;

  const startClose = data.closes[startIdx];
  const endClose = data.closes[data.closes.length - 1];
  if (startClose <= 0) return null;
  return (endClose - startClose) / startClose;
}

/**
 * Get benchmark return with real-time accuracy by combining cached candles + live quote.
 * This matches how the stock chart calculates period returns.
 *
 * @param ticker - Benchmark ticker (SPY, QQQ, DIA)
 * @param startDate - Window start date
 * @param currentPrice - Live quote price for the benchmark
 * @returns Return as fraction (e.g., 0.05 = 5%), or null if insufficient data
 */
export function getBenchmarkReturnWithQuote(
  ticker: string,
  startDate: Date,
  currentPrice: number
): number | null {
  const data = getBenchmarkCandles(ticker);
  if (!data || data.closes.length < 2) return null;

  const startStr = startDate.toISOString().slice(0, 10);

  // Find the first close ON or AFTER the cutoff date (matches chart behavior)
  let startIdx = -1;
  for (let i = 0; i < data.dates.length; i++) {
    if (data.dates[i] >= startStr) {
      startIdx = i;
      break;
    }
  }

  if (startIdx === -1) return null;

  const startClose = data.closes[startIdx];
  if (startClose <= 0) return null;

  // Use live price for end value instead of cached close
  return (currentPrice - startClose) / startClose;
}

/**
 * Get benchmark close prices for the last N trading days (including current).
 */
export function getBenchmarkCloses(ticker: string, days: number): number[] | null {
  const data = getBenchmarkCandles(ticker);
  if (!data || data.closes.length < days) return null;
  return data.closes.slice(-days);
}
