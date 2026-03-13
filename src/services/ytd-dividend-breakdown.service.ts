/**
 * YTD Dividend Breakdown Service
 * Returns detailed per-event YTD dividend data with dismiss/restore support.
 */

import prisma from '../utils/prisma';
import { insightsCache } from '../utils/finnhub';

export interface YtdDividendEntry {
  dividendEventId: string;
  ticker: string;
  payDate: string;
  amountPerShare: number;
  shares: number;
  income: number;
  dividendType: string;
  dismissed: boolean;
}

export interface YtdDividendBreakdown {
  entries: YtdDividendEntry[];
  totalIncome: number;
  totalDismissed: number;
  netIncome: number;
}

export async function getYtdDividendBreakdown(
  userId: string,
  portfolioId?: string
): Promise<YtdDividendBreakdown> {
  const where: any = { userId, shares: { gt: 0 } };
  if (portfolioId) where.portfolioId = portfolioId;

  const holdings = await prisma.holding.findMany({
    where,
    select: { ticker: true, shares: true },
  });

  if (holdings.length === 0) {
    return { entries: [], totalIncome: 0, totalDismissed: 0, netIncome: 0 };
  }

  // Aggregate shares across portfolios for the same ticker
  const sharesMap = new Map<string, number>();
  for (const h of holdings) {
    const t = h.ticker.toUpperCase();
    sharesMap.set(t, (sharesMap.get(t) ?? 0) + h.shares);
  }
  const tickers = Array.from(sharesMap.keys());

  const now = new Date();
  const ytdStart = new Date(now.getFullYear(), 0, 1);

  const [ytdEvents, dismissedRows] = await Promise.all([
    prisma.dividendEvent.findMany({
      where: {
        ticker: { in: tickers },
        payDate: { gte: ytdStart, lt: now },
      },
      select: { id: true, ticker: true, amountPerShare: true, payDate: true, dividendType: true },
      orderBy: { payDate: 'asc' },
    }),
    prisma.dismissedDividend.findMany({
      where: { userId },
      select: { dividendEventId: true },
    }),
  ]);

  const dismissedSet = new Set(dismissedRows.map(d => d.dividendEventId));

  let grossTotal = 0;
  let totalDismissed = 0;

  const entries: YtdDividendEntry[] = ytdEvents.map(ev => {
    const shares = sharesMap.get(ev.ticker.toUpperCase()) ?? 0;
    const income = Math.round(ev.amountPerShare * shares * 100) / 100;
    const dismissed = dismissedSet.has(ev.id);

    grossTotal += income;
    if (dismissed) {
      totalDismissed += income;
    }

    return {
      dividendEventId: ev.id,
      ticker: ev.ticker,
      payDate: ev.payDate.toISOString().slice(0, 10),
      amountPerShare: ev.amountPerShare,
      shares,
      income,
      dividendType: ev.dividendType,
      dismissed,
    };
  });

  return {
    entries,
    totalIncome: Math.round(grossTotal * 100) / 100,
    totalDismissed: Math.round(totalDismissed * 100) / 100,
    netIncome: Math.round((grossTotal - totalDismissed) * 100) / 100,
  };
}

function bustIncomeCache(userId: string) {
  // Income insights caches by key pattern: income-insights:{userId}:*
  const keys = insightsCache.keys().filter(k => k.startsWith(`income-insights:${userId}:`));
  for (const k of keys) insightsCache.del(k);
}

export async function dismissDividend(userId: string, dividendEventId: string): Promise<void> {
  // Validate FK exists before upsert to give a clean 404 instead of 500
  const event = await prisma.dividendEvent.findUnique({ where: { id: dividendEventId }, select: { id: true } });
  if (!event) {
    const err: any = new Error('Dividend event not found');
    err.status = 404;
    throw err;
  }
  await prisma.dismissedDividend.upsert({
    where: {
      userId_dividendEventId: { userId, dividendEventId },
    },
    create: { userId, dividendEventId },
    update: {},
  });
  bustIncomeCache(userId);
}

export async function restoreDividend(userId: string, dividendEventId: string): Promise<void> {
  await prisma.dismissedDividend.deleteMany({
    where: { userId, dividendEventId },
  });
  bustIncomeCache(userId);
}
