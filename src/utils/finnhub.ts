import axios, { AxiosError } from 'axios';
import NodeCache from 'node-cache';
import { config } from '../config';
import { FinnhubQuote, Quote } from '../types';

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';

// Primary cache with short TTL for fresh data
const cache = new NodeCache({ stdTTL: config.priceCacheTtl });

// Backup cache with long TTL (1 hour) for fallback when API fails
const backupCache = new NodeCache({ stdTTL: 3600 });

// Track rate limit state
let rateLimitedUntil: number = 0;

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

  // Check primary cache first
  const cached = cache.get<Quote>(cacheKey);
  if (cached) {
    return { ...cached, isStale: false };
  }

  // Check if we're rate limited
  if (Date.now() < rateLimitedUntil) {
    const backup = backupCache.get<Quote>(cacheKey);
    if (backup) {
      console.log(`Rate limited, using backup cache for ${upperTicker}`);
      return { ...backup, isStale: true };
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

      // If current price is 0 but previous close isn't, that's suspicious
      // Use previous close as current in that case
      const currentPrice = data.c > 0 ? data.c : data.pc;

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
        isStale: false,
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
        rateLimitedUntil = Date.now() + 60000; // Wait 1 minute

        const backup = backupCache.get<Quote>(cacheKey);
        if (backup) {
          console.log(`Using backup cache for ${upperTicker} due to rate limit`);
          return { ...backup, isStale: true };
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
    return { ...backup, isStale: true };
  }

  // No backup available
  throw lastError || new Error(`Failed to fetch quote for ${upperTicker}`);
}

export interface QuotesResult {
  quotes: Map<string, Quote>;
  staleCount: number;
  failedTickers: string[];
}

export async function getQuotes(tickers: string[]): Promise<QuotesResult> {
  const quotes = new Map<string, Quote>();
  const failedTickers: string[] = [];
  let staleCount = 0;

  const promises = tickers.map(async (ticker) => {
    try {
      const quote = await getQuote(ticker);
      quotes.set(ticker.toUpperCase(), quote);
      if (quote.isStale) {
        staleCount++;
      }
    } catch (error) {
      console.error(`Failed to fetch quote for ${ticker}:`, error);
      failedTickers.push(ticker.toUpperCase());
    }
  });

  await Promise.all(promises);

  return { quotes, staleCount, failedTickers };
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
