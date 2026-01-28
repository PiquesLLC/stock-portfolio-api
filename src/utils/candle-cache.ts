/**
 * Candle Cache with Gradual Fetching
 *
 * Features:
 * - 24-hour in-memory cache for candle data
 * - Tracks fetch progress across tickers
 * - Fetches only N tickers per request (gradual fill)
 * - Returns what's available + status info
 * - Works with the rate-limited Finnhub queue
 */

import NodeCache from 'node-cache';
import { finnhubQueue } from './finnhub-queue';

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

// Finnhub candle response
interface CandleResponse {
  c: number[];  // Close prices
  h: number[];  // High prices
  l: number[];  // Low prices
  o: number[];  // Open prices
  t: number[];  // Timestamps (Unix)
  v: number[];  // Volumes
  s: string;    // Status: 'ok' or 'no_data'
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
    // Calculate date range
    // Add buffer for weekends/holidays: tradingDays * 1.5
    const calendarDays = Math.ceil(tradingDays * 1.5);
    const toDate = Math.floor(now / 1000);
    const fromDate = toDate - (calendarDays * 24 * 60 * 60);

    console.log(`[CandleCache] Fetching ${upperTicker} (${tradingDays} trading days)`);

    const data = await finnhubQueue.request<CandleResponse>('/stock/candle', {
      symbol: upperTicker,
      resolution: 'D',
      from: fromDate,
      to: toDate,
    });

    if (data.s !== 'ok' || !data.c || data.c.length === 0) {
      console.warn(`[CandleCache] No data for ${upperTicker}`);
      failedTickers.set(upperTicker, { time: now, reason: 'NO_DATA' });
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

    // Calculate daily returns
    const returns: number[] = [];
    for (let i = 1; i < data.c.length; i++) {
      if (data.c[i - 1] > 0) {
        returns.push((data.c[i] - data.c[i - 1]) / data.c[i - 1]);
      }
    }

    const result: HistoricalCandles = {
      ticker: upperTicker,
      closes: data.c,
      dates: data.t.map(t => new Date(t * 1000)),
      returns,
      fetchedAt: now,
      partial: false,
      daysAvailable: data.c.length,
    };

    // Cache for 24 hours
    candleCache.set(cacheKey, result);

    // Clear from failed list
    failedTickers.delete(upperTicker);

    console.log(`[CandleCache] Cached ${upperTicker} with ${data.c.length} days`);

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isPlanLimit = errorMessage.includes('ACCESS_DENIED') || errorMessage.includes('paid plan');

    console.warn(`[CandleCache] Failed to fetch ${upperTicker}: ${isPlanLimit ? 'Plan limitation' : errorMessage}`);
    failedTickers.set(upperTicker, {
      time: now,
      reason: isPlanLimit ? 'PLAN_LIMIT' : 'ERROR',
    });

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
    message = 'Historical candles require Finnhub paid plan. Using alternative analysis.';
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
  queueStats: { queueLength: number; isProcessing: boolean; rateLimitedUntil: number; consecutiveErrors: number };
} {
  const keys = candleCache.keys();
  const candleKeys = keys.filter(k => k.startsWith('candles:'));

  return {
    cachedTickers: candleKeys.length,
    failedTickers: failedTickers.size,
    queueStats: finnhubQueue.getStats(),
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
