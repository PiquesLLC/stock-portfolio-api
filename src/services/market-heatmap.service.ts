import NodeCache from 'node-cache';
import prisma from '../utils/prisma';
import { subSectorGroups } from '../utils/sectors';
import { fetchPrices, fetchDailyCandles } from './market.service';

// 1D cache: 60s, longer periods: 5min (historical data doesn't change fast)
const heatmapCache = new NodeCache({ stdTTL: 60 });

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
  marketCapB: number;
  subSector: string;
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

export async function getHeatmapData(period: HeatmapPeriod = '1D'): Promise<HeatmapResponse> {
  const cacheKey = `heatmap-${period}`;
  const cached = heatmapCache.get<HeatmapResponse>(cacheKey);
  if (cached) return cached;

  // Collect all tickers from sub-sector groups
  const allTickers: string[] = [];
  for (const subs of Object.values(subSectorGroups)) {
    for (const tickers of Object.values(subs)) {
      allTickers.push(...tickers.map(t => t.toUpperCase()));
    }
  }
  const uniqueTickers = Array.from(new Set(allTickers));

  // Always fetch current prices + fundamentals
  const [{ quotes }, fundamentals] = await Promise.all([
    fetchPrices(uniqueTickers),
    prisma.fundamentalsCache.findMany({
      where: { ticker: { in: uniqueTickers } },
      select: { ticker: true, overviewJson: true },
    }),
  ]);

  // For non-1D periods, fetch historical change %
  let periodChanges: Map<string, number> | null = null;
  if (period !== '1D') {
    const days = PERIOD_DAYS[period];
    periodChanges = await fetchPeriodChanges(uniqueTickers, days);
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

  const sectors: HeatmapSector[] = Object.entries(subSectorGroups).map(([sectorName, subSectors]) => {
    const allStocks: HeatmapStock[] = [];
    const subSectorList: HeatmapSubSector[] = [];

    for (const [subName, subTickers] of Object.entries(subSectors)) {
      const stocks: HeatmapStock[] = subTickers.map((ticker) => {
        const upper = ticker.toUpperCase();
        const quote = quotes.get(upper);
        const overview = fundamentalsMap.get(upper);
        const marketCapB = resolveMarketCapB(overview);

        // Use period change if available, otherwise fall back to daily
        const changePercent = periodChanges
          ? (periodChanges.get(upper) ?? 0)
          : (quote?.changePercent ?? 0);
        const dayChange = period === '1D'
          ? (quote?.change ?? 0)
          : 0; // dayChange only meaningful for 1D

        return {
          ticker: upper,
          name: resolveName(overview, upper),
          price: quote?.currentPrice ?? 0,
          changePercent,
          dayChange,
          marketCapB: marketCapB ?? 1,
          subSector: subName,
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

  const response: HeatmapResponse = {
    sectors,
    period,
    generated: Date.now(),
  };

  // Cache: 1D=60s, longer periods=300s
  const ttl = period === '1D' ? 60 : 300;
  heatmapCache.set(cacheKey, response, ttl);
  return response;
}
