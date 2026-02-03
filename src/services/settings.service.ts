import { PrismaClient } from '@prisma/client';
import { Settings, BaselineInput, BrokerLifetimeInput, YtdInput, PerformanceSummary } from '../types';
import { getPortfolio } from './portfolio.service';
import { getSnapshotsAfter } from './snapshot.service';
import { getTransactions } from './transaction.service';
import { calculateTWR, SnapshotPoint, CashflowEvent } from '../utils/finance-math';

const prisma = new PrismaClient();

export async function getSettings(): Promise<Settings> {
  let settings = await prisma.settings.findUnique({
    where: { id: 'default' },
  });

  if (!settings) {
    settings = await prisma.settings.create({
      data: { id: 'default', cashBalance: 0 },
    });
  }

  return settings as Settings;
}

export async function setBaseline(input: BaselineInput): Promise<Settings> {
  const portfolio = await getPortfolio();
  const now = new Date();

  // Set baseline based on current portfolio ASSETS (not net equity)
  // This ensures margin debt changes don't affect historical performance tracking
  const baselineTotalValue = portfolio.totalAssets;
  const baselineCashBalance = portfolio.cashBalance;

  const settings = await prisma.settings.upsert({
    where: { id: 'default' },
    update: {
      trackingStartDate: now,
      baselineTotalValue,
      baselineCashBalance,
      baselineType: input.type,
    },
    create: {
      id: 'default',
      cashBalance: portfolio.cashBalance,
      trackingStartDate: now,
      baselineTotalValue,
      baselineCashBalance,
      baselineType: input.type,
    },
  });

  return settings as Settings;
}

export async function setBrokerLifetime(input: BrokerLifetimeInput): Promise<Settings> {
  const settings = await prisma.settings.upsert({
    where: { id: 'default' },
    update: {
      brokerLifetimeDeposits: input.deposits,
      brokerLifetimeWithdrawals: input.withdrawals,
      brokerLifetimeValue: input.currentValue,
      brokerLifetimeAsOf: new Date(),
    },
    create: {
      id: 'default',
      cashBalance: 0,
      brokerLifetimeDeposits: input.deposits,
      brokerLifetimeWithdrawals: input.withdrawals,
      brokerLifetimeValue: input.currentValue,
      brokerLifetimeAsOf: new Date(),
    },
  });

  return settings as Settings;
}

export async function clearBrokerLifetime(): Promise<Settings> {
  const settings = await prisma.settings.update({
    where: { id: 'default' },
    data: {
      brokerLifetimeDeposits: null,
      brokerLifetimeWithdrawals: null,
      brokerLifetimeValue: null,
      brokerLifetimeAsOf: null,
    },
  });

  return settings as Settings;
}

export async function setYtdData(input: YtdInput): Promise<Settings> {
  const settings = await prisma.settings.upsert({
    where: { id: 'default' },
    update: {
      ytdStartEquity: input.ytdStartEquity,
      ytdNetContributions: input.netContributionsYTD ?? 0,
    },
    create: {
      id: 'default',
      cashBalance: 0,
      ytdStartEquity: input.ytdStartEquity,
      ytdNetContributions: input.netContributionsYTD ?? 0,
    },
  });
  return settings as Settings;
}

export async function clearYtdData(): Promise<Settings> {
  const settings = await prisma.settings.update({
    where: { id: 'default' },
    data: {
      ytdStartEquity: null,
      ytdNetContributions: null,
    },
  });
  return settings as Settings;
}

export async function activateTracking(): Promise<Settings> {
  const now = new Date();
  const settings = await prisma.settings.upsert({
    where: { id: 'default' },
    update: {
      trackingStartDate: now,
    },
    create: {
      id: 'default',
      cashBalance: 0,
      trackingStartDate: now,
    },
  });
  return settings as Settings;
}

export async function restartTracking(): Promise<Settings> {
  const now = new Date();
  const settings = await prisma.settings.upsert({
    where: { id: 'default' },
    update: {
      trackingStartDate: now,
      baselineTotalValue: null,
      baselineCashBalance: null,
      baselineType: null,
    },
    create: {
      id: 'default',
      cashBalance: 0,
      trackingStartDate: now,
    },
  });
  return settings as Settings;
}

export async function getPerformanceSummary(): Promise<PerformanceSummary> {
  const [settings, portfolio] = await Promise.all([
    getSettings(),
    getPortfolio(),
  ]);

  // Calculate holdings P/L (unrealized)
  const holdingsPL = {
    totalCost: portfolio.totalCost,
    currentValue: portfolio.holdingsValue, // Just holdings market value
    unrealizedPL: portfolio.totalPL,
    unrealizedPLPercent: portfolio.totalPLPercent,
  };

  // Calculate since tracking start (uses totalAssets - NO marginDebt)
  let sinceTracking: PerformanceSummary['sinceTracking'];

  if (settings.trackingStartDate && settings.baselineTotalValue !== null) {
    // Get snapshots since tracking start
    const snapshots = await getSnapshotsAfter(settings.trackingStartDate);

    const startingValue = settings.baselineTotalValue;
    // Use totalAssets (not netEquity) so margin debt changes don't affect performance
    const currentValue = portfolio.totalAssets;
    const absoluteReturn = currentValue - startingValue;
    const percentReturn = startingValue > 0 ? (absoluteReturn / startingValue) * 100 : 0;

    // Fetch transactions and calculate TWR
    const transactions = await getTransactions(null, settings.trackingStartDate);

    // Convert snapshots to SnapshotPoint format for TWR calculation
    const snapshotPoints: SnapshotPoint[] = [
      // Include starting point
      { date: settings.trackingStartDate, value: startingValue },
      ...snapshots.map(s => ({
        date: new Date(s.timestamp),
        value: s.totalValue, // totalValue = totalAssets in snapshots
      })),
    ];

    // Convert transactions to cashflow format
    const cashflows: CashflowEvent[] = transactions.map(t => ({
      date: new Date(t.date),
      amount: t.type === 'deposit' ? t.amount : -t.amount,
    }));

    // Calculate TWR (returns as decimal, e.g., 0.15 for 15%)
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
      currentValue: portfolio.totalAssets, // Use assets for consistency
      absoluteReturn: null,
      percentReturn: null,
      twrPercent: null,
      transactionCount: 0,
      snapshotCount: 0,
    };
  }

  // Broker lifetime (optional)
  let brokerLifetime: PerformanceSummary['brokerLifetime'] = null;

  if (settings.brokerLifetimeDeposits !== null && settings.brokerLifetimeValue !== null) {
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
