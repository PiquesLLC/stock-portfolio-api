import { PrismaClient } from '@prisma/client';
import { PortfolioSnapshot } from '../types';
import { getPortfolio } from './portfolio.service';
import { config } from '../config';
import axios from 'axios';
import NodeCache from 'node-cache';
import { yahooGet, fetchFinnhubCandles, fetchPolygonAggs } from '../utils/yahoo-http';

const chartCandleCache = new NodeCache({ stdTTL: 86400 });
const hiresCache = new NodeCache({ stdTTL: 300 }); // 5-min cache for intraday/hourly candles

const prisma = new PrismaClient();

// In-memory lock to prevent race conditions in snapshot creation
let lastSnapshotTime: number = 0;
let isCreatingSnapshot = false;

export async function createSnapshotIfNeeded(): Promise<PortfolioSnapshot | null> {
  const now = Date.now();
  const intervalMs = config.snapshotIntervalSeconds * 1000;

  // Fast path: check in-memory timestamp first (avoids DB query in most cases)
  if (now - lastSnapshotTime < intervalMs) {
    return null;
  }

  // Prevent concurrent snapshot creation (race condition fix)
  if (isCreatingSnapshot) {
    return null;
  }

  isCreatingSnapshot = true;

  try {
    // Double-check with database (in case server restarted)
    const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
      where: { userId: '237198da-612e-411c-9ef8-f267c887a9f1' },
      orderBy: { timestamp: 'desc' },
    });

    if (latestSnapshot) {
      const timeSinceLastSnapshot = now - new Date(latestSnapshot.timestamp).getTime();
      if (timeSinceLastSnapshot < intervalMs) {
        // Update in-memory timestamp to avoid future DB queries
        lastSnapshotTime = new Date(latestSnapshot.timestamp).getTime();
        return null;
      }
    }

    const portfolio = await getPortfolio();

    // Skip snapshot only if majority of quotes are unavailable
    // (allows snapshots during premarket/after-hours when some tickers lack data)
    const totalHoldings = portfolio.holdings.length;
    const unavailable = portfolio.quotesUnavailableCount ?? 0;
    if (totalHoldings > 0 && unavailable > totalHoldings * 0.5) {
      console.log(
        `[Snapshot] Skipped - ${unavailable}/${totalHoldings} quotes unavailable (>50%)`
      );
      return null;
    }

    // Don't create snapshot if portfolio assets seem suspiciously low
    // Note: We use totalAssets which excludes marginDebt
    const minValueForSnapshot = 100;
    if (portfolio.holdings.length > 0 && portfolio.totalAssets < minValueForSnapshot) {
      console.log(
        `[Snapshot] Skipped - totalAssets $${portfolio.totalAssets.toFixed(2)} too low`
      );
      return null;
    }

    // Skip if sudden large drop AND any quotes unavailable (likely data issue)
    // A 25% drop in 2 minutes is almost certainly bad data, not a real market move
    if (latestSnapshot && unavailable > 0) {
      const prevValue = latestSnapshot.netEquity ?? latestSnapshot.totalValue;
      const dropPercent = ((prevValue - portfolio.totalAssets) / prevValue) * 100;
      if (dropPercent > 25) {
        console.log(
          `[Snapshot] Skipped - ${dropPercent.toFixed(1)}% sudden drop with ${unavailable} unavailable quotes (likely bad data)`
        );
        return null;
      }
    }

    const previousSnapshot = latestSnapshot;

    let dailyPL = 0;
    let dailyPLPercent = 0;

    if (previousSnapshot && previousSnapshot.totalValue > 0) {
      dailyPL = portfolio.totalAssets - previousSnapshot.totalValue;
      dailyPLPercent = (dailyPL / previousSnapshot.totalValue) * 100;
    }

    // Store snapshot using totalAssets (holdingsValue + cashBalance, NO marginDebt)
    // This ensures margin debt changes don't affect historical performance tracking
    const snapshotTime = new Date();
    const snapshot = await prisma.portfolioSnapshot.create({
      data: {
        timestamp: snapshotTime,
        totalValue: portfolio.totalAssets, // Assets only - no marginDebt
        cashBalance: portfolio.cashBalance,
        dailyPL,
        dailyPLPercent,
        totalPL: portfolio.totalPL,
        totalPLPercent: portfolio.totalPLPercent,
        netEquity: portfolio.totalAssets - portfolio.marginDebt,
      },
    });

    // Store per-holding stats for momentum tracking
    if (portfolio.holdings.length > 0) {
      await prisma.holdingSnapshot.createMany({
        data: portfolio.holdings.map(h => ({
          snapshotId: snapshot.id,
          ticker: h.ticker,
          shares: h.shares,
          price: h.currentPrice,
          marketValue: h.currentValue,
          dayPL: h.dayChange,
          dayPLPercent: h.dayChangePercent,
          timestamp: snapshotTime,
        })),
      });
    }

    // Update in-memory timestamp
    lastSnapshotTime = snapshotTime.getTime();

    console.log(
      `[Snapshot] Created at ${snapshotTime.toISOString()} | ` +
      `totalAssets: $${portfolio.totalAssets.toFixed(2)} | ` +
      `cashBalance: $${portfolio.cashBalance.toFixed(2)} | ` +
      `totalPL: $${portfolio.totalPL.toFixed(2)} (${portfolio.totalPLPercent.toFixed(2)}%) | ` +
      `holdingSnapshots: ${portfolio.holdings.length}`
    );

    return snapshot;
  } finally {
    isCreatingSnapshot = false;
  }
}

export async function getAllSnapshots(): Promise<PortfolioSnapshot[]> {
  return prisma.portfolioSnapshot.findMany({
    where: { userId: '237198da-612e-411c-9ef8-f267c887a9f1' },
    orderBy: { timestamp: 'asc' },
  });
}

export async function getSnapshotsAfter(startDate: Date): Promise<PortfolioSnapshot[]> {
  return prisma.portfolioSnapshot.findMany({
    where: {
      userId: '237198da-612e-411c-9ef8-f267c887a9f1',
      timestamp: {
        gte: startDate,
      },
    },
    orderBy: { timestamp: 'asc' },
  });
}

export async function getRecentSnapshots(limit: number): Promise<PortfolioSnapshot[]> {
  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: { userId: '237198da-612e-411c-9ef8-f267c887a9f1' },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
  return snapshots.reverse();
}

export async function getLatestSnapshot(): Promise<PortfolioSnapshot | null> {
  return prisma.portfolioSnapshot.findFirst({
    where: { userId: '237198da-612e-411c-9ef8-f267c887a9f1' },
    orderBy: { timestamp: 'desc' },
  });
}

export async function getSnapshotCount(): Promise<number> {
  return prisma.portfolioSnapshot.count({ where: { userId: '237198da-612e-411c-9ef8-f267c887a9f1' } });
}

/**
 * Get the snapshot closest to AND at-or-before the target time.
 * Returns null if no snapshot exists before targetTime.
 */
export async function getBaselineSnapshot(targetTime: Date): Promise<PortfolioSnapshot | null> {
  return prisma.portfolioSnapshot.findFirst({
    where: {
      userId: '237198da-612e-411c-9ef8-f267c887a9f1',
      timestamp: { lte: targetTime },
    },
    orderBy: { timestamp: 'desc' },
  });
}

/**
 * Get the oldest snapshot (earliest timestamp) for the default user.
 */
export async function getOldestSnapshot(): Promise<PortfolioSnapshot | null> {
  return prisma.portfolioSnapshot.findFirst({
    where: { userId: '237198da-612e-411c-9ef8-f267c887a9f1' },
    orderBy: { timestamp: 'asc' },
  });
}

/**
 * Get per-holding snapshots for the last N distinct calendar days.
 * Returns rows ordered by timestamp ascending.
 */
export async function getRecentHoldingSnapshots(days: number = 5): Promise<{
  ticker: string;
  dayPL: number;
  dayPLPercent: number;
  timestamp: Date;
}[]> {
  // Get distinct snapshot days (by date, not time)
  const allSnapshots = await prisma.holdingSnapshot.findMany({
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
    distinct: ['snapshotId'],
  });

  // Extract unique calendar dates
  const seenDates = new Set<string>();
  const cutoffDates: string[] = [];
  for (const s of allSnapshots) {
    const dateStr = s.timestamp.toISOString().slice(0, 10);
    if (!seenDates.has(dateStr)) {
      seenDates.add(dateStr);
      cutoffDates.push(dateStr);
      if (cutoffDates.length >= days) break;
    }
  }

  if (cutoffDates.length === 0) return [];

  const oldestDate = new Date(cutoffDates[cutoffDates.length - 1]);

  return prisma.holdingSnapshot.findMany({
    where: { timestamp: { gte: oldestDate } },
    select: { ticker: true, dayPL: true, dayPLPercent: true, timestamp: true },
    orderBy: { timestamp: 'asc' },
  });
}

/**
 * Reconstruct historical portfolio value from current holdings + candle data.
 * Uses each holding's shares × historical close price, summed across all tickers.
 * cashBalance is added as a constant since we don't track cash history.
 */
export async function reconstructPortfolioHistory(
  holdings: { ticker: string; shares: number }[],
  cashBalance: number,
  periodDays: number,
  marginDebt: number = 0,
): Promise<{ time: number; value: number }[]> {
  if (holdings.length === 0) return [];

  // Fetch daily candles for holdings — Polygon primary, Yahoo fallback
  const fetchDailyForChart = async (ticker: string): Promise<{ dates: number[]; closes: number[] } | null> => {
    const cacheKey = `chart-candle:${ticker}`;
    const cached = chartCandleCache.get<{ dates: number[]; closes: number[] }>(cacheKey);
    if (cached) return cached;

    // Polygon.io primary
    const today = new Date().toISOString().split('T')[0];
    const fromDate = new Date(Date.now() - Math.max(365, periodDays + 30) * 86400000).toISOString().split('T')[0];
    const pg = await fetchPolygonAggs(ticker, 1, 'day', fromDate, today);
    if (pg && pg.closes.length > 0) {
      const data = { dates: pg.timestamps.map(t => t * 1000), closes: pg.closes };
      chartCandleCache.set(cacheKey, data);
      return data;
    }

    // Yahoo Finance fallback
    try {
      const now = Math.floor(Date.now() / 1000);
      const from = now - Math.max(365, periodDays + 30) * 24 * 60 * 60;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${from}&period2=${now}&interval=1d`;
      const resp = await yahooGet(url);
      const result = resp.data?.chart?.result?.[0];
      if (result?.timestamp && result?.indicators?.quote?.[0]) {
        const timestamps: number[] = result.timestamp;
        const q = result.indicators.quote[0];
        const dates: number[] = [];
        const closes: number[] = [];
        for (let i = 0; i < timestamps.length; i++) {
          if (q.close[i] != null) {
            dates.push(timestamps[i] * 1000);
            closes.push(q.close[i]);
          }
        }
        if (closes.length > 0) {
          const data = { dates, closes };
          chartCandleCache.set(cacheKey, data);
          return data;
        }
      }
    } catch {
      // Yahoo also failed
    }

    return null;
  };

  const candleResults = await Promise.all(holdings.map(h => fetchDailyForChart(h.ticker)));

  // Build a map: ticker -> { dates[], closes[] }
  const tickerCandles = new Map<string, { dates: number[]; closes: number[] }>();
  for (let i = 0; i < holdings.length; i++) {
    const candles = candleResults[i];
    if (!candles) continue;
    tickerCandles.set(holdings[i].ticker, candles);
  }

  if (tickerCandles.size === 0) return [];

  // Find all unique dates across all tickers, filtered to period
  const cutoffMs = Date.now() - periodDays * 24 * 60 * 60 * 1000;
  const allDatesSet = new Set<number>();
  for (const { dates } of tickerCandles.values()) {
    for (const d of dates) {
      if (d >= cutoffMs) allDatesSet.add(d);
    }
  }

  const allDates = Array.from(allDatesSet).sort((a, b) => a - b);
  if (allDates.length === 0) return [];

  // For each date, compute portfolio value
  // For each ticker, find the closest close price at or before that date
  const points: { time: number; value: number }[] = [];

  for (const dateMs of allDates) {
    let totalValue = cashBalance - marginDebt;
    let tickersWithPrice = 0;

    for (const holding of holdings) {
      const candles = tickerCandles.get(holding.ticker);
      if (!candles) continue; // Yahoo failed for this ticker entirely — skip

      // Binary search for closest date <= dateMs
      let lo = 0, hi = candles.dates.length - 1, bestIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (candles.dates[mid] <= dateMs) {
          bestIdx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      if (bestIdx >= 0) {
        totalValue += holding.shares * candles.closes[bestIdx];
        tickersWithPrice++;
      }
    }

    // Include point if all available tickers have price data at this date
    if (tickersWithPrice >= tickerCandles.size) {
      points.push({ time: dateMs, value: totalValue });
    }
  }

  return points;
}

/**
 * Reconstruct portfolio history using higher-resolution Yahoo candles.
 * For 1W: 15-min intervals. For 1M: 1-hour intervals.
 * This produces far more data points than daily candles, matching Robinhood's chart density.
 */
export async function reconstructPortfolioHistoryHiRes(
  holdings: { ticker: string; shares: number }[],
  cashBalance: number,
  marginDebt: number,
  yahooRange: string,   // e.g. '5d', '1mo'
  yahooInterval: string, // e.g. '15m', '1h'
): Promise<{ time: number; value: number }[]> {
  if (holdings.length === 0) return [];

  const fetchHiResForChart = async (ticker: string): Promise<{ dates: number[]; closes: number[] } | null> => {
    const cacheKey = `hires:${ticker}:${yahooRange}:${yahooInterval}`;
    const cached = hiresCache.get<{ dates: number[]; closes: number[] }>(cacheKey);
    if (cached) return cached;

    // Polygon.io primary — map Yahoo params to Polygon params
    const rangeDaysMap: Record<string, number> = { '1d': 2, '5d': 7, '1mo': 35, '3mo': 95, '6mo': 185 };
    const rangeDays = rangeDaysMap[yahooRange] || 35;
    const today = new Date().toISOString().split('T')[0];
    const fromDate = new Date(Date.now() - rangeDays * 86400000).toISOString().split('T')[0];

    // Map Yahoo intervals to Polygon multiplier+timespan
    let multiplier = 1;
    let timespan = 'hour';
    if (yahooInterval === '5m' || yahooInterval === '2m') { multiplier = 5; timespan = 'minute'; }
    else if (yahooInterval === '15m') { multiplier = 15; timespan = 'minute'; }
    else if (yahooInterval === '1h' || yahooInterval === '60m') { multiplier = 1; timespan = 'hour'; }
    else if (yahooInterval === '1d') { multiplier = 1; timespan = 'day'; }

    const pg = await fetchPolygonAggs(ticker, multiplier, timespan, fromDate, today, 300);
    if (pg && pg.closes.length > 0) {
      const data = { dates: pg.timestamps.map(t => t * 1000), closes: pg.closes };
      hiresCache.set(cacheKey, data);
      return data;
    }

    // Yahoo Finance fallback
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${yahooRange}&interval=${yahooInterval}&includePrePost=true`;
      const resp = await yahooGet(url);
      const result = resp.data?.chart?.result?.[0];
      if (result?.timestamp && result?.indicators?.quote?.[0]) {
        const timestamps: number[] = result.timestamp;
        const q = result.indicators.quote[0];
        const dates: number[] = [];
        const closes: number[] = [];
        for (let i = 0; i < timestamps.length; i++) {
          if (q.close[i] != null) {
            dates.push(timestamps[i] * 1000);
            closes.push(q.close[i]);
          }
        }
        if (closes.length > 0) {
          const data = { dates, closes };
          hiresCache.set(cacheKey, data);
          return data;
        }
      }
    } catch { /* Yahoo also failed */ }

    return null;
  };

  const candleResults = await Promise.all(holdings.map(h => fetchHiResForChart(h.ticker)));

  const tickerCandles = new Map<string, { dates: number[]; closes: number[] }>();
  for (let i = 0; i < holdings.length; i++) {
    const candles = candleResults[i];
    if (!candles) continue;
    tickerCandles.set(holdings[i].ticker, candles);
  }

  if (tickerCandles.size === 0) return [];

  // Collect all unique timestamps across all tickers
  const allDatesSet = new Set<number>();
  for (const { dates } of tickerCandles.values()) {
    for (const d of dates) allDatesSet.add(d);
  }

  const allDates = Array.from(allDatesSet).sort((a, b) => a - b);
  if (allDates.length === 0) return [];

  // Pre-compute first available price per ticker for forward-fill.
  // When a timestamp is BEFORE a ticker's first candle, use its earliest
  // known price so the holding isn't silently dropped from the total.
  const firstPrices = new Map<string, number>();
  for (const holding of holdings) {
    const candles = tickerCandles.get(holding.ticker);
    if (candles && candles.closes.length > 0) {
      firstPrices.set(holding.ticker, candles.closes[0]);
    }
  }

  const points: { time: number; value: number }[] = [];

  for (const dateMs of allDates) {
    let totalValue = cashBalance - marginDebt;
    let tickersWithPrice = 0;
    let tickersWithActualPrice = 0;

    for (const holding of holdings) {
      const candles = tickerCandles.get(holding.ticker);
      if (!candles) continue;

      // Binary search for closest date <= dateMs
      let lo = 0, hi = candles.dates.length - 1, bestIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (candles.dates[mid] <= dateMs) { bestIdx = mid; lo = mid + 1; }
        else { hi = mid - 1; }
      }

      if (bestIdx >= 0) {
        totalValue += holding.shares * candles.closes[bestIdx];
        tickersWithPrice++;
        tickersWithActualPrice++;
      } else {
        // Before this ticker's first data point — forward-fill with first available price
        const firstPrice = firstPrices.get(holding.ticker);
        if (firstPrice !== undefined) {
          totalValue += holding.shares * firstPrice;
          tickersWithPrice++;
        }
      }
    }

    // Include point if all tickers are accounted for (actual or forward-filled)
    // AND at least half have real data (avoids phantom early points)
    if (tickersWithPrice >= tickerCandles.size &&
        tickersWithActualPrice >= Math.ceil(tickerCandles.size * 0.5)) {
      points.push({ time: dateMs, value: totalValue });
    }
  }

  // Filter outlier points — if a point deviates more than 5% from its neighbors,
  // it's likely a bad after-hours quote. Replace with interpolated value.
  if (points.length >= 3) {
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1].value;
      const curr = points[i].value;
      const next = points[i + 1].value;
      const neighborAvg = (prev + next) / 2;
      if (neighborAvg > 0) {
        const deviation = Math.abs(curr - neighborAvg) / neighborAvg;
        if (deviation > 0.05) {
          points[i].value = neighborAvg;
        }
      }
    }
    // Check last point against its predecessor
    if (points.length >= 2) {
      const last = points[points.length - 1];
      const secondLast = points[points.length - 2];
      if (secondLast.value > 0) {
        const deviation = Math.abs(last.value - secondLast.value) / secondLast.value;
        if (deviation > 0.05) {
          points[points.length - 1].value = secondLast.value;
        }
      }
    }
  }

  return points;
}

// ---- User-specific snapshot functions ----

const userSnapshotLocks = new Map<string, number>(); // userId -> lastSnapshotTime

export async function createUserSnapshotIfNeeded(userId: string, totalAssets: number, cashBalance: number, dayChange: number, dayChangePercent: number, totalPL: number, totalPLPercent: number, netEquity: number): Promise<void> {
  const now = Date.now();
  const intervalMs = config.snapshotIntervalSeconds * 1000;

  const lastTime = userSnapshotLocks.get(userId) ?? 0;
  if (now - lastTime < intervalMs) return;

  // Check DB
  const latest = await prisma.portfolioSnapshot.findFirst({
    where: { userId },
    orderBy: { timestamp: 'desc' },
  });

  if (latest) {
    const timeSince = now - new Date(latest.timestamp).getTime();
    if (timeSince < intervalMs) {
      userSnapshotLocks.set(userId, new Date(latest.timestamp).getTime());
      return;
    }
  }

  if (totalAssets < 100) return;

  const snapshotTime = new Date();
  await prisma.portfolioSnapshot.create({
    data: {
      timestamp: snapshotTime,
      totalValue: totalAssets,
      cashBalance,
      dailyPL: dayChange,
      dailyPLPercent: dayChangePercent,
      totalPL,
      totalPLPercent,
      netEquity,
      userId,
    },
  });

  userSnapshotLocks.set(userId, snapshotTime.getTime());
}

export async function getUserChartSnapshots(userId: string, period: string): Promise<{
  points: { time: number; value: number }[];
  periodStartValue: number;
  period: string;
}> {
  const now = new Date();
  let startDate: Date;

  switch (period) {
    case '1D':
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      break;
    case '1W':
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 7);
      break;
    case '1M':
      startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 1);
      break;
    case '3M':
      startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 3);
      break;
    case 'YTD':
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    case '1Y':
      startDate = new Date(now);
      startDate.setFullYear(startDate.getFullYear() - 1);
      break;
    case 'ALL':
    default: {
      const oldest = await prisma.portfolioSnapshot.findFirst({
        where: { userId },
        orderBy: { timestamp: 'asc' },
      });
      startDate = oldest ? new Date(oldest.timestamp) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    }
  }

  // Baseline
  const baseline = await prisma.portfolioSnapshot.findFirst({
    where: { userId, timestamp: { lte: startDate } },
    orderBy: { timestamp: 'desc' },
  });
  const periodStartValue = baseline ? (baseline.netEquity ?? baseline.totalValue) : 0;

  // Snapshots in range
  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: { userId, timestamp: { gte: startDate } },
    orderBy: { timestamp: 'asc' },
  });

  let points = snapshots.map(s => ({
    time: new Date(s.timestamp).getTime(),
    value: s.netEquity ?? s.totalValue,
  }));

  if (baseline) {
    const baselineTime = new Date(baseline.timestamp).getTime();
    if (points.length === 0 || baselineTime < points[0].time) {
      points.unshift({ time: baselineTime, value: (baseline.netEquity ?? baseline.totalValue) });
    }
  }

  // Downsample
  if (points.length > 500) {
    const step = Math.ceil(points.length / 500);
    const downsampled = [points[0]];
    for (let i = step; i < points.length - 1; i += step) {
      downsampled.push(points[i]);
    }
    downsampled.push(points[points.length - 1]);
    points = downsampled;
  }

  return { points, periodStartValue, period };
}

/**
 * Reconstruct intraday portfolio values using Yahoo Finance 5-min candles.
 * Used to fill gaps in the 1D chart when no snapshots exist (e.g. PC was asleep).
 * Returns points for the gap period between gapStartMs and gapEndMs.
 */
export async function reconstructIntradayGap(
  holdings: { ticker: string; shares: number }[],
  cashBalance: number,
  marginDebt: number,
  gapStartMs: number,
  gapEndMs: number,
): Promise<{ time: number; value: number }[]> {
  if (holdings.length === 0) return [];

  const { fetchIntradayCandles } = await import('./market.service');

  // Fetch intraday candles for all holdings in parallel
  const results = await Promise.allSettled(
    holdings.map(h => fetchIntradayCandles(h.ticker))
  );

  // Build ticker -> candles map (time in ms -> close price)
  const tickerCandles = new Map<string, { timeMs: number; close: number }[]>();
  for (let i = 0; i < holdings.length; i++) {
    const result = results[i];
    if (result.status !== 'fulfilled' || !result.value.length) continue;
    tickerCandles.set(
      holdings[i].ticker,
      result.value.map(c => ({ timeMs: new Date(c.time).getTime(), close: c.close }))
    );
  }

  if (tickerCandles.size === 0) return [];

  // Collect all unique timestamps within the gap window from all tickers
  const allTimesSet = new Set<number>();
  for (const candles of tickerCandles.values()) {
    for (const c of candles) {
      if (c.timeMs > gapStartMs && c.timeMs < gapEndMs) {
        allTimesSet.add(c.timeMs);
      }
    }
  }

  const allTimes = Array.from(allTimesSet).sort((a, b) => a - b);
  if (allTimes.length === 0) return [];

  // For each timestamp, compute portfolio value
  const points: { time: number; value: number }[] = [];
  for (const t of allTimes) {
    let totalValue = cashBalance - marginDebt;
    let tickersFound = 0;

    for (const holding of holdings) {
      const candles = tickerCandles.get(holding.ticker);
      if (!candles || candles.length === 0) continue;

      // Find closest candle at or before time t
      let bestIdx = -1;
      for (let j = candles.length - 1; j >= 0; j--) {
        if (candles[j].timeMs <= t) { bestIdx = j; break; }
      }
      if (bestIdx >= 0) {
        totalValue += holding.shares * candles[bestIdx].close;
        tickersFound++;
      }
    }

    // Include point if all tickers with available candle data have a price here
    if (tickersFound >= tickerCandles.size && tickerCandles.size > 0) {
      points.push({ time: t, value: totalValue });
    }
  }

  return points;
}

/**
 * Get snapshots for chart display, filtered by period.
 * Returns points + periodStartValue for reference line.
 */
export async function getChartSnapshots(period: string): Promise<{
  points: { time: number; value: number }[];
  periodStartValue: number;
  period: string;
}> {
  const now = new Date();
  let startDate: Date;

  switch (period) {
    case '1D': {
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      break;
    }
    case '1W':
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 7);
      break;
    case '1M':
      startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 1);
      break;
    case '3M':
      startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 3);
      break;
    case 'YTD':
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    case '1Y':
      startDate = new Date(now);
      startDate.setFullYear(startDate.getFullYear() - 1);
      break;
    case 'ALL':
    default: {
      const oldest = await getOldestSnapshot();
      startDate = oldest ? new Date(oldest.timestamp) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    }
  }

  // Get baseline (snapshot at or before start)
  const baseline = await getBaselineSnapshot(startDate);
  const periodStartValue = baseline ? (baseline.netEquity ?? baseline.totalValue) : 0;

  // Get all snapshots in period
  const snapshots = await getSnapshotsAfter(startDate);

  let points = snapshots.map(s => ({
    time: new Date(s.timestamp).getTime(),
    value: s.netEquity ?? s.totalValue,
  }));

  // If baseline exists and is before our first point, prepend it
  if (baseline) {
    const baselineTime = new Date(baseline.timestamp).getTime();
    if (points.length === 0 || baselineTime < points[0].time) {
      points.unshift({ time: baselineTime, value: (baseline.netEquity ?? baseline.totalValue) });
    }
  }

  // Downsample if too many points (max ~500)
  if (points.length > 500) {
    const step = Math.ceil(points.length / 500);
    const downsampled = [points[0]];
    for (let i = step; i < points.length - 1; i += step) {
      downsampled.push(points[i]);
    }
    downsampled.push(points[points.length - 1]);
    points = downsampled;
  }

  return { points, periodStartValue, period };
}

// Utility to clean up duplicate snapshots (for fixing existing data)
export async function cleanupDuplicateSnapshots(): Promise<number> {
  // Get all snapshots
  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: { userId: '237198da-612e-411c-9ef8-f267c887a9f1' },
    orderBy: { timestamp: 'asc' },
  });

  if (snapshots.length === 0) return 0;

  const toDelete: string[] = [];
  let lastKeptTimestamp = 0;
  const intervalMs = config.snapshotIntervalSeconds * 1000;

  for (const snapshot of snapshots) {
    const snapshotTime = new Date(snapshot.timestamp).getTime();
    if (snapshotTime - lastKeptTimestamp < intervalMs) {
      // This snapshot is too close to the last kept one - mark for deletion
      toDelete.push(snapshot.id);
    } else {
      // Keep this snapshot
      lastKeptTimestamp = snapshotTime;
    }
  }

  if (toDelete.length > 0) {
    // Delete in batches to avoid SQLite "too many variables" error
    const batchSize = 500;
    let deletedCount = 0;

    for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = toDelete.slice(i, i + batchSize);
      await prisma.portfolioSnapshot.deleteMany({
        where: {
          id: { in: batch },
        },
      });
      deletedCount += batch.length;
      console.log(`[Snapshot Cleanup] Deleted batch ${Math.floor(i / batchSize) + 1}, total: ${deletedCount}/${toDelete.length}`);
    }

    console.log(`[Snapshot Cleanup] Completed - deleted ${toDelete.length} duplicate snapshots`);
  }

  return toDelete.length;
}
