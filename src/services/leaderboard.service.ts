import prisma from '../utils/prisma';
import { LeaderboardWindow, LeaderboardRegion, LeaderboardEntry, LeaderboardResponse } from '../types';
import {
  calculateTWR,
  isSuspiciousReturn,
  isSuspiciousSharpe,
  dailyReturnsFromValues,
  SnapshotPoint,
  CashflowEvent,
} from '../utils/finance-math';

const REGION_DB_MAP: Record<LeaderboardRegion, string | null> = {
  world: null,
  na: 'NA',
  europe: 'EU',
  apac: 'APAC',
};



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
      d.setDate(d.getDate() - 30);
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

const NEW_USER_DAYS = 7;

export async function getLeaderboard(window: LeaderboardWindow, region: LeaderboardRegion = 'world'): Promise<LeaderboardResponse> {
  const regionFilter = REGION_DB_MAP[region];
  const users = await prisma.user.findMany({
    where: {
      leaderboardEligible: true,
      ...(regionFilter ? { region: regionFilter, showRegion: true } : {}),
    },
  });

  const windowStart = getWindowStartDate(window);
  const entries: LeaderboardEntry[] = [];

  for (const user of users) {
    if (!user.trackingStartAt) continue;

    const effectiveStart = user.trackingStartAt > windowStart ? user.trackingStartAt : windowStart;
    const sinceStart = user.trackingStartAt > windowStart;

    // Is the user "new" (tracking started within 7 days)?
    const daysSinceStart = (Date.now() - user.trackingStartAt.getTime()) / (1000 * 60 * 60 * 24);
    const isNew = daysSinceStart <= NEW_USER_DAYS;

    // Get all snapshots for TWR calculation (baseline + window)
    const baselineSnapshot = await prisma.portfolioSnapshot.findFirst({
      where: { userId: user.id, timestamp: { lte: effectiveStart } },
      orderBy: { timestamp: 'desc' },
    });

    const windowSnapshots = await prisma.portfolioSnapshot.findMany({
      where: { userId: user.id, timestamp: { gte: effectiveStart } },
      orderBy: { timestamp: 'asc' },
    });

    const allSnapshotsRaw = baselineSnapshot
      ? [baselineSnapshot, ...windowSnapshots]
      : windowSnapshots;

    // Deduplicate to one per calendar day (last snapshot of each day)
    const dailyMap = new Map<string, typeof allSnapshotsRaw[0]>();
    for (const s of allSnapshotsRaw) {
      const dayKey = s.timestamp.toISOString().slice(0, 10);
      dailyMap.set(dayKey, s);
    }
    const allSnapshots = Array.from(dailyMap.values()).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );

    const latest = allSnapshots.length > 0 ? allSnapshots[allSnapshots.length - 1] : null;
    const baseline = allSnapshots.length > 0 ? allSnapshots[0] : null;

    const snapshotCount = await prisma.portfolioSnapshot.count({
      where: { userId: user.id },
    });

    if (!baseline || !latest || allSnapshots.length < 2) {
      entries.push({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        region: user.region ?? null,
        window,
        returnPct: null,
        returnDollar: null,
        twrPct: null,
        verified: true,
        basis: 'none',
        sinceStart,
        isNew,
        flagged: false,
        flagReason: null,
        trackingStartAt: user.trackingStartAt.toISOString(),
        snapshotCount,
        startDateUsed: null,
        endDateUsed: null,
        currentAssets: latest ? (latest.netEquity ?? latest.totalValue) : null,
      });
      continue;
    }

    // Build snapshot points for TWR
    const snapshotPoints: SnapshotPoint[] = allSnapshots.map(s => ({
      date: s.timestamp,
      value: s.netEquity ?? s.totalValue,
    }));

    // Get transactions (cashflows) for TWR
    const transactions = await prisma.transaction.findMany({
      where: { userId: user.id, date: { gte: effectiveStart } },
      orderBy: { date: 'asc' },
    });

    const cashflows: CashflowEvent[] = transactions.map(t => ({
      date: t.date,
      amount: t.type === 'deposit' ? t.amount : -t.amount,
    }));

    // Calculate TWR
    const twrRaw = calculateTWR(snapshotPoints, cashflows);
    const twrPct = twrRaw !== null ? Math.round(twrRaw * 10000) / 100 : null;

    // Simple return for backwards compatibility
    const baselineValue = baseline.netEquity ?? baseline.totalValue;
    const latestValue = latest.netEquity ?? latest.totalValue;
    const returnPct = baselineValue > 0
      ? ((latestValue - baselineValue) / baselineValue) * 100
      : null;
    const returnDollar = latestValue - baselineValue;

    // Anti-cheat checks
    let flagged = false;
    let flagReason: string | null = null;

    // Check for suspicious single-day return
    const values = snapshotPoints.map(s => s.value);
    const dailyReturns = dailyReturnsFromValues(values);
    if (dailyReturns.some(r => isSuspiciousReturn(r, 1))) {
      flagged = true;
      flagReason = 'Suspicious single-day return detected (>300%)';
    }

    // Check for suspicious Sharpe ratio
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
      startDateUsed: baseline.timestamp.toISOString(),
      endDateUsed: latest.timestamp.toISOString(),
      currentAssets: latestValue,
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

  // Sort by TWR descending (fall back to returnPct), nulls last
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

