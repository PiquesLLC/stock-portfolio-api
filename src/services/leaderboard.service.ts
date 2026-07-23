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
import { isOpenedTodayET } from '../utils/market-hours';
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
      select: { userId: true, ticker: true, shares: true, averageCost: true, createdAt: true },
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

  // Users whose composition changed during the window. The per-user return below applies
  // CURRENT shares to the window-start price, so buying an already-appreciated stock
  // mid-window would credit that user with its PAST run-up (a gaming vector). For these
  // users we fall back to their recorded snapshot return and flag the entry. F-M-15.
  const compChangedUserIds = new Set<string>();
  try {
    const compGroups = await prisma.activityEvent.groupBy({
      by: ['userId'],
      where: {
        userId: { in: userIds },
        type: { in: ['holding_added', 'holding_removed', 'holding_updated'] },
        createdAt: { gte: windowStart },
      },
      _count: { _all: true },
    });
    for (const g of compGroups) if (g.userId) compChangedUserIds.add(g.userId);
  } catch { /* activity events are best-effort; absence just skips the guard */ }

  // Robust composition signal the client CANNOT suppress: a holding whose
  // server-set createdAt falls inside the window means a position was ADDED
  // mid-window — via CSV/screenshot import, Plaid sync, or a manual add that
  // passed skipActivity=true to dodge the activity-event guard above. Crediting
  // a just-added position's PAST run-up is the primary leaderboard gaming vector
  // (import an already-appreciated portfolio → bank the run-up), so treat these
  // users identically to F-M-15: fall back to the recorded snapshot return, or
  // drop them from the ranking when they lack enough history to measure fairly.
  //
  // Skip 1D: the 1D path already anchors a position opened today at its OWN cost
  // basis (isOpenedTodayET below), so it credits only the user's gain since
  // purchase — there is no pre-ownership run-up to bank in a single day. The
  // vector this guards is the multi-day/week reconstruction from a window-start
  // price that predates ownership.
  if (window !== '1D') {
    for (const [uid, holdings] of holdingsByUser) {
      if (holdings.some(h => h.createdAt != null && new Date(h.createdAt).getTime() >= windowStartMs)) {
        compChangedUserIds.add(uid);
      }
    }
  }

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
        flagged: false, suspicious: false, flagReason: null,
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

      // Previous-close baseline (for 1D). A position opened today is anchored
      // at its cost basis, not previousClose — the user didn't hold it at
      // yesterday's close — matching getPortfolio's day-P&L anchor so the
      // leaderboard 1D return agrees with the dashboard.
      const dayAnchor = isOpenedTodayET(h.createdAt) && h.averageCost > 0 ? h.averageCost : (quote?.previousClose ?? 0);
      if (dayAnchor > 0) { prevCloseHoldings += h.shares * dayAnchor; prevCloseCount++; }

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
        flagged: false, suspicious: false, flagReason: null,
        trackingStartAt: user.trackingStartAt.toISOString(), snapshotCount,
        startDateUsed: null, endDateUsed: null,
      });
      continue;
    }

    // ---- Compute returns from REAL price data, not snapshots ----
    let returnPct: number | null = null;
    let returnDollar: number = 0;
    let flagged = false;
    // `suspicious` marks ONLY anti-cheat detections (>300%/day, Sharpe>5) — the
    // subset of `flagged` that must be excluded from public ranking. Benign
    // composition-change flags (F-M-15) keep `suspicious=false` and stay ranked
    // with a snapshot-recomputed return.
    let suspicious = false;
    let flagReason: string | null = null;

    if (window === '1D' && prevCloseValue != null) {
      // 1D: use previousClose for accurate intraday return
      returnDollar = liveValue - prevCloseValue;
      returnPct = prevCloseValue > 0 ? (returnDollar / prevCloseValue) * 100 : null;
    } else if (historicalValue != null && historicalValue > 0) {
      // All other windows: use historical candle-based value
      returnDollar = liveValue - historicalValue;
      returnPct = (returnDollar / historicalValue) * 100;
    }

    // Composition guard (F-M-15): if the user's composition changed during the window, the
    // current-shares reconstruction above is biased — replace it with the actual recorded
    // snapshot return and flag the entry; if too few snapshots exist to measure it, drop
    // them from the ranking (null return) rather than rank an inflated number.
    if (compChangedUserIds.has(user.id) && returnPct != null) {
      const windowSnaps = await prisma.portfolioSnapshot.findMany({
        where: { userId: user.id, timestamp: { gte: windowStart } },
        orderBy: { timestamp: 'asc' },
        select: { totalValue: true, netEquity: true },
      });
      const firstVal = windowSnaps.length > 0 ? (windowSnaps[0].netEquity ?? windowSnaps[0].totalValue) : null;
      const lastVal = windowSnaps.length > 0 ? (windowSnaps[windowSnaps.length - 1].netEquity ?? windowSnaps[windowSnaps.length - 1].totalValue) : null;
      if (windowSnaps.length >= 2 && firstVal != null && firstVal > 0 && lastVal != null) {
        returnDollar = lastVal - firstVal;
        returnPct = (returnDollar / firstVal) * 100;
        flagReason = 'Composition changed during window — return from recorded snapshots';
      } else {
        returnPct = null;
        returnDollar = 0;
        flagReason = 'Composition changed during window — insufficient history to rank fairly';
      }
      flagged = true;
    }

    const twrPct = returnPct != null ? Math.round(returnPct * 100) / 100 : null;

    // Anti-cheat: build daily return series from candle data for this user's portfolio
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
          suspicious = true;
          flagReason = 'Suspicious single-day return detected (>300%)';
        }
        // Gate on `!suspicious` (not `!flagged`) so a benign composition-flagged
        // entry is still Sharpe-checked and can't smuggle an absurd risk-adjusted
        // return past the anti-cheat.
        if (!suspicious && dailyReturns.length >= 5) {
          const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
          const annualizedMean = mean * 252;
          const variance = dailyReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / dailyReturns.length;
          const annualizedVol = Math.sqrt(variance) * Math.sqrt(252);
          if (isSuspiciousSharpe(annualizedMean, annualizedVol)) {
            flagged = true;
            suspicious = true;
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
      suspicious,
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
    if (aVal === null && bVal === null) return a.userId.localeCompare(b.userId);
    if (aVal === null) return 1;
    if (bVal === null) return -1;
    // deterministic tie-break for equal returns — stable ordering across requests
    return (bVal - aVal) || a.userId.localeCompare(b.userId);
  });

  return {
    entries,
    lastUpdated: new Date().toISOString(),
  };
}
