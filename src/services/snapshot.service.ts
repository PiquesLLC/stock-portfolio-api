import prisma from '../utils/prisma';
import { PortfolioSnapshot } from '../types';
import { getPortfolio } from './portfolio.service';
import { config } from '../config';
import NodeCache from 'node-cache';
import { yahooGet, fetchPolygonAggs } from '../utils/yahoo-http';
import { replayDailyLedger } from './ledger/replay.service';
import { LEDGER_SETTLEMENT_POLICY, TRADE_SETTLEMENT_POLICY, isValidLedgerEventType } from './ledger/settlement-policy';
import { getMarketSession } from '../utils/market-hours';

const chartCandleCache = new NodeCache({ stdTTL: 86400 });
const hiresCache = new NodeCache({ stdTTL: 300 }); // 5-min cache for intraday/hourly candles

export type LedgerReplayGap = {
  start: string;
  end: string;
  reason: string;
};

export type LedgerConfidencePoint = {
  time: number;
  value: number;
  confidence: number;
  estimated: boolean;
};

export type LedgerReplayDiagnostics = {
  points: LedgerConfidencePoint[];
  gaps: LedgerReplayGap[];
  confidenceThreshold: number;
};

/** Bounded concurrency executor — limits parallel async operations (like p-limit) */
export async function limitConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIdx < tasks.length) {
      const i = nextIdx++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

// Per-user in-memory locks to prevent race conditions in snapshot creation
const lastSnapshotTimeByUser = new Map<string, number>();
const creatingSnapshotForUser = new Set<string>();

export async function recordCompositionChange(userId: string, reason?: string): Promise<void> {
  await prisma.portfolioCompositionChange.create({
    data: {
      userId,
      reason: reason || null,
    },
  });
}

export async function getLatestCompositionChangeAfter(userId: string, startDate: Date): Promise<Date | null> {
  const latest = await prisma.portfolioCompositionChange.findFirst({
    where: {
      userId,
      timestamp: { gte: startDate },
    },
    orderBy: { timestamp: 'desc' },
  });
  return latest?.timestamp ?? null;
}

export async function resetSnapshotsForCompositionChange(userId: string): Promise<void> {
  // Don't delete snapshots — the chart handler's composition change filter
  // already handles display cutoffs. Deleting snapshots destroys the 1D
  // chart's fallback data and causes it to disappear.
  // Just reset the timer so a new snapshot is created immediately for this user.
  lastSnapshotTimeByUser.delete(userId);
}

export async function createSnapshotIfNeeded(userId: string): Promise<PortfolioSnapshot | null> {
  const now = Date.now();
  const intervalMs = config.snapshotIntervalSeconds * 1000;

  // Fast path: check per-user in-memory timestamp first (avoids DB query in most cases)
  const lastTime = lastSnapshotTimeByUser.get(userId) ?? 0;
  if (now - lastTime < intervalMs) {
    return null;
  }

  // Prevent concurrent snapshot creation per-user
  if (creatingSnapshotForUser.has(userId)) {
    return null;
  }

  creatingSnapshotForUser.add(userId);

  try {
    // Double-check with database (in case server restarted)
    const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
      where: { userId },
      orderBy: { timestamp: 'desc' },
    });

    if (latestSnapshot) {
      const timeSinceLastSnapshot = now - new Date(latestSnapshot.timestamp).getTime();
      if (timeSinceLastSnapshot < intervalMs) {
        // Update per-user in-memory timestamp to avoid future DB queries
        lastSnapshotTimeByUser.set(userId, new Date(latestSnapshot.timestamp).getTime());
        return null;
      }
    }

    const portfolio = await getPortfolio(userId, { preferPolygon: true });

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

    // Skip if any holding with shares has a $0 price — clearly bad quote data
    const zeroPrice = portfolio.holdings.filter(h => h.shares > 0 && h.currentPrice <= 0);
    if (zeroPrice.length > 0) {
      console.log(
        `[Snapshot] Skipped - ${zeroPrice.length} holdings have $0 price: ${zeroPrice.map(h => h.ticker).join(', ')} (bad quote data)`
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

    // Skip if sudden large drop — likely bad data, not a real market move
    // A 25% drop in a single snapshot interval is almost impossible in normal markets
    if (latestSnapshot) {
      const prevValue = latestSnapshot.netEquity ?? latestSnapshot.totalValue;
      const dropPercent = ((prevValue - portfolio.totalAssets) / prevValue) * 100;
      if (dropPercent > 25) {
        console.log(
          `[Snapshot] Skipped - ${dropPercent.toFixed(1)}% sudden drop (prev: $${prevValue.toFixed(2)}, now: $${portfolio.totalAssets.toFixed(2)}) — likely bad data`
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
        userId,
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

    // Update per-user in-memory timestamp
    lastSnapshotTimeByUser.set(userId, snapshotTime.getTime());

    console.log(
      `[Snapshot] Created at ${snapshotTime.toISOString()} | ` +
      `totalAssets: $${portfolio.totalAssets.toFixed(2)} | ` +
      `cashBalance: $${portfolio.cashBalance.toFixed(2)} | ` +
      `totalPL: $${portfolio.totalPL.toFixed(2)} (${portfolio.totalPLPercent.toFixed(2)}%) | ` +
      `holdingSnapshots: ${portfolio.holdings.length}`
    );

    return snapshot;
  } finally {
    creatingSnapshotForUser.delete(userId);
  }
}

export async function getAllSnapshots(userId: string): Promise<PortfolioSnapshot[]> {
  return prisma.portfolioSnapshot.findMany({
    where: { userId },
    orderBy: { timestamp: 'asc' },
    take: 2000,
  });
}

export async function getSnapshotsAfter(userId: string, startDate: Date): Promise<PortfolioSnapshot[]> {
  return prisma.portfolioSnapshot.findMany({
    where: {
      userId,
      timestamp: {
        gte: startDate,
      },
    },
    orderBy: { timestamp: 'asc' },
    take: 2000,
  });
}

export async function getSnapshotChartPoints(
  userId: string,
  periodDays: number,
): Promise<{ time: number; value: number }[]> {
  const since = new Date(Date.now() - periodDays * 86400000);

  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: { userId, timestamp: { gte: since } },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, totalValue: true, netEquity: true },
  });

  console.log(`[SnapshotChart] userId=${userId.slice(0, 8)}, period=${periodDays}d, found=${snapshots.length} snapshots`);

  if (snapshots.length < 2) return [];

  // Convert to value points
  const allPoints: { time: number; value: number }[] = [];
  for (const s of snapshots) {
    const value = s.netEquity ?? s.totalValue;
    if (Number.isFinite(value) && value > 0) {
      allPoints.push({ time: s.timestamp.getTime(), value });
    }
  }

  if (allPoints.length < 2) return [];

  // Step 1: Deduplicate to 1 point per calendar day (last snapshot wins).
  // This reduces thousands of per-minute snapshots to a manageable set.
  const byDay = new Map<string, { time: number; value: number }>();
  for (const p of allPoints) {
    const day = new Date(p.time).toISOString().slice(0, 10);
    byDay.set(day, p);
  }
  const dailyPoints = Array.from(byDay.values()).sort((a, b) => a.time - b.time);

  if (dailyPoints.length < 2) return [];

  // Step 2: Remove outlier days caused by bad quotes (e.g. $28M spikes, $88K dips).
  // After daily dedup, each day is a single point. A day that differs from
  // BOTH its neighbors by >3× is clearly a data-provider glitch, not real
  // portfolio movement. Running outlier detection on daily points (not raw
  // minute-by-minute) avoids the problem of clustered bad data hiding in crowds.
  const points: { time: number; value: number }[] = [dailyPoints[0]];
  let removed = 0;
  for (let i = 1; i < dailyPoints.length - 1; i++) {
    const prev = dailyPoints[i - 1].value;
    const curr = dailyPoints[i].value;
    const next = dailyPoints[i + 1].value;
    const ratioPrev = curr / prev;
    const ratioNext = curr / next;
    // Outlier if >3× or <0.33× BOTH neighbors (1-day spike/drop)
    if ((ratioPrev > 3 || ratioPrev < 0.33) && (ratioNext > 3 || ratioNext < 0.33)) {
      removed++;
      continue;
    }
    points.push(dailyPoints[i]);
  }
  points.push(dailyPoints[dailyPoints.length - 1]);

  if (removed > 0) {
    console.log(`[SnapshotChart] Removed ${removed} outlier days`);
  }

  console.log(`[SnapshotChart] ${allPoints.length} raw → ${byDay.size} days → ${points.length} clean daily points (period=${periodDays}d)`);
  return points;
}

export async function getRecentSnapshots(userId: string, limit: number): Promise<PortfolioSnapshot[]> {
  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: { userId },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
  return snapshots.reverse();
}

export async function getLatestSnapshot(userId: string): Promise<PortfolioSnapshot | null> {
  return prisma.portfolioSnapshot.findFirst({
    where: { userId },
    orderBy: { timestamp: 'desc' },
  });
}

export async function getSnapshotCount(userId: string): Promise<number> {
  return prisma.portfolioSnapshot.count({ where: { userId } });
}

/**
 * Get the snapshot closest to AND at-or-before the target time.
 * Returns null if no snapshot exists before targetTime.
 */
export async function getBaselineSnapshot(userId: string, targetTime: Date): Promise<PortfolioSnapshot | null> {
  return prisma.portfolioSnapshot.findFirst({
    where: {
      userId,
      timestamp: { lte: targetTime },
    },
    orderBy: { timestamp: 'desc' },
  });
}

/**
 * Get the oldest snapshot (earliest timestamp) for a user.
 */
export async function getOldestSnapshot(userId: string): Promise<PortfolioSnapshot | null> {
  return prisma.portfolioSnapshot.findFirst({
    where: { userId },
    orderBy: { timestamp: 'asc' },
  });
}

/**
 * Get per-holding snapshots for the last N distinct calendar days.
 * Returns rows ordered by timestamp ascending.
 */
export async function getRecentHoldingSnapshots(userId: string, days: number = 5): Promise<{
  ticker: string;
  dayPL: number;
  dayPLPercent: number;
  timestamp: Date;
}[]> {
  // Get the N most recent distinct calendar dates for THIS user via raw SQL
  const recentDates = await prisma.$queryRaw<{ d: string }[]>`
    SELECT DISTINCT date(hs.timestamp / 1000, 'unixepoch') AS d
    FROM HoldingSnapshot hs
    INNER JOIN PortfolioSnapshot ps ON hs.snapshotId = ps.id
    WHERE ps.userId = ${userId}
    ORDER BY d DESC
    LIMIT ${days}
  `;

  if (recentDates.length === 0) return [];

  const oldestDate = new Date(recentDates[recentDates.length - 1].d);

  // Get user's snapshot IDs for the date range, then filter HoldingSnapshots
  const userSnapshots = await prisma.portfolioSnapshot.findMany({
    where: { userId, timestamp: { gte: oldestDate } },
    select: { id: true },
  });
  const snapshotIds = userSnapshots.map(s => s.id);
  if (snapshotIds.length === 0) return [];

  return prisma.holdingSnapshot.findMany({
    where: { snapshotId: { in: snapshotIds }, timestamp: { gte: oldestDate } },
    select: { ticker: true, dayPL: true, dayPLPercent: true, timestamp: true },
    orderBy: { timestamp: 'asc' },
    take: 5000,
  });
}

/**
 * Reconstruct historical portfolio value from current holdings + candle data.
 * Uses each holding's shares Ã— historical close price, summed across all tickers.
 * cashBalance is added as a constant since we don't track cash history.
 */
export async function reconstructPortfolioHistory(
  holdings: { ticker: string; shares: number }[],
  cashBalance: number,
  periodDays: number,
  marginDebt: number = 0,
): Promise<{ time: number; value: number }[]> {
  if (holdings.length === 0) return [];

  // Fetch daily candles for holdings â€” Polygon primary, Yahoo fallback
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

  const candleResults = await limitConcurrency(
    holdings.map(h => () => fetchDailyForChart(h.ticker)), 10
  );

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
      if (!candles) continue; // Yahoo failed for this ticker entirely â€” skip

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

    // Include point if enough tickers have price data at this date
    const minTickers = Math.max(1, Math.ceil(tickerCandles.size * 0.6));
    if (tickersWithPrice >= minTickers) {
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
  _minActualRatio: number = 0.5, // minimum fraction of tickers with real data
): Promise<{ time: number; value: number }[]> {
  if (holdings.length === 0) return [];

  const fetchHiResForChart = async (ticker: string): Promise<{ dates: number[]; closes: number[] } | null> => {
    const cacheKey = `hires:${ticker}:${yahooRange}:${yahooInterval}`;
    const cached = hiresCache.get<{ dates: number[]; closes: number[] }>(cacheKey);
    if (cached) return cached;

    // Polygon.io primary â€” map Yahoo params to Polygon params
    const rangeDaysMap: Record<string, number> = { '1d': 2, '5d': 7, '1mo': 30, '3mo': 95, '6mo': 185 };
    const rangeDays = rangeDaysMap[yahooRange] || 30;
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

  const candleResults = await limitConcurrency(
    holdings.map(h => () => fetchHiResForChart(h.ticker)), 10
  );

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
        // Before this ticker's first data point â€” forward-fill with first available price
        const firstPrice = firstPrices.get(holding.ticker);
        if (firstPrice !== undefined) {
          totalValue += holding.shares * firstPrice;
          tickersWithPrice++;
        }
      }
    }

    // Include point if enough tickers have price data.
    // For large portfolios, some tickers may lack data at certain timestamps
    // (different trading hours, international stocks, etc.)
    const minTickers = Math.max(1, Math.ceil(tickerCandles.size * 0.6));
    if (tickersWithActualPrice >= minTickers && tickersWithPrice >= minTickers) {
      points.push({ time: dateMs, value: totalValue });
    }
  }

  // Filter outlier points â€” if a point deviates more than 5% from its neighbors,
  // it's likely a bad after-hours quote. Replace with interpolated value.
  if (points.length >= 3) {
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1].value;
      const curr = points[i].value;
      const next = points[i + 1].value;
      const neighborAvg = (prev + next) / 2;
      if (neighborAvg > 0) {
        const deviation = Math.abs(curr - neighborAvg) / neighborAvg;
        if (deviation > 0.25) {
          points[i].value = neighborAvg;
        }
      }
    }
    // Never smooth the last point — it should always show the real current value.
  }

  // Gap-fill: when consecutive points are more than 1.5× the expected interval
  // apart, linearly interpolate to keep the chart smooth and continuous.
  const expectedMs = parseIntervalMs(yahooInterval);
  if (expectedMs > 0 && points.length >= 2) {
    const filled: { time: number; value: number }[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const gap = points[i].time - points[i - 1].time;
      if (gap > expectedMs * 1.5) {
        const steps = Math.round(gap / expectedMs);
        for (let s = 1; s < steps; s++) {
          const t = points[i - 1].time + s * expectedMs;
          const frac = s / steps;
          const v = points[i - 1].value + frac * (points[i].value - points[i - 1].value);
          filled.push({ time: Math.round(t), value: v });
        }
      }
      filled.push(points[i]);
    }
    return filled;
  }

  return points;
}

/** Parse interval string like '5m', '15m', '1h', '1d' to milliseconds */
function parseIntervalMs(interval: string): number {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default: return 0;
  }
}

// ---- User-specific snapshot functions ----

const userSnapshotLocks = new Map<string, number>(); // userId -> lastSnapshotTime
const userSnapshotMutex = new Set<string>(); // per-user creation mutex

export async function createUserSnapshotIfNeeded(
  userId: string,
  totalAssets: number,
  cashBalance: number,
  dayChange: number,
  dayChangePercent: number,
  totalPL: number,
  totalPLPercent: number,
  netEquity: number,
  options?: { force?: boolean },
): Promise<boolean> {
  // Per-user mutex: prevent concurrent creation from refresh job + request handler
  if (userSnapshotMutex.has(userId)) return false;
  userSnapshotMutex.add(userId);

  try {
    const now = Date.now();
    const intervalMs = config.snapshotIntervalSeconds * 1000;
    const force = options?.force ?? false;

    if (!force) {
      const lastTime = userSnapshotLocks.get(userId) ?? 0;
      if (now - lastTime < intervalMs) return false;

      // Check DB
      const latest = await prisma.portfolioSnapshot.findFirst({
        where: { userId },
        orderBy: { timestamp: 'desc' },
      });

      if (latest) {
        const timeSince = now - new Date(latest.timestamp).getTime();
        if (timeSince < intervalMs) {
          userSnapshotLocks.set(userId, new Date(latest.timestamp).getTime());
          return false;
        }
      }
    }

    if (totalAssets < 100) return false;

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
    return true;
  } finally {
    userSnapshotMutex.delete(userId);
  }
}

let isRefreshingLeaderboard = false;

/**
 * Refresh snapshots for all leaderboard-eligible users using live market data.
 * Called every 3 hours to keep the leaderboard accurate and up-to-date.
 *
 * Optimizations (per Codex review):
 * - Single shared quote fetch for all unique tickers (saves API quota)
 * - Uses Polygon-preferred path for background job
 * - Mutex to prevent concurrent runs
 * - force: true bypasses interval gating
 * - Returns accurate created counts
 */
export async function refreshLeaderboardSnapshots(): Promise<{ refreshed: number; skipped: number; errors: number }> {
  if (isRefreshingLeaderboard) {
    console.log('[Leaderboard Refresh] Already running, skipping');
    return { refreshed: 0, skipped: 0, errors: 0 };
  }

  isRefreshingLeaderboard = true;

  try {
    const DEFAULT_USER_ID = '515d3ef4-2b46-4133-8c08-84327b420eba';

    const users = await prisma.user.findMany({
      where: {
        leaderboardEligible: true,
        id: { not: DEFAULT_USER_ID },
      },
      select: { id: true, displayName: true },
    });

    if (users.length === 0) return { refreshed: 0, skipped: 0, errors: 0 };

    // Gather all holdings for all leaderboard users in one query
    const allHoldings = await prisma.holding.findMany({
      where: { userId: { in: users.map(u => u.id) } },
      select: { userId: true, ticker: true, shares: true, averageCost: true },
    });

    // Collect unique tickers across all users (normalize to uppercase)
    const uniqueTickers = Array.from(new Set(allHoldings.map(h => h.ticker.toUpperCase())));
    if (uniqueTickers.length === 0) return { refreshed: 0, skipped: 0, errors: 0 };

    // Single shared quote fetch — Polygon-preferred to save Finnhub quota
    const { fetchPrices } = await import('./market.service');
    const quotesResult = await fetchPrices(uniqueTickers, { preferPolygon: true });
    const quotes = quotesResult.quotes;

    // Fetch all user settings in one query
    const allSettings = await prisma.userSettings.findMany({
      where: { userId: { in: users.map(u => u.id) } },
      select: { userId: true, cashBalance: true, marginDebt: true },
    });
    const settingsMap = new Map(allSettings.map(s => [s.userId, s]));

    // Pre-group holdings by userId for O(1) lookup (avoids O(users*holdings) filter)
    const holdingsByUser = new Map<string, typeof allHoldings>();
    for (const h of allHoldings) {
      if (!h.userId) continue;
      const list = holdingsByUser.get(h.userId);
      if (list) list.push(h);
      else holdingsByUser.set(h.userId, [h]);
    }

    let refreshed = 0;
    let skipped = 0;
    let errors = 0;

    for (const user of users) {
      try {
        const userHoldings = holdingsByUser.get(user.id) ?? [];
        if (userHoldings.length === 0) { skipped++; continue; }

        const settings = settingsMap.get(user.id);
        const cashBalance = settings?.cashBalance ?? 0;
        const marginDebt = settings?.marginDebt ?? 0;

        // Compute portfolio values from shared quotes
        // totalCost always includes all holdings (matches getUserPortfolio semantics)
        let holdingsValue = 0;
        let totalCost = 0;
        let dayChange = 0;
        let validCount = 0;

        for (const h of userHoldings) {
          const ticker = h.ticker.toUpperCase();

          const quote = quotes.get(ticker);
          const price = (quote?.extendedPrice && quote.extendedPrice > 0)
            ? quote.extendedPrice
            : (quote?.currentPrice ?? 0);
          if (price <= 0) continue;

          totalCost += h.shares * h.averageCost; // only count if price is valid
          const previousClose = quote?.previousClose ?? price;
          const value = h.shares * price;
          const prevValue = h.shares * previousClose;

          holdingsValue += value;
          dayChange += value - prevValue;
          validCount++;
        }

        if (validCount === 0) { skipped++; continue; }

        const totalAssets = holdingsValue + cashBalance;
        const netEquity = totalAssets - marginDebt;
        const totalPL = holdingsValue - totalCost;
        const totalPLPercent = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;
        const previousHoldingsValue = holdingsValue - dayChange;
        const dayChangePercent = previousHoldingsValue > 0 ? (dayChange / previousHoldingsValue) * 100 : 0;

        const created = await createUserSnapshotIfNeeded(
          user.id, totalAssets, cashBalance,
          dayChange, dayChangePercent,
          totalPL, totalPLPercent, netEquity,
          { force: true },
        );

        if (created) refreshed++;
        else skipped++;
      } catch (err) {
        errors++;
        console.error(`[Leaderboard Refresh] Error for ${user.displayName ?? user.id}:`, (err as Error).message);
      }
    }

    console.log(`[Leaderboard Refresh] Done: ${refreshed} refreshed, ${skipped} skipped, ${errors} errors`);
    return { refreshed, skipped, errors };
  } finally {
    isRefreshingLeaderboard = false;
  }
}

// ----------------------------------------------------------------------------
// Demo user snapshot backfill (leaderboard/profile cards)
// ----------------------------------------------------------------------------

function randomNormal(mean: number, stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + stdDev * z;
}

export async function backfillDemoUserSnapshots(days: number = 90, minSnapshots: number = 5): Promise<void> {
  const DEFAULT_USER_ID = '515d3ef4-2b46-4133-8c08-84327b420eba';

  const users = await prisma.user.findMany({
    where: {
      leaderboardEligible: true,
      id: { not: DEFAULT_USER_ID },
    },
    select: { id: true, displayName: true },
  });

  if (users.length === 0) return;

  let backfilledUsers = 0;
  let skippedUsers = 0;

  for (const user of users) {
    const snapshotCount = await prisma.portfolioSnapshot.count({ where: { userId: user.id } });
    if (snapshotCount >= minSnapshots) {
      skippedUsers++;
      continue;
    }

    const [holdings, settings] = await Promise.all([
      prisma.holding.findMany({
        where: { userId: user.id },
        select: { shares: true, averageCost: true },
      }),
      prisma.userSettings.findUnique({ where: { userId: user.id } }),
    ]);

    if (holdings.length === 0) {
      skippedUsers++;
      continue;
    }

    const cashBalance = settings?.cashBalance ?? 0;
    const marginDebt = settings?.marginDebt ?? 0;

    const holdingsValue = holdings.reduce((sum, h) => sum + (h.shares * h.averageCost), 0);
    const initialAssets = holdingsValue + cashBalance;
    if (initialAssets <= 0) {
      skippedUsers++;
      continue;
    }

    // Random walk parameters per user for variety
    const userDrift = 0.0003 + (Math.random() - 0.5) * 0.001;
    const userVol = 0.012 + Math.random() * 0.008;

    let currentValue = initialAssets;
    const now = new Date();

    for (let day = days - 1; day >= 0; day--) {
      const snapshotDate = new Date(now);
      snapshotDate.setDate(snapshotDate.getDate() - day);
      snapshotDate.setHours(16, 0, 0, 0);

      // Skip weekends
      const dow = snapshotDate.getDay();
      if (dow === 0 || dow === 6) continue;

      const dailyReturn = randomNormal(userDrift, userVol);
      const prevValue = currentValue;
      currentValue = currentValue * (1 + dailyReturn);

      const dailyPL = currentValue - prevValue;
      const dailyPLPercent = prevValue > 0 ? (dailyPL / prevValue) * 100 : 0;

      const totalPL = currentValue - initialAssets;
      const totalPLPercent = initialAssets > 0 ? (totalPL / initialAssets) * 100 : 0;

      const snapshotTotalValue = Math.round(currentValue * 100) / 100;
      const snapshotNetEquity = Math.round((currentValue - marginDebt) * 100) / 100;

      await prisma.portfolioSnapshot.create({
        data: {
          timestamp: snapshotDate,
          totalValue: snapshotTotalValue,
          cashBalance,
          dailyPL: Math.round(dailyPL * 100) / 100,
          dailyPLPercent: Math.round(dailyPLPercent * 100) / 100,
          totalPL: Math.round(totalPL * 100) / 100,
          totalPLPercent: Math.round(totalPLPercent * 100) / 100,
          netEquity: snapshotNetEquity,
          userId: user.id,
        },
      });
    }

    backfilledUsers++;
    console.log(`[Demo Snapshots] Backfilled ${user.displayName ?? user.id}`);
  }

  console.log(`[Demo Snapshots] Done: ${backfilledUsers} backfilled, ${skippedUsers} skipped`);
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
    case '6M':
      startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 6);
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

  // Baseline: latest snapshot at or before startDate
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
export async function getChartSnapshots(userId: string, period: string): Promise<{
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
    case '6M':
      startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 6);
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
      const oldest = await getOldestSnapshot(userId);
      startDate = oldest ? new Date(oldest.timestamp) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    }
  }

  // Get baseline (snapshot at or before start)
  const baseline = await getBaselineSnapshot(userId, startDate);
  const periodStartValue = baseline ? (baseline.netEquity ?? baseline.totalValue) : 0;

  // Get all snapshots in period
  const snapshots = await getSnapshotsAfter(userId, startDate);

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
export async function cleanupDuplicateSnapshots(scopeUserId?: string): Promise<number> {
  const toDelete: string[] = [];
  const fetchBatchSize = 1000;
  // Per-user last-kept timestamp to prevent cross-user snapshot deletion
  const lastKeptByUser = new Map<string, number>();
  const intervalMs = config.snapshotIntervalSeconds * 1000;
  let cursor: { timestamp: Date; id: string } | null = null;

  for (;;) {
    const where: any = {
      ...(scopeUserId ? { userId: scopeUserId } : { userId: { not: undefined } }),
      ...(cursor
        ? {
            OR: [
              { timestamp: { gt: cursor.timestamp } },
              { timestamp: cursor.timestamp, id: { gt: cursor.id } },
            ],
          }
        : {}),
    };
    const snapshots = await prisma.portfolioSnapshot.findMany({
      where,
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      take: fetchBatchSize,
    });

    if (snapshots.length === 0) break;

    for (const snapshot of snapshots) {
      const snapshotTime = new Date(snapshot.timestamp).getTime();
      const userKey = snapshot.userId ?? '__null__';
      const lastKept = lastKeptByUser.get(userKey) ?? 0;
      if (snapshotTime - lastKept < intervalMs) {
        // This snapshot is too close to the last kept one for THIS user
        toDelete.push(snapshot.id);
      } else {
        // Keep this snapshot
        lastKeptByUser.set(userKey, snapshotTime);
      }
    }

    const last = snapshots[snapshots.length - 1];
    cursor = { timestamp: new Date(last.timestamp), id: last.id };
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

/**
 * Reconstruct historical portfolio value using trade history.
 * Instead of projecting current holdings backward, this replays actual trades
 * to compute what was held at each point in time, producing accurate historical charts.
 * Uses daily candles (Polygon primary, Yahoo fallback).
 */
export async function reconstructPortfolioHistoryFromTrades(
  tradeHistory: { date: Date; ticker: string; type: string; shares: number; price: number }[],
  cashBalance: number,
  periodDays: number,
  marginDebt: number = 0,
  cashWeight: number = 0.7,
): Promise<{ time: number; value: number }[]> {
  if (tradeHistory.length === 0) return [];

  // Sort trades chronologically
  const trades = [...tradeHistory].sort((a, b) => a.date.getTime() - b.date.getTime());

  // Only fetch candles for tickers that were held during the chart period.
  // Two groups: (1) tickers held going INTO the period, (2) tickers traded DURING the period.
  const cutoffMs = Date.now() - periodDays * 24 * 60 * 60 * 1000;
  const allTickers = new Set<string>();

  // Group 1: tickers held at the start of the chart window
  const sharesAtCutoff = new Map<string, number>();
  for (const t of trades) {
    if (t.date.getTime() > cutoffMs) break;
    const cur = sharesAtCutoff.get(t.ticker) || 0;
    if (t.type === 'buy' || t.type === 'transfer' || t.type === 'merger') {
      sharesAtCutoff.set(t.ticker, cur + t.shares);
    } else if (t.type === 'sell' || t.type === 'cancel') {
      sharesAtCutoff.set(t.ticker, Math.max(0, cur - t.shares));
    } else if (t.type === 'split' && cur > 0) {
      sharesAtCutoff.set(t.ticker, cur + t.shares);
    }
  }
  for (const [ticker, shares] of sharesAtCutoff) {
    if (shares > 0.001) allTickers.add(ticker);
  }

  // Group 2: any ticker involved in a trade during the chart window
  for (const t of trades) {
    if (t.date.getTime() >= cutoffMs) allTickers.add(t.ticker);
  }

  console.log(`[Chart-Trades] Need candles for ${allTickers.size} tickers (of ${new Set(trades.map(t => t.ticker)).size} total)`);

  // Fetch daily candles for relevant tickers
  const fetchDailyForChart = async (ticker: string): Promise<{ dates: number[]; closes: number[] } | null> => {
    const cacheKey = `chart-candle:${ticker}`;
    const cached = chartCandleCache.get<{ dates: number[]; closes: number[] }>(cacheKey);
    if (cached) return cached;

    const today = new Date().toISOString().split('T')[0];
    const fromDate = new Date(Date.now() - Math.max(365, periodDays + 30) * 86400000).toISOString().split('T')[0];
    const pg = await fetchPolygonAggs(ticker, 1, 'day', fromDate, today);
    if (pg && pg.closes.length > 0) {
      const data = { dates: pg.timestamps.map(t => t * 1000), closes: pg.closes };
      chartCandleCache.set(cacheKey, data);
      return data;
    }

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
    } catch { /* Yahoo also failed */ }

    return null;
  };

  const tickerArr = Array.from(allTickers);
  const candleResults = await limitConcurrency(
    tickerArr.map(t => () => fetchDailyForChart(t)), 10
  );

  const tickerCandles = new Map<string, { dates: number[]; closes: number[] }>();
  for (let i = 0; i < tickerArr.length; i++) {
    if (candleResults[i]) tickerCandles.set(tickerArr[i], candleResults[i]!);
  }

  if (tickerCandles.size === 0) return [];

  // Collect all unique chart dates within the period (reuse cutoffMs from above)
  const allDatesSet = new Set<number>();
  for (const { dates } of tickerCandles.values()) {
    for (const d of dates) {
      if (d >= cutoffMs) allDatesSet.add(d);
    }
  }
  const allDates = Array.from(allDatesSet).sort((a, b) => a - b);
  if (allDates.length === 0) return [];

  // Pre-compute portfolio snapshots at each trade boundary.
  // Walk through trades chronologically building a running portfolio state.
  // Store as sorted array of { dateMs, portfolio: Map<ticker, shares> }
  const portfolioTimeline: { dateMs: number; portfolio: Map<string, number> }[] = [];
  const runningPortfolio = new Map<string, number>();

  // Initial state: empty portfolio before first trade
  portfolioTimeline.push({ dateMs: 0, portfolio: new Map() });

  for (const trade of trades) {
    const dateMs = trade.date.getTime();
    const current = runningPortfolio.get(trade.ticker) || 0;

    if (trade.type === 'buy' || trade.type === 'transfer' || trade.type === 'merger') {
      runningPortfolio.set(trade.ticker, current + trade.shares);
    } else if (trade.type === 'sell' || trade.type === 'cancel') {
      const remaining = current - trade.shares;
      if (remaining <= 0.001) {
        runningPortfolio.delete(trade.ticker);
      } else {
        runningPortfolio.set(trade.ticker, remaining);
      }
    } else if (trade.type === 'split') {
      if (current > 0) {
        runningPortfolio.set(trade.ticker, current + trade.shares);
      }
    }

    portfolioTimeline.push({ dateMs, portfolio: new Map(runningPortfolio) });
  }

  // Helper: find the portfolio state at a given timestamp (binary search)
  function getPortfolioAt(dateMs: number): Map<string, number> {
    let lo = 0, hi = portfolioTimeline.length - 1, bestIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (portfolioTimeline[mid].dateMs <= dateMs) {
        bestIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return portfolioTimeline[bestIdx].portfolio;
  }

  // Helper: get price at a date for a ticker via binary search
  function getPriceAt(ticker: string, dateMs: number): number | null {
    const candles = tickerCandles.get(ticker);
    if (!candles) return null;
    let lo = 0, hi = candles.dates.length - 1, bestIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles.dates[mid] <= dateMs) { bestIdx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return bestIdx >= 0 ? candles.closes[bestIdx] : null;
  }

  // Pre-compute first available price per ticker for forward-fill.
  // When a timestamp is before a ticker's first candle, use its earliest
  // known price so the holding isn't silently dropped from the total.
  const firstPrices = new Map<string, number>();
  for (const [ticker, candles] of tickerCandles) {
    if (candles.closes.length > 0) {
      firstPrices.set(ticker, candles.closes[0]);
    }
  }

  // Pre-compute average trade price per ticker for value-weighted coverage fallback.
  // Used to estimate the value of tickers missing candle data entirely.
  const tickerAvgPrices = new Map<string, number>();
  const tickerPriceSums = new Map<string, { totalCost: number; totalShares: number }>();
  for (const t of trades) {
    if (t.price > 0 && (t.type === 'buy' || t.type === 'sell')) {
      const acc = tickerPriceSums.get(t.ticker) || { totalCost: 0, totalShares: 0 };
      acc.totalCost += t.shares * t.price;
      acc.totalShares += t.shares;
      tickerPriceSums.set(t.ticker, acc);
    }
  }
  for (const [ticker, acc] of tickerPriceSums) {
    if (acc.totalShares > 0) tickerAvgPrices.set(ticker, acc.totalCost / acc.totalShares);
  }

  // ── Weighted cash reconstruction ──
  // Without deposit/withdrawal data, we estimate historical cash from buy/sell trades.
  // Full reconstruction overestimates starting cash (counts bank deposits as existing cash).
  // Constant cash underestimates (ignores that user had more cash before buying).
  // cashWeight blends: 1.0 = full reconstruction, 0.0 = constant, 0.7 = recommended default.
  // 0.7 accounts for ~30% of net purchases typically coming from external deposits.
  const periodTrades = trades.filter(t => t.date.getTime() >= cutoffMs);
  let periodBuyCost = 0;
  let periodSellProceeds = 0;
  for (const t of periodTrades) {
    if (t.type === 'buy') {
      periodBuyCost += t.shares * t.price;
    } else if (t.type === 'sell' || t.type === 'cancel') {
      periodSellProceeds += t.shares * t.price;
    }
  }

  // Build full cash timeline (100% reconstruction), then blend at lookup time
  const fullCashAtStart = cashBalance + periodBuyCost - periodSellProceeds;
  const cashTimeline: { dateMs: number; cash: number }[] = [];
  let runningCash = fullCashAtStart;
  cashTimeline.push({ dateMs: 0, cash: fullCashAtStart });
  for (const t of periodTrades) {
    if (t.type === 'buy') {
      runningCash -= t.shares * t.price;
    } else if (t.type === 'sell' || t.type === 'cancel') {
      runningCash += t.shares * t.price;
    }
    cashTimeline.push({ dateMs: t.date.getTime(), cash: runningCash });
  }

  function getCashAt(dateMs: number): number {
    // Get fully reconstructed cash at this date
    let lo = 0, hi = cashTimeline.length - 1, bestIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cashTimeline[mid].dateMs <= dateMs) { bestIdx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    const fullCash = cashTimeline[bestIdx].cash;
    // Blend between constant (cashBalance) and fully reconstructed
    return cashBalance + cashWeight * (fullCash - cashBalance);
  }

  const adjustedCashAtStart = cashBalance + cashWeight * (fullCashAtStart - cashBalance);
  console.log(`[Chart-Trades] Cash: current=${cashBalance.toFixed(0)}, fullStart=${fullCashAtStart.toFixed(0)}, adjustedStart=${adjustedCashAtStart.toFixed(0)} (weight=${cashWeight}), buys=${periodBuyCost.toFixed(0)}, sells=${periodSellProceeds.toFixed(0)}`);

  // Compute portfolio value at each chart date
  const points: { time: number; value: number }[] = [];
  for (const dateMs of allDates) {
    const portfolio = getPortfolioAt(dateMs);
    if (portfolio.size === 0) continue; // No holdings yet at this date

    let totalValue = getCashAt(dateMs) - marginDebt;
    let coveredValue = 0;
    let missingValue = 0;

    for (const [ticker, shares] of portfolio) {
      const price = getPriceAt(ticker, dateMs);
      if (price != null) {
        const val = shares * price;
        totalValue += val;
        coveredValue += val;
      } else {
        // Forward-fill: use first available price if candle data hasn't started yet
        const firstPrice = firstPrices.get(ticker);
        if (firstPrice !== undefined) {
          const val = shares * firstPrice;
          totalValue += val;
          coveredValue += val;
        } else {
          // No candle data at all — estimate value from avg trade price
          const avgPrice = tickerAvgPrices.get(ticker) || 0;
          missingValue += shares * avgPrice;
        }
      }
    }

    // Value-weighted coverage: require 80% of portfolio VALUE to have price data.
    // This prevents small-cap gaps from blocking the chart while ensuring large
    // holdings with missing data cause appropriate point exclusion.
    const estimatedTotal = coveredValue + missingValue;
    if (estimatedTotal > 0 && coveredValue / estimatedTotal >= 0.8) {
      points.push({ time: dateMs, value: totalValue });
    }
  }

  // Trim leading outlier points that have artificially low values due to data gaps.
  // After holidays or period boundaries, the first 1-2 candle dates may lack coverage
  // for some tickers (missing data passes the 80% threshold but causes a visible dip).
  // If the first point is >2% lower than the median of the next 3-5 points, drop it.
  while (points.length > 5) {
    const windowEnd = Math.min(5, points.length - 1);
    const windowValues = points.slice(1, windowEnd + 1).map(p => p.value).sort((a, b) => a - b);
    const median = windowValues[Math.floor(windowValues.length / 2)];
    if (points[0].value < median * 0.98) {
      points.shift();
    } else {
      break;
    }
  }

  return points;
}

/**
 * Reconstruct historical portfolio value from ledger replay snapshots.
 * Uses replayed daily positions/cash/margin and overlays daily market prices
 * to produce market-value equity points.
 */
export async function reconstructPortfolioHistoryFromLedgerWithDiagnostics(
  userId: string,
  periodDays: number,
): Promise<LedgerReplayDiagnostics> {
  const endDate = new Date();
  const startDate = new Date(Date.now() - periodDays * 86400000);
  const snapshots = await replayDailyLedger(userId, startDate, endDate);
  const confidenceThreshold = 80;
  if (snapshots.length === 0) return { points: [], gaps: [], confidenceThreshold };

  const allTickers = new Set<string>();
  for (const snap of snapshots) {
    for (const [ticker, pos] of snap.positions) {
      if (pos.shares > 0.000001) allTickers.add(ticker);
    }
  }

  if (allTickers.size === 0) {
    return {
      points: snapshots.map(s => ({ time: s.date.getTime(), value: s.cash - s.margin, confidence: 100, estimated: false })),
      gaps: [],
      confidenceThreshold,
    };
  }

  const fetchDailyForChart = async (ticker: string): Promise<{ dates: number[]; closes: number[] } | null> => {
    const cacheKey = `chart-candle:${ticker}`;
    const cached = chartCandleCache.get<{ dates: number[]; closes: number[] }>(cacheKey);
    if (cached) return cached;

    const today = new Date().toISOString().split('T')[0];
    const fromDate = new Date(startDate.getTime() - 30 * 86400000).toISOString().split('T')[0];
    const pg = await fetchPolygonAggs(ticker, 1, 'day', fromDate, today);
    if (pg && pg.closes.length > 0) {
      const data = { dates: pg.timestamps.map(t => t * 1000), closes: pg.closes };
      chartCandleCache.set(cacheKey, data);
      return data;
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      const from = Math.floor((startDate.getTime() - 30 * 86400000) / 1000);
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
      // fallback failed
    }

    return null;
  };

  const tickerArr = Array.from(allTickers);
  const candleResults = await limitConcurrency(
    tickerArr.map(t => () => fetchDailyForChart(t)),
    10,
  );
  const tickerCandles = new Map<string, { dates: number[]; closes: number[] }>();
  for (let i = 0; i < tickerArr.length; i++) {
    if (candleResults[i]) tickerCandles.set(tickerArr[i], candleResults[i]!);
  }
  if (tickerCandles.size === 0) {
    return {
      points: snapshots.map(s => ({ time: s.date.getTime(), value: s.equity, confidence: 10, estimated: true })),
      gaps: [{ start: startDate.toISOString(), end: endDate.toISOString(), reason: 'Missing price data for all holdings' }],
      confidenceThreshold,
    };
  }

  function getPriceAt(ticker: string, dateMs: number): number | null {
    const candles = tickerCandles.get(ticker);
    if (!candles) return null;
    let lo = 0, hi = candles.dates.length - 1, bestIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles.dates[mid] <= dateMs) { bestIdx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return bestIdx >= 0 ? candles.closes[bestIdx] : null;
  }

  const toUtcDayKey = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };

  const addUtcDays = (date: Date, days: number): Date => new Date(date.getTime() + days * 86400000);

  const [tradesInRange, ledgerEventsInRange] = await Promise.all([
    prisma.portfolioTrade.findMany({
      where: { userId, date: { gte: startDate, lte: endDate } },
      select: { date: true, type: true, ticker: true },
    }),
    prisma.ledgerEvent.findMany({
      where: { userId, effectiveDate: { gte: startDate, lte: endDate } },
      select: { eventType: true, effectiveDate: true, settleDate: true, ticker: true, amount: true },
    }),
  ]);

  const cashEventDays = new Set<string>();
  const corporateTickersByDay = new Map<string, Set<string>>();
  const addCorporateTicker = (dayKey: string, ticker: string | null) => {
    if (!ticker) return;
    if (!corporateTickersByDay.has(dayKey)) corporateTickersByDay.set(dayKey, new Set());
    corporateTickersByDay.get(dayKey)!.add(ticker);
  };

  for (const trade of tradesInRange) {
    const tradeType = String(trade.type).toLowerCase() as keyof typeof TRADE_SETTLEMENT_POLICY;
    if (!(tradeType in TRADE_SETTLEMENT_POLICY)) continue;
    const policy = TRADE_SETTLEMENT_POLICY[tradeType];
    if (policy.cashPosting !== 'none') {
      const settleDate = addUtcDays(new Date(Date.UTC(
        trade.date.getUTCFullYear(),
        trade.date.getUTCMonth(),
        trade.date.getUTCDate(),
        0, 0, 0, 0,
      )), 1);
      const cashAt = policy.cashPosting === 'settleDate' ? settleDate : trade.date;
      cashEventDays.add(toUtcDayKey(cashAt.getTime()));
    }
    if (tradeType === 'split' || tradeType === 'transfer' || tradeType === 'merger' || tradeType === 'cancel') {
      addCorporateTicker(toUtcDayKey(trade.date.getTime()), trade.ticker);
    }
  }

  for (const event of ledgerEventsInRange) {
    if (!isValidLedgerEventType(event.eventType)) continue;
    const policy = LEDGER_SETTLEMENT_POLICY[event.eventType];
    if (policy.cashPosting !== 'none' && Math.abs(event.amount) > 0) {
      const cashAt = policy.cashPosting === 'settleDate' && event.settleDate ? event.settleDate : event.effectiveDate;
      cashEventDays.add(toUtcDayKey(cashAt.getTime()));
    }
    if (policy.positionPosting !== 'none') {
      const posAt = policy.positionPosting === 'settleDate' && event.settleDate ? event.settleDate : event.effectiveDate;
      addCorporateTicker(toUtcDayKey(posAt.getTime()), event.ticker);
    }
  }

  const points: LedgerConfidencePoint[] = [];
  const dailyGaps: { day: string; reason: string }[] = [];
  let prevSnap: (typeof snapshots)[number] | null = null;

  for (const snap of snapshots) {
    const time = snap.date.getTime();
    const dayKey = toUtcDayKey(time);
    let totalValue = snap.cash - snap.margin;
    let coveredValue = 0;
    let estimatedMissing = 0;
    let corporateCovered = 0;
    let corporateTotal = 0;
    const corporateTickers = corporateTickersByDay.get(dayKey);

    for (const [ticker, pos] of snap.positions) {
      if (pos.shares <= 0.000001) continue;
      const price = getPriceAt(ticker, time);
      if (corporateTickers?.has(ticker)) {
        corporateTotal += 1;
        if (price != null) corporateCovered += 1;
      }
      if (price != null) {
        const v = pos.shares * price;
        totalValue += v;
        coveredValue += v;
      } else {
        const fallback = pos.shares > 0 ? (pos.costBasis / pos.shares) : 0;
        estimatedMissing += pos.shares * fallback;
      }
    }

    const estimatedTotal = coveredValue + estimatedMissing;
    const coverageRatio = estimatedTotal > 0 ? coveredValue / estimatedTotal : 1;
    const priceScore = Math.max(0, Math.min(100, Math.round(coverageRatio * 100)));

    let cashScore = 100;
    if (prevSnap) {
      const cashDelta = snap.cash - prevSnap.cash;
      const changeThreshold = Math.max(100, Math.abs(prevSnap.equity) * 0.01);
      if (Math.abs(cashDelta) > changeThreshold && !cashEventDays.has(dayKey)) {
        cashScore = 35;
        dailyGaps.push({ day: dayKey, reason: 'Unexplained cash balance jump' });
      }
    }

    let corporateScore = 100;
    if (corporateTotal > 0) {
      corporateScore = Math.max(0, Math.min(100, Math.round((corporateCovered / corporateTotal) * 100)));
      if (corporateCovered < corporateTotal) {
        dailyGaps.push({ day: dayKey, reason: 'Corporate action with missing ticker price data' });
      }
    }

    if (coverageRatio < 0.8) {
      dailyGaps.push({ day: dayKey, reason: 'Missing price data coverage below 80%' });
    }

    const confidence = Math.max(
      0,
      Math.min(100, Math.round(priceScore * 0.6 + cashScore * 0.25 + corporateScore * 0.15)),
    );
    points.push({
      time,
      value: totalValue + estimatedMissing,
      confidence,
      estimated: confidence < confidenceThreshold,
    });
    prevSnap = snap;
  }

  const sortedGaps = [...dailyGaps].sort((a, b) => a.day.localeCompare(b.day));
  const gaps: LedgerReplayGap[] = [];
  for (const g of sortedGaps) {
    const asDate = new Date(`${g.day}T00:00:00.000Z`);
    const prev = gaps[gaps.length - 1];
    if (!prev) {
      gaps.push({ start: asDate.toISOString(), end: asDate.toISOString(), reason: g.reason });
      continue;
    }
    const prevEndDay = prev.end.slice(0, 10);
    const prevEndDate = new Date(`${prevEndDay}T00:00:00.000Z`);
    const isConsecutive = (asDate.getTime() - prevEndDate.getTime()) === 86400000;
    if (prev.reason === g.reason && isConsecutive) {
      prev.end = asDate.toISOString();
    } else {
      gaps.push({ start: asDate.toISOString(), end: asDate.toISOString(), reason: g.reason });
    }
  }

  return { points, gaps, confidenceThreshold };
}

export async function reconstructPortfolioHistoryFromLedger(
  userId: string,
  periodDays: number,
): Promise<{ time: number; value: number }[]> {
  const detailed = await reconstructPortfolioHistoryFromLedgerWithDiagnostics(userId, periodDays);
  return detailed.points.map(p => ({ time: p.time, value: p.value }));
}

export async function getLedgerReplayGapSummary(
  userId: string,
  periodDays: number,
): Promise<LedgerReplayGap[]> {
  const detailed = await reconstructPortfolioHistoryFromLedgerWithDiagnostics(userId, periodDays);
  return detailed.gaps;
}

/**
 * High-resolution trade-aware reconstruction using intraday candles.
 * Same concept as reconstructPortfolioHistoryFromTrades but uses 15-min or 1-hour candles.
 */
export async function reconstructPortfolioHistoryFromTradesHiRes(
  tradeHistory: { date: Date; ticker: string; type: string; shares: number; price: number }[],
  cashBalance: number,
  marginDebt: number,
  yahooRange: string,
  yahooInterval: string,
): Promise<{ time: number; value: number }[]> {
  if (tradeHistory.length === 0) return [];

  const trades = [...tradeHistory].sort((a, b) => a.date.getTime() - b.date.getTime());

  // Only fetch candles for tickers held during the hi-res window
  const rangeDaysMapFilter: Record<string, number> = { '1d': 2, '5d': 7, '1mo': 30, '3mo': 95, '6mo': 185 };
  const windowDays = rangeDaysMapFilter[yahooRange] || 30;
  const windowCutoff = Date.now() - windowDays * 86400000;
  const allTickers = new Set<string>();

  // Group 1: tickers held at the start of the window
  const preWindowShares = new Map<string, number>();
  for (const t of trades) {
    if (t.date.getTime() > windowCutoff) break;
    const cur = preWindowShares.get(t.ticker) || 0;
    if (t.type === 'buy' || t.type === 'transfer' || t.type === 'merger') {
      preWindowShares.set(t.ticker, cur + t.shares);
    } else if (t.type === 'sell' || t.type === 'cancel') {
      preWindowShares.set(t.ticker, Math.max(0, cur - t.shares));
    } else if (t.type === 'split' && cur > 0) {
      preWindowShares.set(t.ticker, cur + t.shares);
    }
  }
  for (const [ticker, shares] of preWindowShares) {
    if (shares > 0.001) allTickers.add(ticker);
  }

  // Group 2: any ticker traded during the window
  for (const t of trades) {
    if (t.date.getTime() >= windowCutoff) allTickers.add(t.ticker);
  }

  // Fetch hi-res candles for relevant tickers
  const fetchHiResForChart = async (ticker: string): Promise<{ dates: number[]; closes: number[] } | null> => {
    const cacheKey = `hires:${ticker}:${yahooRange}:${yahooInterval}`;
    const cached = hiresCache.get<{ dates: number[]; closes: number[] }>(cacheKey);
    if (cached) return cached;

    const rangeDaysMap: Record<string, number> = { '1d': 2, '5d': 7, '1mo': 30, '3mo': 95, '6mo': 185 };
    const rangeDays = rangeDaysMap[yahooRange] || 30;
    const today = new Date().toISOString().split('T')[0];
    const fromDate = new Date(Date.now() - rangeDays * 86400000).toISOString().split('T')[0];

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
          if (q.close[i] != null) { dates.push(timestamps[i] * 1000); closes.push(q.close[i]); }
        }
        if (closes.length > 0) {
          const data = { dates, closes };
          hiresCache.set(cacheKey, data);
          return data;
        }
      }
    } catch { /* fallback failed */ }

    return null;
  };

  const tickerArr = Array.from(allTickers);
  const candleResults = await limitConcurrency(
    tickerArr.map(t => () => fetchHiResForChart(t)), 10
  );

  const tickerCandles = new Map<string, { dates: number[]; closes: number[] }>();
  for (let i = 0; i < tickerArr.length; i++) {
    if (candleResults[i]) tickerCandles.set(tickerArr[i], candleResults[i]!);
  }

  if (tickerCandles.size === 0) return [];

  // Collect all unique timestamps
  const allDatesSet = new Set<number>();
  for (const { dates } of tickerCandles.values()) {
    for (const d of dates) allDatesSet.add(d);
  }
  const allDates = Array.from(allDatesSet).sort((a, b) => a - b);
  if (allDates.length === 0) return [];

  // Build portfolio timeline from trades
  const portfolioTimeline: { dateMs: number; portfolio: Map<string, number> }[] = [];
  const runningPortfolio = new Map<string, number>();
  portfolioTimeline.push({ dateMs: 0, portfolio: new Map() });

  for (const trade of trades) {
    const dateMs = trade.date.getTime();
    const current = runningPortfolio.get(trade.ticker) || 0;
    if (trade.type === 'buy' || trade.type === 'transfer' || trade.type === 'merger') {
      runningPortfolio.set(trade.ticker, current + trade.shares);
    } else if (trade.type === 'sell' || trade.type === 'cancel') {
      const remaining = current - trade.shares;
      if (remaining <= 0.001) runningPortfolio.delete(trade.ticker);
      else runningPortfolio.set(trade.ticker, remaining);
    } else if (trade.type === 'split') {
      if (current > 0) runningPortfolio.set(trade.ticker, current + trade.shares);
    }
    portfolioTimeline.push({ dateMs, portfolio: new Map(runningPortfolio) });
  }

  function getPortfolioAt(dateMs: number): Map<string, number> {
    let lo = 0, hi = portfolioTimeline.length - 1, bestIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (portfolioTimeline[mid].dateMs <= dateMs) { bestIdx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return portfolioTimeline[bestIdx].portfolio;
  }

  function getPriceAt(ticker: string, dateMs: number): number | null {
    const candles = tickerCandles.get(ticker);
    if (!candles) return null;
    let lo = 0, hi = candles.dates.length - 1, bestIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles.dates[mid] <= dateMs) { bestIdx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return bestIdx >= 0 ? candles.closes[bestIdx] : null;
  }

  const points: { time: number; value: number }[] = [];
  for (const dateMs of allDates) {
    const portfolio = getPortfolioAt(dateMs);
    if (portfolio.size === 0) continue;

    let totalValue = cashBalance - marginDebt;
    let tickersWithPrice = 0;

    for (const [ticker, shares] of portfolio) {
      const price = getPriceAt(ticker, dateMs);
      if (price != null) { totalValue += shares * price; tickersWithPrice++; }
    }

    if (tickersWithPrice >= Math.max(1, Math.ceil(portfolio.size * 0.6))) {
      points.push({ time: dateMs, value: totalValue });
    }
  }

  // Outlier smoothing (same as main hi-res function)
  if (points.length >= 3) {
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1].value;
      const curr = points[i].value;
      const next = points[i + 1].value;
      const neighborAvg = (prev + next) / 2;
      if (neighborAvg > 0) {
        const deviation = Math.abs(curr - neighborAvg) / neighborAvg;
        if (deviation > 0.05) points[i].value = neighborAvg;
      }
    }
  }

  // Gap fill
  const expectedMs = parseIntervalMs(yahooInterval);
  if (expectedMs > 0 && points.length >= 2) {
    const filled: { time: number; value: number }[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const gap = points[i].time - points[i - 1].time;
      if (gap > expectedMs * 1.5 && gap < expectedMs * 10) {
        const steps = Math.round(gap / expectedMs);
        for (let s = 1; s < steps; s++) {
          const t = points[i - 1].time + (gap * s) / steps;
          const v = points[i - 1].value + ((points[i].value - points[i - 1].value) * s) / steps;
          filled.push({ time: Math.round(t), value: v });
        }
      }
      filled.push(points[i]);
    }
    return filled;
  }

  return points;
}

// ---------------------------------------------------------------------------
// Snapshot Health Check
// ---------------------------------------------------------------------------

export interface SnapshotHealthReport {
  userId: string;
  username: string;
  lastSnapshotAge: number | null; // minutes since last snapshot, null if never
  snapshotsLast24h: number;
  gapCount: number; // number of gaps > 15min during market hours
  longestGapMinutes: number;
  status: 'healthy' | 'stale' | 'gaps' | 'critical'; // critical = no snapshots in 24h
}

/**
 * Checks snapshot integrity for every user with active holdings (shares > 0).
 *
 * For each user it reports:
 *  - age of the most recent snapshot
 *  - total snapshot count in the last 24 hours
 *  - number of gaps > 15 min during market hours (PRE/REG/POST) in the last 24h
 *  - longest such gap
 *  - an overall health status
 */
export async function getSnapshotHealth(): Promise<SnapshotHealthReport[]> {
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Find all users who have at least one holding with shares > 0
  const usersWithHoldings = await prisma.holding.findMany({
    select: { userId: true },
    distinct: ['userId'],
    where: { shares: { gt: 0 }, userId: { not: null } },
  });

  const userIds = usersWithHoldings
    .map(h => h.userId)
    .filter((id): id is string => id != null);

  if (userIds.length === 0) return [];

  // Batch-fetch usernames
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true },
  });
  const usernameMap = new Map(users.map(u => [u.id, u.username]));

  const currentSession = getMarketSession(now);
  const marketOpen = currentSession === 'PRE' || currentSession === 'REG' || currentSession === 'POST';

  const reports: SnapshotHealthReport[] = [];

  for (const userId of userIds) {
    // Get snapshots from last 24h ordered chronologically
    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: {
        userId,
        timestamp: { gte: twentyFourHoursAgo },
      },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true },
    });

    const snapshotsLast24h = snapshots.length;

    // Last snapshot age — check regardless of 24h window
    let lastSnapshotAge: number | null = null;
    if (snapshotsLast24h > 0) {
      const lastTs = snapshots[snapshots.length - 1].timestamp;
      lastSnapshotAge = (now.getTime() - new Date(lastTs).getTime()) / (1000 * 60);
    } else {
      // Check if there's any snapshot at all (older than 24h)
      const anySnapshot = await prisma.portfolioSnapshot.findFirst({
        where: { userId },
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true },
      });
      if (anySnapshot) {
        lastSnapshotAge = (now.getTime() - new Date(anySnapshot.timestamp).getTime()) / (1000 * 60);
      }
    }

    // Analyze gaps during market hours in last 24h
    // Include boundary gaps: windowStart→firstSnapshot and lastSnapshot→now
    let gapCount = 0;
    let longestGapMinutes = 0;

    const isMarketOpen = (d: Date) => {
      const s = getMarketSession(d);
      return s === 'PRE' || s === 'REG' || s === 'POST';
    };

    const checkGap = (start: Date, end: Date) => {
      const gapMs = end.getTime() - start.getTime();
      const gapMinutes = gapMs / (1000 * 60);
      if (gapMinutes <= 15) return;
      // Sample every 30 minutes across the gap to catch spans crossing overnight
      let overlapsMarket = false;
      const step = Math.min(30 * 60 * 1000, gapMs); // 30-min steps
      for (let t = start.getTime(); t <= end.getTime(); t += step) {
        if (isMarketOpen(new Date(t))) { overlapsMarket = true; break; }
      }
      // Also check the end point
      if (!overlapsMarket && isMarketOpen(end)) overlapsMarket = true;
      if (overlapsMarket) {
        gapCount++;
        if (gapMinutes > longestGapMinutes) {
          longestGapMinutes = gapMinutes;
        }
      }
    };

    if (snapshotsLast24h > 0) {
      // Boundary gap: window start → first snapshot
      checkGap(twentyFourHoursAgo, new Date(snapshots[0].timestamp));
      // Gaps between consecutive snapshots
      for (let i = 1; i < snapshots.length; i++) {
        checkGap(new Date(snapshots[i - 1].timestamp), new Date(snapshots[i].timestamp));
      }
      // Boundary gap: last snapshot → now
      checkGap(new Date(snapshots[snapshots.length - 1].timestamp), now);
    }

    // Determine status
    let status: SnapshotHealthReport['status'];
    if (snapshotsLast24h === 0) {
      status = 'critical';
    } else if (marketOpen && (lastSnapshotAge == null || lastSnapshotAge > 10)) {
      status = 'stale';
    } else if (gapCount > 0) {
      status = 'gaps';
    } else {
      status = 'healthy';
    }

    reports.push({
      userId,
      username: usernameMap.get(userId) ?? 'unknown',
      lastSnapshotAge: lastSnapshotAge != null ? Math.round(lastSnapshotAge * 10) / 10 : null,
      snapshotsLast24h,
      gapCount,
      longestGapMinutes: Math.round(longestGapMinutes * 10) / 10,
      status,
    });
  }

  // Sort: critical first, then stale, then gaps, then healthy
  const statusOrder: Record<SnapshotHealthReport['status'], number> = {
    critical: 0,
    stale: 1,
    gaps: 2,
    healthy: 3,
  };
  reports.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  return reports;
}
