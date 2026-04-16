import prisma from '../utils/prisma';
import { LeaderboardWindow, LeaderboardRegion, LeaderboardEntry, LeaderboardResponse } from '../types';
import {
  isSuspiciousReturn,
  isSuspiciousSharpe,
  dailyReturnsFromValues,
} from '../utils/finance-math';
import { fetchPrices } from './market.service';
import { fetchPolygonAggs } from '../utils/yahoo-http';
import { etDate } from '../utils/date';
import NodeCache from 'node-cache';

const REGION_DB_MAP: Record<LeaderboardRegion, string | null> = {
  world: null,
  na: 'NA',
  europe: 'EU',
  apac: 'APAC',
};

// Cache daily candles for 6 hours — historical data doesn't change
const dailyCandleCache = new NodeCache({ stdTTL: 21600 });

function getWindowStartDate(window: LeaderboardWindow): Date {
  const now = new Date();
  switch (window) {
    case '1D': {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return d;
    }
    case '1W': {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return d;
    }
    case '1M': {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 1);
      return d;
    }
    case '6M': {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 6);
      return d;
    }
    case 'YTD': {
      return new Date(now.getFullYear(), 0, 1);
    }
    case '1Y': {
      const d = new Date(now);
      d.setFullYear(d.getFullYear() - 1);
      return d;
    }
  }
}

/**
 * Fetch daily candle data for a ticker, returns sorted array of { dateMs, close }.
 * Cached for 6 hours since historical data doesn't change.
 */
async function getDailyCandles(ticker: string): Promise<{ dateMs: number; close: number }[] | null> {
  const cacheKey = `lb-candle:${ticker}`;
  const cached = dailyCandleCache.get<{ dateMs: number; close: number }[]>(cacheKey);
  if (cached) return cached;

  const today = etDate();
  const fromDate = etDate(new Date(Date.now() - 400 * 86400000)); // ~13 months back
  const pg = await fetchPolygonAggs(ticker, 1, 'day', fromDate, today);
  if (!pg || pg.closes.length === 0) return null;

  const candles = pg.timestamps.map((t, i) => ({ dateMs: t * 1000, close: pg.closes[i] }));
  dailyCandleCache.set(cacheKey, candles);
  return candles;
}

/**
 * Find the closing price at or before a target date using binary search.
 */
function getPriceAtDate(candles: { dateMs: number; close: number }[], targetMs: number): number | null {
  let lo = 0, hi = candles.length - 1, bestIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].dateMs <= targetMs) { bestIdx = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return bestIdx >= 0 ? candles[bestIdx].close : null;
}

const NEW_USER_DAYS = 7;

export async function getLeaderboard(window: LeaderboardWindow, region: LeaderboardRegion = 'world'): Promise<LeaderboardResponse> {
  const regionFilter = REGION_DB_MAP[region];
  const users = await prisma.user.findMany({
    where: {
      leaderboardEligible: true,
      holdingsVisibility: 'all',  // Exclude users who hide their holdings
      holdings: { some: { shares: { gt: 0 } } },
      ...(regionFilter ? { region: regionFilter, showRegion: true } : {}),
    },
    select: {
      id: true, username: true, displayName: true,
      region: true, trackingStartAt: true, avatarUrl: true,
    },
  });

  const windowStart = getWindowStartDate(window);
  const windowStartMs = windowStart.getTime();
  const entries: LeaderboardEntry[] = [];

  // ---- Batch-fetch all holdings, settings, and quotes once ----
  const userIds = users.map(u => u.id);
  const [allHoldings, allSettings] = await Promise.all([
    prisma.holding.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, ticker: true, shares: true, averageCost: true },
    }),
    prisma.userSettings.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, cashBalance: true, marginDebt: true },
    }),
  ]);

  const uniqueTickers = Array.from(new Set(allHoldings.map(h => h.ticker.toUpperCase())));

  // Fetch live quotes + historical candles in parallel
  const [quotesResult, ...candleResults] = await Promise.all([
    uniqueTickers.length > 0
      ? fetchPrices(uniqueTickers, { preferPolygon: true })
      : Promise.resolve({ quotes: new Map<string, any>() }),
    ...uniqueTickers.map(t => getDailyCandles(t)),
  ]);

  const quotes = quotesResult.quotes;

  // Build candle lookup: ticker → candles array
  const candleMap = new Map<string, { dateMs: number; close: number }[]>();
  for (let i = 0; i < uniqueTickers.length; i++) {
    const candles = candleResults[i];
    if (candles) candleMap.set(uniqueTickers[i], candles);
  }

  // Pre-group holdings and settings by userId
  const holdingsByUser = new Map<string, typeof allHoldings>();
  for (const h of allHoldings) {
    if (!h.userId) continue;
    const list = holdingsByUser.get(h.userId);
    if (list) list.push(h);
    else holdingsByUser.set(h.userId, [h]);
  }
  const settingsMap = new Map(allSettings.map(s => [s.userId, s]));

  for (const user of users) {
    if (!user.trackingStartAt) continue;

    const sinceStart = user.trackingStartAt > windowStart;
    const effectiveStartMs = sinceStart ? user.trackingStartAt.getTime() : windowStartMs;

    const daysSinceStart = (Date.now() - user.trackingStartAt.getTime()) / (1000 * 60 * 60 * 24);
    const isNew = daysSinceStart <= NEW_USER_DAYS;

    const userHoldings = holdingsByUser.get(user.id) ?? [];
    const userSettings = settingsMap.get(user.id);
    const cashBalance = userSettings?.cashBalance ?? 0;
    const marginDebt = userSettings?.marginDebt ?? 0;

    const snapshotCount = await prisma.portfolioSnapshot.count({
      where: { userId: user.id },
    });

    if (userHoldings.length === 0) {
      entries.push({
        userId: user.id, username: user.username, displayName: user.displayName,
        region: user.region ?? null, window,
        returnPct: null, returnDollar: null, twrPct: null,
        verified: true, basis: 'none', sinceStart, isNew,
        flagged: false, flagReason: null,
        trackingStartAt: user.trackingStartAt.toISOString(), snapshotCount,
        startDateUsed: null, endDateUsed: null,
      });
      continue;
    }

    // ---- Compute LIVE portfolio value ----
    let liveHoldings = 0;
    let liveCount = 0;
    // ---- Compute HISTORICAL portfolio value at window start ----
    let historicalHoldings = 0;
    let historicalCount = 0;
    // ---- 1D: also compute previousClose value ----
    let prevCloseHoldings = 0;
    let prevCloseCount = 0;

    for (const h of userHoldings) {
      const ticker = h.ticker.toUpperCase();
      const quote = quotes.get(ticker);

      // Current price
      const price = (quote?.extendedPrice && quote.extendedPrice > 0)
        ? quote.extendedPrice
        : (quote?.currentPrice ?? 0);
      if (price > 0) { liveHoldings += h.shares * price; liveCount++; }

      // Previous close (for 1D)
      const prevClose = quote?.previousClose ?? 0;
      if (prevClose > 0) { prevCloseHoldings += h.shares * prevClose; prevCloseCount++; }

      // Historical price at window start from candle data
      const candles = candleMap.get(ticker);
      if (candles) {
        const histPrice = getPriceAtDate(candles, effectiveStartMs);
        if (histPrice != null) { historicalHoldings += h.shares * histPrice; historicalCount++; }
      }
    }

    const liveValue = liveCount > 0 ? liveHoldings + cashBalance - marginDebt : null;
    const historicalValue = historicalCount > 0 ? historicalHoldings + cashBalance - marginDebt : null;
    const prevCloseValue = prevCloseCount > 0 ? prevCloseHoldings + cashBalance - marginDebt : null;

    if (liveValue == null) {
      entries.push({
        userId: user.id, username: user.username, displayName: user.displayName,
        region: user.region ?? null, window,
        returnPct: null, returnDollar: null, twrPct: null,
        verified: true, basis: 'none', sinceStart, isNew,
        flagged: false, flagReason: null,
        trackingStartAt: user.trackingStartAt.toISOString(), snapshotCount,
        startDateUsed: null, endDateUsed: null,
      });
      continue;
    }

    // ---- Compute returns from REAL price data, not snapshots ----
    let returnPct: number | null = null;
    let returnDollar: number = 0;

    if (window === '1D' && prevCloseValue != null) {
      // 1D: use previousClose for accurate intraday return
      returnDollar = liveValue - prevCloseValue;
      returnPct = prevCloseValue > 0 ? (returnDollar / prevCloseValue) * 100 : null;
    } else if (historicalValue != null && historicalValue > 0) {
      // All other windows: use historical candle-based value
      returnDollar = liveValue - historicalValue;
      returnPct = (returnDollar / historicalValue) * 100;
    }

    // TWR = simple return when there are no cashflows (deposits/withdrawals).
    // Using candle-based computation, this is always accurate.
    const twrPct = returnPct != null ? Math.round(returnPct * 100) / 100 : null;

    // Anti-cheat: build daily return series from candle data for this user's portfolio
    let flagged = false;
    let flagReason: string | null = null;

    if (historicalValue != null && liveValue != null) {
      // Reconstruct daily portfolio values from candles for anti-cheat
      const dailyValues: number[] = [];
      // Find all unique trading days in the window from any ticker's candles
      const allDaysSet = new Set<number>();
      for (const h of userHoldings) {
        const candles = candleMap.get(h.ticker.toUpperCase());
        if (candles) {
          for (const c of candles) {
            if (c.dateMs >= effectiveStartMs) allDaysSet.add(c.dateMs);
          }
        }
      }
      const allDays = Array.from(allDaysSet).sort((a, b) => a - b);

      for (const dayMs of allDays) {
        let dayValue = cashBalance - marginDebt;
        let dayCount = 0;
        for (const h of userHoldings) {
          const candles = candleMap.get(h.ticker.toUpperCase());
          if (!candles) continue;
          const p = getPriceAtDate(candles, dayMs);
          if (p != null) { dayValue += h.shares * p; dayCount++; }
        }
        if (dayCount > 0) dailyValues.push(dayValue);
      }

      if (dailyValues.length >= 2) {
        const dailyReturns = dailyReturnsFromValues(dailyValues);
        if (dailyReturns.some(r => isSuspiciousReturn(r, 1))) {
          flagged = true;
          flagReason = 'Suspicious single-day return detected (>300%)';
        }
        if (!flagged && dailyReturns.length >= 5) {
          const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
          const annualizedMean = mean * 252;
          const variance = dailyReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / dailyReturns.length;
          const annualizedVol = Math.sqrt(variance) * Math.sqrt(252);
          if (isSuspiciousSharpe(annualizedMean, annualizedVol)) {
            flagged = true;
            flagReason = 'Abnormally high risk-adjusted return (Sharpe > 5)';
          }
        }
      }
    }

    const windowStartISO = new Date(effectiveStartMs).toISOString();

    entries.push({
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      region: user.region ?? null,
      window,
      returnPct,
      returnDollar,
      twrPct,
      verified: true,
      basis: 'verified',
      sinceStart,
      isNew,
      flagged,
      flagReason,
      trackingStartAt: user.trackingStartAt.toISOString(),
      snapshotCount,
      startDateUsed: windowStartISO,
      endDateUsed: new Date().toISOString(),
      // currentAssets intentionally omitted — exact portfolio values are private
    });
  }

  // Write to LeaderboardCache for fast reads
  await Promise.all(entries.map(entry =>
    prisma.leaderboardCache.upsert({
      where: { userId_window: { userId: entry.userId, window } },
      create: {
        userId: entry.userId,
        window,
        twrPct: entry.twrPct,
        flagged: entry.flagged,
        flagReason: entry.flagReason,
        isNew: entry.isNew,
        computedAt: new Date(),
      },
      update: {
        twrPct: entry.twrPct,
        flagged: entry.flagged,
        flagReason: entry.flagReason,
        isNew: entry.isNew,
        computedAt: new Date(),
      },
    }).catch(() => {}) // non-critical
  ));

  // Note: Creators with trade delay still show return percentages on the leaderboard.
  // The leaderboard only displays aggregate return %, which doesn't reveal specific
  // holdings composition. The trade delay protects holdings detail (tickers, shares),
  // not aggregate performance — that's handled by the creator paywall on profile views.

  // Sort by return descending, nulls last
  entries.sort((a, b) => {
    const aVal = a.twrPct ?? a.returnPct;
    const bVal = b.twrPct ?? b.returnPct;
    if (aVal === null && bVal === null) return 0;
    if (aVal === null) return 1;
    if (bVal === null) return -1;
    return bVal - aVal;
  });

  return {
    entries,
    lastUpdated: new Date().toISOString(),
  };
}
