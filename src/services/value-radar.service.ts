/**
 * Value Radar Service — identifies stocks trading below their 10-year average P/E.
 *
 * Backfill job fetches annual EPS + annual closing prices from Polygon,
 * computes historical P/E per year, and stores the 10-year average.
 *
 * At request time, current P/E is computed from live price + ScreenerCache EPS,
 * then compared to the stored average to produce a discount/premium percentage.
 */
import axios from 'axios';
import NodeCache from 'node-cache';
import prisma from '../utils/prisma';
import { config } from '../config';
import { fetchPolygonAggs } from '../utils/yahoo-http';
import { subSectorGroups } from '../utils/sectors';

const POLYGON_BASE = 'https://api.polygon.io';
const responseCache = new NodeCache({ stdTTL: 1800 }); // 30-min in-memory cache

interface PEHistoryEntry {
  year: number;
  pe: number;
}

export interface ValueRadarStock {
  ticker: string;
  name: string;
  sector: string;
  subSector: string;
  price: number;
  marketCapB: number;
  currentPE: number;
  avgPE: number;
  discountPct: number;
  tier: 'deep_value' | 'attractive' | 'fair' | 'expensive';
  peHistory: PEHistoryEntry[];
  yearsOfData: number;
}

export interface ValueRadarResponse {
  stocks: ValueRadarStock[];
  totalStocks: number;
  generatedAt: string;
  cached: boolean;
}

function classifyTier(discountPct: number): 'deep_value' | 'attractive' | 'fair' | 'expensive' {
  if (discountPct <= -35) return 'deep_value';
  if (discountPct <= -20) return 'attractive';
  if (discountPct <= 20) return 'fair';
  return 'expensive';
}

// ─── Polygon Data Fetchers ──────────────────────────────────────────────────

/**
 * Fetch up to 10 years of annual diluted EPS from Polygon financials.
 * Returns a Map<year, eps> (only positive EPS — negative means no meaningful P/E).
 */
async function fetchAnnualEPS(ticker: string): Promise<Map<number, number>> {
  try {
    const resp = await axios.get(`${POLYGON_BASE}/vX/reference/financials`, {
      params: {
        ticker: ticker.toUpperCase(),
        timeframe: 'annual',
        limit: 12,
        sort: 'period_of_report_date',
        order: 'desc',
        apiKey: config.polygonApiKey,
      },
      timeout: 15000,
    });

    const results = resp.data?.results;
    if (!Array.isArray(results)) return new Map();

    const epsMap = new Map<number, number>();
    for (const filing of results) {
      const eps =
        filing.financials?.income_statement?.diluted_earnings_per_share?.value ??
        filing.financials?.income_statement?.basic_earnings_per_share?.value;
      const periodDate = filing.end_date || filing.period_of_report_date;
      if (typeof eps === 'number' && Number.isFinite(eps) && eps > 0 && periodDate) {
        const year = new Date(periodDate).getFullYear();
        if (!epsMap.has(year)) {
          epsMap.set(year, eps);
        }
      }
    }
    return epsMap;
  } catch {
    return new Map();
  }
}

/**
 * Fetch annual closing prices from Polygon aggs (one bar per year).
 * Returns Map<year, closingPrice>.
 */
async function fetchAnnualPrices(ticker: string): Promise<Map<number, number>> {
  try {
    const now = new Date();
    const from = new Date(now.getFullYear() - 11, 0, 1).toISOString().split('T')[0];
    const to = now.toISOString().split('T')[0];

    const candles = await fetchPolygonAggs(ticker, 1, 'year', from, to, 86400);
    if (!candles || candles.closes.length === 0) return new Map();

    const priceMap = new Map<number, number>();
    for (let i = 0; i < candles.timestamps.length; i++) {
      const year = new Date(candles.timestamps[i] * 1000).getFullYear();
      priceMap.set(year, candles.closes[i]);
    }
    return priceMap;
  } catch {
    return new Map();
  }
}

/**
 * Compute 10-year average P/E for a single ticker.
 * Returns null if insufficient data (< 3 years).
 */
async function computeForTicker(ticker: string): Promise<{
  avgPE: number;
  peHistory: PEHistoryEntry[];
  yearsOfData: number;
} | null> {
  const [epsMap, priceMap] = await Promise.all([
    fetchAnnualEPS(ticker),
    fetchAnnualPrices(ticker),
  ]);

  if (epsMap.size < 3) return null;

  const peHistory: PEHistoryEntry[] = [];
  for (const [year, eps] of epsMap.entries()) {
    const price = priceMap.get(year);
    if (price && price > 0 && eps > 0) {
      const pe = price / eps;
      // Exclude extreme outliers (P/E > 200 is usually noise)
      if (pe < 200) {
        peHistory.push({ year, pe: Math.round(pe * 100) / 100 });
      }
    }
  }

  if (peHistory.length < 3) return null;

  peHistory.sort((a, b) => a.year - b.year);

  const avgPE = peHistory.reduce((sum, p) => sum + p.pe, 0) / peHistory.length;

  return {
    avgPE: Math.round(avgPE * 100) / 100,
    peHistory,
    yearsOfData: peHistory.length,
  };
}

// ─── Backfill Job ───────────────────────────────────────────────────────────

function collectAllTickers(): string[] {
  const tickers: string[] = [];
  for (const sector of Object.values(subSectorGroups)) {
    for (const list of Object.values(sector)) {
      for (const t of list) tickers.push(t.toUpperCase());
    }
  }
  return Array.from(new Set(tickers));
}

/**
 * Background job: computes 10-year avg P/E for all heatmap tickers.
 * Runs daily — only refreshes stale entries (> 7 days old).
 */
export async function backfillValueRadar(): Promise<void> {
  if (!config.polygonApiKey) {
    console.log('[Value Radar] No POLYGON_API_KEY set, skipping');
    return;
  }

  const tickers = collectAllTickers();
  console.log(`[Value Radar] Starting backfill for ${tickers.length} tickers`);

  // Check which tickers need refresh (stale > 7 days)
  const existing = await prisma.valueRadarCache.findMany({
    select: { ticker: true, lastFetchedAt: true },
  });
  const existingMap = new Map(existing.map(r => [r.ticker, r.lastFetchedAt]));
  const STALE_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const needsRefresh = tickers.filter(t => {
    const last = existingMap.get(t);
    if (!last) return true;
    return now - new Date(last).getTime() > STALE_MS;
  });

  if (needsRefresh.length === 0) {
    console.log(`[Value Radar] All ${tickers.length} tickers are fresh, skipping`);
    return;
  }

  console.log(`[Value Radar] ${needsRefresh.length} tickers need refresh`);

  const BATCH_SIZE = 5; // Conservative — 2 Polygon calls per ticker
  let success = 0;
  let failed = 0;

  for (let i = 0; i < needsRefresh.length; i += BATCH_SIZE) {
    const batch = needsRefresh.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        const result = await computeForTicker(ticker);
        if (!result) return false;

        await prisma.valueRadarCache.upsert({
          where: { ticker },
          create: {
            ticker,
            avgPE: result.avgPE,
            peHistoryJson: JSON.stringify(result.peHistory),
            yearsOfData: result.yearsOfData,
            lastFetchedAt: new Date(),
          },
          update: {
            avgPE: result.avgPE,
            peHistoryJson: JSON.stringify(result.peHistory),
            yearsOfData: result.yearsOfData,
            lastFetchedAt: new Date(),
          },
        });
        return true;
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) success++;
      else failed++;
    }

    // Delay between batches to respect Polygon rate limits
    if (i + BATCH_SIZE < needsRefresh.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Clear response cache so next request picks up fresh data
  responseCache.flushAll();

  console.log(
    `[Value Radar] Backfill complete: ${success} updated, ${failed} failed/skipped, ${tickers.length - needsRefresh.length} already fresh`,
  );
}

// ─── API Response Builder ───────────────────────────────────────────────────

/**
 * Build the sector lookup from subSectorGroups (ticker → { sector, subSector }).
 */
function buildSectorLookup(): Map<string, { sector: string; subSector: string }> {
  const lookup = new Map<string, { sector: string; subSector: string }>();
  for (const [sector, subs] of Object.entries(subSectorGroups)) {
    for (const [subSector, tickers] of Object.entries(subs)) {
      for (const t of tickers) {
        lookup.set(t.toUpperCase(), { sector, subSector });
      }
    }
  }
  return lookup;
}

/**
 * GET /market/value-radar — returns stocks ranked by P/E discount to historical average.
 */
export async function getValueRadarData(): Promise<ValueRadarResponse> {
  const cacheKey = 'value-radar-response';
  const cached = responseCache.get<ValueRadarResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  // 1. Load all value radar cache entries that have valid avgPE
  const radarEntries = await prisma.valueRadarCache.findMany({
    where: { avgPE: { not: null } },
  });

  if (radarEntries.length === 0) {
    return {
      stocks: [],
      totalStocks: 0,
      generatedAt: new Date().toISOString(),
      cached: false,
    };
  }

  // 2. Load screener cache for current EPS
  const tickers = radarEntries.map(r => r.ticker);
  const screenerRows = await prisma.screenerCache.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, eps: true },
  });
  const epsMap = new Map(screenerRows.filter(r => r.eps != null).map(r => [r.ticker, r.eps!]));

  // 3. Load current prices from heatmap fundamentals cache
  const fundamentalsRows = await prisma.fundamentalsCache.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, overviewJson: true },
  });
  const overviewMap = new Map<string, any>();
  for (const row of fundamentalsRows) {
    if (row.overviewJson) {
      try {
        overviewMap.set(row.ticker, JSON.parse(row.overviewJson));
      } catch { /* skip */ }
    }
  }

  // 4. Build sector lookup
  const sectorLookup = buildSectorLookup();

  // 5. Merge and compute live metrics
  const stocks: ValueRadarStock[] = [];
  for (const entry of radarEntries) {
    const eps = epsMap.get(entry.ticker);
    const overview = overviewMap.get(entry.ticker);
    const avgPE = entry.avgPE;

    if (!eps || eps <= 0 || !avgPE || avgPE <= 0) continue;

    // Get current price from overview or skip
    const price = overview?.price ?? overview?.currentPrice;
    if (!price || price <= 0) continue;

    const currentPE = price / eps;
    if (currentPE <= 0 || currentPE > 200) continue;

    const discountPct = ((currentPE - avgPE) / avgPE) * 100;
    const tier = classifyTier(discountPct);
    const sectorInfo = sectorLookup.get(entry.ticker);

    let peHistory: PEHistoryEntry[] = [];
    try {
      peHistory = entry.peHistoryJson ? JSON.parse(entry.peHistoryJson) : [];
    } catch { /* skip */ }

    stocks.push({
      ticker: entry.ticker,
      name: overview?.companyName || overview?.name || entry.ticker,
      sector: sectorInfo?.sector || overview?.sector || 'Unknown',
      subSector: sectorInfo?.subSector || '',
      price: Math.round(price * 100) / 100,
      marketCapB: overview?.marketCap
        ? Math.round((overview.marketCap / 1_000_000_000) * 100) / 100
        : 0,
      currentPE: Math.round(currentPE * 100) / 100,
      avgPE: Math.round(avgPE * 100) / 100,
      discountPct: Math.round(discountPct * 10) / 10,
      tier,
      peHistory,
      yearsOfData: entry.yearsOfData ?? peHistory.length,
    });
  }

  // Sort by discount (most undervalued first)
  stocks.sort((a, b) => a.discountPct - b.discountPct);

  const result: ValueRadarResponse = {
    stocks,
    totalStocks: stocks.length,
    generatedAt: new Date().toISOString(),
    cached: false,
  };

  if (stocks.length > 0) {
    responseCache.set(cacheKey, result);
  }

  return result;
}
