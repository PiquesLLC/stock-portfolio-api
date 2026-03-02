import prisma from '../utils/prisma';
import { BaselineInput, BrokerLifetimeInput, YtdInput, PerformanceSummary } from '../types';
import { getPortfolio } from './portfolio.service';
import { getSnapshotsAfter } from './snapshot.service';
import { getTransactions } from './transaction.service';
import { calculateTWR, SnapshotPoint, CashflowEvent } from '../utils/finance-math';

/**
 * Get per-user tracking settings.
 * Returns the UserSettings row for this user (or defaults if none exists).
 */
export async function getTrackingSettings(userId: string) {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
  });
  return settings;
}

export async function setBaseline(userId: string, input: BaselineInput) {
  const portfolio = await getPortfolio(userId);
  const now = new Date();

  const baselineTotalValue = portfolio.totalAssets;
  const baselineCashBalance = portfolio.cashBalance;

  const settings = await prisma.userSettings.upsert({
    where: { userId },
    update: {
      trackingStartDate: now,
      baselineTotalValue,
      baselineCashBalance,
      baselineType: input.type,
    },
    create: {
      userId,
      cashBalance: portfolio.cashBalance,
      trackingStartDate: now,
      baselineTotalValue,
      baselineCashBalance,
      baselineType: input.type,
    },
  });

  return settings;
}

export async function setBrokerLifetime(userId: string, input: BrokerLifetimeInput) {
  const settings = await prisma.userSettings.upsert({
    where: { userId },
    update: {
      brokerLifetimeDeposits: input.deposits,
      brokerLifetimeWithdrawals: input.withdrawals,
      brokerLifetimeValue: input.currentValue,
      brokerLifetimeAsOf: new Date(),
    },
    create: {
      userId,
      cashBalance: 0,
      brokerLifetimeDeposits: input.deposits,
      brokerLifetimeWithdrawals: input.withdrawals,
      brokerLifetimeValue: input.currentValue,
      brokerLifetimeAsOf: new Date(),
    },
  });

  return settings;
}

export async function clearBrokerLifetime(userId: string) {
  const settings = await prisma.userSettings.update({
    where: { userId },
    data: {
      brokerLifetimeDeposits: null,
      brokerLifetimeWithdrawals: null,
      brokerLifetimeValue: null,
      brokerLifetimeAsOf: null,
    },
  });

  return settings;
}

export async function setYtdData(userId: string, input: YtdInput) {
  const settings = await prisma.userSettings.upsert({
    where: { userId },
    update: {
      ytdStartEquity: input.ytdStartEquity,
      ytdNetContributions: input.netContributionsYTD ?? 0,
    },
    create: {
      userId,
      cashBalance: 0,
      ytdStartEquity: input.ytdStartEquity,
      ytdNetContributions: input.netContributionsYTD ?? 0,
    },
  });
  return settings;
}

export async function clearYtdData(userId: string) {
  const settings = await prisma.userSettings.update({
    where: { userId },
    data: {
      ytdStartEquity: null,
      ytdNetContributions: null,
    },
  });
  return settings;
}

export async function activateTracking(userId: string) {
  const now = new Date();
  const settings = await prisma.userSettings.upsert({
    where: { userId },
    update: {
      trackingStartDate: now,
    },
    create: {
      userId,
      cashBalance: 0,
      trackingStartDate: now,
    },
  });
  return settings;
}

export async function restartTracking(userId: string) {
  const now = new Date();
  const settings = await prisma.userSettings.upsert({
    where: { userId },
    update: {
      trackingStartDate: now,
      baselineTotalValue: null,
      baselineCashBalance: null,
      baselineType: null,
    },
    create: {
      userId,
      cashBalance: 0,
      trackingStartDate: now,
    },
  });
  return settings;
}

export async function getPerformanceSummary(userId: string): Promise<PerformanceSummary> {
  const [settings, portfolio] = await Promise.all([
    getTrackingSettings(userId),
    getPortfolio(userId),
  ]);

  // Calculate holdings P/L (unrealized)
  const holdingsPL = {
    totalCost: portfolio.totalCost,
    currentValue: portfolio.holdingsValue,
    unrealizedPL: portfolio.totalPL,
    unrealizedPLPercent: portfolio.totalPLPercent,
  };

  // Calculate since tracking start (uses totalAssets - NO marginDebt)
  let sinceTracking: PerformanceSummary['sinceTracking'];

  if (settings?.trackingStartDate && settings.baselineTotalValue != null) {
    const snapshots = await getSnapshotsAfter(userId, settings.trackingStartDate);

    const startingValue = settings.baselineTotalValue;
    const currentValue = portfolio.totalAssets;
    const absoluteReturn = currentValue - startingValue;
    const percentReturn = startingValue > 0 ? (absoluteReturn / startingValue) * 100 : 0;

    const transactions = await getTransactions(userId, settings.trackingStartDate);

    const snapshotPoints: SnapshotPoint[] = [
      { date: settings.trackingStartDate, value: startingValue },
      ...snapshots.map(s => ({
        date: new Date(s.timestamp),
        value: s.totalValue,
      })),
    ];

    const cashflows: CashflowEvent[] = transactions.map(t => ({
      date: new Date(t.date),
      amount: t.type === 'deposit' ? t.amount : -t.amount,
    }));

    const twrDecimal = calculateTWR(snapshotPoints, cashflows);
    const twrPercent = twrDecimal !== null ? twrDecimal * 100 : null;

    sinceTracking = {
      hasBaseline: true,
      startDate: settings.trackingStartDate.toISOString(),
      startingValue,
      currentValue,
      absoluteReturn,
      percentReturn,
      twrPercent,
      transactionCount: transactions.length,
      snapshotCount: snapshots.length,
    };
  } else {
    sinceTracking = {
      hasBaseline: false,
      startDate: null,
      startingValue: null,
      currentValue: portfolio.totalAssets,
      absoluteReturn: null,
      percentReturn: null,
      twrPercent: null,
      transactionCount: 0,
      snapshotCount: 0,
    };
  }

  // Broker lifetime (optional)
  let brokerLifetime: PerformanceSummary['brokerLifetime'] = null;

  if (settings?.brokerLifetimeDeposits != null && settings?.brokerLifetimeValue != null) {
    const deposits = settings.brokerLifetimeDeposits;
    const withdrawals = settings.brokerLifetimeWithdrawals ?? 0;
    const currentValue = settings.brokerLifetimeValue;
    const netContributions = deposits - withdrawals;
    const absoluteReturn = currentValue - netContributions;
    const percentReturn = netContributions > 0 ? (absoluteReturn / netContributions) * 100 : 0;

    brokerLifetime = {
      hasData: true,
      deposits,
      withdrawals,
      currentValue,
      netContributions,
      absoluteReturn,
      percentReturn,
      asOf: settings.brokerLifetimeAsOf?.toISOString() ?? null,
    };
  }

  return {
    sinceTracking,
    holdingsPL,
    brokerLifetime,
  };
}
