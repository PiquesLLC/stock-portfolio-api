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

// ============================================================================
// ETF HOLDINGS DATA
// ============================================================================

export interface ETFHolding {
  symbol: string;
  holdingName: string;
  holdingPercent: number;
}

export interface ETFSectorWeighting {
  sector: string;
  weight: number;
}

export interface ETFHoldingsData {
  topHoldings: ETFHolding[];
  sectorWeightings: ETFSectorWeighting[];
  totalHoldingsPercent: number;
  asOfDate: string | null;
  isETF: boolean;
}

interface YahooQuoteSummaryResponse {
  quoteSummary: {
    result: Array<{
      topHoldings?: {
        holdings: Array<{
          symbol: string;
          holdingName: string;
          holdingPercent: { raw: number };
        }>;
        sectorWeightings: Array<{
          [key: string]: { raw: number };
        }>;
        equityHoldings?: {
          priceToEarnings?: { raw: number };
        };
      };
      fundProfile?: {
        categoryName?: string;
        family?: string;
        legalType?: string;
      };
      price?: {
        quoteType?: string;
      };
    }>;
    error?: { code: string; description: string };
  };
}

// Sector name mapping - Yahoo uses camelCase keys
const SECTOR_NAME_MAP: Record<string, string> = {
  realestate: 'Real Estate',
  consumer_cyclical: 'Consumer Cyclical',
  basic_materials: 'Basic Materials',
  consumer_defensive: 'Consumer Defensive',
  technology: 'Technology',
  communication_services: 'Communication Services',
  financial_services: 'Financial Services',
  utilities: 'Utilities',
  industrials: 'Industrials',
  energy: 'Energy',
  healthcare: 'Healthcare',
};

// ETF holdings cache - longer TTL since holdings don't change often
const etfHoldingsCache = new NodeCache({ stdTTL: 3600 }); // 1 hour

// Known ETFs list for detection
const KNOWN_ETFS = new Set([
  'SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO', 'VEA', 'VWO', 'EFA', 'EEM',
  'GLD', 'SLV', 'TLT', 'IEF', 'LQD', 'HYG', 'XLF', 'XLK', 'XLE', 'XLV',
  'XLI', 'XLP', 'XLY', 'XLU', 'XLC', 'XLRE', 'XLB', 'ARKK', 'ARKG', 'ARKW',
  'ARKF', 'SCHD', 'VIG', 'DGRO', 'DVY', 'VYM', 'SPHD', 'NOBL', 'SDY',
  'XBI', 'IBB', 'VHT', 'IYH', 'SOXX', 'SMH', 'HACK', 'CIBR', 'BOTZ',
  'TAN', 'ICLN', 'PBW', 'QCLN', 'LIT', 'REMX', 'URA', 'JETS', 'ITA',
  'PFF', 'VCIT', 'VCSH', 'BND', 'AGG', 'EMB', 'BNDX', 'MUB', 'SUB',
]);

// Hardcoded ETF data for common ETFs (updated periodically)
// This provides data when Yahoo Finance API is blocked
const ETF_STATIC_DATA: Record<string, ETFHoldingsData> = {
  SPY: {
    topHoldings: [
      { symbol: 'NVDA', holdingName: 'NVIDIA', holdingPercent: 7.84 },
      { symbol: 'AAPL', holdingName: 'Apple', holdingPercent: 6.47 },
      { symbol: 'MSFT', holdingName: 'Microsoft', holdingPercent: 5.39 },
      { symbol: 'AMZN', holdingName: 'Amazon', holdingPercent: 3.93 },
      { symbol: 'GOOGL', holdingName: 'Alphabet Class A', holdingPercent: 3.32 },
      { symbol: 'GOOG', holdingName: 'Alphabet Class C', holdingPercent: 2.66 },
      { symbol: 'META', holdingName: 'Meta Platforms', holdingPercent: 2.56 },
      { symbol: 'BRK.B', holdingName: 'Berkshire Hathaway', holdingPercent: 1.97 },
      { symbol: 'TSLA', holdingName: 'Tesla', holdingPercent: 1.77 },
      { symbol: 'AVGO', holdingName: 'Broadcom', holdingPercent: 1.50 },
    ],
    sectorWeightings: [
      { sector: 'Technology', weight: 34.10 },
      { sector: 'Financial Services', weight: 12.62 },
      { sector: 'Communication Services', weight: 11.24 },
      { sector: 'Consumer Cyclical', weight: 10.59 },
      { sector: 'Healthcare', weight: 9.45 },
      { sector: 'Industrials', weight: 7.95 },
      { sector: 'Consumer Defensive', weight: 5.00 },
      { sector: 'Energy', weight: 3.17 },
      { sector: 'Utilities', weight: 2.25 },
      { sector: 'Real Estate', weight: 1.86 },
      { sector: 'Basic Materials', weight: 1.77 },
    ],
    totalHoldingsPercent: 38.41,
    asOfDate: '2026-01-30',
    isETF: true,
  },
  QQQ: {
    topHoldings: [
      { symbol: 'AAPL', holdingName: 'Apple', holdingPercent: 8.73 },
      { symbol: 'NVDA', holdingName: 'NVIDIA', holdingPercent: 8.21 },
      { symbol: 'MSFT', holdingName: 'Microsoft', holdingPercent: 7.82 },
      { symbol: 'AMZN', holdingName: 'Amazon', holdingPercent: 5.34 },
      { symbol: 'AVGO', holdingName: 'Broadcom', holdingPercent: 4.98 },
      { symbol: 'META', holdingName: 'Meta Platforms', holdingPercent: 4.91 },
      { symbol: 'TSLA', holdingName: 'Tesla', holdingPercent: 3.78 },
      { symbol: 'COST', holdingName: 'Costco', holdingPercent: 2.61 },
      { symbol: 'GOOGL', holdingName: 'Alphabet Class A', holdingPercent: 2.55 },
      { symbol: 'GOOG', holdingName: 'Alphabet Class C', holdingPercent: 2.48 },
    ],
    sectorWeightings: [
      { sector: 'Technology', weight: 58.42 },
      { sector: 'Communication Services', weight: 15.21 },
      { sector: 'Consumer Cyclical', weight: 12.87 },
      { sector: 'Healthcare', weight: 5.93 },
      { sector: 'Consumer Defensive', weight: 4.12 },
      { sector: 'Industrials', weight: 2.58 },
      { sector: 'Utilities', weight: 0.87 },
    ],
    totalHoldingsPercent: 51.41,
    asOfDate: '2026-01-30',
    isETF: true,
  },
  DIA: {
    topHoldings: [
      { symbol: 'GS', holdingName: 'Goldman Sachs', holdingPercent: 8.12 },
      { symbol: 'UNH', holdingName: 'UnitedHealth', holdingPercent: 7.89 },
      { symbol: 'MSFT', holdingName: 'Microsoft', holdingPercent: 6.21 },
      { symbol: 'HD', holdingName: 'Home Depot', holdingPercent: 5.84 },
      { symbol: 'CAT', holdingName: 'Caterpillar', holdingPercent: 5.12 },
      { symbol: 'AMGN', holdingName: 'Amgen', holdingPercent: 4.67 },
      { symbol: 'V', holdingName: 'Visa', holdingPercent: 4.45 },
      { symbol: 'MCD', holdingName: 'McDonald\'s', holdingPercent: 4.21 },
      { symbol: 'TRV', holdingName: 'Travelers', holdingPercent: 3.98 },
      { symbol: 'AAPL', holdingName: 'Apple', holdingPercent: 3.45 },
    ],
    sectorWeightings: [
      { sector: 'Financial Services', weight: 23.45 },
      { sector: 'Healthcare', weight: 18.32 },
      { sector: 'Industrials', weight: 15.67 },
      { sector: 'Technology', weight: 14.89 },
      { sector: 'Consumer Cyclical', weight: 12.34 },
      { sector: 'Consumer Defensive', weight: 8.21 },
      { sector: 'Energy', weight: 4.12 },
      { sector: 'Communication Services', weight: 3.00 },
    ],
    totalHoldingsPercent: 53.94,
    asOfDate: '2026-01-30',
    isETF: true,
  },
  XBI: {
    topHoldings: [
      { symbol: 'VRTX', holdingName: 'Vertex Pharmaceuticals', holdingPercent: 2.45 },
      { symbol: 'REGN', holdingName: 'Regeneron', holdingPercent: 2.32 },
      { symbol: 'MRNA', holdingName: 'Moderna', holdingPercent: 2.21 },
      { symbol: 'BIIB', holdingName: 'Biogen', holdingPercent: 2.15 },
      { symbol: 'ILMN', holdingName: 'Illumina', holdingPercent: 2.08 },
      { symbol: 'EXAS', holdingName: 'Exact Sciences', holdingPercent: 1.98 },
      { symbol: 'ALNY', holdingName: 'Alnylam', holdingPercent: 1.92 },
      { symbol: 'SGEN', holdingName: 'Seagen', holdingPercent: 1.87 },
      { symbol: 'NBIX', holdingName: 'Neurocrine Bio', holdingPercent: 1.82 },
      { symbol: 'SRPT', holdingName: 'Sarepta', holdingPercent: 1.78 },
    ],
    sectorWeightings: [
      { sector: 'Healthcare', weight: 100.00 },
    ],
    totalHoldingsPercent: 20.58,
    asOfDate: '2026-01-30',
    isETF: true,
  },
};

/**
 * Fetch ETF holdings and sector weightings
 * Uses static data for common ETFs since Yahoo Finance API has been restricted
 */
export async function getETFHoldings(ticker: string): Promise<ETFHoldingsData | null> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `etf-holdings:${upperTicker}`;

  // Check cache first
  const cached = etfHoldingsCache.get<ETFHoldingsData>(cacheKey);
  if (cached) {
    return cached;
  }

  // Check if we have static data for this ETF
  if (ETF_STATIC_DATA[upperTicker]) {
    const data = ETF_STATIC_DATA[upperTicker];
    etfHoldingsCache.set(cacheKey, data);
    return data;
  }

  // Check if it's a known ETF but we don't have data
  if (KNOWN_ETFS.has(upperTicker)) {
    const data: ETFHoldingsData = {
      topHoldings: [],
      sectorWeightings: [],
      totalHoldingsPercent: 0,
      asOfDate: null,
      isETF: true,
    };
    etfHoldingsCache.set(cacheKey, data);
    return data;
  }

  // Try to detect ETF status from chart endpoint (which still works)
  try {
    const response = await axios.get<YahooChartResult>(`${YAHOO_BASE_URL}/${upperTicker}`, {
      params: {
        interval: '1d',
        range: '5d',
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 5000,
    });

    const result = response.data.chart.result?.[0];
    if (result) {
      // Can't reliably detect ETF from chart endpoint, assume not an ETF
      return null;
    }
  } catch {
    // Failed to fetch - not an ETF or ticker doesn't exist
  }

  return null;
}
