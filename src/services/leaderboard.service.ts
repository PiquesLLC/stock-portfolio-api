import { PrismaClient } from '@prisma/client';
import { LeaderboardWindow, LeaderboardEntry, LeaderboardResponse } from '../types';

const prisma = new PrismaClient();

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

export async function getLeaderboard(window: LeaderboardWindow): Promise<LeaderboardResponse> {
  const users = await prisma.user.findMany({
    where: { leaderboardEligible: true },
  });

  const windowStart = getWindowStartDate(window);
  const entries: LeaderboardEntry[] = [];

  for (const user of users) {
    if (!user.trackingStartAt) continue;

    const effectiveStart = user.trackingStartAt > windowStart ? user.trackingStartAt : windowStart;
    const sinceStart = user.trackingStartAt > windowStart;

    // Baseline = closest snapshot to effectiveStart
    // Prefer the most recent snapshot at/before effectiveStart (anchors to window edge),
    // fall back to first snapshot after effectiveStart if none exists before
    let baseline = await prisma.portfolioSnapshot.findFirst({
      where: {
        userId: user.id,
        timestamp: { lte: effectiveStart },
      },
      orderBy: { timestamp: 'desc' },
    });
    if (!baseline) {
      baseline = await prisma.portfolioSnapshot.findFirst({
        where: {
          userId: user.id,
          timestamp: { gte: effectiveStart },
        },
        orderBy: { timestamp: 'asc' },
      });
    }

    // Latest = most recent snapshot
    const latest = await prisma.portfolioSnapshot.findFirst({
      where: { userId: user.id },
      orderBy: { timestamp: 'desc' },
    });

    // Count snapshots for this user
    const snapshotCount = await prisma.portfolioSnapshot.count({
      where: { userId: user.id },
    });

    if (!baseline || !latest || baseline.id === latest.id) {
      entries.push({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        window,
        returnPct: null,
        returnDollar: null,
        verified: true,
        basis: 'none',
        sinceStart,
        trackingStartAt: user.trackingStartAt.toISOString(),
        snapshotCount,
        startDateUsed: null,
        endDateUsed: null,
        currentAssets: latest?.totalValue ?? null,
      });
      continue;
    }

    const returnPct = baseline.totalValue > 0
      ? ((latest.totalValue - baseline.totalValue) / baseline.totalValue) * 100
      : null;
    const returnDollar = latest.totalValue - baseline.totalValue;

    entries.push({
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      window,
      returnPct,
      returnDollar,
      verified: true,
      basis: 'verified',
      sinceStart,
      trackingStartAt: user.trackingStartAt.toISOString(),
      snapshotCount,
      startDateUsed: baseline.timestamp.toISOString(),
      endDateUsed: latest.timestamp.toISOString(),
      currentAssets: latest.totalValue,
    });
  }

  // Sort by returnPct descending, nulls last
  entries.sort((a, b) => {
    if (a.returnPct === null && b.returnPct === null) return 0;
    if (a.returnPct === null) return 1;
    if (b.returnPct === null) return -1;
    return b.returnPct - a.returnPct;
  });

  return {
    entries,
    lastUpdated: new Date().toISOString(),
  };
}
