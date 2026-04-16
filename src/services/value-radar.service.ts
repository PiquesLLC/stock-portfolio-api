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
import { etDate } from '../utils/date';
import { fetchPrices } from './market.service';
import { getMarketSession } from '../utils/market-hours';

const POLYGON_BASE = 'https://api.polygon.io';
const responseCache = new NodeCache({ stdTTL: 300 }); // 5-min default TTL

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
  dividendYield: number | null;
  forwardPE: number | null;
  beta: number | null;
  week52High: number | null;
  week52Low: number | null;
  week52Pos: number | null;
  returnOnEquity: number | null;
  profitMargin: number | null;
  analystTargetPrice: number | null;
  upsideToTarget: number | null;
  qualityScore: number | null;
  qualityScoreCoverage: number | null;
  changePercent: number;
  changeDollar: number;
}

export interface ValueRadarResponse {
  stocks: ValueRadarStock[];
  totalStocks: number;
  generatedAt: string;
  cached: boolean;
  preliminary: boolean;
}

function classifyTier(discountPct: number): 'deep_value' | 'attractive' | 'fair' | 'expensive' {
  if (discountPct <= -35) return 'deep_value';
  if (discountPct <= -20) return 'attractive';
  if (discountPct <= 20) return 'fair';
  return 'expensive';
}

// ─── Quality Score ──────────────────────────────────────────────────────────

/**
 * Compute a business quality score (0–100) using weighted fundamentals.
 * Weights: ROE 25%, Profit Margin 20%, Forward P/E Improvement 20%,
 *          52-Week Position 20%, Dividend Yield 10%, Analyst Upside 5%.
 * Returns null if less than 60% of weight is backed by data.
 */
function computeQualityScore(stock: {
  returnOnEquity: number | null;
  profitMargin: number | null;
  currentPE: number;
  forwardPE: number | null;
  week52Pos: number | null;
  dividendYield: number | null;
  upsideToTarget: number | null;
}): { qualityScore: number | null; qualityScoreCoverage: number | null } {
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

  const factors: { weight: number; score: number | null }[] = [
    // ROE: 0% → 0, 30%+ → 1. Negative → 0.
    {
      weight: 0.25,
      score: stock.returnOnEquity != null
        ? clamp01(Math.max(0, stock.returnOnEquity) / 0.30)
        : null,
    },
    // Profit Margin: 0% → 0, 25%+ → 1. Negative → 0.
    {
      weight: 0.20,
      score: stock.profitMargin != null
        ? clamp01(Math.max(0, stock.profitMargin) / 0.25)
        : null,
    },
    // Forward P/E Improvement: (currentPE - forwardPE) / currentPE. 0% → 0, 40%+ → 1.
    // Negative forwardPE = distressed earnings → score 0, not null.
    {
      weight: 0.20,
      score: stock.forwardPE != null && stock.currentPE > 0
        ? (stock.forwardPE <= 0 ? 0 : clamp01(Math.max(0, (stock.currentPE - stock.forwardPE) / stock.currentPE) / 0.40))
        : null,
    },
    // 52-Week Position: at low → 1, at high → 0.
    {
      weight: 0.20,
      score: stock.week52Pos != null
        ? 1 - clamp01(stock.week52Pos)
        : null,
    },
    // Dividend Yield: 0% → 0, 6%+ → 1. dividendYield is always a percentage number (3.5 = 3.5%).
    {
      weight: 0.10,
      score: stock.dividendYield != null
        ? clamp01(Math.max(0, stock.dividendYield) / 6)
        : null,
    },
    // Analyst Upside: 0% → 0, 30%+ → 1. upsideToTarget is a percentage number (30 = 30%).
    {
      weight: 0.05,
      score: stock.upsideToTarget != null
        ? clamp01(Math.max(0, stock.upsideToTarget) / 30)
        : null,
    },
  ];

  const available = factors.filter(f => f.score != null);
  const totalAvailableWeight = available.reduce((sum, f) => sum + f.weight, 0);

  // Coverage below 60% → suppress score
  if (totalAvailableWeight < 0.60) {
    return { qualityScore: null, qualityScoreCoverage: Math.round(totalAvailableWeight * 100) / 100 };
  }

  // Weighted sum, redistributed across available factors
  const rawScore = available.reduce((sum, f) => sum + (f.weight / totalAvailableWeight) * f.score!, 0);
  const qualityScore = Math.round(rawScore * 100);

  return {
    qualityScore,
    qualityScoreCoverage: Math.round(totalAvailableWeight * 100) / 100,
  };
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
    const from = etDate(new Date(now.getFullYear() - 11, 0, 1));
    const to = etDate(now);

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

  const BATCH_SIZE = 15; // Paid Polygon Developer plan — 2 calls/ticker
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

    // Brief pause between batches — Developer plan has high but not unlimited throughput
    if (i + BATCH_SIZE < needsRefresh.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
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
  if (cached) return { ...cached, cached: true, preliminary: cached.preliminary };

  // 1. Load all value radar cache entries that have valid avgPE
  const radarEntries = await prisma.valueRadarCache.findMany({
    where: { avgPE: { not: null } },
  });

  // If ValueRadarCache is empty, bootstrap from FundamentalsCache + ScreenerCache
  if (radarEntries.length === 0) {
    console.log('[Value Radar] Cache empty — bootstrapping from FundamentalsCache + ScreenerCache');

    const [fundRows, screenRows] = await Promise.all([
      prisma.fundamentalsCache.findMany({
        where: { overviewJson: { not: null } },
        select: { ticker: true, overviewJson: true },
      }),
      prisma.screenerCache.findMany({
        where: { eps: { not: null } },
        select: { ticker: true, eps: true, annualDividend: true, beta: true, week52High: true, week52Low: true },
      }),
    ]);

    // Build lookup maps
    const screenMap = new Map(screenRows.filter(r => r.eps != null && r.eps > 0).map(r => [r.ticker, r]));
    const overviewByTicker = new Map<string, any>();
    for (const row of fundRows) {
      if (row.overviewJson) {
        try { overviewByTicker.set(row.ticker, JSON.parse(row.overviewJson)); } catch { /* skip */ }
      }
    }

    // Only keep tickers that appear in our sector map and have both overview + eps
    const sectorLookup = buildSectorLookup();
    const bootstrapTickers = [...sectorLookup.keys()].filter(
      t => overviewByTicker.has(t) && screenMap.has(t),
    );

    if (bootstrapTickers.length === 0) {
      return {
        stocks: [],
        totalStocks: 0,
        generatedAt: new Date().toISOString(),
        cached: false,
        preliminary: false,
      };
    }

    // Fetch live prices for bootstrap tickers
    const { quotes: bootQuotes } = await fetchPrices(bootstrapTickers);

    const bootStocks: ValueRadarStock[] = [];
    for (const ticker of bootstrapTickers) {
      const overview = overviewByTicker.get(ticker);
      const screener = screenMap.get(ticker)!;
      const eps = screener.eps!;
      const quote = bootQuotes.get(ticker);
      const price = quote?.currentPrice ?? 0;
      if (!price || price <= 0) continue;

      const currentPE = price / eps;
      if (currentPE <= 0 || currentPE > 200) continue;

      // Use fundamentals peRatio as avgPE proxy (reasonable when no 10-year history)
      const fundPE = typeof overview?.peRatio === 'number' && overview.peRatio > 0
        ? overview.peRatio
        : null;
      // If fundamentals has a peRatio, use it as avgPE; otherwise use currentPE (discount will be ~0%)
      const avgPE = fundPE ?? currentPE;

      const discountPct = ((currentPE - avgPE) / avgPE) * 100;
      const tier = classifyTier(discountPct);
      const sectorInfo = sectorLookup.get(ticker);

      const forwardPE = overview?.forwardPE != null ? Math.round(overview.forwardPE * 100) / 100 : null;
      const returnOnEquity = overview?.returnOnEquity != null ? Math.round(overview.returnOnEquity * 100) / 100 : null;
      const profitMarginVal = overview?.profitMargin != null ? Math.round(overview.profitMargin * 100) / 100 : null;
      const analystTargetPrice = overview?.analystTargetPrice != null ? Math.round(overview.analystTargetPrice * 100) / 100 : null;
      const beta = screener.beta != null ? Math.round(screener.beta * 100) / 100 : null;
      const week52High = screener.week52High != null ? Math.round(screener.week52High * 100) / 100 : null;
      const week52Low = screener.week52Low != null ? Math.round(screener.week52Low * 100) / 100 : null;

      // dividendYield: always store as percentage number (3.5 = 3.5%)
      // overview.dividendYield is decimal (0.035), screener fallback already computes pct
      // Only trust overview when meaningfully positive; zero may be a data gap
      let dividendYield: number | null = null;
      if (overview?.dividendYield != null && overview.dividendYield > 0) {
        dividendYield = Math.round(overview.dividendYield * 100 * 100) / 100;
      } else if (screener.annualDividend != null && screener.annualDividend > 0) {
        dividendYield = Math.round(((screener.annualDividend / price) * 100) * 100) / 100;
      }

      let week52Pos: number | null = null;
      if (week52High != null && week52Low != null && week52High !== week52Low) {
        week52Pos = Math.round(((price - week52Low) / (week52High - week52Low)) * 100) / 100;
      }

      let upsideToTarget: number | null = null;
      if (analystTargetPrice != null && analystTargetPrice > 0) {
        upsideToTarget = Math.round(((analystTargetPrice - price) / price) * 100 * 100) / 100;
      }

      const { qualityScore, qualityScoreCoverage } = computeQualityScore({
        returnOnEquity, profitMargin: profitMarginVal, currentPE, forwardPE,
        week52Pos, dividendYield, upsideToTarget,
      });

      bootStocks.push({
        ticker,
        name: overview?.companyName || overview?.name || ticker,
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
        peHistory: [],
        yearsOfData: 0,
        dividendYield,
        forwardPE,
        beta,
        week52High,
        week52Low,
        week52Pos,
        returnOnEquity,
        profitMargin: profitMarginVal,
        analystTargetPrice,
        upsideToTarget,
        qualityScore,
        qualityScoreCoverage,
        changePercent: Math.round((quote?.changePercent ?? 0) * 100) / 100,
        changeDollar: Math.round((quote?.change ?? 0) * 100) / 100,
      });
    }

    bootStocks.sort((a, b) => a.discountPct - b.discountPct);

    const bootResult: ValueRadarResponse = {
      stocks: bootStocks,
      totalStocks: bootStocks.length,
      generatedAt: new Date().toISOString(),
      cached: false,
      preliminary: true,
    };

    const session = getMarketSession();
    const cacheTtl = session === 'CLOSED' ? 1800 : 300; // 30 min closed, 5 min during market
    if (bootStocks.length > 0) {
      responseCache.set(cacheKey, bootResult, cacheTtl);
    }

    console.log(`[Value Radar] Bootstrap complete: ${bootStocks.length} stocks from existing caches`);
    return bootResult;
  }

  // 2. Load screener cache (EPS), fundamentals cache (name/sector/marketCap), and live prices concurrently
  const tickers = radarEntries.map(r => r.ticker);
  const [screenerRows, fundamentalsRows, { quotes }] = await Promise.all([
    prisma.screenerCache.findMany({
      where: { ticker: { in: tickers } },
      select: { ticker: true, eps: true, annualDividend: true, beta: true, week52High: true, week52Low: true },
    }),
    prisma.fundamentalsCache.findMany({
      where: { ticker: { in: tickers } },
      select: { ticker: true, overviewJson: true },
    }),
    fetchPrices(tickers),
  ]);
  const epsMap = new Map(screenerRows.filter(r => r.eps != null).map(r => [r.ticker, r.eps!]));
  const screenerMap = new Map(screenerRows.map(r => [r.ticker, r]));

  // 3. Build overview map for name/sector/marketCap lookups (NOT for price)
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

    // Get current price from live quote
    const quote = quotes.get(entry.ticker);
    const price = quote?.currentPrice ?? 0;
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

    // Extract additional fields from screener and overview caches
    const screener = screenerMap.get(entry.ticker);
    const forwardPE = overview?.forwardPE != null ? Math.round(overview.forwardPE * 100) / 100 : null;
    const returnOnEquity = overview?.returnOnEquity != null ? Math.round(overview.returnOnEquity * 100) / 100 : null;
    const profitMargin = overview?.profitMargin != null ? Math.round(overview.profitMargin * 100) / 100 : null;
    const analystTargetPrice = overview?.analystTargetPrice != null ? Math.round(overview.analystTargetPrice * 100) / 100 : null;
    const beta = screener?.beta != null ? Math.round(screener.beta * 100) / 100 : null;
    const week52High = screener?.week52High != null ? Math.round(screener.week52High * 100) / 100 : null;
    const week52Low = screener?.week52Low != null ? Math.round(screener.week52Low * 100) / 100 : null;

    // dividendYield: always store as percentage number (3.5 = 3.5%)
    // overview.dividendYield is decimal (0.035), screener fallback already computes pct
    // Only trust overview when meaningfully positive; zero may be a data gap
    let dividendYield: number | null = null;
    if (overview?.dividendYield != null && overview.dividendYield > 0) {
      dividendYield = Math.round(overview.dividendYield * 100 * 100) / 100;
    } else if (screener?.annualDividend != null && screener.annualDividend > 0) {
      dividendYield = Math.round(((screener.annualDividend / price) * 100) * 100) / 100;
    }

    // Compute week52Pos: position in 52-week range (0-1)
    let week52Pos: number | null = null;
    if (week52High != null && week52Low != null && week52High !== week52Low) {
      week52Pos = Math.round(((price - week52Low) / (week52High - week52Low)) * 100) / 100;
    }

    // Compute upsideToTarget: percentage upside to analyst target
    let upsideToTarget: number | null = null;
    if (analystTargetPrice != null && analystTargetPrice > 0) {
      upsideToTarget = Math.round(((analystTargetPrice - price) / price) * 100 * 100) / 100;
    }

    const { qualityScore, qualityScoreCoverage } = computeQualityScore({
      returnOnEquity, profitMargin, currentPE, forwardPE,
      week52Pos, dividendYield, upsideToTarget,
    });

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
      dividendYield,
      forwardPE,
      beta,
      week52High,
      week52Low,
      week52Pos,
      returnOnEquity,
      profitMargin,
      analystTargetPrice,
      upsideToTarget,
      qualityScore,
      qualityScoreCoverage,
      changePercent: Math.round((quote?.changePercent ?? 0) * 100) / 100,
      changeDollar: Math.round((quote?.change ?? 0) * 100) / 100,
    });
  }

  // Sort by discount (most undervalued first)
  stocks.sort((a, b) => a.discountPct - b.discountPct);

  const result: ValueRadarResponse = {
    stocks,
    totalStocks: stocks.length,
    generatedAt: new Date().toISOString(),
    cached: false,
    preliminary: false,
  };

  const session = getMarketSession();
  const cacheTtl = session === 'CLOSED' ? 1800 : 300; // 30 min closed, 5 min during market
  if (stocks.length > 0) {
    responseCache.set(cacheKey, result, cacheTtl);
  }

  return result;
}
