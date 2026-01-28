import { PrismaClient } from '@prisma/client';
import { PortfolioSnapshot } from '../types';
import { getPortfolio } from './portfolio.service';
import { config } from '../config';

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

    // Don't create snapshot if quotes are unavailable - data would be misleading
    if (portfolio.quotesUnavailableCount && portfolio.quotesUnavailableCount > 0) {
      console.log(
        `[Snapshot] Skipped - ${portfolio.quotesUnavailableCount} quotes unavailable`
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
      },
    });

    // Update in-memory timestamp
    lastSnapshotTime = snapshotTime.getTime();

    console.log(
      `[Snapshot] Created at ${snapshotTime.toISOString()} | ` +
      `totalAssets: $${portfolio.totalAssets.toFixed(2)} | ` +
      `cashBalance: $${portfolio.cashBalance.toFixed(2)} | ` +
      `totalPL: $${portfolio.totalPL.toFixed(2)} (${portfolio.totalPLPercent.toFixed(2)}%)`
    );

    return snapshot;
  } finally {
    isCreatingSnapshot = false;
  }
}

export async function getAllSnapshots(): Promise<PortfolioSnapshot[]> {
  return prisma.portfolioSnapshot.findMany({
    orderBy: { timestamp: 'asc' },
  });
}

export async function getSnapshotsAfter(startDate: Date): Promise<PortfolioSnapshot[]> {
  return prisma.portfolioSnapshot.findMany({
    where: {
      timestamp: {
        gte: startDate,
      },
    },
    orderBy: { timestamp: 'asc' },
  });
}

export async function getRecentSnapshots(limit: number): Promise<PortfolioSnapshot[]> {
  const snapshots = await prisma.portfolioSnapshot.findMany({
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
  return snapshots.reverse();
}

export async function getLatestSnapshot(): Promise<PortfolioSnapshot | null> {
  return prisma.portfolioSnapshot.findFirst({
    orderBy: { timestamp: 'desc' },
  });
}

export async function getSnapshotCount(): Promise<number> {
  return prisma.portfolioSnapshot.count();
}

// Utility to clean up duplicate snapshots (for fixing existing data)
export async function cleanupDuplicateSnapshots(): Promise<number> {
  // Get all snapshots
  const snapshots = await prisma.portfolioSnapshot.findMany({
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
