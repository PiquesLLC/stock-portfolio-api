import axios from 'axios';
import NodeCache from 'node-cache';
import { Quote } from '../types';
import { getMarketSession } from './market-hours';

const YAHOO_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

// Cache with short TTL for real-time feel (15 seconds during market hours)
const cache = new NodeCache({ stdTTL: 15 });

// Backup cache with longer TTL (1 hour) for fallback
const backupCache = new NodeCache({ stdTTL: 3600 });

interface YahooChartResult {
  chart: {
    result: Array<{
      meta: {
        symbol: string;
        regularMarketPrice: number;
        previousClose: number;
        regularMarketTime: number;
        regularMarketDayHigh: number;
        regularMarketDayLow: number;
        regularMarketOpen: number;
      };
      timestamp?: number[];
      indicators: {
        quote: Array<{
          close: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          open: (number | null)[];
          volume: (number | null)[];
        }>;
      };
    }>;
    error?: {
      code: string;
      description: string;
    };
  };
}

export async function getYahooQuote(ticker: string): Promise<Quote> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `yahoo:${upperTicker}`;

  // Check primary cache first
  const cached = cache.get<Quote>(cacheKey);
  if (cached) {
    return { ...cached, isStale: false };
  }

  try {
    // Use 1-minute interval with includePrePost=true to get extended hours data
    const response = await axios.get<YahooChartResult>(`${YAHOO_BASE_URL}/${upperTicker}`, {
      params: {
        interval: '1m',
        range: '1d',
        includePrePost: 'true',
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 5000,
    });

    const result = response.data.chart.result?.[0];
    if (!result) {
      throw new Error(`No data found for ticker: ${upperTicker}`);
    }

    const meta = result.meta;
    const session = getMarketSession();

    // Get the most recent price from the actual data series
    // This includes extended hours data when available
    let currentPrice = meta.regularMarketPrice;
    let priceTimestamp = meta.regularMarketTime;

    if (result.timestamp && result.timestamp.length > 0 && result.indicators.quote[0].close) {
      const timestamps = result.timestamp;
      const closes = result.indicators.quote[0].close;

      // Find the last valid (non-null) close price
      for (let i = timestamps.length - 1; i >= 0; i--) {
        const closePrice = closes[i];
        if (closePrice !== null && closePrice !== undefined && closePrice > 0) {
          currentPrice = closePrice;
          priceTimestamp = timestamps[i];
          break;
        }
      }
    }

    const previousClose = meta.previousClose || currentPrice;
    const change = currentPrice - previousClose;
    const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

    const quote: Quote = {
      ticker: upperTicker,
      currentPrice,
      change,
      changePercent,
      high: meta.regularMarketDayHigh || currentPrice,
      low: meta.regularMarketDayLow || currentPrice,
      open: meta.regularMarketOpen || currentPrice,
      previousClose,
      timestamp: priceTimestamp,
      isStale: false,
      session,
    };

    // Store in both caches
    cache.set(cacheKey, quote);
    backupCache.set(cacheKey, quote);

    return quote;
  } catch (error) {
    // Try backup cache on error
    const backup = backupCache.get<Quote>(cacheKey);
    if (backup) {
      console.log(`Yahoo fetch failed, using backup cache for ${upperTicker}`);
      return { ...backup, isStale: true };
    }

    throw error instanceof Error ? error : new Error(`Failed to fetch quote for ${upperTicker}`);
  }
}

export interface YahooQuotesResult {
  quotes: Map<string, Quote>;
  staleCount: number;
  failedTickers: string[];
}

export async function getYahooQuotes(tickers: string[]): Promise<YahooQuotesResult> {
  const quotes = new Map<string, Quote>();
  const failedTickers: string[] = [];
  let staleCount = 0;

  // Fetch quotes in parallel
  const promises = tickers.map(async (ticker) => {
    try {
      const quote = await getYahooQuote(ticker);
      quotes.set(ticker.toUpperCase(), quote);
      if (quote.isStale) {
        staleCount++;
      }
    } catch (error) {
      console.error(`Failed to fetch Yahoo quote for ${ticker}:`, error);
      failedTickers.push(ticker.toUpperCase());
    }
  });

  await Promise.all(promises);

  return { quotes, staleCount, failedTickers };
}

export function clearYahooCache(): void {
  cache.flushAll();
}

export function clearAllYahooCaches(): void {
  cache.flushAll();
  backupCache.flushAll();
}
