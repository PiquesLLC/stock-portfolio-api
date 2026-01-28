import { PrismaClient } from '@prisma/client';
import { LeaderboardWindow, LeaderboardEntry } from '../types';

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

function getWindowDays(window: LeaderboardWindow): number {
  switch (window) {
    case '1D': return 1;
    case '1W': return 7;
    case '1M': return 30;
    case 'YTD': {
      const now = new Date();
      const jan1 = new Date(now.getFullYear(), 0, 1);
      return Math.floor((now.getTime() - jan1.getTime()) / (1000 * 60 * 60 * 24));
    }
    case '1Y': return 365;
  }
}

export async function getLeaderboard(window: LeaderboardWindow): Promise<LeaderboardEntry[]> {
  const users = await prisma.user.findMany({
    include: { settings: true },
  });

  const windowStart = getWindowStartDate(window);
  const windowDays = getWindowDays(window);
  const entries: LeaderboardEntry[] = [];

  for (const user of users) {
    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: {
        userId: user.id,
        timestamp: { gte: windowStart },
      },
      orderBy: { timestamp: 'asc' },
    });

    // Also get the most recent snapshot before the window for the start reference
    const startSnapshot = await prisma.portfolioSnapshot.findFirst({
      where: {
        userId: user.id,
        timestamp: { lt: windowStart },
      },
      orderBy: { timestamp: 'desc' },
    });

    // Get latest snapshot overall
    const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
      where: { userId: user.id },
      orderBy: { timestamp: 'desc' },
    });

    let returnPct: number | null = null;
    let returnDollar: number | null = null;
    let isEstimated = false;
    let basis: 'snapshots' | 'estimated' | 'none' = 'none';
    let startDateUsed: string | null = null;
    let endDateUsed: string | null = null;
    const currentAssets = latestSnapshot?.totalValue ?? null;

    if (startSnapshot && latestSnapshot && startSnapshot.id !== latestSnapshot.id) {
      // Have both start and end reference points
      returnPct = ((latestSnapshot.totalValue - startSnapshot.totalValue) / startSnapshot.totalValue) * 100;
      returnDollar = latestSnapshot.totalValue - startSnapshot.totalValue;
      basis = 'snapshots';
      startDateUsed = startSnapshot.timestamp.toISOString();
      endDateUsed = latestSnapshot.timestamp.toISOString();
    } else if (snapshots.length >= 2) {
      // No pre-window snapshot, but have snapshots within window - estimate
      const first = snapshots[0];
      const last = snapshots[snapshots.length - 1];
      const daysBetween = (last.timestamp.getTime() - first.timestamp.getTime()) / (1000 * 60 * 60 * 24);

      if (daysBetween > 0 && first.totalValue > 0) {
        const dailyReturn = Math.pow(last.totalValue / first.totalValue, 1 / daysBetween) - 1;
        const estReturn = Math.pow(1 + dailyReturn, windowDays) - 1;
        returnPct = estReturn * 100;
        returnDollar = first.totalValue * estReturn;
        isEstimated = true;
        basis = 'estimated';
        startDateUsed = first.timestamp.toISOString();
        endDateUsed = last.timestamp.toISOString();
      }
    }

    entries.push({
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      window,
      returnPct,
      returnDollar,
      isEstimated,
      basis,
      startDateUsed,
      endDateUsed,
      currentAssets,
    });
  }

  // Sort by returnPct descending, nulls last
  entries.sort((a, b) => {
    if (a.returnPct === null && b.returnPct === null) return 0;
    if (a.returnPct === null) return 1;
    if (b.returnPct === null) return -1;
    return b.returnPct - a.returnPct;
  });

  return entries;
}
