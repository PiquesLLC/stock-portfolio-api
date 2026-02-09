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

interface YahooAssetProfileResponse {
  quoteSummary: {
    result: Array<{
      assetProfile?: {
        longBusinessSummary?: string;
        sector?: string;
        industry?: string;
        fullTimeEmployees?: number;
        city?: string;
        state?: string;
        country?: string;
      };
      summaryProfile?: {
        longBusinessSummary?: string;
        sector?: string;
        industry?: string;
      };
      fundProfile?: {
        categoryName?: string;
        family?: string;
        legalType?: string;
      };
      summaryDetail?: {
        totalAssets?: { raw: number };
      };
      topHoldings?: {
        holdings?: Array<unknown>;
      };
      price?: {
        quoteType?: string;
      };
    }>;
    error?: { code: string; description: string };
  };
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
};

/**
 * Fetch description from Wikipedia based on company name
 */
async function fetchWikipediaDescription(companyName: string): Promise<string | null> {
  if (!companyName) return null;

  try {
    // Clean up company name for Wikipedia search
    // Remove common suffixes that might interfere with search
    const searchName = companyName
      .replace(/,?\s*(Inc\.?|Corp\.?|Corporation|Company|Ltd\.?|Limited|PLC|N\.V\.?|S\.A\.?|AG|SE|Holdings?|Group)\.?\s*$/gi, '')
      .trim();

    // Search Wikipedia for the company
    // Wikipedia requires a proper User-Agent header
    const headers = {
      'User-Agent': 'StockPortfolioApp/1.0 (https://github.com/stock-portfolio; contact@example.com)',
    };

    const searchResponse = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'query',
        list: 'search',
        srsearch: `${searchName} company`,
        format: 'json',
        srlimit: 1,
      },
      headers,
      timeout: 5000,
    });

    const searchResults = searchResponse.data?.query?.search;
    if (!searchResults || searchResults.length === 0) {
      return null;
    }

    const pageTitle = searchResults[0].title;

    // Get the page extract (summary)
    const extractResponse = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'query',
        titles: pageTitle,
        prop: 'extracts',
        exintro: true,
        explaintext: true,
        format: 'json',
      },
      headers,
      timeout: 5000,
    });

    const pages = extractResponse.data?.query?.pages;
    if (!pages) return null;

    const pageId = Object.keys(pages)[0];
    if (pageId === '-1') return null;

    let extract = pages[pageId].extract || '';

    // Clean up the extract - take first 2-3 paragraphs, limit length
    const paragraphs = extract.split('\n').filter((p: string) => p.trim().length > 50);
    extract = paragraphs.slice(0, 2).join(' ').trim();

    // Limit to ~800 characters for a reasonable description length
    if (extract.length > 800) {
      extract = extract.substring(0, 800);
      // Cut at last sentence
      const lastPeriod = extract.lastIndexOf('.');
      if (lastPeriod > 400) {
        extract = extract.substring(0, lastPeriod + 1);
      }
    }

    return extract || null;
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
    const response = await axios.get<YahooChartResult>(`${YAHOO_BASE_URL}/${upperTicker}`, {
      params: {
        interval: '1d',
        range: '1y',
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 10000,
    });

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
    const validHighs = quotes.high.filter((h): h is number => h !== null && h > 0);
    const validLows = quotes.low.filter((l): l is number => l !== null && l > 0);

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
    const response = await axios.get<YahooChartResult>(`${YAHOO_BASE_URL}/${upperTicker}`, {
      params: {
        interval: '1wk', // Weekly candles for max range
        range: 'max',
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 15000,
    });

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
    const validHighs = quotes.high.filter((h): h is number => h !== null && h > 0);
    const validLows = quotes.low.filter((l): l is number => l !== null && l > 0);

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
  } catch (err) {
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

