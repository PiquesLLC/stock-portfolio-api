/**
 * Dividend Service â€” CRUD operations for dividend events.
 * Updated for new schema with exDate, payDate, amountPerShare.
 */

import prisma from '../utils/prisma';



export interface DividendEventInput {
  ticker: string;
  exDate: string;       // ISO date
  payDate: string;      // ISO date
  amountPerShare: number;
  recordDate?: string;
  dividendType?: string;
  source?: string;
}

export async function createDividendEvent(input: DividendEventInput) {
  return prisma.dividendEvent.upsert({
    where: {
      ticker_exDate_amountPerShare: {
        ticker: input.ticker.toUpperCase(),
        exDate: new Date(input.exDate),
        amountPerShare: input.amountPerShare,
      },
    },
    create: {
      ticker: input.ticker.toUpperCase(),
      exDate: new Date(input.exDate),
      payDate: new Date(input.payDate),
      amountPerShare: input.amountPerShare,
      recordDate: input.recordDate ? new Date(input.recordDate) : null,
      dividendType: input.dividendType ?? 'regular',
      source: input.source ?? 'manual',
      status: 'confirmed',
    },
    update: {
      payDate: new Date(input.payDate),
      recordDate: input.recordDate ? new Date(input.recordDate) : undefined,
      dividendType: input.dividendType ?? undefined,
      source: input.source ?? 'manual',
      status: 'confirmed',
    },
  });
}

export async function getDividendEvents(options?: {
  ticker?: string;
  fromDate?: Date;
  toDate?: Date;
  userId?: string | null;
}) {
  // If no specific ticker requested, scope to user's held tickers
  let tickerFilter: { ticker?: string | { in: string[] } } = {};
  if (options?.ticker) {
    tickerFilter = { ticker: options.ticker.toUpperCase() };
  } else {
    const holdings = await prisma.holding.findMany({
      where: {
        userId: options?.userId ?? null,
        shares: { gt: 0 },
      },
      select: { ticker: true },
    });
    const heldTickers = holdings.map(h => h.ticker);
    if (heldTickers.length === 0) return [];
    tickerFilter = { ticker: { in: heldTickers } };
  }

  return prisma.dividendEvent.findMany({
    where: {
      ...tickerFilter,
      ...(options?.fromDate || options?.toDate ? {
        exDate: {
          ...(options?.fromDate ? { gte: options.fromDate } : {}),
          ...(options?.toDate ? { lte: options.toDate } : {}),
        },
      } : {}),
    },
    orderBy: { exDate: 'desc' },
  });
}

export async function getUpcomingDividendEvents(userId?: string | null) {
  // Only return events for tickers the user actually holds
  const holdings = await prisma.holding.findMany({
    where: {
      userId: userId ?? null,
      shares: { gt: 0 },
    },
    select: { ticker: true },
  });

  const heldTickers = holdings.map(h => h.ticker);
  if (heldTickers.length === 0) return [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return prisma.dividendEvent.findMany({
    where: {
      payDate: { gte: today },
      ticker: { in: heldTickers },
    },
    orderBy: { payDate: 'asc' },
  });
}

/**
 * Get total dividend amount between two dates (for projection service compat).
 * Uses DividendCredit (posted amounts) if available, falls back to events.
 */
export async function getTotalDividendsBetween(startDate: Date, endDate: Date): Promise<number> {
  // First try credits (actual posted amounts)
  const credits = await prisma.dividendCredit.findMany({
    where: {
      status: 'posted',
      creditedAt: { gte: startDate, lte: endDate },
    },
  });

  if (credits.length > 0) {
    return credits.reduce((sum, c) => sum + c.amountGross, 0);
  }

  // Fallback: sum from events (estimated)
  const events = await prisma.dividendEvent.findMany({
    where: {
      payDate: { gte: startDate, lte: endDate },
    },
  });

  return events.reduce((sum, e) => sum + e.amountPerShare, 0);
}

export async function deleteDividendEvent(id: string) {
  // Delete associated credits first
  await prisma.dividendCredit.deleteMany({
    where: { dividendEventId: id },
  });
  return prisma.dividendEvent.delete({
    where: { id },
  });
}

