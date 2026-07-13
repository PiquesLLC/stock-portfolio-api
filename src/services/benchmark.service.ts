/**
 * Benchmark Comparison Service
 * Computes portfolio TWR vs benchmark (SPY/QQQ/DIA) for any window.
 */

import prisma from '../utils/prisma';
import {
  calculateTWR,
  calculateBeta,
  calculateCorrelation,
  annualizedVolatility,
  maxDrawdown,
  calculateXIRR,
  SnapshotPoint,
  CashflowEvent,
} from '../utils/finance-math';
import { getBenchmarkReturns, getBenchmarkTotalReturn, getBenchmarkTotalReturnFromDate, getBenchmarkReturnWithQuote, getBenchmarkCandles } from '../utils/candle-cache';
import { reconstructPortfolioHistory } from './snapshot.service';
import { fetchPrice } from './market.service';
import { getPortfolio } from './portfolio.service';

/**
 * Build the cashflow series for a money-weighted return (XIRR) computation.
 *
 * XIRR sign convention (finance-math.ts calculateXIRR): negative = money
 * invested, positive = money returned. The `cashflows` array is TWR-signed
 * (deposit = +amount, because calculateTWR adds it to the new-period base), so
 * the intermediate flows must be NEGATED for XIRR — a deposit is additional
 * money invested (negative), a withdrawal is money returned (positive). Reusing
 * the TWR-signed array verbatim inverted MWR: a deposit-only account reported a
 * large positive money-weighted return instead of ~0% (audit finding C1).
 *
 * Exported so the sign convention is regression-tested directly on this
 * construction (see mwr-xirr-sign.test.ts).
 */
export function buildXirrFlows(
  snapshotPoints: SnapshotPoint[],
  cashflows: CashflowEvent[],
): CashflowEvent[] {
  return [
    // Initial portfolio value = money already invested → negative
    { date: snapshotPoints[0].date, amount: -snapshotPoints[0].value },
    // Intermediate cashflows — negate TWR signs for the XIRR convention
    ...cashflows.map(cf => ({ date: cf.date, amount: -cf.amount })),
    // Final portfolio value = money returned → positive
    { date: snapshotPoints[snapshotPoints.length - 1].date, amount: snapshotPoints[snapshotPoints.length - 1].value },
  ];
}

export type PerformanceWindow = '1D' | '1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y' | 'ALL';

export interface PerformanceData {
  window: PerformanceWindow;
  benchmarkTicker: string;
  // Portfolio metrics
  simpleReturnPct: number | null; // matches chart display (reconstructed from candles)
  twrPct: number | null;
  mwrPct: number | null;
  // Benchmark
  benchmarkReturnPct: number | null;
  alphaPct: number | null;
  // Risk metrics
  beta: number | null;
  correlation: number | null;
  volatilityPct: number | null;
  maxDrawdownPct: number | null;
  // Extremes
  bestDay: { date: string; returnPct: number } | null;
  worstDay: { date: string; returnPct: number } | null;
  // Metadata
  snapshotCount: number;
  dataStartDate: string | null;
  dataEndDate: string | null;
}

function getWindowDays(window: PerformanceWindow): number {
  switch (window) {
    case '1D': return 1;
    case '1W': return 7;
    case '1M': return 30;
    case '3M': return 90;
    case '6M': return 180;
    case 'YTD': return Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000);
    case '1Y': return 365;
    case 'ALL': return 3650; // 10 years max
  }
}

function getWindowTradingDays(window: PerformanceWindow): number {
  const calendarDays = getWindowDays(window);
  return Math.round(calendarDays * 252 / 365);
}

function getWindowStartDate(window: PerformanceWindow): Date {
  if (window === 'YTD') return new Date(new Date().getFullYear(), 0, 1);
  const d = new Date();
  d.setDate(d.getDate() - getWindowDays(window));
  return d;
}

/**
 * Resolve the 'AUTO' performance window to the largest standard window the user's
 * snapshot history can FULLY fill: span >= 30d -> 1M, >= 7d -> 1W, else 1D.
 * Thresholds equal each window's own length so real history covers the whole
 * window — the portfolio return and the windowStart-anchored benchmark then span
 * the same dates (otherwise alpha mismatches for short histories).
 *
 * Single source of truth shared by the profile performance stat
 * (getPerformanceComparison) and the shareable performance card, so the window a
 * profile shows can never drift from the window its share image shows.
 */
export async function resolveAutoWindow(userId: string): Promise<PerformanceWindow> {
  const earliest = await prisma.portfolioSnapshot.findFirst({
    where: { userId },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true },
  });
  const spanDays = earliest ? (Date.now() - earliest.timestamp.getTime()) / 86400000 : 0;
  return spanDays >= 30 ? '1M' : spanDays >= 7 ? '1W' : '1D';
}

export async function getPerformanceComparison(
  windowParam: PerformanceWindow | 'AUTO' = '1M',
  benchmarkTicker: string = 'SPY',
  userId: string,
  portfolioId?: string
): Promise<PerformanceData> {
  // Resolve AUTO to the largest standard window the user's snapshot history can
  // fully fill (mirrors the profile chart's 1M->1W->1D fallback). The resolved
  // window is returned in PerformanceData.window for the UI to label.
  const window: PerformanceWindow = windowParam === 'AUTO'
    ? await resolveAutoWindow(userId)
    : windowParam;
  const windowStart = getWindowStartDate(window);
  const tradingDays = getWindowTradingDays(window);

  // Special handling for 1D: use live portfolio data instead of snapshots
  // This ensures accuracy by using the same dayChange calculation as the chart
  if (window === '1D') {
    try {
      const portfolio = await getPortfolio(userId, { portfolioId });
      if (portfolio.holdings.length === 0) {
        return emptyPerformanceData(window, benchmarkTicker);
      }
      const portfolioReturnPct = Math.round(portfolio.dayChangePercent * 100) / 100;

      // Get benchmark return from live quote
      let benchmarkReturnPct: number | null = null;
      try {
        const benchmarkQuote = await fetchPrice(benchmarkTicker);
        if (benchmarkQuote.changePercent != null) {
          benchmarkReturnPct = Math.round(benchmarkQuote.changePercent * 100) / 100;
        }
      } catch (err) {
        console.warn(`[Benchmark] Failed to get quote for ${benchmarkTicker}:`, err);
      }

      const alphaPct = benchmarkReturnPct !== null
        ? Math.round((portfolioReturnPct - benchmarkReturnPct) * 100) / 100
        : null;

      return {
        window,
        benchmarkTicker,
        simpleReturnPct: portfolioReturnPct,
        twrPct: portfolioReturnPct, // For 1D, TWR equals simple return
        mwrPct: null,
        benchmarkReturnPct,
        alphaPct,
        beta: null,
        correlation: null,
        volatilityPct: null,
        maxDrawdownPct: portfolioReturnPct < 0 ? Math.abs(portfolioReturnPct) : 0,
        bestDay: { date: new Date().toISOString().slice(0, 10), returnPct: portfolioReturnPct },
        worstDay: { date: new Date().toISOString().slice(0, 10), returnPct: portfolioReturnPct },
        snapshotCount: portfolio.holdings.length > 0 ? 2 : 0,
        dataStartDate: new Date().toISOString(),
        dataEndDate: new Date().toISOString(),
      };
    } catch (err) {
      console.warn('[Benchmark] Failed to get live portfolio for 1D, falling back to snapshots:', err);
      // Fall through to snapshot-based calculation
    }
  }

  // Get portfolio snapshots for this window
  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: {
      userId,
      timestamp: { gte: windowStart },
    },
    orderBy: { timestamp: 'asc' },
  });

  // Also get the last snapshot before the window for baseline
  const baselineSnapshot = await prisma.portfolioSnapshot.findFirst({
    where: {
      userId,
      timestamp: { lt: windowStart },
    },
    orderBy: { timestamp: 'desc' },
  });

  // Build full snapshot series (baseline + window)
  const allSnapshotsRaw = baselineSnapshot
    ? [baselineSnapshot, ...snapshots]
    : snapshots;

  // Deduplicate to one snapshot per calendar day (last snapshot of each day)
  // This prevents intraday noise from distorting TWR and risk metrics
  const dailyMap = new Map<string, typeof allSnapshotsRaw[0]>();
  for (const s of allSnapshotsRaw) {
    const dayKey = s.timestamp.toISOString().slice(0, 10);
    dailyMap.set(dayKey, s); // last one wins (they're sorted asc)
  }
  const allSnapshots = Array.from(dailyMap.values()).sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );

  // Filter out snapshots where netEquity is null (totalValue includes cost basis,
  // not actual equity). Only filter if SOME snapshots have netEquity â€” if none do,
  // totalValue is all we have and is likely correct for that user.
  const hasAnyNetEquity = allSnapshots.some(s => s.netEquity !== null && Number(s.netEquity) > 0);
  const reliableSnapshots = hasAnyNetEquity
    ? allSnapshots.filter(s => s.netEquity !== null && Number(s.netEquity) > 0)
    : allSnapshots;
  const effectiveSnapshots = reliableSnapshots.length >= 2 ? reliableSnapshots : allSnapshots;

  // Tracks whether snapshotPoints is raw account history (deposits/withdrawals
  // are IN the values and must be flow-adjusted out of the risk metrics) or a
  // candle reconstruction (holds cash constant — no flows in the series).
  let seriesFromSnapshots = true;
  let snapshotPoints: SnapshotPoint[] = effectiveSnapshots.map(s => ({
    date: s.timestamp,
    // Use netEquity if it's a real value (> 0), otherwise fall back to totalValue.
    // netEquity can be 0 (Decimal) when not yet computed â€” 0 ?? X returns 0, not X.
    value: (s.netEquity !== null && Number(s.netEquity) > 0) ? Number(s.netEquity) : Number(s.totalValue),
  }));

  // Prefer candle-based reconstruction for metrics accuracy ONLY when portfolio
  // composition hasn't changed. Candles represent market close values (better than
  // arbitrary snapshot times), but reconstruction assumes current holdings were held
  // for the entire window — creating survivor bias if the user traded.
  const windowDays = getWindowDays(window);

  // Fetch current holdings to reconstruct history from candles
  const holdingWhere = portfolioId ? { portfolioId } : { userId };
  const holdings = await prisma.holding.findMany({
    where: holdingWhere,
  });

  // Only reconstruct from candles if a baseline snapshot exists before the window.
  // Without a pre-window anchor, candle reconstruction fabricates performance —
  // it pretends the user held current positions for the entire window.
  const hasSnapshotHistory = baselineSnapshot != null;

  // Check if portfolio composition changed during the window (holdings added/removed/updated).
  // If it did, candle reconstruction with current holdings would produce wrong returns
  // because it uses current share counts for the entire window, ignoring that the user
  // held different quantities (or different stocks entirely) earlier in the period.
  const compositionChanges = await prisma.activityEvent.count({
    where: {
      userId,
      type: { in: ['holding_added', 'holding_removed', 'holding_updated'] },
      createdAt: { gte: windowStart },
    },
  });
  const compositionStable = compositionChanges === 0;

  if (holdings.length > 0 && windowDays > 1 && hasSnapshotHistory && compositionStable) {
    const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
      where: { userId },
      orderBy: { timestamp: 'desc' },
    });
    const cashBalance = latestSnapshot?.cashBalance ?? 0;
    // Get marginDebt from user settings (not on snapshot model)
    const userSettings = await prisma.userSettings.findUnique({ where: { userId } });
    const marginDebt = userSettings?.marginDebt ?? 0;

    // Request extra buffer days to ensure enough trading days for statistical measures.
    // 30 calendar days â‰ˆ 21 trading days â†’ 20 returns, but we need margin for holidays/gaps.
    const bufferDays = windowDays + 15;

    const reconstructed = await reconstructPortfolioHistory(
      holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
      cashBalance,
      bufferDays,
      marginDebt,
    );

    if (reconstructed.length >= 2) {
      snapshotPoints = reconstructed.map(p => ({
        date: new Date(p.time),
        value: p.value,
      }));
      seriesFromSnapshots = false;
    }
  }

  // Get transactions for TWR calculation
  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      date: { gte: windowStart },
    },
    orderBy: { date: 'asc' },
  });

  const cashflows: CashflowEvent[] = transactions.map(t => ({
    date: t.date,
    amount: t.type === 'deposit' ? t.amount : -t.amount,
  }));

  // The candle-reconstruction series (seriesFromSnapshots === false) holds cash
  // CONSTANT and contains no deposit/withdrawal step, so feeding it cashflows makes
  // calculateTWR/XIRR split the series at flows that aren't present in its values
  // and fabricate a return (a stable-composition manual deposit read as a large
  // negative TWR). Only the raw-snapshot series has flows baked into its values.
  // Mirrors the risk-loop's own `if (seriesFromSnapshots)` guard below. See F-HIGH-5.
  const effectiveCashflows: CashflowEvent[] = seriesFromSnapshots ? cashflows : [];

  // The reconstructed candle series spans windowDays+15 (buffer for statistically
  // meaningful vol/beta). The RETURN numbers (TWR/MWR/simpleReturn) must be measured
  // over the WINDOW only — otherwise a "1M" TWR reflects ~45 days and alpha subtracts a
  // 45-day portfolio return from a 30-day benchmark. The raw-snapshot series already
  // carries an intentional pre-window baseline anchor, so only the candle series is
  // sliced here; the risk loop below keeps the full buffered series. F-M-10.
  const windowPoints: SnapshotPoint[] = seriesFromSnapshots
    ? snapshotPoints
    : snapshotPoints.filter(p => p.date.getTime() >= windowStart.getTime());

  // Calculate TWR
  const twrRaw = calculateTWR(windowPoints, effectiveCashflows);
  const twrPct = twrRaw !== null ? Math.round(twrRaw * 10000) / 100 : null;

  // Calculate MWR (XIRR) â€” needs initial investment + final value
  let mwrPct: number | null = null;
  if (windowPoints.length >= 2) {
    const xirr = calculateXIRR(buildXirrFlows(windowPoints, effectiveCashflows));
    mwrPct = xirr !== null ? Math.round(xirr * 10000) / 100 : null;
  }

  // Benchmark return â€” always use real-time quote for accuracy
  let benchmarkReturnPct: number | null = null;

  try {
    const quote = await fetchPrice(benchmarkTicker);

    if (window === '1D') {
      // For 1D, use the quote's built-in day change
      if (quote.changePercent != null) {
        benchmarkReturnPct = Math.round(quote.changePercent * 100) / 100;
      }
    } else {
      // For all other windows, use live price + historical start price (matches chart calculation)
      const returnRaw = getBenchmarkReturnWithQuote(benchmarkTicker, windowStart, quote.currentPrice);
      if (returnRaw !== null) {
        benchmarkReturnPct = Math.round(returnRaw * 10000) / 100;
      }
    }
  } catch (err) {
    console.warn(`[Benchmark] Failed to get real-time quote for ${benchmarkTicker}:`, err);
  }

  // Fallback to historical cache only if quote failed
  if (benchmarkReturnPct === null) {
    const benchmarkReturnRaw = getBenchmarkTotalReturnFromDate(benchmarkTicker, windowStart)
      ?? getBenchmarkTotalReturn(benchmarkTicker, tradingDays);
    benchmarkReturnPct = benchmarkReturnRaw !== null
      ? Math.round(benchmarkReturnRaw * 10000) / 100
      : null;
  }

  // Simple return from snapshot data (API-side approximation; UI overrides with chart data)
  const simpleReturnPct = windowPoints.length >= 2
    ? Math.round(((windowPoints[windowPoints.length - 1].value - windowPoints[0].value) / windowPoints[0].value) * 10000) / 100
    : null;

  // Alpha â€” computed from simpleReturnPct; UI may override with chart-derived values
  const alphaPct = (simpleReturnPct !== null && benchmarkReturnPct !== null)
    ? Math.round((simpleReturnPct - benchmarkReturnPct) * 100) / 100
    : null;

  // Risk metrics — flow-adjusted daily returns, date-paired with the benchmark.
  // When the series is raw account history, each day's return is TWR-style
  // flow-adjusted (r = V_t / (V_{t-1} + CF_t) - 1) so deposits/withdrawals
  // don't read as market moves (same rule as the health score's risk series).
  // The candle-reconstruction series holds cash constant — nothing to remove.
  const flowByDay = new Map<string, number>();
  if (seriesFromSnapshots) {
    for (const cf of cashflows) {
      const key = cf.date.toISOString().slice(0, 10);
      flowByDay.set(key, (flowByDay.get(key) ?? 0) + cf.amount);
    }
  }

  const benchmarkData = getBenchmarkCandles(benchmarkTicker);
  const bmCloseMap = new Map<string, number>();
  if (benchmarkData) {
    for (let i = 0; i < benchmarkData.dates.length; i++) {
      bmCloseMap.set(benchmarkData.dates[i], benchmarkData.closes[i]);
    }
  }

  // One pass builds: flow-adjusted portfolio returns (volatility), the
  // deposit-neutral equity index (drawdown), best/worst day, and PAIRED
  // portfolio/benchmark returns for beta/correlation — a pair is pushed only
  // when BOTH sides have data for that date, so a mid-series benchmark gap
  // can't shift the pairing (the old code trimmed the portfolio array from
  // the FRONT, misaligning every pair before a mid-window gap).
  const portfolioReturns: number[] = [];
  const pairedPortfolioReturns: number[] = [];
  const pairedBenchmarkReturns: number[] = [];
  const equityIndex: number[] = [100];
  let bestDay: { date: string; returnPct: number } | null = null;
  let worstDay: { date: string; returnPct: number } | null = null;
  for (let i = 1; i < snapshotPoints.length; i++) {
    const dateKey = snapshotPoints[i].date.toISOString().slice(0, 10);
    const base = snapshotPoints[i - 1].value + (flowByDay.get(dateKey) ?? 0);
    if (base <= 0) continue;
    const r = snapshotPoints[i].value / base - 1;
    portfolioReturns.push(r);
    equityIndex.push(equityIndex[equityIndex.length - 1] * (1 + r));

    const retPct = Math.round(r * 10000) / 100;
    // Best/worst DAY are user-facing "this period" extremes, so scope them to the
    // window even though vol/beta/drawdown keep the full buffered series for
    // statistical significance. Without this, the candle path could report a best
    // day dated up to ~15 days before windowStart. F-M-10 (extremes).
    if (snapshotPoints[i].date.getTime() >= windowStart.getTime()) {
      if (!bestDay || retPct > bestDay.returnPct) bestDay = { date: dateKey, returnPct: retPct };
      if (!worstDay || retPct < worstDay.returnPct) worstDay = { date: dateKey, returnPct: retPct };
    }

    const bmClose = bmCloseMap.get(dateKey);
    const bmPrevClose = bmCloseMap.get(snapshotPoints[i - 1].date.toISOString().slice(0, 10));
    if (bmClose != null && bmPrevClose != null && bmPrevClose > 0) {
      pairedPortfolioReturns.push(r);
      pairedBenchmarkReturns.push((bmClose - bmPrevClose) / bmPrevClose);
    }
  }

  // Use the date-paired series when enough dates matched; otherwise fall back
  // to tail-sliced benchmark returns (calculateBeta/Correlation tail-align).
  let betaPortfolioReturns = portfolioReturns;
  let benchmarkReturns: number[] | null;
  if (pairedBenchmarkReturns.length >= 10) {
    betaPortfolioReturns = pairedPortfolioReturns;
    benchmarkReturns = pairedBenchmarkReturns;
  } else {
    benchmarkReturns = getBenchmarkReturns(benchmarkTicker, tradingDays);
  }

  const beta = benchmarkReturns
    ? calculateBeta(betaPortfolioReturns, benchmarkReturns)
    : null;

  const correlation = benchmarkReturns
    ? calculateCorrelation(betaPortfolioReturns, benchmarkReturns)
    : null;

  const vol = annualizedVolatility(portfolioReturns);
  const volatilityPct = vol !== null ? Math.round(vol * 10000) / 100 : null;

  const mdd = maxDrawdown(equityIndex);
  const maxDrawdownPct = equityIndex.length >= 2 ? Math.round(mdd * 10000) / 100 : null;

  return {
    window,
    benchmarkTicker,
    simpleReturnPct,
    twrPct,
    mwrPct,
    benchmarkReturnPct,
    alphaPct,
    beta: beta !== null ? Math.round(beta * 100) / 100 : null,
    correlation: correlation !== null ? Math.round(correlation * 100) / 100 : null,
    volatilityPct,
    maxDrawdownPct,
    bestDay,
    worstDay,
    snapshotCount: snapshots.length,
    dataStartDate: allSnapshots.length > 0 ? allSnapshots[0].timestamp.toISOString() : null,
    dataEndDate: allSnapshots.length > 0 ? allSnapshots[allSnapshots.length - 1].timestamp.toISOString() : null,
  };
}

function emptyPerformanceData(window: PerformanceWindow, benchmarkTicker: string): PerformanceData {
  return {
    window,
    benchmarkTicker,
    simpleReturnPct: null,
    twrPct: null,
    mwrPct: null,
    benchmarkReturnPct: null,
    alphaPct: null,
    beta: null,
    correlation: null,
    volatilityPct: null,
    maxDrawdownPct: null,
    bestDay: null,
    worstDay: null,
    snapshotCount: 0,
    dataStartDate: null,
    dataEndDate: null,
  };
}

