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
  bestWorstDays,
  dailyReturnsFromValues,
  calculateXIRR,
  SnapshotPoint,
  CashflowEvent,
} from '../utils/finance-math';
import { getBenchmarkReturns, getBenchmarkTotalReturn, getBenchmarkTotalReturnFromDate, getBenchmarkReturnWithQuote, getBenchmarkCandles } from '../utils/candle-cache';
import { reconstructPortfolioHistory } from './snapshot.service';
import { fetchPrice } from './market.service';
import { getPortfolio } from './portfolio.service';

export type PerformanceWindow = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | 'ALL';

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

export async function getPerformanceComparison(
  window: PerformanceWindow = '1M',
  benchmarkTicker: string = 'SPY',
  userId: string
): Promise<PerformanceData> {
  const windowStart = getWindowStartDate(window);
  const tradingDays = getWindowTradingDays(window);

  // Special handling for 1D: use live portfolio data instead of snapshots
  // This ensures accuracy by using the same dayChange calculation as the chart
  if (window === '1D') {
    try {
      const portfolio = await getPortfolio(userId);
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

  let snapshotPoints: SnapshotPoint[] = effectiveSnapshots.map(s => ({
    date: s.timestamp,
    // Use netEquity if it's a real value (> 0), otherwise fall back to totalValue.
    // netEquity can be 0 (Decimal) when not yet computed â€” 0 ?? X returns 0, not X.
    value: (s.netEquity !== null && Number(s.netEquity) > 0) ? Number(s.netEquity) : Number(s.totalValue),
  }));

  // ALWAYS prefer candle-based reconstruction for metrics accuracy.
  // Snapshots are taken at arbitrary times throughout the day, causing inaccurate
  // day-over-day comparisons. Candles represent market close values which is what
  // users expect when viewing "best day", "worst day", etc.
  const windowDays = getWindowDays(window);

  // Fetch current holdings to reconstruct history from candles
  const holdings = await prisma.holding.findMany({
    where: { userId },
  });

  // Only reconstruct from candles if a baseline snapshot exists before the window.
  // Without a pre-window anchor, candle reconstruction fabricates performance —
  // it pretends the user held current positions for the entire window.
  // A new account with snapshots only from today would pass "snapshots.length >= 2"
  // but still has no history before the window, producing fake 30-day returns.
  const hasSnapshotHistory = baselineSnapshot != null;

  if (holdings.length > 0 && windowDays > 1 && hasSnapshotHistory) {
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

  // Calculate TWR
  const twrRaw = calculateTWR(snapshotPoints, cashflows);
  const twrPct = twrRaw !== null ? Math.round(twrRaw * 10000) / 100 : null;

  // Calculate MWR (XIRR) â€” needs initial investment + final value
  let mwrPct: number | null = null;
  if (snapshotPoints.length >= 2) {
    const xirrFlows: CashflowEvent[] = [
      // Initial: negative (investment)
      { date: snapshotPoints[0].date, amount: -snapshotPoints[0].value },
      // Intermediate cashflows
      ...cashflows,
      // Final: positive (current value)
      { date: snapshotPoints[snapshotPoints.length - 1].date, amount: snapshotPoints[snapshotPoints.length - 1].value },
    ];
    const xirr = calculateXIRR(xirrFlows);
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
  const simpleReturnPct = snapshotPoints.length >= 2
    ? Math.round(((snapshotPoints[snapshotPoints.length - 1].value - snapshotPoints[0].value) / snapshotPoints[0].value) * 10000) / 100
    : null;

  // Alpha â€” computed from simpleReturnPct; UI may override with chart-derived values
  const alphaPct = (simpleReturnPct !== null && benchmarkReturnPct !== null)
    ? Math.round((simpleReturnPct - benchmarkReturnPct) * 100) / 100
    : null;

  // Risk metrics â€” date-align portfolio and benchmark returns for accuracy.
  // Portfolio daily returns from candle reconstruction are date-indexed;
  // benchmark returns must match the same trading dates.
  const values = snapshotPoints.map(s => s.value);
  const portfolioReturns = dailyReturnsFromValues(values);

  // Build date-aligned benchmark returns from the same dates as portfolio
  const benchmarkData = getBenchmarkCandles(benchmarkTicker);
  let benchmarkReturns: number[] | null = null;

  if (benchmarkData && snapshotPoints.length >= 2) {
    // Create a date â†’ close lookup for the benchmark
    const bmCloseMap = new Map<string, number>();
    for (let i = 0; i < benchmarkData.dates.length; i++) {
      bmCloseMap.set(benchmarkData.dates[i], benchmarkData.closes[i]);
    }

    // For each portfolio snapshot date, find the matching benchmark close
    const alignedBmReturns: number[] = [];
    for (let i = 1; i < snapshotPoints.length; i++) {
      const dateKey = snapshotPoints[i].date.toISOString().slice(0, 10);
      const prevDateKey = snapshotPoints[i - 1].date.toISOString().slice(0, 10);
      const bmClose = bmCloseMap.get(dateKey);
      const bmPrevClose = bmCloseMap.get(prevDateKey);
      if (bmClose != null && bmPrevClose != null && bmPrevClose > 0) {
        alignedBmReturns.push((bmClose - bmPrevClose) / bmPrevClose);
      }
    }

    // Only use aligned returns if we got enough matching dates
    if (alignedBmReturns.length >= 10) {
      benchmarkReturns = alignedBmReturns;
      // Trim portfolio returns to match aligned length (in case some dates didn't match)
      while (portfolioReturns.length > alignedBmReturns.length) {
        portfolioReturns.shift();
      }
    }
  }

  // Fallback to tail-slicing if date alignment failed
  if (!benchmarkReturns) {
    benchmarkReturns = getBenchmarkReturns(benchmarkTicker, tradingDays);
  }

  const beta = benchmarkReturns
    ? calculateBeta(portfolioReturns, benchmarkReturns)
    : null;

  const correlation = benchmarkReturns
    ? calculateCorrelation(portfolioReturns, benchmarkReturns)
    : null;

  const vol = annualizedVolatility(portfolioReturns);
  const volatilityPct = vol !== null ? Math.round(vol * 10000) / 100 : null;

  const mdd = maxDrawdown(values);
  const maxDrawdownPct = values.length >= 2 ? Math.round(mdd * 10000) / 100 : null;

  const { bestDay: bd, worstDay: wd } = bestWorstDays(snapshotPoints);

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
    bestDay: bd ? { date: bd.date.toISOString().slice(0, 10), returnPct: bd.returnPct } : null,
    worstDay: wd ? { date: wd.date.toISOString().slice(0, 10), returnPct: wd.returnPct } : null,
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

