import axios, { AxiosError } from 'axios';
import NodeCache from 'node-cache';
import { config } from '../config';
import { FinnhubQuote, Quote, SymbolSearchResult } from '../types';
import { getMarketSession } from './market-hours';

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';

// Primary cache with configurable TTL for fresh data
const cache = new NodeCache({ stdTTL: config.quoteCacheTtlSeconds || config.priceCacheTtl });

// Backup cache with long TTL (1 hour) for fallback when API fails
const backupCache = new NodeCache({ stdTTL: 3600 });

// Historical candle cache with 24-hour TTL
const candleCache = new NodeCache({ stdTTL: 86400 });

// Insights cache with 24-hour TTL (for computed insights)
export const insightsCache = new NodeCache({ stdTTL: 86400 });

// Track rate limit state
let rateLimitedUntil: number = 0;
let searchRateLimitedUntil: number = 0; // Separate rate limit for search so background jobs don't block it

// Retry configuration
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface QuoteResult {
  quote: Quote | null;
  isStale: boolean;
  error?: string;
}

async function fetchFromFinnhub(ticker: string): Promise<FinnhubQuote> {
  const response = await axios.get<FinnhubQuote>(`${FINNHUB_BASE_URL}/quote`, {
    params: {
      symbol: ticker.toUpperCase(),
      token: config.finnhubApiKey,
    },
    timeout: 5000,
  });
  return response.data;
}

export async function getQuote(ticker: string): Promise<Quote> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `quote:${upperTicker}`;
  const now = Date.now();
  const repriceThreshold = config.repriceThresholdSeconds || 30;

  // Check primary cache first
  const cached = cache.get<Quote>(cacheKey);
  if (cached) {
    const quoteAge = Math.floor((now - (cached.updatedAt || cached.timestamp * 1000)) / 1000);
    const isRepricing = quoteAge > repriceThreshold;
    return {
      ...cached,
      isStale: false,
      isRepricing,
      quoteAgeSeconds: quoteAge,
    };
  }

  // Check if we're rate limited
  if (now < rateLimitedUntil) {
    const backup = backupCache.get<Quote>(cacheKey);
    if (backup) {
      console.log(`Rate limited, using backup cache for ${upperTicker}`);
      const quoteAge = Math.floor((now - (backup.updatedAt || backup.timestamp * 1000)) / 1000);
      return {
        ...backup,
        isStale: true,
        isRepricing: true,
        quoteAgeSeconds: quoteAge,
      };
    }
    throw new Error(`Rate limited and no cached data for ${upperTicker}`);
  }

  let lastError: Error | null = null;

  // Retry loop with exponential backoff
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt - 1));
      }

      const data = await fetchFromFinnhub(upperTicker);

      // Validate the response - both current and previous close being 0 means no data
      if (data.c === 0 && data.pc === 0) {
        throw new Error(`No data found for ticker: ${upperTicker}`);
      }

      // CRITICAL: Never use 0 as a valid price
      // If current price is 0 but previous close isn't, use previous close
      const currentPrice = data.c > 0 ? data.c : data.pc;

      const quoteTimestamp = now;
      const quote: Quote = {
        ticker: upperTicker,
        currentPrice,
        change: data.d || 0,
        changePercent: data.dp || 0,
        high: data.h || currentPrice,
        low: data.l || currentPrice,
        open: data.o || currentPrice,
        previousClose: data.pc || currentPrice,
        timestamp: data.t,
        updatedAt: quoteTimestamp,
        isStale: false,
        isRepricing: false,
        quoteAgeSeconds: 0,
        session: getMarketSession(),
      };

      // Store in both caches
      cache.set(cacheKey, quote);
      backupCache.set(cacheKey, quote);

      return quote;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Handle rate limiting (429)
      if (error instanceof AxiosError && error.response?.status === 429) {
        console.warn(`Finnhub rate limited for ${upperTicker}`);
        rateLimitedUntil = now + 60000; // Wait 1 minute

        const backup = backupCache.get<Quote>(cacheKey);
        if (backup) {
          console.log(`Using backup cache for ${upperTicker} due to rate limit`);
          const quoteAge = Math.floor((now - (backup.updatedAt || backup.timestamp * 1000)) / 1000);
          return {
            ...backup,
            isStale: true,
            isRepricing: true,
            quoteAgeSeconds: quoteAge,
          };
        }
        break; // Don't retry on rate limit
      }

      // Handle other API errors (401, 403, 5xx)
      if (error instanceof AxiosError && error.response) {
        const status = error.response.status;
        if (status === 401 || status === 403) {
          console.error(`Finnhub auth error (${status}) for ${upperTicker}`);
          break; // Don't retry auth errors
        }
      }

      console.warn(`Attempt ${attempt + 1} failed for ${upperTicker}:`, lastError.message);
    }
  }

  // All retries failed - try backup cache
  const backup = backupCache.get<Quote>(cacheKey);
  if (backup) {
    console.log(`All retries failed, using backup cache for ${upperTicker}`);
    const quoteAge = Math.floor((now - (backup.updatedAt || backup.timestamp * 1000)) / 1000);
    return {
      ...backup,
      isStale: true,
      isRepricing: true,
      quoteAgeSeconds: quoteAge,
    };
  }

  // No backup available
  throw lastError || new Error(`Failed to fetch quote for ${upperTicker}`);
}

export interface QuotesResult {
  quotes: Map<string, Quote>;
  staleCount: number;
  repricingCount: number;
  failedTickers: string[];
  provider: string;
}

export async function getQuotes(tickers: string[]): Promise<QuotesResult> {
  const quotes = new Map<string, Quote>();
  const failedTickers: string[] = [];
  let staleCount = 0;
  let repricingCount = 0;

  // Fetch sequentially with small delay to avoid burst rate limiting.
  // Cached quotes return instantly (no delay needed).
  for (const ticker of tickers) {
    try {
      const quote = await getQuote(ticker);
      quotes.set(ticker.toUpperCase(), quote);
      if (quote.isStale) staleCount++;
      if (quote.isRepricing) repricingCount++;
    } catch (error) {
      console.error(`Failed to fetch quote for ${ticker}:`, error);
      failedTickers.push(ticker.toUpperCase());
    }
  }

  return { quotes, staleCount, repricingCount, failedTickers, provider: 'finnhub' };
}

export function clearCache(): void {
  cache.flushAll();
}

export function clearAllCaches(): void {
  cache.flushAll();
  backupCache.flushAll();
}

// For testing: check if a ticker has backup cached data
export function hasBackupCache(ticker: string): boolean {
  return backupCache.has(`quote:${ticker.toUpperCase()}`);
}

// Historical candle data interface
export interface CandleData {
  c: number[];  // Close prices
  h: number[];  // High prices
  l: number[];  // Low prices
  o: number[];  // Open prices
  t: number[];  // Timestamps (Unix)
  v: number[];  // Volumes
  s: string;    // Status: 'ok' or 'no_data'
}

export interface HistoricalCandles {
  ticker: string;
  closes: number[];
  dates: Date[];
  returns: number[];  // Daily returns calculated from closes
  fetchedAt: number;
  partial: boolean;
}

/**
 * Fetch historical daily candles from Finnhub with 24-hour caching
 * @param ticker - Stock ticker symbol
 * @param years - Number of years of history (1 or 3)
 */
export async function getHistoricalCandles(ticker: string, years: number = 1): Promise<HistoricalCandles> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `candles:${upperTicker}:${years}y`;

  // Check cache first
  const cached = candleCache.get<HistoricalCandles>(cacheKey);
  if (cached) {
    return cached;
  }

  const now = Date.now();

  // Check rate limit
  if (now < rateLimitedUntil) {
    return {
      ticker: upperTicker,
      closes: [],
      dates: [],
      returns: [],
      fetchedAt: now,
      partial: true,
    };
  }

  try {
    const toDate = Math.floor(now / 1000);
    const fromDate = toDate - (years * 365 * 24 * 60 * 60);

    const response = await axios.get<CandleData>(`${FINNHUB_BASE_URL}/stock/candle`, {
      params: {
        symbol: upperTicker,
        resolution: 'D',  // Daily
        from: fromDate,
        to: toDate,
        token: config.finnhubApiKey,
      },
      timeout: 10000,
    });

    const data = response.data;

    if (data.s !== 'ok' || !data.c || data.c.length === 0) {
      console.warn(`No candle data for ${upperTicker}`);
      return {
        ticker: upperTicker,
        closes: [],
        dates: [],
        returns: [],
        fetchedAt: now,
        partial: true,
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
    };

    // Cache for 24 hours
    candleCache.set(cacheKey, result);

    return result;
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 429) {
      rateLimitedUntil = now + 60000;
    }
    console.error(`Failed to fetch candles for ${upperTicker}:`, error);

    return {
      ticker: upperTicker,
      closes: [],
      dates: [],
      returns: [],
      fetchedAt: now,
      partial: true,
    };
  }
}

/**
 * Fetch historical candles for multiple tickers with rate limit awareness
 * Staggers requests to avoid hitting rate limits
 */
export async function getMultipleHistoricalCandles(
  tickers: string[],
  years: number = 1
): Promise<Map<string, HistoricalCandles>> {
  const results = new Map<string, HistoricalCandles>();

  // Process in batches of 5 with small delays to respect rate limits
  const batchSize = 5;
  const delayBetweenBatches = 1000; // 1 second between batches

  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(ticker => getHistoricalCandles(ticker, years))
    );

    batchResults.forEach((result, idx) => {
      results.set(batch[idx].toUpperCase(), result);
    });

    // Add delay between batches (except for last batch)
    if (i + batchSize < tickers.length) {
      await sleep(delayBetweenBatches);
    }
  }

  return results;
}

export function clearCandleCache(): void {
  candleCache.flushAll();
}

export function clearInsightsCache(): void {
  insightsCache.flushAll();
}

// Symbol search cache with 24-hour TTL
const searchCache = new NodeCache({ stdTTL: 86400 });

// ADV (Average Daily Volume) cache with 24-hour TTL
const advCache = new NodeCache({ stdTTL: 86400 });

// Track ADV fetch queue to avoid duplicate fetches
const advFetchQueue = new Set<string>();

// Track tickers that failed ADV fetch (don't retry for 24h)
const advFailedCache = new NodeCache({ stdTTL: 86400 });

// Finnhub symbol search response interface
interface FinnhubSearchResult {
  count: number;
  result: {
    description: string;
    displaySymbol: string;
    symbol: string;
    type: string;
    primary_exchange?: string;
  }[];
}

// Instrument type priority (higher = more relevant for US retail)
const TYPE_PRIORITY: Record<string, number> = {
  'Common Stock': 100,
  'ETP': 90,
  'ETF': 90,
  'REIT': 80,
  'ADR': 70,
  'Closed-End Fund': 60,
  'Unit': 50,
  'Warrant': 30,
  'Preferred Stock': 40,
};

// Exchange priority (US exchanges first, then international)
const EXCHANGE_PRIORITY: Record<string, number> = {
  // US exchanges
  'NEW YORK STOCK EXCHANGE': 100,
  'NYSE': 100,
  'NASDAQ': 95,
  'NYSE ARCA': 90,
  'AMEX': 85,
  'BATS': 80,
  'NYSE AMERICAN': 75,
  // Canadian
  'TORONTO STOCK EXCHANGE': 60,
  'TSX': 60,
  'TSX VENTURE EXCHANGE': 55,
  'TSX-V': 55,
  // UK
  'LONDON STOCK EXCHANGE': 55,
  'LSE': 55,
  // Europe
  'EURONEXT': 50,
  'PARIS': 50,
  'AMSTERDAM': 50,
  'XETRA': 45,
  'FRANKFURT': 45,
  // Asia-Pacific
  'TOKYO STOCK EXCHANGE': 40,
  'HONG KONG STOCK EXCHANGE': 40,
  'AUSTRALIAN SECURITIES EXCHANGE': 35,
  'ASX': 35,
};

/**
 * POPULARITY OVERRIDES - Hardcoded market caps (in billions USD) for top tickers
 * This ensures good UX even when Finnhub API can't provide data
 * Values are approximate and used only for ranking, not display
 * Updated: Jan 2025
 */
const POPULARITY_OVERRIDES: Record<string, { marketCapB: number; isPopular: boolean }> = {
  // Mega caps (>$500B)
  'AAPL': { marketCapB: 3500, isPopular: true },
  'MSFT': { marketCapB: 3100, isPopular: true },
  'NVDA': { marketCapB: 3000, isPopular: true },
  'GOOGL': { marketCapB: 2100, isPopular: true },
  'GOOG': { marketCapB: 2100, isPopular: true },
  'AMZN': { marketCapB: 2000, isPopular: true },
  'META': { marketCapB: 1500, isPopular: true },
  'TSLA': { marketCapB: 1200, isPopular: true },
  'BRK.A': { marketCapB: 900, isPopular: true },
  'BRK.B': { marketCapB: 900, isPopular: true },
  'AVGO': { marketCapB: 800, isPopular: true },
  'LLY': { marketCapB: 750, isPopular: true },
  'JPM': { marketCapB: 650, isPopular: true },
  'V': { marketCapB: 600, isPopular: true },
  'UNH': { marketCapB: 550, isPopular: true },
  'XOM': { marketCapB: 500, isPopular: true },
  'MA': { marketCapB: 480, isPopular: true },
  'COST': { marketCapB: 400, isPopular: true },
  'HD': { marketCapB: 400, isPopular: true },
  'PG': { marketCapB: 380, isPopular: true },
  'JNJ': { marketCapB: 370, isPopular: true },
  'NFLX': { marketCapB: 350, isPopular: true },
  'CRM': { marketCapB: 320, isPopular: true },
  'BAC': { marketCapB: 310, isPopular: true },
  'ORCL': { marketCapB: 300, isPopular: true },
  'CVX': { marketCapB: 280, isPopular: true },
  'MRK': { marketCapB: 270, isPopular: true },
  'KO': { marketCapB: 265, isPopular: true },
  'WMT': { marketCapB: 500, isPopular: true },
  'PEP': { marketCapB: 230, isPopular: true },
  'AMD': { marketCapB: 220, isPopular: true },
  'INTC': { marketCapB: 100, isPopular: true },
  'DIS': { marketCapB: 200, isPopular: true },
  'CSCO': { marketCapB: 230, isPopular: true },
  'ADBE': { marketCapB: 240, isPopular: true },
  'NKE': { marketCapB: 120, isPopular: true },
  'PYPL': { marketCapB: 80, isPopular: true },
  'UBER': { marketCapB: 150, isPopular: true },
  'SQ': { marketCapB: 50, isPopular: true },
  'COIN': { marketCapB: 60, isPopular: true },
  'PLTR': { marketCapB: 150, isPopular: true },
  'SNOW': { marketCapB: 50, isPopular: true },
  'SHOP': { marketCapB: 130, isPopular: true },
  'SPOT': { marketCapB: 90, isPopular: true },
  'ZM': { marketCapB: 25, isPopular: true },
  'ROKU': { marketCapB: 12, isPopular: true },
  'RBLX': { marketCapB: 35, isPopular: true },
  'RIVN': { marketCapB: 15, isPopular: true },
  'LCID': { marketCapB: 8, isPopular: true },
  'GME': { marketCapB: 12, isPopular: true },
  'AMC': { marketCapB: 5, isPopular: true },

  // Popular ETFs
  'SPY': { marketCapB: 550, isPopular: true },
  'QQQ': { marketCapB: 280, isPopular: true },
  'IWM': { marketCapB: 60, isPopular: true },
  'VTI': { marketCapB: 400, isPopular: true },
  'VOO': { marketCapB: 450, isPopular: true },
  'VXX': { marketCapB: 1, isPopular: true },
  'ARKK': { marketCapB: 6, isPopular: true },
  'XLF': { marketCapB: 40, isPopular: true },
  'XLE': { marketCapB: 35, isPopular: true },
  'XLK': { marketCapB: 65, isPopular: true },
  'GLD': { marketCapB: 70, isPopular: true },
  'SLV': { marketCapB: 12, isPopular: true },
  'TLT': { marketCapB: 50, isPopular: true },
  'DIA': { marketCapB: 35, isPopular: true },
  'SOXL': { marketCapB: 10, isPopular: true },
  'TQQQ': { marketCapB: 20, isPopular: true },
  'SQQQ': { marketCapB: 3, isPopular: true },

  // Other notable stocks
  'AAP': { marketCapB: 2.5, isPopular: false }, // Advance Auto Parts - smaller company
  'AA': { marketCapB: 8, isPopular: false }, // Alcoa
  'AAPJ': { marketCapB: 0.01, isPopular: false }, // Tiny company
};

/**
 * Get popularity data for a ticker (from overrides or cache)
 */
function getPopularityData(ticker: string): { marketCapB?: number; avgVolume?: number; isPopular: boolean } {
  const upperTicker = ticker.toUpperCase();
  const override = POPULARITY_OVERRIDES[upperTicker];
  if (override) {
    return { marketCapB: override.marketCapB, isPopular: override.isPopular };
  }
  const adv = getCachedAdv(upperTicker);
  return { avgVolume: adv, isPopular: false };
}

/**
 * Popular ticker descriptions for supplemental matching
 */
const POPULAR_TICKER_DESCRIPTIONS: Record<string, { description: string; type: string }> = {
  'AAPL': { description: 'APPLE INC', type: 'Common Stock' },
  'MSFT': { description: 'MICROSOFT CORP', type: 'Common Stock' },
  'NVDA': { description: 'NVIDIA CORP', type: 'Common Stock' },
  'GOOGL': { description: 'ALPHABET INC', type: 'Common Stock' },
  'AMZN': { description: 'AMAZON.COM INC', type: 'Common Stock' },
  'META': { description: 'META PLATFORMS INC', type: 'Common Stock' },
  'TSLA': { description: 'TESLA INC', type: 'Common Stock' },
  'AVGO': { description: 'BROADCOM INC', type: 'Common Stock' },
  'SPY': { description: 'SPDR S&P 500 ETF TRUST', type: 'ETP' },
  'QQQ': { description: 'INVESCO QQQ TRUST', type: 'ETP' },
  'AMD': { description: 'ADVANCED MICRO DEVICES', type: 'Common Stock' },
  'NFLX': { description: 'NETFLIX INC', type: 'Common Stock' },
  'INTC': { description: 'INTEL CORP', type: 'Common Stock' },
  'DIS': { description: 'WALT DISNEY CO', type: 'Common Stock' },
  'PYPL': { description: 'PAYPAL HOLDINGS INC', type: 'Common Stock' },
  'UBER': { description: 'UBER TECHNOLOGIES INC', type: 'Common Stock' },
  'COIN': { description: 'COINBASE GLOBAL INC', type: 'Common Stock' },
  'PLTR': { description: 'PALANTIR TECHNOLOGIES INC', type: 'Common Stock' },
  'GME': { description: 'GAMESTOP CORP', type: 'Common Stock' },
  'AMC': { description: 'AMC ENTERTAINMENT HOLDINGS', type: 'Common Stock' },
};

/**
 * Get supplemental popular tickers that match query but might not be in Finnhub results
 * Only returns tickers where symbol starts with query (prefix match)
 */
function getSupplementalPopularTickers(query: string): Array<{
  symbol: string;
  description: string;
  type: string;
  primaryExchange: string;
}> {
  const upperQuery = query.toUpperCase();
  const results: Array<{
    symbol: string;
    description: string;
    type: string;
    primaryExchange: string;
  }> = [];

  // Check all popular tickers for prefix matches
  for (const [ticker, data] of Object.entries(POPULAR_TICKER_DESCRIPTIONS)) {
    // Only add if ticker starts with query (prefix match)
    if (ticker.startsWith(upperQuery) && ticker !== upperQuery) {
      results.push({
        symbol: ticker,
        description: data.description,
        type: data.type,
        primaryExchange: '',
      });
    }
  }

  return results;
}

/**
 * Get cached ADV for a ticker
 */
export function getCachedAdv(ticker: string): number | undefined {
  return advCache.get<number>(`adv:${ticker.toUpperCase()}`);
}

/**
 * Set ADV in cache
 */
export function setCachedAdv(ticker: string, adv: number): void {
  advCache.set(`adv:${ticker.toUpperCase()}`, adv);
}

/**
 * Check if ADV fetch is pending for a ticker
 */
export function isAdvPending(ticker: string): boolean {
  return advFetchQueue.has(ticker.toUpperCase());
}

/**
 * Queue ADV fetches for tickers (non-blocking, runs in background)
 * Uses finnhub-queue for rate limiting
 * Only fetches for US tickers (no dots in symbol) to avoid wasting API calls
 */
export async function queueAdvFetches(tickers: string[]): Promise<void> {
  const { finnhubQueue } = await import('./finnhub-queue');

  for (const ticker of tickers) {
    const upperTicker = ticker.toUpperCase();

    // Skip if already cached, failed, or queued
    if (
      advCache.has(`adv:${upperTicker}`) ||
      advFailedCache.has(`adv-fail:${upperTicker}`) ||
      advFetchQueue.has(upperTicker)
    ) {
      continue;
    }

    advFetchQueue.add(upperTicker);

    // Fire and forget - don't await
    (async () => {
      try {
        const now = Date.now();
        const toDate = Math.floor(now / 1000);
        const fromDate = toDate - (45 * 24 * 60 * 60); // ~45 days for 30 trading days

        const data = await finnhubQueue.request<CandleData>('/stock/candle', {
          symbol: upperTicker,
          resolution: 'D',
          from: fromDate,
          to: toDate,
        });

        if (data.s === 'ok' && data.v && data.v.length > 0) {
          // Calculate 30-day average volume (or whatever we have)
          const volumes = data.v.slice(-30);
          const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
          setCachedAdv(upperTicker, avgVolume);
          console.log(`[ADV] Cached ${upperTicker}: ${Math.round(avgVolume).toLocaleString()}`);
        } else {
          // Mark as failed (no data)
          advFailedCache.set(`adv-fail:${upperTicker}`, true);
        }
      } catch (error) {
        // Mark as failed, don't retry for 24h
        advFailedCache.set(`adv-fail:${upperTicker}`, true);
        // Only log non-403 errors (403 is expected for free tier)
        const msg = error instanceof Error ? error.message : 'unknown';
        if (!msg.includes('ACCESS_DENIED')) {
          console.log(`[ADV] Failed for ${upperTicker}: ${msg}`);
        }
      } finally {
        advFetchQueue.delete(upperTicker);
      }
    })();
  }
}

/**
 * Match bucket enum - determines primary sort order
 * Lower bucket number = higher priority
 */
enum MatchBucket {
  EXACT_TICKER = 1,
  EXACT_NAME = 2,
  PREFIX_TICKER = 3,
  PREFIX_NAME = 4,
  SUBSTRING_TICKER = 5,
  SUBSTRING_NAME = 6,
  NO_MATCH = 7,
}

/**
 * Determine which bucket a result belongs to based on query match
 */
function getMatchBucket(
  symbol: string,
  description: string,
  query: string
): MatchBucket {
  const upperSymbol = symbol.toUpperCase();
  const upperDesc = description.toUpperCase();
  const upperQuery = query.toUpperCase();

  // Exact ticker match (case-insensitive)
  if (upperSymbol === upperQuery) {
    return MatchBucket.EXACT_TICKER;
  }

  // Exact name match (case-insensitive) - full word match
  if (upperDesc === upperQuery) {
    return MatchBucket.EXACT_NAME;
  }

  // Prefix ticker match (startsWith)
  if (upperSymbol.startsWith(upperQuery)) {
    return MatchBucket.PREFIX_TICKER;
  }

  // Prefix name match (first word starts with query, or full desc starts with)
  const firstWord = upperDesc.split(/\s+/)[0];
  if (upperDesc.startsWith(upperQuery) || firstWord.startsWith(upperQuery)) {
    return MatchBucket.PREFIX_NAME;
  }

  // Substring ticker match (includes)
  if (upperSymbol.includes(upperQuery)) {
    return MatchBucket.SUBSTRING_TICKER;
  }

  // Substring name match (includes)
  if (upperDesc.includes(upperQuery)) {
    return MatchBucket.SUBSTRING_NAME;
  }

  return MatchBucket.NO_MATCH;
}

/**
 * Calculate a numeric popularity value for sorting within buckets
 * Uses marketCap (billions) > avgVolume > 0
 * Returns a number where higher = more popular
 */
function getPopularityValue(ticker: string): number {
  const data = getPopularityData(ticker);

  // Market cap in billions is our primary popularity metric
  if (data.marketCapB !== undefined && data.marketCapB > 0) {
    return data.marketCapB * 1_000_000_000; // Convert to raw dollars for consistent scale
  }

  // Fall back to average daily volume
  if (data.avgVolume !== undefined && data.avgVolume > 0) {
    // Volume is already a large number, but typically less than market cap
    // Scale it up to be comparable but always less than market cap companies
    return data.avgVolume;
  }

  return 0;
}

/**
 * Full ranking comparator for search results
 *
 * Sort order:
 * 1. Match bucket (lower = better): exact ticker > exact name > prefix ticker > prefix name > substring
 * 2. Within same bucket: popularity descending (marketCap > volume)
 * 3. Tie-breaker: US exchange priority
 * 4. Final tie-breaker: alphabetical by symbol
 */
function compareSearchResults(
  a: { symbol: string; description: string; type: string; primaryExchange: string },
  b: { symbol: string; description: string; type: string; primaryExchange: string },
  query: string
): number {
  // 1. Compare by match bucket
  const bucketA = getMatchBucket(a.symbol, a.description, query);
  const bucketB = getMatchBucket(b.symbol, b.description, query);
  if (bucketA !== bucketB) {
    return bucketA - bucketB; // Lower bucket = higher priority
  }

  // 2. Within same bucket, sort by popularity (descending)
  const popA = getPopularityValue(a.symbol);
  const popB = getPopularityValue(b.symbol);
  if (popA !== popB) {
    return popB - popA; // Higher popularity = earlier in list
  }

  // 3. Tie-breaker: US exchange priority (higher = better)
  const exchA = EXCHANGE_PRIORITY[a.primaryExchange.toUpperCase()] || 0;
  const exchB = EXCHANGE_PRIORITY[b.primaryExchange.toUpperCase()] || 0;
  if (exchA !== exchB) {
    return exchB - exchA; // Higher exchange priority = earlier
  }

  // 4. Tie-breaker: instrument type priority
  const typeA = TYPE_PRIORITY[a.type] || 0;
  const typeB = TYPE_PRIORITY[b.type] || 0;
  if (typeA !== typeB) {
    return typeB - typeA;
  }

  // 5. Final tie-breaker: alphabetical by symbol
  return a.symbol.localeCompare(b.symbol);
}

/**
 * Calculate a display score for UI (higher = more relevant)
 * This is for informational purposes and "Popular" badge logic
 */
function calculateDisplayScore(
  bucket: MatchBucket,
  popularityValue: number,
  isHeld: boolean,
  type?: string
): number {
  // Base score from bucket (100-700 range, inverted so higher = better)
  const bucketScore = (8 - bucket) * 100;

  // Popularity bonus (0-200 range based on log scale of market cap)
  let popularityScore = 0;
  if (popularityValue > 0) {
    // log10 of $1T = 12, log10 of $1B = 9, log10 of $1M = 6
    const logPop = Math.log10(popularityValue);
    popularityScore = Math.min(200, Math.max(0, (logPop - 6) * 33)); // 0-200
  }

  // Commodity/crypto bonus - these have no market cap data but are highly relevant
  if (type === 'Commodity' || type === 'Crypto') {
    popularityScore = Math.max(popularityScore, 150);
  }

  // Held ticker bonus
  const heldBonus = isHeld ? 25 : 0;

  return Math.round(bucketScore + popularityScore + heldBonus);
}

// Commodity futures and crypto tickers (Yahoo Finance compatible)
const COMMODITY_CRYPTO_MAP: { symbol: string; description: string; type: string; keywords: string[] }[] = [
  // Commodities
  { symbol: 'GC=F', description: 'Gold Futures', type: 'Commodity', keywords: ['gold', 'gc', 'xau'] },
  { symbol: 'SI=F', description: 'Silver Futures', type: 'Commodity', keywords: ['silver', 'si', 'xag'] },
  { symbol: 'CL=F', description: 'Crude Oil WTI Futures', type: 'Commodity', keywords: ['oil', 'crude', 'wti', 'cl', 'petroleum'] },
  { symbol: 'BZ=F', description: 'Brent Crude Oil Futures', type: 'Commodity', keywords: ['brent', 'bz'] },
  { symbol: 'NG=F', description: 'Natural Gas Futures', type: 'Commodity', keywords: ['natural gas', 'ng', 'natgas'] },
  { symbol: 'HG=F', description: 'Copper Futures', type: 'Commodity', keywords: ['copper', 'hg'] },
  { symbol: 'PL=F', description: 'Platinum Futures', type: 'Commodity', keywords: ['platinum', 'pl'] },
  { symbol: 'PA=F', description: 'Palladium Futures', type: 'Commodity', keywords: ['palladium', 'pa'] },
  { symbol: 'ZC=F', description: 'Corn Futures', type: 'Commodity', keywords: ['corn', 'zc'] },
  { symbol: 'ZW=F', description: 'Wheat Futures', type: 'Commodity', keywords: ['wheat', 'zw'] },
  { symbol: 'ZS=F', description: 'Soybean Futures', type: 'Commodity', keywords: ['soybean', 'soy', 'zs'] },
  // Crypto
  { symbol: 'BTC-USD', description: 'Bitcoin USD', type: 'Crypto', keywords: ['bitcoin', 'btc'] },
  { symbol: 'ETH-USD', description: 'Ethereum USD', type: 'Crypto', keywords: ['ethereum', 'eth', 'ether'] },
  { symbol: 'SOL-USD', description: 'Solana USD', type: 'Crypto', keywords: ['solana', 'sol'] },
  { symbol: 'XRP-USD', description: 'XRP USD', type: 'Crypto', keywords: ['xrp', 'ripple'] },
  { symbol: 'DOGE-USD', description: 'Dogecoin USD', type: 'Crypto', keywords: ['doge', 'dogecoin'] },
  { symbol: 'ADA-USD', description: 'Cardano USD', type: 'Crypto', keywords: ['cardano', 'ada'] },
  { symbol: 'AVAX-USD', description: 'Avalanche USD', type: 'Crypto', keywords: ['avalanche', 'avax'] },
  { symbol: 'DOT-USD', description: 'Polkadot USD', type: 'Crypto', keywords: ['polkadot', 'dot'] },
  { symbol: 'LINK-USD', description: 'Chainlink USD', type: 'Crypto', keywords: ['chainlink', 'link'] },
  { symbol: 'MATIC-USD', description: 'Polygon USD', type: 'Crypto', keywords: ['polygon', 'matic'] },
];

function matchCommoditiesAndCrypto(query: string): { symbol: string; description: string; type: string; primaryExchange: string }[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  // Match if query matches symbol prefix, description, or keywords
  return COMMODITY_CRYPTO_MAP
    .filter(item => {
      const symbolMatch = item.symbol.toLowerCase().startsWith(q) || item.symbol.toLowerCase().replace(/[=-]/g, '').startsWith(q);
      const descMatch = item.description.toLowerCase().includes(q);
      const keywordMatch = item.keywords.some(kw => kw.startsWith(q) || q.startsWith(kw));
      return symbolMatch || descMatch || keywordMatch;
    })
    .map(item => ({
      symbol: item.symbol,
      description: item.description,
      type: item.type,
      primaryExchange: item.type === 'Crypto' ? 'Crypto' : 'Futures',
    }));
}

/**
 * Search for symbols using Finnhub symbol search endpoint
 *
 * Ranking algorithm (Robinhood-style):
 * 1. Bucket by match type: exact ticker > exact name > prefix ticker > prefix name > substring
 * 2. Within each bucket, sort by popularity (marketCap > avgVolume) descending
 * 3. Tie-break by exchange priority, then alphabetically
 *
 * Returns normalized results sorted by relevance
 */
export async function searchSymbols(
  query: string,
  heldTickers: string[] = []
): Promise<{
  results: SymbolSearchResult[];
  partial: boolean;
  cached: boolean;
  advPending: string[];
}> {
  const normalizedQuery = query.trim();
  const heldSet = new Set(heldTickers.map(t => t.toUpperCase()));

  if (!normalizedQuery) {
    return { results: [], partial: false, cached: false, advPending: [] };
  }

  const cacheKey = `search:${normalizedQuery.toLowerCase()}`;

  // Check cache first (raw Finnhub results, not scored)
  interface RawSearchResult {
    symbol: string;
    description: string;
    type: string;
    primaryExchange: string;
  }

  let rawResults: RawSearchResult[] | undefined = searchCache.get<RawSearchResult[]>(cacheKey);
  let wasCached = !!rawResults;

  const now = Date.now();

  if (!rawResults) {
    // Try Finnhub first, fall back to Polygon if rate-limited
    let usedFallback = false;

    if (now < rateLimitedUntil && now < searchRateLimitedUntil) {
      // Both Finnhub limits hit — go straight to Polygon
      usedFallback = true;
    } else if (now >= searchRateLimitedUntil) {
      try {
        const response = await axios.get<FinnhubSearchResult>(`${FINNHUB_BASE_URL}/search`, {
          params: {
            q: query.toUpperCase(),
            token: config.finnhubApiKey,
          },
          timeout: 5000,
        });

        const data = response.data;

        if (!data.result || data.result.length === 0) {
          rawResults = [];
          searchCache.set(cacheKey, rawResults);
        } else {

        // Filter results - keep equities/ETFs from known exchanges
        const allowedTypes = new Set(['Common Stock', 'ETP', 'ETF', 'REIT', 'ADR', 'Equity', 'Unit']);
        const knownExchanges = new Set(Object.keys(EXCHANGE_PRIORITY));
        const upperQuery = normalizedQuery.toUpperCase();

        rawResults = data.result
          .filter(item => {
            const exchangeUpper = item.primary_exchange?.toUpperCase() || '';
            const hasKnownExchange = knownExchanges.has(exchangeUpper);
            const isAllowedType = allowedTypes.has(item.type);
            const symbolMatches = item.symbol.toUpperCase().includes(upperQuery);
            const nameMatches = item.description.toUpperCase().includes(upperQuery);
            // Keep if it's an allowed type or from a known exchange, and matches query
            return (isAllowedType || hasKnownExchange) && (symbolMatches || nameMatches);
          })
          .slice(0, 30) // Keep more for re-ranking
          .map(item => ({
            symbol: item.symbol,
            description: item.description,
            type: item.type,
            primaryExchange: item.primary_exchange || '',
          }));

        // Cache raw results
        searchCache.set(cacheKey, rawResults);
        }
      } catch (error) {
        if (error instanceof AxiosError && error.response?.status === 429) {
          searchRateLimitedUntil = now + 60000;
          console.warn('Finnhub rate limited for symbol search, falling back to Polygon');
          usedFallback = true;
        } else {
          console.error('Symbol search error:', error);
          usedFallback = true;
        }
      }
    } else {
      usedFallback = true;
    }

    // Polygon fallback
    if (usedFallback && !rawResults) {
      try {
        const polygonKey = process.env.POLYGON_API_KEY;
        if (polygonKey) {
          const resp = await axios.get('https://api.polygon.io/v3/reference/tickers', {
            params: {
              search: query.toUpperCase(),
              active: true,
              limit: 20,
              apiKey: polygonKey,
            },
            timeout: 5000,
          });
          const polygonTypeMap: Record<string, string> = {
            CS: 'Common Stock', ETF: 'ETF', ETS: 'ETF', ADRC: 'ADR',
            UNIT: 'Unit', RIGHT: 'Right', PFD: 'Preferred',
          };
          rawResults = (resp.data.results || []).map((r: any) => ({
            symbol: r.ticker,
            description: r.name,
            type: polygonTypeMap[r.type] || r.type || '',
            primaryExchange: r.primary_exchange || '',
          }));
          searchCache.set(cacheKey, rawResults);
        }
      } catch (error) {
        console.error('Polygon search fallback error:', error);
        return { results: [], partial: true, cached: false, advPending: [] };
      }
    }

    if (!rawResults) {
      return { results: [], partial: true, cached: false, advPending: [] };
    }
  }

  // Merge in supplemental popular tickers that might not be in Finnhub results
  const existingSymbols = new Set(rawResults.map(r => r.symbol.toUpperCase()));
  const supplemental = getSupplementalPopularTickers(normalizedQuery);
  for (const ticker of supplemental) {
    if (!existingSymbols.has(ticker.symbol.toUpperCase())) {
      rawResults.push(ticker);
      existingSymbols.add(ticker.symbol.toUpperCase());
    }
  }

  // Inject commodity and crypto tickers (not in Finnhub search)
  const commodityMatches = matchCommoditiesAndCrypto(normalizedQuery);
  for (const item of commodityMatches) {
    if (!existingSymbols.has(item.symbol.toUpperCase())) {
      rawResults.push(item);
      existingSymbols.add(item.symbol.toUpperCase());
    }
  }

  // Sort results using bucket-based ranking
  const sortedRaw = [...rawResults].sort((a, b) =>
    compareSearchResults(a, b, normalizedQuery)
  );

  // Limit same-base-symbol variants to top 3 (e.g., GOLD, GOLD.TO, GOLD.JK but not 10 GOLD.xx)
  const baseSymbolCount = new Map<string, number>();
  const deduped = sortedRaw.filter(item => {
    const base = item.symbol.split('.')[0].split('=')[0].split('-')[0];
    const count = baseSymbolCount.get(base) || 0;
    baseSymbolCount.set(base, count + 1);
    return count < 3;
  });

  // Enhance results with popularity data and scores
  const enhancedResults: SymbolSearchResult[] = deduped.map(item => {
    const popData = getPopularityData(item.symbol);
    const isHeld = heldSet.has(item.symbol.toUpperCase());
    const bucket = getMatchBucket(item.symbol, item.description, normalizedQuery);
    const popularityValue = getPopularityValue(item.symbol);
    const popularityScore = calculateDisplayScore(bucket, popularityValue, isHeld, item.type);

    return {
      symbol: item.symbol,
      description: item.description,
      type: item.type,
      primaryExchange: item.primaryExchange,
      popularityScore,
      marketCapB: popData.marketCapB,
      avgVolume: popData.avgVolume,
      isPopular: popData.isPopular || undefined,
      isHeld: isHeld || undefined,
    };
  });

  // Take top 10
  const results = enhancedResults.slice(0, 10);

  // Queue ADV fetches for US tickers that don't have popularity data
  const tickersNeedingData = results
    .filter(r => !r.marketCapB && !r.avgVolume)
    .map(r => r.symbol);

  const advPending = tickersNeedingData.filter(t => isAdvPending(t));

  // Queue fetches for tickers not already being fetched (fire and forget)
  if (tickersNeedingData.length > 0) {
    queueAdvFetches(tickersNeedingData);
  }

  return { results, partial: false, cached: wasCached, advPending };
}

export function clearSearchCache(): void {
  searchCache.flushAll();
}

export function clearAdvCache(): void {
  advCache.flushAll();
  advFailedCache.flushAll();
  advFetchQueue.clear();
}

// ============================================================================
// STOCK PROFILE & METRICS (for stock detail page)
// ============================================================================

const profileCache = new NodeCache({ stdTTL: 86400 }); // 24h
const metricsCache = new NodeCache({ stdTTL: 86400 }); // 24h

export interface FinnhubProfile {
  country: string;
  currency: string;
  exchange: string;
  finnhubIndustry: string;
  ipo: string;
  logo: string;
  marketCapitalization: number;
  name: string;
  phone: string;
  shareOutstanding: number;
  ticker: string;
  weburl: string;
}

export async function getStockProfile(ticker: string): Promise<FinnhubProfile | null> {
  const cacheKey = `profile:${ticker.toUpperCase()}`;
  const cached = profileCache.get<FinnhubProfile>(cacheKey);
  if (cached) return cached;

  try {
    const { finnhubQueue } = await import('./finnhub-queue');
    const data = await finnhubQueue.request<FinnhubProfile>('/stock/profile2', {
      symbol: ticker.toUpperCase(),
    });
    if (data && data.name) {
      profileCache.set(cacheKey, data);
      return data;
    }
    return null;
  } catch (err) {
    console.error(`[StockProfile] Failed to fetch profile for ${ticker}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export interface FinnhubMetricData {
  metric: {
    '52WeekHigh'?: number;
    '52WeekLow'?: number;
    '10DayAverageTradingVolume'?: number;
    beta?: number;
    peBasicExclExtraTTM?: number;
    dividendYieldIndicatedAnnual?: number;
    epsBasicExclExtraItemsTTM?: number;
    [key: string]: unknown;
  };
}

export async function getStockMetrics(ticker: string): Promise<FinnhubMetricData | null> {
  const cacheKey = `metrics:${ticker.toUpperCase()}`;
  const cached = metricsCache.get<FinnhubMetricData>(cacheKey);
  if (cached) return cached;

  try {
    const { finnhubQueue } = await import('./finnhub-queue');
    const data = await finnhubQueue.request<FinnhubMetricData>('/stock/metric', {
      symbol: ticker.toUpperCase(),
      metric: 'all',
    });
    if (data && data.metric) {
      metricsCache.set(cacheKey, data);
      return data;
    }
    return null;
  } catch (err) {
    console.error(`[StockMetrics] Failed to fetch metrics for ${ticker}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
