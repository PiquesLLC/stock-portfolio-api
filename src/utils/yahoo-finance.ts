import axios from 'axios';
import NodeCache from 'node-cache';
import { Quote } from '../types';
import { getMarketSession } from './market-hours';
import { yahooGet } from './yahoo-http';

const YAHOO_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

// Cache with short TTL for real-time feel (15 seconds during market hours)
const cache = new NodeCache({ stdTTL: 15 });

// Backup cache with longer TTL (1 hour) for fallback
const backupCache = new NodeCache({ stdTTL: 3600 });

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
    const response = await yahooGet(
      `${YAHOO_BASE_URL}/${upperTicker}?interval=1m&range=1d&includePrePost=true`,
      5000
    );

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
  // Country/Region ETFs
  'EWJ', 'EWZ', 'EWG', 'EWU', 'EWA', 'EWC', 'EWY', 'EWH', 'EWT', 'EWS',
  'EWP', 'EWI', 'EWQ', 'EWL', 'EWN', 'EWD', 'EWK', 'EIS',
  'INDA', 'MCHI', 'FXI', 'EPI', 'IEMG', 'IEFA', 'KWEB',
  // Additional broad market, bond, commodity, thematic
  'IVV', 'ITOT', 'RSP', 'MDY', 'IJR', 'IGV', 'SHY', 'TIP',
  'USO', 'UNG', 'DBA', 'DBC', 'PDBC', 'ROBO', 'SKYY', 'CLOU',
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
  EEM: {
    topHoldings: [
      { symbol: 'TSM', holdingName: 'Taiwan Semiconductor', holdingPercent: 9.82 },
      { symbol: 'BABA', holdingName: 'Alibaba', holdingPercent: 3.41 },
      { symbol: 'TCEHY', holdingName: 'Tencent', holdingPercent: 3.28 },
      { symbol: 'RELIANCE.NS', holdingName: 'Reliance Industries', holdingPercent: 1.72 },
      { symbol: 'PDD', holdingName: 'PDD Holdings', holdingPercent: 1.56 },
      { symbol: 'MRVL', holdingName: 'Marvell Technology', holdingPercent: 1.32 },
      { symbol: 'INFY', holdingName: 'Infosys', holdingPercent: 1.21 },
      { symbol: 'JD', holdingName: 'JD.com', holdingPercent: 1.08 },
      { symbol: 'VALE', holdingName: 'Vale', holdingPercent: 0.98 },
      { symbol: 'NU', holdingName: 'Nu Holdings', holdingPercent: 0.94 },
    ],
    sectorWeightings: [
      { sector: 'Technology', weight: 24.50 },
      { sector: 'Financial Services', weight: 22.10 },
      { sector: 'Consumer Cyclical', weight: 13.80 },
      { sector: 'Communication Services', weight: 10.20 },
      { sector: 'Basic Materials', weight: 7.40 },
      { sector: 'Energy', weight: 5.90 },
      { sector: 'Industrials', weight: 5.60 },
      { sector: 'Consumer Defensive', weight: 4.80 },
      { sector: 'Healthcare', weight: 3.20 },
      { sector: 'Utilities', weight: 1.50 },
      { sector: 'Real Estate', weight: 1.00 },
    ],
    totalHoldingsPercent: 25.32,
    asOfDate: '2026-01-30',
    isETF: true,
  },
  EWJ: {
    topHoldings: [
      { symbol: 'TM', holdingName: 'Toyota Motor', holdingPercent: 5.12 },
      { symbol: 'SONY', holdingName: 'Sony Group', holdingPercent: 3.84 },
      { symbol: 'MUFG', holdingName: 'Mitsubishi UFJ', holdingPercent: 3.21 },
      { symbol: 'HMC', holdingName: 'Honda Motor', holdingPercent: 1.98 },
      { symbol: 'SMFG', holdingName: 'Sumitomo Mitsui', holdingPercent: 1.87 },
      { symbol: 'NMR', holdingName: 'Nomura Holdings', holdingPercent: 1.45 },
      { symbol: 'MFG', holdingName: 'Mizuho Financial', holdingPercent: 1.32 },
      { symbol: 'NTDOY', holdingName: 'Nintendo', holdingPercent: 1.28 },
      { symbol: 'IX', holdingName: 'ORIX Corp', holdingPercent: 1.15 },
      { symbol: 'KYOCY', holdingName: 'Kyocera', holdingPercent: 0.98 },
    ],
    sectorWeightings: [
      { sector: 'Industrials', weight: 22.30 },
      { sector: 'Financial Services', weight: 16.80 },
      { sector: 'Technology', weight: 14.60 },
      { sector: 'Consumer Cyclical', weight: 13.90 },
      { sector: 'Healthcare', weight: 8.50 },
      { sector: 'Communication Services', weight: 7.80 },
      { sector: 'Basic Materials', weight: 6.10 },
      { sector: 'Consumer Defensive', weight: 4.50 },
      { sector: 'Real Estate', weight: 3.20 },
      { sector: 'Energy', weight: 1.50 },
      { sector: 'Utilities', weight: 0.80 },
    ],
    totalHoldingsPercent: 22.20,
    asOfDate: '2026-01-30',
    isETF: true,
  },
  EWZ: {
    topHoldings: [
      { symbol: 'VALE', holdingName: 'Vale', holdingPercent: 12.45 },
      { symbol: 'PBR', holdingName: 'Petrobras', holdingPercent: 8.92 },
      { symbol: 'ITUB', holdingName: 'Itau Unibanco', holdingPercent: 6.78 },
      { symbol: 'BBD', holdingName: 'Bradesco', holdingPercent: 4.21 },
      { symbol: 'NU', holdingName: 'Nu Holdings', holdingPercent: 3.87 },
      { symbol: 'BSBR', holdingName: 'Banco Santander Brasil', holdingPercent: 2.95 },
      { symbol: 'ABEV', holdingName: 'Ambev', holdingPercent: 2.67 },
      { symbol: 'SBS', holdingName: 'SABESP', holdingPercent: 2.34 },
      { symbol: 'ELP', holdingName: 'Eletrobras', holdingPercent: 2.12 },
      { symbol: 'CIG', holdingName: 'CEMIG', holdingPercent: 1.89 },
    ],
    sectorWeightings: [
      { sector: 'Financial Services', weight: 28.50 },
      { sector: 'Basic Materials', weight: 15.20 },
      { sector: 'Energy', weight: 14.80 },
      { sector: 'Consumer Defensive', weight: 10.30 },
      { sector: 'Utilities', weight: 9.40 },
      { sector: 'Industrials', weight: 7.50 },
      { sector: 'Consumer Cyclical', weight: 5.60 },
      { sector: 'Technology', weight: 4.20 },
      { sector: 'Healthcare', weight: 2.30 },
      { sector: 'Communication Services', weight: 1.40 },
      { sector: 'Real Estate', weight: 0.80 },
    ],
    totalHoldingsPercent: 48.20,
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
 * Try to dynamically fetch ETF holdings from Yahoo Finance quoteSummary API.
 */
async function fetchETFHoldingsYahoo(ticker: string): Promise<ETFHoldingsData | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=topHoldings,fundProfile`;
    const response = await yahooGet(url, 8000);
    const data = response.data as YahooQuoteSummaryResponse;
    const result = data?.quoteSummary?.result?.[0];
    if (!result?.topHoldings?.holdings || result.topHoldings.holdings.length === 0) return null;

    const th = result.topHoldings;
    const topHoldings: ETFHolding[] = th.holdings
      .filter((h: any) => h.symbol && h.holdingPercent?.raw > 0)
      .slice(0, 15)
      .map((h: any) => ({
        symbol: h.symbol,
        holdingName: h.holdingName || h.symbol,
        holdingPercent: Math.round(h.holdingPercent.raw * 10000) / 100,
      }));

    const sectorWeightings: ETFSectorWeighting[] = [];
    if (th.sectorWeightings) {
      for (const sectorObj of th.sectorWeightings) {
        for (const [key, val] of Object.entries(sectorObj)) {
          if (val && typeof val === 'object' && 'raw' in val) {
            const sectorName = SECTOR_NAME_MAP[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            const weight = Math.round((val as { raw: number }).raw * 10000) / 100;
            if (weight > 0) sectorWeightings.push({ sector: sectorName, weight });
          }
        }
      }
    }
    sectorWeightings.sort((a, b) => b.weight - a.weight);

    const totalHoldingsPercent = topHoldings.reduce((sum, h) => sum + h.holdingPercent, 0);
    console.log(`[ETF Holdings] Yahoo dynamic for ${ticker}: ${topHoldings.length} holdings`);
    return {
      topHoldings, sectorWeightings,
      totalHoldingsPercent: Math.round(totalHoldingsPercent * 100) / 100,
      asOfDate: new Date().toISOString().slice(0, 10),
      isETF: true,
    };
  } catch {
    return null;
  }
}

/**
 * Use Perplexity to fetch ETF holdings for any ETF.
 * This handles foreign ETFs, obscure ETFs, and any ETF that Yahoo can't provide data for.
 */
async function fetchETFHoldingsPerplexity(ticker: string): Promise<ETFHoldingsData | null> {
  try {
    const { callPerplexity, extractJson } = await import('../utils/perplexity');

    const resp = await callPerplexity([
      {
        role: 'system',
        content: 'You are a financial data assistant. Return ONLY valid JSON, no markdown fences, no explanation.',
      },
      {
        role: 'user',
        content: `What are the top 10 holdings of the ETF "${ticker}" with their approximate percentage weights? Include their US-listed ticker symbols where possible. Also include the top sector weightings.

Return JSON in this exact format:
{
  "holdings": [
    {"symbol": "AAPL", "name": "Apple Inc", "weight": 7.5},
    {"symbol": "MSFT", "name": "Microsoft", "weight": 6.2}
  ],
  "sectors": [
    {"sector": "Technology", "weight": 30.5},
    {"sector": "Financial Services", "weight": 18.2}
  ]
}

Use the most recent data available. For foreign stocks, use their US ADR ticker if one exists (e.g., TSM for Taiwan Semiconductor, BABA for Alibaba). If no US ticker exists, use the local exchange ticker.`,
      },
    ], { timeout: 30000, feature: 'etf-holdings', ticker });

    if (!resp?.content) return null;

    const jsonStr = extractJson(resp.content);
    const parsed = JSON.parse(jsonStr);

    if (!parsed.holdings || !Array.isArray(parsed.holdings) || parsed.holdings.length === 0) return null;

    const topHoldings: ETFHolding[] = parsed.holdings
      .filter((h: any) => h.symbol && h.weight > 0)
      .slice(0, 15)
      .map((h: any) => ({
        symbol: String(h.symbol).toUpperCase(),
        holdingName: h.name || h.symbol,
        holdingPercent: Number(h.weight) || 0,
      }));

    const sectorWeightings: ETFSectorWeighting[] = (parsed.sectors || [])
      .filter((s: any) => s.sector && s.weight > 0)
      .map((s: any) => ({
        sector: String(s.sector),
        weight: Number(s.weight) || 0,
      }))
      .sort((a: ETFSectorWeighting, b: ETFSectorWeighting) => b.weight - a.weight);

    const totalHoldingsPercent = topHoldings.reduce((sum, h) => sum + h.holdingPercent, 0);

    console.log(`[ETF Holdings] Perplexity for ${ticker}: ${topHoldings.length} holdings, ${sectorWeightings.length} sectors`);
    return {
      topHoldings,
      sectorWeightings,
      totalHoldingsPercent: Math.round(totalHoldingsPercent * 100) / 100,
      asOfDate: new Date().toISOString().slice(0, 10),
      isETF: true,
    };
  } catch (err: any) {
    console.error(`[ETF Holdings] Perplexity failed for ${ticker}:`, err.message);
    return null;
  }
}

// Longer cache for Perplexity-fetched data (24 hours) to minimize API calls
const etfPerplexityCache = new NodeCache({ stdTTL: 86400 });

/**
 * Fetch ETF holdings and sector weightings.
 * Priority: cache → static data → Yahoo API → Perplexity AI → known ETF empty shell
 */
export async function getETFHoldings(ticker: string): Promise<ETFHoldingsData | null> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `etf-holdings:${upperTicker}`;

  // 1. Check short-lived cache
  const cached = etfHoldingsCache.get<ETFHoldingsData>(cacheKey);
  if (cached) return cached;

  // 2. Check Perplexity long-lived cache (24hr)
  const perplexityCached = etfPerplexityCache.get<ETFHoldingsData>(cacheKey);
  if (perplexityCached) {
    etfHoldingsCache.set(cacheKey, perplexityCached);
    return perplexityCached;
  }

  // 3. Static hardcoded data (fastest, no API call)
  if (ETF_STATIC_DATA[upperTicker]) {
    const data = ETF_STATIC_DATA[upperTicker];
    etfHoldingsCache.set(cacheKey, data);
    return data;
  }

  // 4. Try Yahoo Finance quoteSummary (free, may be restricted)
  const yahoo = await fetchETFHoldingsYahoo(upperTicker);
  if (yahoo && yahoo.topHoldings.length > 0) {
    etfHoldingsCache.set(cacheKey, yahoo);
    return yahoo;
  }

  // 5. Use Perplexity AI for known ETFs without data (handles foreign, obscure, any ETF)
  if (KNOWN_ETFS.has(upperTicker)) {
    const perplexity = await fetchETFHoldingsPerplexity(upperTicker);
    if (perplexity && perplexity.topHoldings.length > 0) {
      etfHoldingsCache.set(cacheKey, perplexity);
      etfPerplexityCache.set(cacheKey, perplexity); // Cache for 24 hours
      return perplexity;
    }

    // Perplexity also failed — return empty shell
    const empty: ETFHoldingsData = {
      topHoldings: [], sectorWeightings: [],
      totalHoldingsPercent: 0, asOfDate: null, isETF: true,
    };
    etfHoldingsCache.set(cacheKey, empty);
    return empty;
  }

  return null;
}

// ============================================================================
// ABOUT / ASSET PROFILE DATA
// ============================================================================

export interface AssetAbout {
  description: string;
  sector: string;
  industry: string;
  // ETF-specific fields
  category: string | null;
  fundFamily: string | null;
  legalType: string | null;
  totalAssets: number | null;
  numberOfHoldings: number | null;
  inceptionDate: string | null;
  // Stock-specific fields
  fullTimeEmployees: number | null;
  headquarters: string | null;
}

const aboutCache = new NodeCache({ stdTTL: 86400 }); // 24 hour cache

// Static descriptions for common tickers (fallback when API fails)
const STATIC_DESCRIPTIONS: Record<string, Partial<AssetAbout>> = {
  SPY: {
    description: 'SPY tracks a market cap-weighted index of US large- and mid-cap stocks selected by the S&P Committee. The listed name for SPY is State Street SPDR S&P 500 ETF Trust.',
    category: 'Large Blend',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Jan 22, 1993',
    numberOfHoldings: 503,
  },
  QQQ: {
    description: 'QQQ tracks a modified market cap-weighted index of 100 NASDAQ-listed stocks, excluding financials. The fund provides exposure to the largest non-financial companies on the NASDAQ.',
    category: 'Large Growth',
    fundFamily: 'Invesco',
    inceptionDate: 'Mar 10, 1999',
    numberOfHoldings: 101,
  },
  VOO: {
    description: 'VOO tracks the S&P 500 index, providing exposure to 500 of the largest U.S. companies. It offers broad market exposure with low costs.',
    category: 'Large Blend',
    fundFamily: 'Vanguard',
    inceptionDate: 'Sep 7, 2010',
    numberOfHoldings: 504,
  },
  VTI: {
    description: 'VTI tracks a market cap-weighted index of the entire U.S. equity market, including small-, mid-, and large-cap stocks.',
    category: 'Large Blend',
    fundFamily: 'Vanguard',
    inceptionDate: 'May 24, 2001',
    numberOfHoldings: 3637,
  },
  DIA: {
    description: 'DIA tracks a price-weighted index of 30 large-cap US stocks, selected by the editors of the Wall Street Journal. It represents the Dow Jones Industrial Average.',
    category: 'Large Value',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Jan 14, 1998',
    numberOfHoldings: 30,
  },
  SCHD: {
    description: 'SCHD tracks an index of 100 US dividend-paying stocks selected by fundamental strength and dividend sustainability.',
    category: 'Large Value',
    fundFamily: 'Schwab',
    inceptionDate: 'Oct 20, 2011',
    numberOfHoldings: 104,
  },
  ARKK: {
    description: 'ARKK is an actively managed fund that invests in companies expected to benefit from disruptive innovation in areas like AI, robotics, energy storage, DNA sequencing, and blockchain.',
    category: 'Large Growth',
    fundFamily: 'ARK Investment Management',
    inceptionDate: 'Oct 31, 2014',
    numberOfHoldings: 35,
  },
  XBI: {
    description: 'SPDR S&P Biotech ETF tracks an equal-weighted index of US biotechnology stocks from the S&P Total Market Index. The fund provides exposure to the biotech industry with equal weighting to reduce concentration risk among holdings. This approach gives smaller biotech companies similar influence as larger ones, making the fund more volatile but potentially capturing gains from emerging biotech firms. XBI is managed by State Street Global Advisors and is popular among investors seeking biotech sector exposure.',
    category: 'Health',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Jan 31, 2006',
    numberOfHoldings: 141,
  },
  // Additional common ETFs
  IWM: {
    description: 'iShares Russell 2000 ETF tracks the Russell 2000 Index, which measures the performance of approximately 2,000 small-cap US companies. The fund provides broad exposure to the small-cap segment of the US equity market, which historically has offered higher growth potential but with greater volatility than large-cap stocks. IWM is one of the most widely traded small-cap ETFs and is often used as a benchmark for small-cap performance. The fund is managed by BlackRock.',
    category: 'Small Blend',
    fundFamily: 'iShares',
    inceptionDate: 'May 22, 2000',
    numberOfHoldings: 1977,
  },
  VEA: {
    description: 'Vanguard FTSE Developed Markets ETF tracks the FTSE Developed All Cap ex US Index, providing exposure to stocks in developed markets outside the United States and Canada. The fund includes large-, mid-, and small-cap stocks from Europe, Japan, Australia, and other developed economies. VEA offers diversification beyond US markets and is popular for international developed market exposure with Vanguard\'s low expense ratios.',
    category: 'Foreign Large Blend',
    fundFamily: 'Vanguard',
    inceptionDate: 'Jul 20, 2007',
    numberOfHoldings: 4048,
  },
  VWO: {
    description: 'Vanguard FTSE Emerging Markets ETF tracks the FTSE Emerging Markets All Cap China A Inclusion Index, providing exposure to stocks in emerging market countries including China, Taiwan, India, Brazil, and South Africa. The fund offers broad diversification across developing economies with growth potential. VWO is one of the largest emerging markets ETFs by assets and offers Vanguard\'s characteristic low costs.',
    category: 'Diversified Emerging Mkts',
    fundFamily: 'Vanguard',
    inceptionDate: 'Mar 4, 2005',
    numberOfHoldings: 5759,
  },
  GLD: {
    description: 'SPDR Gold Shares is designed to track the price of gold bullion. The fund holds physical gold bars in a London vault and is one of the largest gold ETFs in the world. GLD provides investors with a convenient way to gain exposure to gold prices without the complexities of buying, storing, and insuring physical gold. The fund is often used as a hedge against inflation, currency devaluation, and market volatility.',
    category: 'Commodities Precious Metals',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Nov 18, 2004',
    numberOfHoldings: 1,
  },
  TLT: {
    description: 'iShares 20+ Year Treasury Bond ETF tracks an index of US Treasury bonds with remaining maturities greater than 20 years. The fund provides exposure to long-term US government debt, which is considered among the safest investments but is highly sensitive to interest rate changes. TLT is often used for portfolio diversification, as an interest rate hedge, or for tactical positioning based on rate expectations.',
    category: 'Long Government',
    fundFamily: 'iShares',
    inceptionDate: 'Jul 22, 2002',
    numberOfHoldings: 44,
  },
  XLF: {
    description: 'Financial Select Sector SPDR Fund tracks the Financial Select Sector Index, providing exposure to US financial services companies including banks, insurance companies, and diversified financial services firms. Top holdings typically include Berkshire Hathaway, JPMorgan Chase, and Visa. XLF offers concentrated exposure to the financial sector of the S&P 500.',
    category: 'Financial',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Dec 16, 1998',
    numberOfHoldings: 72,
  },
  XLK: {
    description: 'Technology Select Sector SPDR Fund tracks the Technology Select Sector Index, providing exposure to US technology companies including software, hardware, semiconductors, and IT services. Top holdings typically include Apple, Microsoft, and NVIDIA. XLK offers concentrated exposure to the technology sector of the S&P 500 and has been one of the best-performing sector ETFs over the past decade.',
    category: 'Technology',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Dec 16, 1998',
    numberOfHoldings: 69,
  },
  XLE: {
    description: 'Energy Select Sector SPDR Fund tracks the Energy Select Sector Index, providing exposure to US energy companies including oil, gas, and consumable fuels companies, as well as energy equipment and services providers. Top holdings typically include ExxonMobil and Chevron. XLE offers concentrated exposure to the energy sector of the S&P 500.',
    category: 'Energy',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Dec 16, 1998',
    numberOfHoldings: 23,
  },
  XLV: {
    description: 'Health Care Select Sector SPDR Fund tracks the Health Care Select Sector Index, providing exposure to US healthcare companies including pharmaceuticals, biotechnology, healthcare equipment, and healthcare providers. Top holdings typically include UnitedHealth, Johnson & Johnson, and Eli Lilly. XLV offers concentrated exposure to the healthcare sector of the S&P 500.',
    category: 'Health',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Dec 16, 1998',
    numberOfHoldings: 64,
  },
  BND: {
    description: 'Vanguard Total Bond Market ETF tracks the Bloomberg US Aggregate Float Adjusted Index, providing broad exposure to US investment-grade bonds including government, corporate, and mortgage-backed securities. The fund offers diversified fixed income exposure with Vanguard\'s low expense ratio. BND is one of the most popular bond ETFs and is commonly used as the fixed income component of diversified portfolios.',
    category: 'Intermediate Core Bond',
    fundFamily: 'Vanguard',
    inceptionDate: 'Apr 3, 2007',
    numberOfHoldings: 11388,
  },
  AGG: {
    description: 'iShares Core US Aggregate Bond ETF tracks the Bloomberg US Aggregate Bond Index, providing broad exposure to US investment-grade bonds. The fund includes Treasury bonds, government agency bonds, mortgage-backed securities, and corporate bonds. AGG is one of the largest and most liquid bond ETFs, offering low-cost diversified exposure to the US bond market.',
    category: 'Intermediate Core Bond',
    fundFamily: 'iShares',
    inceptionDate: 'Sep 22, 2003',
    numberOfHoldings: 12072,
  },
  VIG: {
    description: 'Vanguard Dividend Appreciation ETF tracks the S&P US Dividend Growers Index, focusing on US companies that have increased their dividends for at least 10 consecutive years. The fund emphasizes dividend growth rather than high current yield, selecting companies with strong fundamentals and consistent dividend policies. VIG is popular among income-focused investors seeking quality companies with sustainable dividend growth.',
    category: 'Large Blend',
    fundFamily: 'Vanguard',
    inceptionDate: 'Apr 21, 2006',
    numberOfHoldings: 338,
  },
  VYM: {
    description: 'Vanguard High Dividend Yield ETF tracks the FTSE High Dividend Yield Index, providing exposure to US stocks with above-average dividend yields. The fund focuses on companies expected to pay above-average dividends and offers higher current income than growth-focused funds. VYM is popular among income investors seeking regular dividend payments with Vanguard\'s low costs.',
    category: 'Large Value',
    fundFamily: 'Vanguard',
    inceptionDate: 'Nov 10, 2006',
    numberOfHoldings: 535,
  },
  SOXX: {
    description: 'iShares Semiconductor ETF tracks the ICE Semiconductor Index, providing exposure to US companies involved in the design, manufacture, and distribution of semiconductors. Holdings include companies like NVIDIA, AMD, Broadcom, and Intel. SOXX offers concentrated exposure to the semiconductor industry, which is critical to technology, AI, and computing advancements.',
    category: 'Technology',
    fundFamily: 'iShares',
    inceptionDate: 'Jul 10, 2001',
    numberOfHoldings: 30,
  },
  SMH: {
    description: 'VanEck Semiconductor ETF tracks the MVIS US Listed Semiconductor 25 Index, providing exposure to the 25 largest US-listed semiconductor companies. The fund includes chip designers, manufacturers, and equipment makers. SMH offers targeted exposure to the semiconductor industry with a concentrated portfolio of the sector\'s largest players.',
    category: 'Technology',
    fundFamily: 'VanEck',
    inceptionDate: 'Dec 20, 2011',
    numberOfHoldings: 25,
  },
  AAPL: {
    description: 'Apple Inc. designs, manufactures, and markets smartphones, personal computers, tablets, wearables, and accessories worldwide. The company offers iPhone, a line of smartphones; Mac, a line of personal computers; iPad, a line of multi-purpose tablets; and wearables, home, and accessories comprising AirPods, Apple TV, Apple Watch, Beats products, and HomePod. It also provides AppleCare support and cloud services; and operates various platforms, including the App Store and Apple Music. The company was founded by Steve Jobs, Steve Wozniak, and Ronald Wayne in April 1976 and is headquartered in Cupertino, CA. The listed name for AAPL is Apple Inc. Common Stock.',
    sector: 'Technology',
    industry: 'Consumer Electronics',
  },
  MSFT: {
    description: 'Microsoft Corporation develops and supports software, services, devices, and solutions worldwide. The Productivity and Business Processes segment offers Office, Exchange, SharePoint, Microsoft Teams, and related services. The Intelligent Cloud segment offers Azure, SQL Server, Windows Server, GitHub, and enterprise services. The More Personal Computing segment offers Windows, devices like Surface, gaming including Xbox, and search advertising. The company was founded by Bill Gates and Paul Allen in April 1975 and is headquartered in Redmond, WA. The listed name for MSFT is Microsoft Corporation Common Stock.',
    sector: 'Technology',
    industry: 'Software—Infrastructure',
  },
  GOOGL: {
    description: 'Alphabet Inc. is a holding company that operates through Google Services, Google Cloud, and Other Bets segments. Google Services includes products and services such as ads, Android, Chrome, Gmail, Google Drive, Google Maps, Google Photos, Google Play, Search, and YouTube. Google Cloud offers infrastructure, cybersecurity, data, analytics, AI, and machine learning services. Other Bets includes businesses like Waymo autonomous vehicles and Verily life sciences. The company was founded by Larry Page and Sergey Brin in September 1998 and is headquartered in Mountain View, CA. The listed name for GOOGL is Alphabet Inc. Class A Common Stock.',
    sector: 'Communication Services',
    industry: 'Internet Content & Information',
  },
  AMZN: {
    description: 'Amazon.com, Inc. is a multinational technology company which engages in the provision of online retail shopping services. It operates through the following segments: North America, International, and Amazon Web Services (AWS). The North America segment offers retail sale of consumer products, including from sellers, advertising, and subscriptions services through North America-focused online and physical stores. The International segment focuses on retail sale of consumer products, including from sellers, advertising, and subscription services through internationally-focused online stores. The AWS segment is composed of global sales of compute, storage, database, and other services for start-ups, enterprises, government agencies, and academic institutions. The company was founded by Jeffrey P. Bezos in July 1994 and is headquartered in Seattle, WA. The listed name for AMZN is Amazon.com, Inc. Common Stock.',
    sector: 'Consumer Cyclical',
    industry: 'Internet Retail',
  },
  NVDA: {
    description: 'NVIDIA Corporation provides graphics and compute solutions worldwide. The Graphics segment offers GeForce GPUs for gaming and PCs, the GeForce NOW game streaming service, and solutions for gaming platforms. The Compute & Networking segment provides Data Center accelerated computing platforms for AI, high-performance computing, and data center workloads; Mellanox networking and interconnect solutions; automotive AI Cockpit and self-driving platforms; and NVIDIA AI Enterprise software. The company was founded by Jensen Huang, Chris Malachowsky, and Curtis Priem in January 1993 and is headquartered in Santa Clara, CA. The listed name for NVDA is NVIDIA Corporation Common Stock.',
    sector: 'Technology',
    industry: 'Semiconductors',
  },
  TSLA: {
    description: 'Tesla, Inc. designs, develops, manufactures, leases, and sells electric vehicles, and energy generation and storage systems. The Automotive segment includes the design, development, manufacturing, and sales of electric vehicles, including the Model 3 sedan, Model Y crossover, Model S sedan, Model X SUV, and Cybertruck. The Energy Generation and Storage segment includes the design, manufacture, installation, and sale of solar energy generation and energy storage products. The company also offers vehicle service centers, Supercharger stations, and self-driving capability. The company was founded by Elon Musk, JB Straubel, Martin Eberhard, Marc Tarpenning, and Ian Wright in July 2003 and is headquartered in Austin, TX. The listed name for TSLA is Tesla, Inc. Common Stock.',
    sector: 'Consumer Cyclical',
    industry: 'Auto Manufacturers',
  },
  META: {
    description: 'Meta Platforms, Inc. develops products that enable people to connect and share through mobile devices, personal computers, virtual reality headsets, and wearables worldwide. It operates through Family of Apps and Reality Labs segments. The Family of Apps segment offers Facebook, Instagram, Messenger, WhatsApp, and other services for people to connect, share, discover, and communicate. The Reality Labs segment includes augmented and virtual reality products comprising Quest, Ray-Ban Meta smart glasses, and related software and content. The company was founded by Mark Zuckerberg, Dustin Moskovitz, Chris Hughes, Andrew McCollum, and Eduardo Saverin in February 2004 and is headquartered in Menlo Park, CA. The listed name for META is Meta Platforms, Inc. Class A Common Stock.',
    sector: 'Communication Services',
    industry: 'Internet Content & Information',
  },
  // Additional stocks
  ASML: {
    description: 'ASML Holding N.V. develops, produces, markets, sells, and services advanced semiconductor equipment systems worldwide. The company provides lithography systems, primarily used to manufacture complex integrated circuits. It offers extreme ultraviolet (EUV) lithography systems, deep ultraviolet (DUV) lithography systems, and metrology and inspection systems. ASML serves the semiconductor industry and has a near-monopoly on EUV lithography machines essential for manufacturing advanced chips. The company was founded in 1984 and is headquartered in Veldhoven, the Netherlands. The listed name for ASML is ASML Holding N.V. New York Registry Shares.',
    sector: 'Technology',
    industry: 'Semiconductor Equipment & Materials',
  },
  AXP: {
    description: 'American Express Company provides charge and credit payment card products, and travel-related services worldwide. The Global Consumer Services Group segment issues cards and provides services to consumers. The Global Commercial Services segment issues business and corporate cards, provides expense management and business financing. The Global Merchant and Network Services segment operates a global payments network and provides merchant acquisition and processing. The company was founded by Henry Wells and William Fargo in March 1850 and is headquartered in New York, NY. The listed name for AXP is American Express Company Common Stock.',
    sector: 'Financial Services',
    industry: 'Credit Services',
  },
  BA: {
    description: 'The Boeing Company designs, develops, manufactures, sells, services, and supports commercial jetliners, military aircraft, satellites, missile defense, human space flight and launch systems worldwide. The Commercial Airplanes segment develops, produces, and markets commercial jet aircraft including the 737, 767, 777, and 787 families. The Defense, Space & Security segment engages in research, development, and production of military aircraft, weapons systems, and space systems. The Global Services segment provides parts, maintenance, training, and data analytics. The company was founded by William Boeing in July 1916 and is headquartered in Arlington, VA. The listed name for BA is Boeing Company Common Stock.',
    sector: 'Industrials',
    industry: 'Aerospace & Defense',
  },
  BABA: {
    description: 'Alibaba Group Holding Limited provides technology infrastructure and marketing reach to help merchants, brands, retailers, and businesses engage with customers in China and internationally. The China Commerce segment operates Taobao, Tmall, and other marketplaces. The International Commerce segment operates Lazada, AliExpress, and Alibaba.com. The Cloud segment offers elastic computing, database, storage, and security services through Alibaba Cloud. The Digital Media segment includes Youku video platform and Alibaba Pictures. The company was founded by Jack Ma and 17 partners in April 1999 and is headquartered in Hangzhou, China. The listed name for BABA is Alibaba Group Holding Limited American Depositary Shares.',
    sector: 'Consumer Cyclical',
    industry: 'Internet Retail',
  },
  EEM: {
    description: 'iShares MSCI Emerging Markets ETF tracks a market cap-weighted index of emerging-market firms, providing broad exposure to large and mid-cap companies in developing economies worldwide. The fund invests in countries including China, Taiwan, India, South Korea, and Brazil among others. Top sectors include technology, financials, and consumer discretionary. The fund offers diversified exposure to growth potential in developing economies with the associated higher volatility and risk. EEM is managed by BlackRock and is one of the largest emerging markets ETFs by assets under management.',
    category: 'Diversified Emerging Mkts',
    fundFamily: 'iShares',
    inceptionDate: 'Apr 7, 2003',
    numberOfHoldings: 1200,
  },
  HD: {
    description: 'The Home Depot, Inc. operates as a home improvement retailer in the United States, Canada, and Mexico. The company sells building materials, home improvement products, lawn and garden products, décor products, and facilities maintenance, repair, and operations products. It also provides home improvement installation services and tool and equipment rental. The company operates approximately 2,300 stores with an average store size of 105,000 square feet of enclosed space and 24,000 square feet of outdoor garden area. The company was founded by Bernard Marcus, Arthur Blank, Ron Brill, and Pat Farrah in June 1978 and is headquartered in Atlanta, GA. The listed name for HD is Home Depot, Inc. Common Stock.',
    sector: 'Consumer Cyclical',
    industry: 'Home Improvement Retail',
  },
  LMT: {
    description: 'Lockheed Martin Corporation is a global security and aerospace company that researches, designs, develops, manufactures, integrates, and sustains advanced technology systems, products, and services worldwide. The Aeronautics segment offers combat and air mobility aircraft including the F-35, F-22, F-16, and C-130. The Missiles and Fire Control segment provides air and missile defense systems, tactical missiles, and precision strike weapons. The Rotary and Mission Systems segment offers military and commercial helicopters, surface ships, and cyber solutions. The Space segment provides satellites, strategic missiles, and space transportation systems. The company was founded in 1995 through the merger of Lockheed Corporation and Martin Marietta and is headquartered in Bethesda, MD. The listed name for LMT is Lockheed Martin Corporation Common Stock.',
    sector: 'Industrials',
    industry: 'Aerospace & Defense',
  },
  RDDT: {
    description: 'Reddit, Inc. operates as a social media and online community platform in the United States and internationally. The company operates Reddit, a community of communities where people can explore their interests, hobbies, and passions through posting, commenting, and voting on content. The platform hosts over 100,000 active communities (subreddits) covering topics from news and entertainment to niche hobbies. Revenue comes primarily from advertising and premium subscriptions (Reddit Premium). The company also provides APIs for developers and has expanded into data licensing for AI training. Reddit was founded by Steve Huffman and Alexis Ohanian in June 2005 and is headquartered in San Francisco, CA. The listed name for RDDT is Reddit, Inc. Class A Common Stock.',
    sector: 'Communication Services',
    industry: 'Internet Content & Information',
  },
  TSM: {
    description: 'Taiwan Semiconductor Manufacturing Company Limited manufactures, packages, tests, and sells integrated circuits and semiconductor devices worldwide. It provides wafer manufacturing services for logic, mixed-signal, radio frequency, and embedded memory semiconductors. The company serves customers including Apple, NVIDIA, AMD, and Qualcomm, manufacturing chips designed by these companies. TSMC operates advanced fabrication facilities producing chips at leading-edge process nodes including 3nm and 5nm. The company holds over 50% market share of the global semiconductor foundry market and is critical to the global technology supply chain. The company was founded by Morris Chang in February 1987 and is headquartered in Hsinchu, Taiwan. The listed name for TSM is Taiwan Semiconductor Manufacturing Company Limited American Depositary Shares.',
    sector: 'Technology',
    industry: 'Semiconductors',
  },
  ON: {
    description: 'ON Semiconductor Corporation (doing business as onsemi) designs and manufactures power and sensing semiconductors — power management ICs, analog and mixed-signal devices, image sensors, and discrete components — for the automotive, industrial, cloud, and consumer markets. onsemi is a leading supplier of silicon carbide (SiC) power technology central to electric vehicles, EV charging, renewable energy infrastructure, and data-center power efficiency. Originally a semiconductor division of Motorola, it became an independent company in 1999 and is headquartered in Scottsdale, Arizona. The listed name for ON is ON Semiconductor Corporation.',
    sector: 'Technology',
    industry: 'Semiconductors',
  },
  VRT: {
    description: 'Vertiv Holdings Co designs, manufactures, and services critical digital infrastructure technologies and life cycle services for data centers, communication networks, and commercial and industrial environments worldwide. The Americas and Asia Pacific segments provide power management products including uninterruptible power supplies (UPS), power distribution, and switchgear. The company also offers thermal management solutions including precision cooling systems for data centers. Vertiv serves hyperscale cloud providers, colocation providers, enterprises, and telecommunications companies. The company was formerly known as Emerson Network Power before being spun off and is headquartered in Westerville, OH. The listed name for VRT is Vertiv Holdings Co Class A Common Stock.',
    sector: 'Technology',
    industry: 'Electrical Equipment & Parts',
  },
  WMT: {
    description: 'Walmart Inc. operates retail, wholesale, and other units worldwide. The Walmart U.S. segment operates supercenters, supermarkets, hypermarkets, and discount stores, as well as eCommerce platforms including Walmart.com. The Walmart International segment operates supercenters, supermarkets, hypermarkets, warehouse clubs, and eCommerce in multiple countries. The Sam\'s Club segment operates warehouse membership clubs and eCommerce. The company is the world\'s largest retailer by revenue with over 10,500 stores and clubs in 19 countries. Walmart employs approximately 2.1 million associates worldwide. The company was founded by Sam Walton in July 1962 and is headquartered in Bentonville, AR. The listed name for WMT is Walmart Inc. Common Stock.',
    sector: 'Consumer Defensive',
    industry: 'Discount Stores',
  },
  TTWO: {
    description: 'Take-Two Interactive Software, Inc. develops, publishes, and markets interactive entertainment for consumers worldwide. The company offers products through its wholly-owned labels Rockstar Games and 2K, as well as Private Division and Zynga. Rockstar Games is known for franchises including Grand Theft Auto and Red Dead Redemption. 2K publishes titles including NBA 2K, WWE 2K, Civilization, and Borderlands. Zynga produces mobile games including Words With Friends and FarmVille. Products are designed for console gaming systems, personal computers, and mobile devices including smartphones and tablets. The company was founded by Ryan A. Brant in September 1993 and is headquartered in New York, NY. The listed name for TTWO is Take-Two Interactive Software, Inc. Common Stock.',
    sector: 'Communication Services',
    industry: 'Electronic Gaming & Multimedia',
  },
  CAT: {
    description: 'Caterpillar Inc. manufactures construction and mining equipment, diesel and natural gas engines, industrial gas turbines, and diesel-electric locomotives worldwide. The Construction Industries segment offers machinery for infrastructure, forestry, and building construction. The Resource Industries segment provides equipment for mining, quarry, and aggregates. The Energy & Transportation segment offers reciprocating engines, turbines, diesel-electric locomotives, and related services. Caterpillar is the world\'s largest manufacturer of construction and mining equipment. The company was founded in 1925 through the merger of Holt Manufacturing and C.L. Best Tractor and is headquartered in Irving, TX.',
    sector: 'Industrials',
    industry: 'Farm & Heavy Construction Machinery',
  },
  PWR: {
    description: 'Quanta Services, Inc. provides infrastructure services for the electric and gas utility, renewable energy, telecommunications, and pipeline industries in the United States, Canada, and internationally. The Electric Power Infrastructure Solutions segment designs, installs, upgrades, and maintains electric power transmission and distribution infrastructure. The Renewable Energy Infrastructure Solutions segment provides engineering, procurement, and construction services for wind, solar, and battery storage. The Underground Utility and Infrastructure Solutions segment installs and maintains gas distribution and transmission systems. The company was founded in 1997 and is headquartered in Houston, TX.',
    sector: 'Industrials',
    industry: 'Engineering & Construction',
  },
  ROK: {
    description: 'Rockwell Automation, Inc. provides industrial automation and digital transformation solutions worldwide. The Intelligent Devices segment offers drives, motion control, safety devices, sensors, and industrial components. The Software & Control segment provides control and visualization software, information software, and network technology. The Lifecycle Services segment delivers consulting, professional services, and connected enterprise solutions. The company serves industries including automotive, food and beverage, life sciences, oil and gas, and mining. Rockwell Automation was founded in 1903 and is headquartered in Milwaukee, WI.',
    sector: 'Industrials',
    industry: 'Specialty Industrial Machinery',
  },
  MAR: {
    description: 'Marriott International, Inc. operates, franchises, and licenses hotel, residential, and timeshare properties worldwide. The company operates through US & Canada and International segments. It operates and franchises hotels and resorts under brands including Marriott, Sheraton, Westin, W Hotels, The Ritz-Carlton, St. Regis, Courtyard, Residence Inn, and Fairfield. The company manages approximately 8,800 properties across 139 countries, making it the world\'s largest hotel company by room count. Marriott International was founded by J. Willard Marriott in 1927 and is headquartered in Bethesda, MD.',
    sector: 'Consumer Cyclical',
    industry: 'Lodging',
  },
  HLT: {
    description: 'Hilton Worldwide Holdings Inc. is a global hospitality company that manages and franchises hotels and resorts. The company operates through Management & Franchise and Ownership segments. It operates brands including Hilton Hotels & Resorts, Waldorf Astoria, Conrad, DoubleTree, Hampton, Embassy Suites, Hilton Garden Inn, and Home2 Suites. Hilton has a portfolio of approximately 7,500 properties with over 1.1 million rooms across 126 countries and territories. The company was founded by Conrad Hilton in 1919 and is headquartered in McLean, VA.',
    sector: 'Consumer Cyclical',
    industry: 'Lodging',
  },
  FERG: {
    description: 'Ferguson plc distributes plumbing and heating products in the United States, United Kingdom, and Canada. The company supplies residential and commercial customers with pipes, valves, fittings, plumbing fixtures, HVAC equipment, waterworks products, and fire protection systems. It serves professional contractors, municipalities, and industrial customers through approximately 1,700 branches. Ferguson is the largest distributor of plumbing supplies in North America. The company was founded in 1887 and is headquartered in Wokingham, United Kingdom, with US operations based in Newport News, VA.',
    sector: 'Industrials',
    industry: 'Industrial Distribution',
  },
  CRH: {
    description: 'CRH plc manufactures and distributes building materials worldwide. The Americas Materials segment produces aggregates, asphalt, cement, and ready-mixed concrete across North America. The Americas Products segment provides architectural products, infrastructure products, and construction accessories. The company also operates in Europe through its Building Products and Materials divisions. CRH is one of the largest building materials companies in the world, operating in over 25 countries with approximately 3,100 operating locations. The company was founded in 1970 and is headquartered in Dublin, Ireland.',
    sector: 'Basic Materials',
    industry: 'Building Materials',
  },
  CSX: {
    description: 'CSX Corporation provides rail-based freight transportation services in the eastern United States, the District of Columbia, and parts of Canada. The company transports merchandise including chemicals, automotive, agricultural, forest products, minerals, and metals. It also transports intermodal containers and trailers, as well as coal for utilities and industrial customers. CSX operates approximately 20,000 route miles of track across 26 states east of the Mississippi River. The company was founded in 1827 and is headquartered in Jacksonville, FL.',
    sector: 'Industrials',
    industry: 'Railroads',
  },
  GILD: {
    description: 'Gilead Sciences, Inc. is a biopharmaceutical company that discovers, develops, and commercializes medicines in areas of unmet medical need worldwide. The company\'s products include Biktarvy, Descovy, and Truvada for HIV/AIDS treatment and prevention; Veklury (remdesivir) for COVID-19; Harvoni and Sovaldi for hepatitis C; Vemlidy for hepatitis B; and Yescarta and Tecartus CAR T-cell therapies for certain cancers. Gilead is a leader in antiviral therapeutics and has expanded into oncology and inflammatory diseases. The company was founded by Michael L. Riordan in June 1987 and is headquartered in Foster City, CA.',
    sector: 'Healthcare',
    industry: 'Drug Manufacturers—General',
  },
  EWJ: {
    description: 'iShares MSCI Japan ETF tracks the MSCI Japan Index, providing exposure to large and mid-cap Japanese equities. The fund invests in companies across Japan\'s economy including Toyota, Sony, Mitsubishi, Keyence, and other major corporations. Top sectors include industrials, consumer discretionary, financials, and information technology. EWJ is one of the oldest and most widely traded Japan-focused ETFs, offering investors broad access to the world\'s third-largest economy. The fund is managed by BlackRock.',
    category: 'Japan Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 225,
  },
  EIS: {
    description: 'iShares MSCI Israel ETF tracks the MSCI Israel Capped Investable Market Index, providing exposure to Israeli equities across all market capitalizations. The fund invests in companies spanning Israel\'s technology-heavy economy, including firms in information technology, healthcare, financials, and real estate sectors. Israel is known as the "Startup Nation" with a highly innovative technology sector. Top holdings typically include Check Point Software, Nice Ltd, and Bank Leumi. The fund is managed by BlackRock.',
    category: 'Miscellaneous Region',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 26, 2008',
    numberOfHoldings: 112,
  },
  EWZ: {
    description: 'iShares MSCI Brazil ETF tracks the MSCI Brazil 25/50 Index, providing exposure to large and mid-cap Brazilian equities. The fund invests in companies across Brazil\'s commodity-rich economy including Petrobras, Vale, Itau Unibanco, and Ambev. Top sectors include financials, energy, materials, and utilities. EWZ is the most widely traded Brazil-focused ETF and offers investors access to Latin America\'s largest economy. The fund is managed by BlackRock.',
    category: 'Latin America Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Jul 10, 2000',
    numberOfHoldings: 47,
  },
  IGV: {
    description: 'iShares Expanded Tech-Software Sector ETF tracks the S&P North American Expanded Technology Software Index, providing exposure to North American software companies. The fund invests in companies involved in systems software, application software, home entertainment software, and interactive media. Top holdings typically include Microsoft, Salesforce, Adobe, Intuit, and ServiceNow. IGV offers targeted exposure to the software industry, which benefits from recurring revenue models, cloud computing growth, and enterprise digital transformation. The fund is managed by BlackRock.',
    category: 'Technology',
    fundFamily: 'iShares',
    inceptionDate: 'Jul 10, 2001',
    numberOfHoldings: 120,
  },
  // ── Sector Select SPDRs ──────────────────────────────────────────
  XLC: {
    description: 'Communication Services Select Sector SPDR Fund tracks the Communication Services Select Sector Index, providing exposure to US communication services companies including interactive media, entertainment, and telecommunications. Top holdings typically include Meta Platforms, Alphabet, Netflix, and Walt Disney. XLC was created in 2018 when the GICS sector classification was reorganized.',
    category: 'Communications',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Jun 18, 2018',
    numberOfHoldings: 23,
  },
  XLY: {
    description: 'Consumer Discretionary Select Sector SPDR Fund tracks the Consumer Discretionary Select Sector Index, providing exposure to US consumer discretionary companies including retail, automobiles, hotels, restaurants, and leisure. Top holdings typically include Amazon, Tesla, Home Depot, and McDonald\'s.',
    category: 'Consumer Cyclical',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Dec 16, 1998',
    numberOfHoldings: 51,
  },
  XLP: {
    description: 'Consumer Staples Select Sector SPDR Fund tracks the Consumer Staples Select Sector Index, providing exposure to US consumer staples companies including food, beverage, tobacco, and household products. Top holdings typically include Procter & Gamble, Costco, Walmart, and Coca-Cola.',
    category: 'Consumer Defensive',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Dec 16, 1998',
    numberOfHoldings: 38,
  },
  XLI: {
    description: 'Industrial Select Sector SPDR Fund tracks the Industrial Select Sector Index, providing exposure to US industrial companies including aerospace & defense, building products, electrical equipment, conglomerates, and machinery. Top holdings typically include GE Aerospace, Caterpillar, RTX, and Union Pacific.',
    category: 'Industrials',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Dec 16, 1998',
    numberOfHoldings: 78,
  },
  XLU: {
    description: 'Utilities Select Sector SPDR Fund tracks the Utilities Select Sector Index, providing exposure to US utilities companies including electric, gas, water utilities, and independent power producers. Top holdings typically include NextEra Energy, Southern Company, and Duke Energy. XLU is often used as a defensive, income-oriented investment.',
    category: 'Utilities',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Dec 16, 1998',
    numberOfHoldings: 31,
  },
  XLRE: {
    description: 'Real Estate Select Sector SPDR Fund tracks the Real Estate Select Sector Index, providing exposure to US real estate investment trusts (REITs) and real estate management companies. Top holdings typically include Prologis, American Tower, Equinix, and Simon Property Group.',
    category: 'Real Estate',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Oct 7, 2015',
    numberOfHoldings: 31,
  },
  XLB: {
    description: 'Materials Select Sector SPDR Fund tracks the Materials Select Sector Index, providing exposure to US materials companies including chemicals, metals & mining, containers & packaging, and construction materials. Top holdings typically include Linde, Sherwin-Williams, Freeport-McMoRan, and Ecolab.',
    category: 'Basic Materials',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'Dec 16, 1998',
    numberOfHoldings: 28,
  },
  // ── ARK ETFs ──────────────────────────────────────────────────────
  ARKG: {
    description: 'ARK Genomic Revolution ETF is an actively managed fund that invests in companies focused on extending and enhancing the quality of human and other life by incorporating technological and scientific developments in genomics. The fund targets areas like CRISPR gene editing, targeted therapeutics, bioinformatics, molecular diagnostics, and agricultural biology.',
    category: 'Health',
    fundFamily: 'ARK Investment Management',
    inceptionDate: 'Oct 31, 2014',
    numberOfHoldings: 30,
  },
  ARKW: {
    description: 'ARK Next Generation Internet ETF is an actively managed fund that invests in companies focused on and expected to benefit from shifting technology infrastructure to cloud-based services, enabling mobile and internet-based products, and new payment methods. The fund targets areas like cloud computing, cybersecurity, cryptocurrency, e-commerce, and artificial intelligence.',
    category: 'Technology',
    fundFamily: 'ARK Investment Management',
    inceptionDate: 'Sep 30, 2014',
    numberOfHoldings: 35,
  },
  ARKF: {
    description: 'ARK Fintech Innovation ETF is an actively managed fund that invests in companies that are changing the way the financial sector works by introducing technology-driven products and services. The fund targets areas like digital wallets, peer-to-peer lending, blockchain technology, risk transformation, and frictionless funding platforms.',
    category: 'Financial',
    fundFamily: 'ARK Investment Management',
    inceptionDate: 'Feb 4, 2019',
    numberOfHoldings: 35,
  },
  // ── Bond ETFs ─────────────────────────────────────────────────────
  IEF: {
    description: 'iShares 7-10 Year Treasury Bond ETF tracks an index of US Treasury bonds with remaining maturities between seven and ten years. The fund provides targeted exposure to intermediate-term US government debt, offering moderate interest rate sensitivity between short-term and long-term bonds. IEF is commonly used for duration management and as a portfolio diversifier.',
    category: 'Intermediate Government',
    fundFamily: 'iShares',
    inceptionDate: 'Jul 22, 2002',
    numberOfHoldings: 16,
  },
  SHY: {
    description: 'iShares 1-3 Year Treasury Bond ETF tracks an index of US Treasury bonds with remaining maturities between one and three years. The fund provides exposure to short-term US government debt with minimal interest rate risk. SHY is often used as a cash alternative or for capital preservation during periods of rising rates.',
    category: 'Short Government',
    fundFamily: 'iShares',
    inceptionDate: 'Jul 22, 2002',
    numberOfHoldings: 86,
  },
  HYG: {
    description: 'iShares iBoxx $ High Yield Corporate Bond ETF tracks a market-weighted index of US dollar-denominated, high yield (below investment-grade) corporate bonds. The fund provides exposure to corporate debt rated BB and below, offering higher yields with correspondingly higher credit risk. HYG is one of the most liquid high yield bond ETFs.',
    category: 'High Yield Bond',
    fundFamily: 'iShares',
    inceptionDate: 'Apr 4, 2007',
    numberOfHoldings: 1200,
  },
  LQD: {
    description: 'iShares iBoxx $ Investment Grade Corporate Bond ETF tracks a market-weighted index of US dollar-denominated, investment grade corporate bonds. The fund provides exposure to high-quality corporate debt from companies like JPMorgan, AT&T, and Bank of America. LQD is one of the largest and most liquid corporate bond ETFs.',
    category: 'Corporate Bond',
    fundFamily: 'iShares',
    inceptionDate: 'Jul 22, 2002',
    numberOfHoldings: 2800,
  },
  BNDX: {
    description: 'Vanguard Total International Bond ETF tracks the Bloomberg Global Aggregate ex-USD Float Adjusted RIC Capped Index (USD Hedged), providing exposure to non-US dollar-denominated investment-grade bonds while hedging currency risk. The fund includes government, agency, and corporate bonds from developed and emerging markets outside the US.',
    category: 'World Bond-USD Hedged',
    fundFamily: 'Vanguard',
    inceptionDate: 'Jun 4, 2013',
    numberOfHoldings: 6900,
  },
  EMB: {
    description: 'iShares JP Morgan USD Emerging Markets Bond ETF tracks the J.P. Morgan EMBI Global Core Index, providing exposure to US dollar-denominated government bonds issued by emerging market countries. The fund includes sovereign debt from countries like Mexico, Indonesia, Saudi Arabia, and Turkey, offering higher yields than developed market bonds.',
    category: 'Emerging Markets Bond',
    fundFamily: 'iShares',
    inceptionDate: 'Dec 17, 2007',
    numberOfHoldings: 600,
  },
  TIP: {
    description: 'iShares TIPS Bond ETF tracks an index of US Treasury Inflation-Protected Securities (TIPS). These bonds adjust their principal value based on changes in the Consumer Price Index, providing protection against inflation. TIP is widely used as an inflation hedge in diversified portfolios.',
    category: 'Inflation-Protected Bond',
    fundFamily: 'iShares',
    inceptionDate: 'Dec 4, 2003',
    numberOfHoldings: 50,
  },
  // ── Broad Market ETFs ─────────────────────────────────────────────
  IVV: {
    description: 'iShares Core S&P 500 ETF tracks the S&P 500 Index, providing exposure to 500 of the largest US companies. IVV is one of the three largest S&P 500 ETFs by assets and offers an extremely low expense ratio. The fund is managed by BlackRock and competes directly with SPY and VOO.',
    category: 'Large Blend',
    fundFamily: 'iShares',
    inceptionDate: 'May 15, 2000',
    numberOfHoldings: 503,
  },
  ITOT: {
    description: 'iShares Core S&P Total US Stock Market ETF tracks the S&P Total Market Index, providing exposure to the entire US equity market across large-, mid-, small-, and micro-cap stocks. The fund offers comprehensive domestic stock market exposure in a single holding with very low costs.',
    category: 'Large Blend',
    fundFamily: 'iShares',
    inceptionDate: 'Jan 20, 2004',
    numberOfHoldings: 3700,
  },
  RSP: {
    description: 'Invesco S&P 500 Equal Weight ETF tracks an equal-weighted version of the S&P 500 Index, giving each stock the same weight regardless of market capitalization. This approach reduces concentration in mega-cap tech stocks and provides more balanced exposure across all 500 constituents. RSP is rebalanced quarterly.',
    category: 'Large Blend',
    fundFamily: 'Invesco',
    inceptionDate: 'Apr 24, 2003',
    numberOfHoldings: 503,
  },
  MDY: {
    description: 'SPDR S&P Midcap 400 ETF Trust tracks the S&P MidCap 400 Index, providing exposure to mid-sized US companies. Mid-cap stocks often offer a balance between the growth potential of small caps and the stability of large caps. MDY is one of the oldest and most widely traded mid-cap ETFs.',
    category: 'Mid-Cap Blend',
    fundFamily: 'SPDR State Street Global Advisors',
    inceptionDate: 'May 4, 1995',
    numberOfHoldings: 401,
  },
  IJR: {
    description: 'iShares Core S&P Small-Cap ETF tracks the S&P SmallCap 600 Index, providing exposure to small-cap US companies that meet specific profitability and liquidity criteria. The quality screen differentiates IJR from broader small-cap benchmarks like the Russell 2000. The fund is managed by BlackRock.',
    category: 'Small Blend',
    fundFamily: 'iShares',
    inceptionDate: 'May 22, 2000',
    numberOfHoldings: 601,
  },
  // ── Biotech & Healthcare ──────────────────────────────────────────
  IBB: {
    description: 'iShares Biotechnology ETF tracks the ICE Biotechnology Index, providing market cap-weighted exposure to US biotechnology companies. Unlike the equal-weighted XBI, IBB is dominated by large-cap biotech firms like Amgen, Gilead, Regeneron, and Vertex. The fund offers concentrated exposure to the biotech industry with a large-cap tilt.',
    category: 'Health',
    fundFamily: 'iShares',
    inceptionDate: 'Feb 5, 2001',
    numberOfHoldings: 270,
  },
  // ── Commodity ETFs ────────────────────────────────────────────────
  SLV: {
    description: 'iShares Silver Trust holds physical silver bullion and is designed to track the price of silver. SLV is the largest silver ETF by assets and provides investors with a convenient way to gain exposure to silver prices without handling physical metal. Silver has both industrial and precious metal demand characteristics.',
    category: 'Commodities Precious Metals',
    fundFamily: 'iShares',
    inceptionDate: 'Apr 21, 2006',
    numberOfHoldings: 1,
  },
  USO: {
    description: 'United States Oil Fund holds front-month West Texas Intermediate (WTI) crude oil futures contracts. USO aims to track the daily price movements of WTI light, sweet crude oil. The fund is commonly used for short-term oil price exposure but can deviate from spot oil prices over longer periods due to contango in the futures curve.',
    category: 'Commodities Energy',
    fundFamily: 'USCF',
    inceptionDate: 'Apr 10, 2006',
    numberOfHoldings: 1,
  },
  UNG: {
    description: 'United States Natural Gas Fund holds front-month natural gas futures contracts traded on NYMEX. UNG aims to track the daily price movements of natural gas delivered at the Henry Hub, Louisiana. Like other commodity futures ETFs, UNG can deviate from spot prices over time due to the rolling of futures contracts.',
    category: 'Commodities Energy',
    fundFamily: 'USCF',
    inceptionDate: 'Apr 18, 2007',
    numberOfHoldings: 1,
  },
  DBA: {
    description: 'Invesco DB Agriculture Fund tracks the DBIQ Diversified Agriculture Index Excess Return, providing exposure to agricultural commodity futures including corn, soybeans, wheat, sugar, cocoa, coffee, cotton, and live cattle. The fund uses an optimized roll strategy to minimize the negative effects of contango.',
    category: 'Commodities Agriculture',
    fundFamily: 'Invesco',
    inceptionDate: 'Jan 5, 2007',
    numberOfHoldings: 10,
  },
  DBC: {
    description: 'Invesco DB Commodity Index Tracking Fund tracks the DBIQ Optimum Yield Diversified Commodity Index Excess Return, providing broad exposure to commodity futures including energy, precious metals, industrial metals, and agriculture. The fund uses an optimized roll strategy to select futures contracts that minimize contango effects.',
    category: 'Commodities Broad Basket',
    fundFamily: 'Invesco',
    inceptionDate: 'Feb 3, 2006',
    numberOfHoldings: 14,
  },
  PDBC: {
    description: 'Invesco Optimum Yield Diversified Commodity Strategy No K-1 ETF provides broad commodity exposure through futures contracts on energy, precious metals, industrial metals, and agriculture. Unlike DBC, PDBC is structured to avoid issuing a K-1 tax form, simplifying tax reporting for investors.',
    category: 'Commodities Broad Basket',
    fundFamily: 'Invesco',
    inceptionDate: 'Nov 7, 2014',
    numberOfHoldings: 14,
  },
  // ── Thematic ETFs ─────────────────────────────────────────────────
  KWEB: {
    description: 'KraneShares CSI China Internet ETF tracks the CSI Overseas China Internet Index, providing exposure to Chinese internet and internet-related companies listed outside of mainland China. Top holdings typically include Alibaba, Tencent, PDD Holdings, JD.com, and Baidu. The fund offers targeted access to China\'s rapidly growing digital economy.',
    category: 'China Region',
    fundFamily: 'KraneShares',
    inceptionDate: 'Jul 31, 2013',
    numberOfHoldings: 40,
  },
  LIT: {
    description: 'Global X Lithium & Battery Tech ETF tracks the Solactive Global Lithium Index, providing exposure to the full lithium cycle from mining to battery production. Holdings include lithium miners, battery manufacturers, and electric vehicle companies. LIT offers targeted exposure to the lithium supply chain benefiting from EV adoption growth.',
    category: 'Miscellaneous Sector',
    fundFamily: 'Global X',
    inceptionDate: 'Jul 22, 2010',
    numberOfHoldings: 40,
  },
  TAN: {
    description: 'Invesco Solar ETF tracks the MAC Global Solar Energy Index, providing exposure to companies in the solar energy industry including solar panel manufacturers, installers, and solar technology providers. TAN offers targeted exposure to the solar energy transition and clean energy adoption trends.',
    category: 'Miscellaneous Sector',
    fundFamily: 'Invesco',
    inceptionDate: 'Apr 15, 2008',
    numberOfHoldings: 45,
  },
  ICLN: {
    description: 'iShares Global Clean Energy ETF tracks the S&P Global Clean Energy Index, providing exposure to global companies involved in clean energy production and equipment including solar, wind, and other renewable sources. The fund invests across developed and emerging markets.',
    category: 'Miscellaneous Sector',
    fundFamily: 'iShares',
    inceptionDate: 'Jun 24, 2008',
    numberOfHoldings: 100,
  },
  HACK: {
    description: 'ETFMG Prime Cyber Security ETF tracks the Prime Cyber Defense Index, providing exposure to companies involved in the cybersecurity industry including hardware, software, and services. The fund covers firms protecting against cyberattacks, managing security infrastructure, and providing consulting services.',
    category: 'Technology',
    fundFamily: 'ETFMG',
    inceptionDate: 'Nov 11, 2014',
    numberOfHoldings: 60,
  },
  BOTZ: {
    description: 'Global X Robotics & Artificial Intelligence ETF tracks the Indxx Global Robotics & Artificial Intelligence Thematic Index, providing exposure to companies involved in industrial robotics, automation, autonomous vehicles, and AI applications. Top holdings include firms from the US, Japan, and Europe.',
    category: 'Technology',
    fundFamily: 'Global X',
    inceptionDate: 'Sep 12, 2016',
    numberOfHoldings: 40,
  },
  CIBR: {
    description: 'First Trust NASDAQ Cybersecurity ETF tracks the Nasdaq CTA Cybersecurity Index, providing exposure to companies engaged in the cybersecurity segment of the technology and industrials sectors. The fund includes companies involved in building, implementing, and managing cybersecurity protocols and solutions.',
    category: 'Technology',
    fundFamily: 'First Trust',
    inceptionDate: 'Jul 6, 2015',
    numberOfHoldings: 35,
  },
  ROBO: {
    description: 'Robo Global Robotics and Automation Index ETF tracks the ROBO Global Robotics and Automation Index, providing exposure to companies driving innovation in robotics, automation, and AI. The fund covers subsectors including manufacturing, healthcare, logistics, and consumer applications across global markets.',
    category: 'Technology',
    fundFamily: 'Exchange Traded Concepts',
    inceptionDate: 'Oct 22, 2013',
    numberOfHoldings: 80,
  },
  SKYY: {
    description: 'First Trust Cloud Computing ETF tracks the ISE CTA Cloud Computing Index, providing exposure to companies actively involved in the cloud computing industry. The fund includes infrastructure-as-a-service, platform-as-a-service, and software-as-a-service providers driving the shift to cloud-based computing.',
    category: 'Technology',
    fundFamily: 'First Trust',
    inceptionDate: 'Jul 5, 2011',
    numberOfHoldings: 65,
  },
  CLOU: {
    description: 'Global X Cloud Computing ETF tracks the Indxx Global Cloud Computing Index, providing exposure to companies positioned to benefit from the increased adoption of cloud computing technology. The fund includes companies providing cloud-based software, platforms, and infrastructure services.',
    category: 'Technology',
    fundFamily: 'Global X',
    inceptionDate: 'Apr 12, 2019',
    numberOfHoldings: 35,
  },
  // ── Country/Region ETFs ───────────────────────────────────────────
  EWG: {
    description: 'iShares MSCI Germany ETF tracks the MSCI Germany Index, providing exposure to large and mid-cap German equities. The fund invests in companies spanning Europe\'s largest economy including SAP, Siemens, Allianz, and Deutsche Telekom. Top sectors include industrials, financials, and information technology.',
    category: 'Europe Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 60,
  },
  EWU: {
    description: 'iShares MSCI United Kingdom ETF tracks the MSCI United Kingdom Index, providing exposure to large and mid-cap UK equities. Top holdings typically include AstraZeneca, Shell, HSBC, and Unilever. The fund offers broad access to the UK equity market with significant weight in financials, healthcare, and energy.',
    category: 'Europe Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 80,
  },
  EWA: {
    description: 'iShares MSCI Australia ETF tracks the MSCI Australia Index, providing exposure to large and mid-cap Australian equities. Top holdings typically include BHP Group, Commonwealth Bank, CSL Limited, and National Australia Bank. The fund is weighted toward financials and materials sectors.',
    category: 'Australia/New Zealand Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 60,
  },
  EWC: {
    description: 'iShares MSCI Canada ETF tracks the MSCI Canada Custom Capped Index, providing exposure to large and mid-cap Canadian equities. Top holdings typically include Royal Bank of Canada, Toronto-Dominion Bank, Shopify, and Canadian Natural Resources. The fund is weighted toward financials and energy sectors.',
    category: 'Canada Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 90,
  },
  EWY: {
    description: 'iShares MSCI South Korea ETF tracks the MSCI Korea 25/50 Index, providing exposure to large and mid-cap South Korean equities. Top holdings typically include Samsung Electronics, SK Hynix, and Hyundai Motor. The fund is heavily weighted toward technology and consumer cyclical sectors.',
    category: 'Korea Stock',
    fundFamily: 'iShares',
    inceptionDate: 'May 9, 2000',
    numberOfHoldings: 110,
  },
  EWH: {
    description: 'iShares MSCI Hong Kong ETF tracks the MSCI Hong Kong Index, providing exposure to large and mid-cap Hong Kong equities. Top holdings typically include AIA Group, Hong Kong Exchanges, and Sun Hung Kai Properties. The fund is weighted toward financials and real estate sectors.',
    category: 'China Region',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 30,
  },
  EWT: {
    description: 'iShares MSCI Taiwan ETF tracks the MSCI Taiwan 25/50 Index, providing exposure to large and mid-cap Taiwanese equities. The fund is heavily concentrated in Taiwan Semiconductor Manufacturing Company (TSMC) and includes other tech firms like MediaTek and Hon Hai Precision. Technology dominates the sector allocation.',
    category: 'Taiwan Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Jun 20, 2000',
    numberOfHoldings: 90,
  },
  EWS: {
    description: 'iShares MSCI Singapore ETF tracks the MSCI Singapore 25/50 Index, providing exposure to large and mid-cap Singaporean equities. Top holdings typically include DBS Group, Oversea-Chinese Banking, and Singapore Telecommunications. The fund is weighted toward financials and industrials.',
    category: 'Singapore Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 20,
  },
  EWP: {
    description: 'iShares MSCI Spain ETF tracks the MSCI Spain 25/50 Index, providing exposure to large and mid-cap Spanish equities. Top holdings typically include Banco Santander, Iberdrola, Inditex, and BBVA. The fund is weighted toward financials and utilities sectors.',
    category: 'Europe Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 25,
  },
  EWI: {
    description: 'iShares MSCI Italy ETF tracks the MSCI Italy 25/50 Index, providing exposure to large and mid-cap Italian equities. Top holdings typically include Enel, Intesa Sanpaolo, UniCredit, and Ferrari. The fund is weighted toward financials, utilities, and consumer discretionary sectors.',
    category: 'Europe Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 30,
  },
  EWQ: {
    description: 'iShares MSCI France ETF tracks the MSCI France Index, providing exposure to large and mid-cap French equities. Top holdings typically include LVMH, TotalEnergies, Schneider Electric, and Sanofi. The fund provides access to one of Europe\'s largest economies with significant luxury goods, energy, and industrial exposure.',
    category: 'Europe Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 60,
  },
  EWL: {
    description: 'iShares MSCI Switzerland ETF tracks the MSCI Switzerland 25/50 Index, providing exposure to large and mid-cap Swiss equities. Top holdings typically include Nestle, Roche, Novartis, and Zurich Insurance. Switzerland is known for its stable economy, strong healthcare and consumer sectors, and defensive market characteristics.',
    category: 'Europe Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 45,
  },
  EWN: {
    description: 'iShares MSCI Netherlands ETF tracks the MSCI Netherlands IMI 25/50 Index, providing exposure to Dutch equities across all market capitalizations. Top holdings typically include ASML, ING Group, and Adyen. The fund is notable for its heavy weighting toward ASML, the dominant EUV lithography equipment maker.',
    category: 'Europe Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 30,
  },
  EWD: {
    description: 'iShares MSCI Sweden ETF tracks the MSCI Sweden 25/50 Index, providing exposure to large and mid-cap Swedish equities. Top holdings typically include Atlas Copco, Volvo, Ericsson, and Hexagon. Sweden has a diversified economy with strengths in industrials, financials, and technology.',
    category: 'Europe Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 45,
  },
  EWK: {
    description: 'iShares MSCI Belgium ETF tracks the MSCI Belgium IMI 25/50 Index, providing exposure to Belgian equities across all market capitalizations. Top holdings typically include Anheuser-Busch InBev, KBC Group, and UCB. The fund provides access to Belgium\'s economy with significant exposure to consumer staples and financials.',
    category: 'Europe Stock',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 12, 1996',
    numberOfHoldings: 20,
  },
  INDA: {
    description: 'iShares MSCI India ETF tracks the MSCI India Index, providing exposure to large and mid-cap Indian equities. Top holdings typically include Reliance Industries, Infosys, HDFC Bank, and ICICI Bank. India is one of the fastest-growing major economies with strengths in technology services, financials, and consumer sectors.',
    category: 'India Equity',
    fundFamily: 'iShares',
    inceptionDate: 'Feb 2, 2012',
    numberOfHoldings: 130,
  },
  MCHI: {
    description: 'iShares MSCI China ETF tracks the MSCI China Index, providing exposure to large and mid-cap Chinese equities including companies listed in Hong Kong, the US (via ADRs), and mainland China. Top holdings typically include Tencent, Alibaba, Meituan, and China Construction Bank.',
    category: 'China Region',
    fundFamily: 'iShares',
    inceptionDate: 'Mar 29, 2011',
    numberOfHoldings: 600,
  },
  FXI: {
    description: 'iShares China Large-Cap ETF tracks the FTSE China 50 Index, providing exposure to the 50 largest Chinese stocks trading on the Hong Kong Stock Exchange. Top holdings typically include Alibaba, Tencent, Meituan, and China Construction Bank. FXI is one of the oldest and most traded China-focused ETFs.',
    category: 'China Region',
    fundFamily: 'iShares',
    inceptionDate: 'Oct 5, 2004',
    numberOfHoldings: 50,
  },
  EPI: {
    description: 'WisdomTree India Earnings Fund tracks the WisdomTree India Earnings Index, which selects and weights Indian companies based on their earnings rather than market capitalization. This fundamentally weighted approach provides a value tilt relative to market-cap-weighted India funds. Top sectors include financials, energy, and technology.',
    category: 'India Equity',
    fundFamily: 'WisdomTree',
    inceptionDate: 'Feb 22, 2008',
    numberOfHoldings: 430,
  },
  IEMG: {
    description: 'iShares Core MSCI Emerging Markets ETF tracks the MSCI Emerging Markets Investable Market Index, providing broad exposure to emerging market equities across large, mid, and small-cap companies. The fund covers over 25 countries including China, Taiwan, India, and South Korea. IEMG offers broader coverage than EEM with more small-cap holdings and a lower expense ratio.',
    category: 'Diversified Emerging Mkts',
    fundFamily: 'iShares',
    inceptionDate: 'Oct 18, 2012',
    numberOfHoldings: 2800,
  },
  IEFA: {
    description: 'iShares Core MSCI EAFE ETF tracks the MSCI EAFE IMI Index, providing exposure to equities in Europe, Australasia, and the Far East across large, mid, and small-cap companies. The fund covers developed markets outside of the US and Canada. IEFA is one of the lowest-cost international developed market ETFs and is widely held in diversified portfolios.',
    category: 'Foreign Large Blend',
    fundFamily: 'iShares',
    inceptionDate: 'Oct 18, 2012',
    numberOfHoldings: 2800,
  },
};

/**
 * Fetch description from Wikipedia based on company name
 */
export async function fetchWikipediaDescription(companyName: string): Promise<string | null> {
  if (!companyName) return null;

  try {
    const SUFFIX_RE = /,?\s*(Inc\.?|Corp\.?|Corporation|Company|Ltd\.?|Limited|PLC|N\.V\.?|S\.A\.?|AG|SE|Holdings?|Group)\.?\s*$/gi;
    const stripSuffix = (s: string) => s.replace(SUFFIX_RE, '').trim();
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

    const searchName = stripSuffix(companyName);
    const normName = normalize(searchName);
    // If we can't form a name to verify against (e.g. a non-Latin name stripped to
    // empty), reject rather than trust an unvalidated match.
    if (!normName) return null;

    // Wikipedia requires a proper User-Agent header
    const headers = {
      'User-Agent': 'StockPortfolioApp/1.0 (https://github.com/stock-portfolio; contact@example.com)',
    };

    // Trim a Wikipedia intro extract to ~2 paragraphs / 800 chars on a sentence boundary.
    const cleanExtract = (raw: string | undefined): string => {
      let extract = raw || '';
      const paragraphs = extract.split('\n').filter((p: string) => p.trim().length > 50);
      extract = paragraphs.slice(0, 2).join(' ').trim();
      if (extract.length > 800) {
        extract = extract.substring(0, 800);
        const lastPeriod = extract.lastIndexOf('.');
        if (lastPeriod > 400) extract = extract.substring(0, lastPeriod + 1);
      }
      return extract;
    };

    // Look up a page by EXACT title, following redirects. Returns the validated intro
    // extract, or null if the page is missing, a disambiguation page, or doesn't actually
    // mention this company (so we never serve a confidently WRONG description).
    const extractForTitle = async (title: string): Promise<string | null> => {
      const resp = await axios.get('https://en.wikipedia.org/w/api.php', {
        params: {
          action: 'query',
          titles: title,
          prop: 'extracts|pageprops',
          exintro: true,
          explaintext: true,
          redirects: 1,
          format: 'json',
        },
        headers,
        timeout: 5000,
      });
      const pages = resp.data?.query?.pages;
      if (!pages) return null;
      const pageId = Object.keys(pages)[0];
      if (pageId === '-1') return null; // no such page
      const page = pages[pageId];
      if (page?.pageprops && 'disambiguation' in page.pageprops) return null; // "X may refer to…"
      const extract = cleanExtract(page?.extract);
      if (!extract || !normalize(extract).includes(normName)) return null;
      return extract;
    };

    // 1) DIRECT title lookup first. Wikipedia resolves redirects + corporate-suffix
    //    variants, so this lands on the company's OWN article instead of a named
    //    subsidiary, a generic concept, or a same-name entity that full-text search ranks
    //    above it — the bug class here: ticker TU / "Telus Corporation" full-text search
    //    resolved to the "Telus Communications" (subsidiary) article; "Shell plc" to the
    //    "shell corporation" concept; "Sea Limited" to the 1711 "South Sea Company". Try
    //    the full provider name first (most specific), then the suffix-stripped name.
    for (const candidate of [companyName, searchName]) {
      const extract = await extractForTitle(candidate);
      if (extract) return extract;
    }

    // 2) Fallback: full-text search, used only when neither exact title exists (the
    //    article is titled differently from the provider name). Pick the result whose
    //    TITLE is the company (suffix-insensitive, or a leading sub-name like "Toyota"
    //    for "Toyota Motor"); a named subsidiary EXTENDS the name with a non-suffix word
    //    and is correctly skipped. No confident title match -> NO description.
    const searchResponse = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'query',
        list: 'search',
        srsearch: `${searchName} company`,
        format: 'json',
        srlimit: 6,
      },
      headers,
      timeout: 5000,
    });
    const searchResults: Array<{ title: string }> | undefined = searchResponse.data?.query?.search;
    if (!searchResults || searchResults.length === 0) return null;

    const titleIsCompany = (raw: string): boolean => {
      const ts = normalize(stripSuffix(raw));
      return !!ts && (ts === normName || normName.startsWith(`${ts} `));
    };
    const chosen = searchResults.find((r) => titleIsCompany(r.title));
    if (!chosen) {
      console.warn(`[Wikipedia] no confident match for "${searchName}" among [${searchResults.map((r) => r.title).join(', ')}]`);
      return null;
    }
    return await extractForTitle(chosen.title);
  } catch (err) {
    console.warn('Wikipedia fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ============================================================================
// 52-WEEK HIGH/LOW DATA
// ============================================================================

export interface Week52Range {
  week52High: number;
  week52Low: number;
  currentPrice: number;
}

const week52Cache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

/**
 * Fetch 52-week high and low from Yahoo Finance chart API
 * Uses 1 year of daily candles to calculate accurate 52-week range
 */
export async function get52WeekRange(ticker: string): Promise<Week52Range | null> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `52w:${upperTicker}`;

  // Check cache first
  const cached = week52Cache.get<Week52Range>(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const response = await yahooGet(
      `${YAHOO_BASE_URL}/${upperTicker}?interval=1d&range=1y`
    );

    const result = response.data.chart.result?.[0];
    if (!result) {
      console.error(`[Yahoo 52W] No data found for ${upperTicker}`);
      return null;
    }

    const meta = result.meta;
    const quotes = result.indicators.quote[0];

    if (!quotes.high || !quotes.low) {
      console.error(`[Yahoo 52W] No price data for ${upperTicker}`);
      return null;
    }

    // Calculate 52-week high from daily highs
    const validHighs = quotes.high.filter((h: any): h is number => h !== null && h > 0);
    const validLows = quotes.low.filter((l: any): l is number => l !== null && l > 0);

    if (validHighs.length === 0 || validLows.length === 0) {
      console.error(`[Yahoo 52W] Insufficient data for ${upperTicker}`);
      return null;
    }

    const week52High = Math.max(...validHighs);
    const week52Low = Math.min(...validLows);
    const currentPrice = meta.regularMarketPrice;

    const rangeData: Week52Range = {
      week52High,
      week52Low,
      currentPrice,
    };

    week52Cache.set(cacheKey, rangeData);
    console.log(`[Yahoo 52W] ${upperTicker}: High=$${week52High.toFixed(2)}, Low=$${week52Low.toFixed(2)}, Current=$${currentPrice.toFixed(2)}`);

    return rangeData;
  } catch (error) {
    console.error(`[Yahoo 52W] Failed to fetch ${upperTicker}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Fetch 52-week ranges for multiple tickers in parallel
 */
export async function get52WeekRanges(tickers: string[]): Promise<Map<string, Week52Range>> {
  const results = new Map<string, Week52Range>();

  const promises = tickers.map(async (ticker) => {
    const range = await get52WeekRange(ticker);
    if (range) {
      results.set(ticker.toUpperCase(), range);
    }
  });

  await Promise.all(promises);
  return results;
}

// ============================================================================
// ALL-TIME HIGH/LOW DATA
// ============================================================================

export interface AllTimeRange {
  allTimeHigh: number;
  allTimeLow: number;
  currentPrice: number;
}

const allTimeCache = new NodeCache({ stdTTL: 86400 }); // 24 hour cache

/**
 * Fetch all-time high and low from Yahoo Finance chart API
 * Uses max range (up to 50 years of data)
 */
export async function getAllTimeRange(ticker: string): Promise<AllTimeRange | null> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `alltime:${upperTicker}`;

  // Check cache first
  const cached = allTimeCache.get<AllTimeRange>(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const response = await yahooGet(
      `${YAHOO_BASE_URL}/${upperTicker}?interval=1wk&range=max`,
      15000
    );

    const result = response.data.chart.result?.[0];
    if (!result) {
      console.error(`[Yahoo AllTime] No data found for ${upperTicker}`);
      return null;
    }

    const meta = result.meta;
    const quotes = result.indicators.quote[0];

    if (!quotes.high || !quotes.low) {
      console.error(`[Yahoo AllTime] No price data for ${upperTicker}`);
      return null;
    }

    // Calculate all-time high from weekly highs
    const validHighs = quotes.high.filter((h: any): h is number => h !== null && h > 0);
    const validLows = quotes.low.filter((l: any): l is number => l !== null && l > 0);

    if (validHighs.length === 0 || validLows.length === 0) {
      console.error(`[Yahoo AllTime] Insufficient data for ${upperTicker}`);
      return null;
    }

    const allTimeHigh = Math.max(...validHighs);
    const allTimeLow = Math.min(...validLows);
    const currentPrice = meta.regularMarketPrice;

    const rangeData: AllTimeRange = {
      allTimeHigh,
      allTimeLow,
      currentPrice,
    };

    allTimeCache.set(cacheKey, rangeData);
    console.log(`[Yahoo AllTime] ${upperTicker}: High=$${allTimeHigh.toFixed(2)}, Low=$${allTimeLow.toFixed(2)}`);

    return rangeData;
  } catch (error) {
    console.error(`[Yahoo AllTime] Failed to fetch ${upperTicker}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export async function getAssetAbout(ticker: string): Promise<AssetAbout | null> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `about:${upperTicker}`;

  const cached = aboutCache.get<AssetAbout>(cacheKey);
  if (cached) return cached;

  // Start with static data if available
  const staticData = STATIC_DESCRIPTIONS[upperTicker];

  // Use FinnHub profile API as primary source for metadata
  let finnhubData: {
    name?: string;
    industry?: string;
    country?: string;
    ipo?: string;
    weburl?: string;
  } | null = null;

  try {
    const { config } = await import('../config');
    if (config.finnhubApiKey) {
      const response = await axios.get('https://finnhub.io/api/v1/stock/profile2', {
        params: { symbol: upperTicker, token: config.finnhubApiKey },
        timeout: 5000,
      });
      if (response.data && (response.data.finnhubIndustry || response.data.name)) {
        finnhubData = {
          name: response.data.name,
          industry: response.data.finnhubIndustry,
          country: response.data.country,
          ipo: response.data.ipo,
          weburl: response.data.weburl,
        };
      }
    }
  } catch (_err) {
    // FinnHub failed, continue with static data
  }

  // If no static description, try Wikipedia
  let description = staticData?.description || '';
  if (!description && finnhubData?.name) {
    const wikiDesc = await fetchWikipediaDescription(finnhubData.name);
    if (wikiDesc) {
      // Append ticker info to make it more like Robinhood's format
      description = wikiDesc;
      if (!description.toLowerCase().includes(upperTicker.toLowerCase())) {
        description += ` The listed name for ${upperTicker} is ${finnhubData.name}.`;
      }
    }
  }

  // Build the about object from available sources
  const about: AssetAbout = {
    description,
    sector: staticData?.sector || '',
    industry: finnhubData?.industry || staticData?.industry || '',
    category: staticData?.category || null,
    fundFamily: staticData?.fundFamily || null,
    legalType: null,
    totalAssets: null,
    numberOfHoldings: staticData?.numberOfHoldings || null,
    inceptionDate: staticData?.inceptionDate || null,
    fullTimeEmployees: null,
    headquarters: null,
  };

  // Only cache and return if we got meaningful data
  if (about.description || about.sector || about.industry) {
    aboutCache.set(cacheKey, about);
    return about;
  }

  return null;
}

