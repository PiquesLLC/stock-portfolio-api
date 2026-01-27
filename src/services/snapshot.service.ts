import { PrismaClient } from '@prisma/client';
import { PortfolioSnapshot } from '../types';
import { getPortfolio } from './portfolio.service';
import { config } from '../config';

const prisma = new PrismaClient();

export async function createSnapshotIfNeeded(): Promise<PortfolioSnapshot | null> {
  const latestSnapshot = await prisma.portfolioSnapshot.findFirst({
    orderBy: { timestamp: 'desc' },
  });

  const now = new Date();
  const intervalMs = config.snapshotIntervalSeconds * 1000;

  if (latestSnapshot) {
    const timeSinceLastSnapshot = now.getTime() - new Date(latestSnapshot.timestamp).getTime();
    if (timeSinceLastSnapshot < intervalMs) {
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

  // Don't create snapshot if portfolio value seems suspiciously low
  const minValueForSnapshot = 100;
  if (portfolio.holdings.length > 0 && portfolio.totalValue < minValueForSnapshot) {
    console.log(
      `[Snapshot] Skipped - totalValue $${portfolio.totalValue.toFixed(2)} too low`
    );
    return null;
  }

  const previousSnapshot = latestSnapshot;

  let dailyPL = 0;
  let dailyPLPercent = 0;

  if (previousSnapshot && previousSnapshot.totalValue > 0) {
    dailyPL = portfolio.totalValue - previousSnapshot.totalValue;
    dailyPLPercent = (dailyPL / previousSnapshot.totalValue) * 100;
  }

  const snapshot = await prisma.portfolioSnapshot.create({
    data: {
      timestamp: now,
      totalValue: portfolio.totalValue,
      cashBalance: portfolio.cashBalance,
      dailyPL,
      dailyPLPercent,
      totalPL: portfolio.totalPL,
      totalPLPercent: portfolio.totalPLPercent,
    },
  });

  console.log(
    `[Snapshot] Created at ${now.toISOString()} | ` +
    `totalValue: $${portfolio.totalValue.toFixed(2)} | ` +
    `cashBalance: $${portfolio.cashBalance.toFixed(2)} | ` +
    `totalPL: $${portfolio.totalPL.toFixed(2)} (${portfolio.totalPLPercent.toFixed(2)}%)`
  );

  return snapshot;
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
