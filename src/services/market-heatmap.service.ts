import NodeCache from 'node-cache';
import prisma from '../utils/prisma';
import { subSectorGroups, MarketIndex, INDEX_SETS } from '../utils/sectors';
import { fetchPrices, fetchDailyCandles } from './market.service';
import { yahooGet } from '../utils/yahoo-http';
import { queueAdvFetches, getCachedAdv } from '../utils/finnhub';
import { getPolygonSnapshotVolumes, getPolygonMarketCaps } from '../utils/polygon';

// 1D cache: 20s for live polling, longer periods: 5min (historical data doesn't change fast)
const heatmapCache = new NodeCache({ stdTTL: 20 });
const yahooFundamentalsCache = new NodeCache({ stdTTL: 6 * 60 * 60 }); // 6h

export type HeatmapPeriod = '1D' | '1W' | '1M' | '3M' | '6M' | '1Y';

const PERIOD_DAYS: Record<HeatmapPeriod, number> = {
  '1D': 0,
  '1W': 7,
  '1M': 30,
  '3M': 90,
  '6M': 180,
  '1Y': 365,
};

interface HeatmapStock {
  ticker: string;
  name: string;
  price: number;
  changePercent: number;
  dayChange: number;
  weekChangePercent: number;
  marketCapB: number;
  volume: number;
  avgVolume: number;
  subSector: string;
  // Screener fundamentals (from overview cache, may be null)
  sector?: string;
  pe?: number | null;
  dividendYield?: number | null;
  beta?: number | null;
  week52High?: number | null;
  week52Low?: number | null;
}

interface HeatmapSubSector {
  name: string;
  stocks: HeatmapStock[];
  totalMarketCapB: number;
  avgChangePercent: number;
}

interface HeatmapSector {
  name: string;
  stocks: HeatmapStock[];
  subSectors: HeatmapSubSector[];
  totalMarketCapB: number;
  avgChangePercent: number;
  gainers: number;
  losers: number;
}

export interface HeatmapResponse {
  sectors: HeatmapSector[];
  period: HeatmapPeriod;
  generated: number;
}

function parseMarketCapB(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const num = parseFloat(raw.replace(/[$,]/g, ''));
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function resolveName(overview: any, fallbackTicker: string): string {
  return (
    overview?.companyName ||
    overview?.name ||
    overview?.Name ||
    fallbackTicker
  );
}

function resolveMarketCapB(overview: any): number | null {
  const direct = parseMarketCapB(overview?.marketCapB);
  if (direct != null) return direct;
  const rawCap = parseMarketCapB(overview?.marketCap ?? overview?.MarketCapitalization);
  if (rawCap != null) return rawCap / 1_000_000_000;
  return null;
}

async function fetchYahooFundamentals(ticker: string): Promise<{ name: string; marketCapB: number } | null> {
  const upper = ticker.toUpperCase();
  const cacheKey = `yh-fund:${upper}`;
  const cached = yahooFundamentalsCache.get<{ name: string; marketCapB: number }>(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(upper)}?modules=price`;
    const resp = await yahooGet(url, 8000);
    const price = resp.data?.quoteSummary?.result?.[0]?.price;
    if (!price) return null;

    const name = price.shortName || price.longName || upper;
    const mc = price.marketCap?.raw;
    if (typeof mc !== 'number' || !isFinite(mc) || mc <= 0) return null;

    const result = { name, marketCapB: mc / 1_000_000_000 };
    yahooFundamentalsCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

async function fetchYahooFundamentalsBatch(tickers: string[]): Promise<Map<string, { name: string; marketCapB: number }>> {
  const result = new Map<string, { name: string; marketCapB: number }>();
  if (tickers.length === 0) return result;

  const BATCH_SIZE = 20;
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(t => fetchYahooFundamentals(t)));
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      if (r.status === 'fulfilled' && r.value) {
        result.set(batch[j].toUpperCase(), r.value);
      }
    }
  }
  return result;
}

/**
 * Fetch historical change % for all tickers over a given period.
 * Uses fetchDailyCandles (which has 1hr cache per ticker via Polygon).
 * Returns Map<ticker, changePercent>.
 */
async function fetchPeriodChanges(
  tickers: string[],
  days: number,
): Promise<Map<string, number>> {
  const changes = new Map<string, number>();

  // Process in batches of 20 concurrent requests
  const BATCH_SIZE = 20;
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        const candles = await fetchDailyCandles(ticker, days);
        if (candles.length < 2) return { ticker, change: 0 };

        const startPrice = candles[0].close;
        const endPrice = candles[candles.length - 1].close;
        if (startPrice <= 0) return { ticker, change: 0 };

        const change = ((endPrice - startPrice) / startPrice) * 100;
        return { ticker, change: Math.round(change * 100) / 100 };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        changes.set(result.value.ticker, result.value.change);
      }
    }
  }

  return changes;
}

export async function getHeatmapData(period: HeatmapPeriod = '1D', index?: MarketIndex): Promise<HeatmapResponse> {
  const cacheKey = `heatmap-${period}-${index || 'all'}`;
  const cached = heatmapCache.get<HeatmapResponse>(cacheKey);
  if (cached) return cached;

  // Filter by index if specified
  const indexFilter = index ? INDEX_SETS[index] : null;

  // Collect all tickers from sub-sector groups
  const allTickers: string[] = [];
  for (const subs of Object.values(subSectorGroups)) {
    for (const tickers of Object.values(subs)) {
      allTickers.push(...tickers.map(t => t.toUpperCase()));
    }
  }
  const uniqueTickers = Array.from(new Set(allTickers));

  // Always fetch current prices + fundamentals + screener cache
  const [{ quotes }, fundamentals, polygonVolumes, polygonMarketCaps, screenerRows] = await Promise.all([
    fetchPrices(uniqueTickers),
    prisma.fundamentalsCache.findMany({
      where: { ticker: { in: uniqueTickers } },
      select: { ticker: true, overviewJson: true },
    }),
    getPolygonSnapshotVolumes(uniqueTickers),
    getPolygonMarketCaps(uniqueTickers),
    prisma.screenerCache.findMany({
      where: { ticker: { in: uniqueTickers } },
    }),
  ]);

  // Build screener lookup map
  const screenerMap = new Map(screenerRows.map(r => [r.ticker, r]));

  // Best-effort ADV refresh (non-blocking). Heatmap response uses currently cached values.
  void queueAdvFetches(uniqueTickers).catch(() => {
    // Ignore ADV queue failures; avgVolume defaults to 0.
  });

  // Fetch historical change % from candle data for all periods.
  // For 1D: use 2-day lookback as fallback when live quotes show 0%
  // (Finnhub resets dp to 0 after midnight; Polygon free tier hardcodes 0%).
  // Also fetch 7-day changes for weekChangePercent (in parallel).
  let periodChanges: Map<string, number> | null = null;
  let weekChanges: Map<string, number> | null = null;
  const candleDays = period === '1D' ? 2 : PERIOD_DAYS[period];
  const weekFetch = fetchPeriodChanges(uniqueTickers, 7);
  if (candleDays > 0) {
    const [pc, wc] = await Promise.all([fetchPeriodChanges(uniqueTickers, candleDays), weekFetch]);
    periodChanges = pc;
    weekChanges = wc;
  } else {
    weekChanges = await weekFetch;
  }

  const fundamentalsMap = new Map<string, any>();
  for (const row of fundamentals) {
    if (!row.overviewJson) continue;
    try {
      fundamentalsMap.set(row.ticker, JSON.parse(row.overviewJson));
    } catch {
      // Ignore malformed cache rows
    }
  }

  // Yahoo fallback for missing fundamentals (name + market cap)
  const missingTickers = uniqueTickers.filter(t => !fundamentalsMap.has(t));
  const yahooFallbacks = await fetchYahooFundamentalsBatch(missingTickers);
  for (const [ticker, data] of yahooFallbacks) {
    fundamentalsMap.set(ticker, { companyName: data.name, marketCapB: data.marketCapB });
  }

  const sectors: HeatmapSector[] = Object.entries(subSectorGroups).map(([sectorName, subSectors]) => {
    const allStocks: HeatmapStock[] = [];
    const subSectorList: HeatmapSubSector[] = [];

    for (const [subName, subTickers] of Object.entries(subSectors)) {
      // Filter tickers by index membership if specified
      const filteredSubTickers = indexFilter
        ? subTickers.filter(t => indexFilter.has(t.toUpperCase()))
        : subTickers;
      if (filteredSubTickers.length === 0) continue;

      const stocks: HeatmapStock[] = filteredSubTickers.map((ticker) => {
        const upper = ticker.toUpperCase();
        const quote = quotes.get(upper);
        const overview = fundamentalsMap.get(upper);
        const marketCapFromOverview = resolveMarketCapB(overview);
        const marketCapB = marketCapFromOverview ?? polygonMarketCaps.get(upper) ?? 1;

        // For 1D: prefer live quote changePercent when non-zero, fall back to candle data.
        // After midnight or with Polygon free tier, live changePercent is 0 — candle data is reliable.
        // For other periods: always use candle-based periodChanges.
        let changePercent: number;
        if (period === '1D' && quote?.changePercent) {
          changePercent = quote.changePercent;
        } else {
          changePercent = periodChanges?.get(upper) ?? (quote?.changePercent ?? 0);
        }
        const dayChange = period === '1D'
          ? (quote?.change ?? 0)
          : 0; // dayChange only meaningful for 1D

        // Compute P/E and dividend yield from ScreenerCache + live price
        const screener = screenerMap.get(upper);
        const currentPrice = quote?.currentPrice ?? 0;

        let pe: number | null = overview?.peRatio ?? null;
        let dividendYield: number | null = overview?.dividendYield ?? null;
        let beta: number | null = overview?.beta ?? null;
        let week52High: number | null = overview?.fiftyTwoWeekHigh ?? null;
        let week52Low: number | null = overview?.fiftyTwoWeekLow ?? null;

        if (screener) {
          // P/E: price / TTM EPS (only if EPS > 0)
          if (screener.eps != null && screener.eps > 0 && currentPrice > 0) {
            pe = Math.round((currentPrice / screener.eps) * 100) / 100;
          }
          // Dividend yield: (annual dividend / price) * 100
          if (screener.annualDividend != null && screener.annualDividend > 0 && currentPrice > 0) {
            dividendYield = Math.round((screener.annualDividend / currentPrice) * 10000) / 100;
          }
          if (screener.beta != null) beta = screener.beta;
          if (screener.week52High != null) week52High = screener.week52High;
          if (screener.week52Low != null) week52Low = screener.week52Low;
        }

        return {
          ticker: upper,
          name: resolveName(overview, upper),
          price: currentPrice,
          changePercent,
          dayChange,
          weekChangePercent: weekChanges?.get(upper) ?? 0,
          marketCapB,
          volume: polygonVolumes.get(upper) ?? 0,
          avgVolume: getCachedAdv(upper) ?? 0,
          subSector: subName,
          sector: sectorName,
          pe,
          dividendYield,
          beta,
          week52High,
          week52Low,
        };
      });

      const subTotal = stocks.reduce((sum, s) => sum + s.marketCapB, 0);
      const subAvg = stocks.length > 0
        ? stocks.reduce((sum, s) => sum + s.changePercent, 0) / stocks.length
        : 0;

      subSectorList.push({
        name: subName,
        stocks,
        totalMarketCapB: Math.round(subTotal * 100) / 100,
        avgChangePercent: Math.round(subAvg * 100) / 100,
      });

      allStocks.push(...stocks);
    }

    const totalMarketCapB = allStocks.reduce((sum, s) => sum + s.marketCapB, 0);
    const avgChangePercent = allStocks.length > 0
      ? allStocks.reduce((sum, s) => sum + s.changePercent, 0) / allStocks.length
      : 0;
    const gainers = allStocks.filter(s => s.changePercent > 0).length;
    const losers = allStocks.filter(s => s.changePercent < 0).length;

    return {
      name: sectorName,
      stocks: allStocks,
      subSectors: subSectorList,
      totalMarketCapB: Math.round(totalMarketCapB * 100) / 100,
      avgChangePercent: Math.round(avgChangePercent * 100) / 100,
      gainers,
      losers,
    };
  });

  // Remove empty sectors (can happen when filtering by index)
  const filteredSectors = sectors.filter(s => s.stocks.length > 0);

  const response: HeatmapResponse = {
    sectors: filteredSectors,
    period,
    generated: Date.now(),
  };

  // Cache: 1D=120s (prices don't change meaningfully in 2min), longer periods=300s
  const ttl = period === '1D' ? 120 : 300;
  heatmapCache.set(cacheKey, response, ttl);
  return response;
}
