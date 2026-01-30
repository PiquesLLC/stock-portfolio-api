/**
 * Benchmark Comparison Service
 * Computes portfolio TWR vs benchmark (SPY/QQQ/DIA) for any window.
 */

import { PrismaClient } from '@prisma/client';
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
import { getBenchmarkReturns, getBenchmarkTotalReturn, getBenchmarkCloses } from '../utils/candle-cache';
import { reconstructPortfolioHistory } from './snapshot.service';

const prisma = new PrismaClient();

export type PerformanceWindow = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | 'ALL';

export interface PerformanceData {
  window: PerformanceWindow;
  benchmarkTicker: string;
  // Portfolio metrics
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
  userId?: string | null
): Promise<PerformanceData> {
  const windowStart = getWindowStartDate(window);
  const tradingDays = getWindowTradingDays(window);

  // Get portfolio snapshots for this window
  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: {
      userId: userId ?? null,
      timestamp: { gte: windowStart },
    },
    orderBy: { timestamp: 'asc' },
  });

  // Also get the last snapshot before the window for baseline
  const baselineSnapshot = await prisma.portfolioSnapshot.findFirst({
    where: {
      userId: userId ?? null,
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

  let snapshotPoints: SnapshotPoint[] = allSnapshots.map(s => ({
    date: s.timestamp,
    value: s.netEquity ?? s.totalValue,
  }));

  // Check if snapshot history covers the requested window adequately.
  // If snapshots cover less than 50% of the window, fall back to candle-based reconstruction.
  const windowDays = getWindowDays(window);
  const snapshotSpanDays = snapshotPoints.length >= 2
    ? (snapshotPoints[snapshotPoints.length - 1].date.getTime() - snapshotPoints[0].date.getTime()) / 86400000
    : 0;

  if (snapshotSpanDays < windowDays * 0.5 && windowDays > 1) {
    // Fetch current holdings to reconstruct history from candles
    const holdings = await prisma.holding.findMany({
      where: { userId: userId ?? undefined },
    });

    if (holdings.length > 0) {
      const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
        where: { userId: userId ?? null },
        orderBy: { timestamp: 'desc' },
      });
      const cashBalance = latestSnapshot?.cashBalance ?? 0;

      const reconstructed = await reconstructPortfolioHistory(
        holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
        cashBalance,
        windowDays,
        0,
      );

      if (reconstructed.length >= 2) {
        snapshotPoints = reconstructed.map(p => ({
          date: new Date(p.time),
          value: p.value,
        }));
      }
    }
  }

  // Get transactions for TWR calculation
  const transactions = await prisma.transaction.findMany({
    where: {
      userId: userId ?? null,
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

  // Calculate MWR (XIRR) — needs initial investment + final value
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

  // Benchmark return
  const benchmarkReturnRaw = getBenchmarkTotalReturn(benchmarkTicker, tradingDays);
  const benchmarkReturnPct = benchmarkReturnRaw !== null
    ? Math.round(benchmarkReturnRaw * 10000) / 100
    : null;

  // Alpha
  const alphaPct = (twrPct !== null && benchmarkReturnPct !== null)
    ? Math.round((twrPct - benchmarkReturnPct) * 100) / 100
    : null;

  // Risk metrics from portfolio daily returns
  const values = snapshotPoints.map(s => s.value);
  const portfolioReturns = dailyReturnsFromValues(values);
  const benchmarkReturns = getBenchmarkReturns(benchmarkTicker, tradingDays);

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
