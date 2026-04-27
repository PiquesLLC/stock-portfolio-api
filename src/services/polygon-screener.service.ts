/**
 * Polygon Screener Service — fetches fundamental data from Polygon.io
 * to populate the ScreenerCache table (P/E, Dividend Yield, Beta, 52W Range).
 *
 * Raw EPS + annual dividend are stored in DB; P/E and yield are computed
 * at request time using live price so they're always current.
 */
import axios from 'axios';
import prisma from '../utils/prisma';
import { config } from '../config';
import { fetchPolygonAggs, PolygonCandleResult } from '../utils/yahoo-http';
import { subSectorGroups } from '../utils/sectors';
import { etDate } from '../utils/date';

const POLYGON_BASE = 'https://api.polygon.io';

// ─── Data Fetchers ───────────────────────────────────────────────────────────

/**
 * Fetch TTM diluted EPS from Polygon financials endpoint.
 * Sums diluted_earnings_per_share from the last 4 quarterly reports.
 */
async function fetchEpsForTicker(ticker: string): Promise<number | null> {
  try {
    const url = `${POLYGON_BASE}/vX/reference/financials`;
    const resp = await axios.get(url, {
      params: {
        ticker: ticker.toUpperCase(),
        timeframe: 'quarterly',
        limit: 4,
        sort: 'period_of_report_date',
        order: 'desc',
        apiKey: config.polygonApiKey,
      },
      timeout: 10000,
    });

    const results = resp.data?.results;
    if (!Array.isArray(results) || results.length === 0) return null;

    let totalEps = 0;
    let validQuarters = 0;

    for (const filing of results) {
      const eps =
        filing.financials?.income_statement?.diluted_earnings_per_share?.value ??
        filing.financials?.income_statement?.basic_earnings_per_share?.value;
      if (typeof eps === 'number' && Number.isFinite(eps)) {
        totalEps += eps;
        validQuarters++;
      }
    }

    // Need at least 2 quarters to be meaningful
    if (validQuarters < 2) return null;

    // If we have fewer than 4 quarters, annualize
    const ttmEps = validQuarters === 4 ? totalEps : (totalEps / validQuarters) * 4;
    return Math.round(ttmEps * 100) / 100;
  } catch {
    return null;
  }
}

/**
 * Fetch annual dividend from Polygon dividends endpoint.
 * Sums cash_amount from the last 12 months of dividend payments.
 */
async function fetchAnnualDividendForTicker(ticker: string): Promise<number | null> {
  try {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const fromDate = etDate(oneYearAgo);

    const url = `${POLYGON_BASE}/v3/reference/dividends`;
    const resp = await axios.get(url, {
      params: {
        ticker: ticker.toUpperCase(),
        'ex_dividend_date.gte': fromDate,
        limit: 20,
        sort: 'ex_dividend_date',
        order: 'desc',
        apiKey: config.polygonApiKey,
      },
      timeout: 10000,
    });

    const results = resp.data?.results;
    if (!Array.isArray(results) || results.length === 0) return null;

    let totalDividend = 0;
    for (const div of results) {
      if (typeof div.cash_amount === 'number' && Number.isFinite(div.cash_amount) && div.cash_amount > 0) {
        totalDividend += div.cash_amount;
      }
    }

    return totalDividend > 0 ? Math.round(totalDividend * 10000) / 10000 : null;
  } catch {
    return null;
  }
}

/**
 * Calculate beta from 1Y daily returns vs SPY.
 * Beta = Cov(stock, market) / Var(market)
 */
function calculateBeta(
  stockCandles: PolygonCandleResult,
  spyCandles: PolygonCandleResult,
): number | null {
  // Build date-indexed maps for alignment
  const stockByDate = new Map<string, number>();
  for (let i = 0; i < stockCandles.timestamps.length; i++) {
    const date = etDate(new Date(stockCandles.timestamps[i] * 1000));
    stockByDate.set(date, stockCandles.closes[i]);
  }

  const spyByDate = new Map<string, number>();
  for (let i = 0; i < spyCandles.timestamps.length; i++) {
    const date = etDate(new Date(spyCandles.timestamps[i] * 1000));
    spyByDate.set(date, spyCandles.closes[i]);
  }

  // Align dates and compute daily returns
  const spyDates = Array.from(spyByDate.keys()).sort();
  const stockReturns: number[] = [];
  const spyReturns: number[] = [];

  for (let i = 1; i < spyDates.length; i++) {
    const prevDate = spyDates[i - 1];
    const currDate = spyDates[i];

    const stockPrev = stockByDate.get(prevDate);
    const stockCurr = stockByDate.get(currDate);
    const spyPrev = spyByDate.get(prevDate);
    const spyCurr = spyByDate.get(currDate);

    if (stockPrev && stockCurr && spyPrev && spyCurr && stockPrev > 0 && spyPrev > 0) {
      stockReturns.push((stockCurr - stockPrev) / stockPrev);
      spyReturns.push((spyCurr - spyPrev) / spyPrev);
    }
  }

  // Need at least 50 data points for meaningful beta
  if (stockReturns.length < 50) return null;

  const n = stockReturns.length;
  const meanStock = stockReturns.reduce((a, b) => a + b, 0) / n;
  const meanSpy = spyReturns.reduce((a, b) => a + b, 0) / n;

  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const dStock = stockReturns[i] - meanStock;
    const dSpy = spyReturns[i] - meanSpy;
    covariance += dStock * dSpy;
    variance += dSpy * dSpy;
  }

  if (variance === 0) return null;

  const beta = covariance / variance;
  return Math.round(beta * 100) / 100;
}

/**
 * Calculate 52-week high and low from 1Y daily candles.
 */
function calculate52WeekRange(candles: PolygonCandleResult): { high: number; low: number } | null {
  if (candles.highs.length === 0 || candles.lows.length === 0) return null;

  let high = -Infinity;
  let low = Infinity;

  for (let i = 0; i < candles.highs.length; i++) {
    if (candles.highs[i] > high) high = candles.highs[i];
    if (candles.lows[i] < low) low = candles.lows[i];
  }

  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return { high, low };
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

async function collectAllScreenerTickers(): Promise<string[]> {
  const tickers = new Set<string>();
  for (const sector of Object.values(subSectorGroups)) {
    for (const list of Object.values(sector)) {
      for (const t of list) tickers.add(t.toUpperCase());
    }
  }
  // Union with the broader ScreenerUniverse table (Finviz themes ingest, etc)
  // so newly-added tickers also get P/E / dividend / beta / 52W populated.
  try {
    const universe = await prisma.screenerUniverse.findMany({ select: { ticker: true } });
    for (const row of universe) tickers.add(row.ticker.toUpperCase());
  } catch (e) {
    // ScreenerUniverse may not exist yet on a brand-new deploy — degrade to curated only.
    console.warn('[Polygon Screener] ScreenerUniverse query failed, using curated universe only:', e instanceof Error ? e.message : String(e));
  }
  return Array.from(tickers);
}

/**
 * Backfill screener data from Polygon.io for all heatmap tickers.
 * Fetches SPY candles once, then processes tickers in batches.
 */
export async function backfillPolygonScreenerData(): Promise<void> {
  if (!config.polygonApiKey) {
    console.log('[Polygon Screener] No POLYGON_API_KEY set, skipping');
    return;
  }

  const tickers = await collectAllScreenerTickers();
  console.log(`[Polygon Screener] Starting backfill for ${tickers.length} tickers`);

  // Check which tickers need refresh (stale > 12 hours)
  const existing = await prisma.screenerCache.findMany({
    select: { ticker: true, lastFetchedAt: true },
  });
  const existingMap = new Map(existing.map(r => [r.ticker, r.lastFetchedAt]));
  const STALE_MS = 12 * 60 * 60 * 1000;
  const now = Date.now();

  const needsRefresh = tickers.filter(t => {
    const last = existingMap.get(t);
    if (!last) return true;
    return now - new Date(last).getTime() > STALE_MS;
  });

  if (needsRefresh.length === 0) {
    console.log(`[Polygon Screener] All ${tickers.length} tickers are fresh, skipping`);
    return;
  }

  console.log(`[Polygon Screener] ${needsRefresh.length} tickers need refresh`);

  // Fetch SPY candles once for beta calculation
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const fromDate = etDate(oneYearAgo);
  const toDate = etDate();

  const spyCandles = await fetchPolygonAggs('SPY', 1, 'day', fromDate, toDate, 43200);
  if (!spyCandles || spyCandles.closes.length < 50) {
    console.error('[Polygon Screener] Failed to fetch SPY candles for beta calc');
    // Continue anyway — we can still get EPS, dividends, 52W range
  }

  const BATCH_SIZE = 10;
  let success = 0;
  let failed = 0;

  for (let i = 0; i < needsRefresh.length; i += BATCH_SIZE) {
    const batch = needsRefresh.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        // Fetch all data concurrently for this ticker
        const [eps, annualDividend, tickerCandles] = await Promise.all([
          fetchEpsForTicker(ticker),
          fetchAnnualDividendForTicker(ticker),
          fetchPolygonAggs(ticker, 1, 'day', fromDate, toDate, 43200),
        ]);

        // Calculate beta and 52W range from candle data
        let beta: number | null = null;
        let week52High: number | null = null;
        let week52Low: number | null = null;

        if (tickerCandles) {
          const range = calculate52WeekRange(tickerCandles);
          if (range) {
            week52High = range.high;
            week52Low = range.low;
          }

          if (spyCandles) {
            beta = calculateBeta(tickerCandles, spyCandles);
          }
        }

        // Only upsert if we got at least some data
        if (eps != null || annualDividend != null || beta != null || week52High != null) {
          await prisma.screenerCache.upsert({
            where: { ticker },
            create: {
              ticker,
              eps,
              annualDividend,
              beta,
              week52High,
              week52Low,
              lastFetchedAt: new Date(),
            },
            update: {
              ...(eps != null && { eps }),
              ...(annualDividend != null && { annualDividend }),
              ...(beta != null && { beta }),
              ...(week52High != null && { week52High }),
              ...(week52Low != null && { week52Low }),
              lastFetchedAt: new Date(),
            },
          });
          return true;
        }
        return false;
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        success++;
      } else {
        failed++;
      }
    }

    // Small delay between batches to be nice to the API
    if (i + BATCH_SIZE < needsRefresh.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log(
    `[Polygon Screener] Backfill complete: ${success} updated, ${failed} failed/empty, ${tickers.length - needsRefresh.length} already fresh`
  );
}
