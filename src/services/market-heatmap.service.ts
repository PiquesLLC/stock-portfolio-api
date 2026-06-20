import NodeCache from 'node-cache';
import prisma from '../utils/prisma';
import { subSectorGroups, MarketIndex, INDEX_SETS } from '../utils/sectors';
import { fetchPrices, fetchDailyCandles } from './market.service';
import { getMarketSession } from '../utils/market-hours';
import { yahooGet } from '../utils/yahoo-http';
import { queueAdvFetches, getCachedAdv } from '../utils/finnhub';
import { getPolygonSnapshotVolumes } from '../utils/polygon';

// 1D cache: 120s, longer periods: 5min (historical data doesn't change fast)
const heatmapCache = new NodeCache({ stdTTL: 120 });
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

  const BATCH_SIZE = 30;
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
interface PeriodReference {
  anchor: number; // close as-of `days` ago (date-anchored, like the stock chart)
  latest: number; // most recent candle close (live-price fallback for dropped quotes)
}

/** Date string (YYYY-MM-DD, UTC) for a candle timestamp; '' when missing/invalid. */
function candleDateStr(time: unknown): string {
  if (time == null) return '';
  const d = new Date(time as string | number);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * For each ticker, returns the reference (anchor) close `days` ago plus the most
 * recent candle close.
 *
 * The anchor is matched BY DATE — the first candle whose calendar date is on/after
 * (today - days) — exactly mirroring the stock chart (useStockChart). The previous
 * code compared timestamps (`>= now - days*ms`): because a daily bar is stamped at
 * the START of its day, the boundary day's candle fell just before the cutoff's
 * time-of-day and was SKIPPED, so a "7-day" change was really ~6 days and understated
 * the move (e.g. AMAT's Top 100 7D read +5.35% vs the chart's correct +9.21%).
 */
async function fetchPeriodReferencePrices(
  tickers: string[],
  days: number,
): Promise<Map<string, PeriodReference>> {
  const refs = new Map<string, PeriodReference>();
  const cutoffDate = candleDateStr(Date.now() - days * 86_400_000);

  // Process in batches of 50 concurrent requests (Polygon paid plan allows high concurrency)
  const BATCH_SIZE = 50;
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        const candles = await fetchDailyCandles(ticker, days);
        if (candles.length < 1) return { ticker, ref: null as PeriodReference | null };

        // fetchDailyCandles over-fetches `days + 10` calendar days as a buffer, so
        // candles[0] is older than the window. Anchor at the first candle whose DATE
        // is on/after (today - days); fall back to candles[0] if none qualify.
        const startCandle = candles.find((c) => {
          const d = candleDateStr((c as { time?: unknown }).time);
          return d !== '' && d >= cutoffDate;
        }) ?? candles[0];

        return {
          ticker,
          ref: { anchor: startCandle.close, latest: candles[candles.length - 1].close } as PeriodReference | null,
        };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.ref) {
        refs.set(result.value.ticker, result.value.ref);
      }
    }
  }

  return refs;
}

/**
 * Compute 1D change from the last two daily candles. Used when the market is
 * CLOSED — on weekends/holidays the live-quote chain is flaky, but archived
 * daily candles are stable. "1D change" on Saturday = Thursday close vs
 * Wednesday close (i.e., the last two trading days).
 */
async function fetchOneDayChangesFromCandles(
  tickers: string[],
): Promise<Map<string, number>> {
  const changes = new Map<string, number>();
  const BATCH_SIZE = 50;
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        // 5-day buffer absorbs weekends + a holiday; we only need the last 2 candles.
        const candles = await fetchDailyCandles(ticker, 5);
        if (candles.length < 2) return { ticker, change: 0 };
        const prev = candles[candles.length - 2].close;
        const last = candles[candles.length - 1].close;
        if (prev <= 0) return { ticker, change: 0 };
        const change = ((last - prev) / prev) * 100;
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

  // ── Phase 1: Fire ALL slow fetches in parallel ──
  // Key optimization: run prices, volumes, DB queries, AND period changes concurrently.
  // Removed getPolygonMarketCaps (328 individual API calls, ~20s cold) — fundamentalsCache
  // and screenerCache already have market cap for almost all S&P 500 tickers.
  //
  // For 1D during trading hours: live quote changePercent is fresh.
  // For 1D when market is CLOSED (weekend/holiday/overnight): live quotes are
  // flaky — use archived daily candles instead, same reliable path that 1W/1M use.
  // For non-1D: period changes are essential (the main changePercent).
  // Week changes are always fetched — Top 100 view shows 7D column regardless of period.
  const candleDays = PERIOD_DAYS[period];
  const marketIsClosed = getMarketSession() === 'CLOSED';
  const use1DCandles = period === '1D' && marketIsClosed;
  const needsPeriodChanges = period !== '1D' && candleDays > 0;

  const parallelFetches: [
    Promise<{ quotes: Map<string, any> }>,
    Promise<any[]>,
    Promise<Map<string, number>>,
    Promise<any[]>,
    Promise<Map<string, number> | null>,
    Promise<Map<string, PeriodReference> | null>,
    Promise<Map<string, PeriodReference>>,
  ] = [
    fetchPrices(uniqueTickers),
    prisma.fundamentalsCache.findMany({
      where: { ticker: { in: uniqueTickers } },
      select: { ticker: true, overviewJson: true },
    }),
    getPolygonSnapshotVolumes(uniqueTickers),
    prisma.screenerCache.findMany({
      where: { ticker: { in: uniqueTickers } },
    }),
    // 1D-from-candles — only when the 1D tab is viewed while the market is CLOSED
    // (live quotes are flaky on weekends/holidays, so use archived daily candles).
    use1DCandles ? fetchOneDayChangesFromCandles(uniqueTickers) : Promise.resolve(null),
    // Period anchor prices — for non-1D periods (drives the tile's main change).
    needsPeriodChanges ? fetchPeriodReferencePrices(uniqueTickers, candleDays) : Promise.resolve(null),
    // Week anchor prices — always fetched (Top 100 shows the 7D column regardless of period).
    fetchPeriodReferencePrices(uniqueTickers, 7),
  ];

  const [{ quotes }, fundamentals, polygonVolumes, screenerRows, oneDayChanges, periodRefs, weekRefs] =
    await Promise.all(parallelFetches);

  // Build screener lookup map
  const screenerMap = new Map(screenerRows.map((r: any) => [r.ticker, r]));

  // Best-effort ADV refresh (non-blocking). Heatmap response uses currently cached values.
  void queueAdvFetches(uniqueTickers).catch(() => {
    // Ignore ADV queue failures; avgVolume defaults to 0.
  });

  const fundamentalsMap = new Map<string, any>();
  for (const row of fundamentals) {
    if (!row.overviewJson) continue;
    try {
      fundamentalsMap.set(row.ticker, JSON.parse(row.overviewJson));
    } catch {
      // Ignore malformed cache rows
    }
  }

  // Yahoo fallback for missing market caps. Two cases:
  //   (a) Ticker has no FundamentalsCache row at all (cold start).
  //   (b) Row exists but its overviewJson has marketCap:null — common for ADRs
  //       (TSM, ASML, ARM, BABA…) where Polygon's tickerDetails.market_cap is null.
  // Both cases used to silently fall through to a `?? 1` stub on the row builder,
  // surfacing as "$1B" in the Screener and breaking the cap filter / sort.
  const tickersNeedingCap = uniqueTickers.filter(t => {
    const overview = fundamentalsMap.get(t);
    return resolveMarketCapB(overview) == null;
  });
  if (tickersNeedingCap.length > 0 && tickersNeedingCap.length < 30) {
    const yahooFallbacks = await fetchYahooFundamentalsBatch(tickersNeedingCap);
    for (const [ticker, data] of yahooFallbacks) {
      const existing = fundamentalsMap.get(ticker) ?? {};
      fundamentalsMap.set(ticker, {
        ...existing,
        companyName: existing.companyName ?? existing.name ?? data.name,
        marketCapB: data.marketCapB,
      });
    }
  } else if (tickersNeedingCap.length >= 30) {
    // Too many missing — fetch in background without blocking response
    void fetchYahooFundamentalsBatch(tickersNeedingCap).catch(() => {});
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
        const marketCapB = resolveMarketCapB(overview) ?? 0;

        const periodRef = periodRefs?.get(upper);
        const weekRef = weekRefs.get(upper);
        // Live price for change math + display. Fall back to the most recent daily
        // candle close when the live quote is missing/zero, so a dropped quote can't
        // surface as a "$0.00" row (e.g. RBLX) or a bogus -100% change.
        const quoteLivePrice = quote?.currentPrice ?? 0;
        const livePrice = quoteLivePrice > 0
          ? quoteLivePrice
          : (weekRef?.latest ?? periodRef?.latest ?? 0);

        // 1D changePercent priority — preserve extended-hours moves across all sessions:
        //   1. extendedPrice + extendedChangePercent set (live PRE/POST) → total change from
        //      previousClose using extendedPrice. Mirrors themes-heatmap.service.ts.
        //   2. quote.changePercent non-zero (Yahoo overlay path at market.service.ts:896-900
        //      preserves the AH close in changePercent during ALL sessions including CLOSED,
        //      so the tile keeps showing the extended-hours move overnight until the next
        //      session begins). This is what makes Finviz-style "stay green after hours" work.
        //   3. periodChanges fallback (weekend/holiday with stale snapshot, candle-based 1D
        //      from fetchOneDayChangesFromCandles).
        // Non-1D periods → candle-based periodChanges; extended-hours ignored.
        let changePercent: number;
        let useExtendedForRow = false;
        if (period === '1D') {
          const hasExtended = quote?.extendedChangePercent != null && quote?.extendedPrice != null;
          if (hasExtended && (quote?.previousClose ?? 0) > 0) {
            // Total change from previous close, NOT just the after-hours delta.
            changePercent = ((quote!.extendedPrice! - quote!.previousClose) / quote!.previousClose) * 100;
            useExtendedForRow = true;
          } else if (quote?.changePercent) {
            changePercent = quote.changePercent;
          } else {
            changePercent = oneDayChanges?.get(upper) ?? 0;
          }
        } else {
          // Non-1D: (live price - the close N days ago) / that close, date-anchored to
          // match the stock chart. Uses the regular-session live price (not the
          // after-hours pop) — non-1D tiles deliberately ignore extended hours.
          changePercent = (periodRef && periodRef.anchor > 0 && livePrice > 0)
            ? Math.round(((livePrice - periodRef.anchor) / periodRef.anchor) * 10000) / 100
            : (quote?.changePercent ?? 0);
        }
        const dayChange = period === '1D'
          ? (quote?.change ?? 0)
          : 0; // dayChange only meaningful for 1D

        // Compute P/E and dividend yield from ScreenerCache + live price.
        // currentPrice keeps the regular-session price so fundamentals math stays
        // anchored to the regular close. displayPrice is what we show on the tile —
        // it tracks extendedPrice during extended hours so the tooltip is consistent
        // with the displayed change.
        const screener = screenerMap.get(upper);
        const currentPrice = livePrice;
        const displayPrice = useExtendedForRow ? (quote?.extendedPrice ?? currentPrice) : currentPrice;

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
          price: displayPrice,
          changePercent,
          dayChange,
          weekChangePercent: (weekRef && weekRef.anchor > 0 && livePrice > 0)
            ? Math.round(((livePrice - weekRef.anchor) / weekRef.anchor) * 10000) / 100
            : 0,
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
