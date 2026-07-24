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

/**
 * Match an existing dividend by ex-date CALENDAR DAY, not exact timestamp.
 *
 * `@@unique([ticker, exDate, amountPerShare])` compares `exDate` exactly, but the
 * Yahoo and Polygon feeds stamp different times (13:30Z vs 14:30Z) for the same
 * dividend, so an exact-match upsert takes the `create` branch and duplicates the
 * row. Measured on prod 2026-07-24: 2,631 excess rows across 96 tickers. The
 * match runs in JS after Prisma decodes, because a SQL day-window predicate is
 * unreliable while `exDate` still holds both TEXT ISO and INTEGER epoch-ms values
 * (SQLite orders every INTEGER below every TEXT). Mirrors upsertByExDateDay in
 * dividend-fetch.service.ts.
 */
async function findByExDateDay(ticker: string, exDate: Date, amountPerShare: number) {
  const day = exDate.toISOString().slice(0, 10);
  // N+1 by construction — every row for the ticker, per call. Acceptable only
  // because the sole caller (dividend.controller.ts addDividendEvent) handles
  // one event per HTTP request. Do NOT wire this into a bulk import loop; hoist
  // the findMany out of the loop as dividend-fetch.service.ts does.
  // orderBy: oldest wins, matching the dedupe migration's survivor rule.
  const candidates = await prisma.dividendEvent.findMany({
    where: { ticker },
    orderBy: { createdAt: 'asc' },
    select: { id: true, exDate: true, amountPerShare: true },
  });
  return candidates.find(
    c => c.exDate.toISOString().slice(0, 10) === day
      // 4dp = the feeds' own published precision. A 1e-9 epsilon would miss
      // legacy unrounded rows (0.24499 vs 0.245) and leave duplicates behind.
      && Math.round(c.amountPerShare * 10000) === Math.round(amountPerShare * 10000),
  );
}

export async function createDividendEvent(input: DividendEventInput) {
  const normalizedType = input.dividendType ? input.dividendType.toLowerCase() : undefined;
  const ticker = input.ticker.toUpperCase();
  const exDate = new Date(input.exDate);
  const existing = await findByExDateDay(ticker, exDate, input.amountPerShare);

  if (existing) {
    return prisma.dividendEvent.update({
      where: { id: existing.id },
      data: {
        payDate: new Date(input.payDate),
        recordDate: input.recordDate ? new Date(input.recordDate) : undefined,
        dividendType: normalizedType ?? undefined,
        source: input.source ?? 'manual',
        status: 'confirmed',
      },
    });
  }

  return prisma.dividendEvent.create({
    data: {
      ticker,
      exDate,
      payDate: new Date(input.payDate),
      amountPerShare: input.amountPerShare,
      recordDate: input.recordDate ? new Date(input.recordDate) : null,
      dividendType: normalizedType ?? 'regular',
      source: input.source ?? 'manual',
      status: 'confirmed',
    },
  });
}

export async function getDividendEvents(options: {
  ticker?: string;
  fromDate?: Date;
  toDate?: Date;
  userId: string;
}) {
  // If no specific ticker requested, scope to user's held tickers
  let tickerFilter: { ticker?: string | { in: string[] } } = {};
  if (options.ticker) {
    tickerFilter = { ticker: options.ticker.toUpperCase() };
  } else {
    const holdings = await prisma.holding.findMany({
      where: {
        userId: options.userId,
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

export async function getUpcomingDividendEvents(userId: string) {
  // Only return events for tickers the user actually holds
  const holdings = await prisma.holding.findMany({
    where: {
      userId,
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
export async function getTotalDividendsBetween(userId: string, startDate: Date, endDate: Date): Promise<number> {
  // First try credits (actual posted amounts) — scoped to user
  const credits = await prisma.dividendCredit.findMany({
    where: {
      userId,
      status: 'posted',
      creditedAt: { gte: startDate, lte: endDate },
    },
  });

  if (credits.length > 0) {
    return credits.reduce((sum, c) => sum + c.amountGross, 0);
  }

  // Fallback: sum from events × user's shares (estimated)
  // Events are per-ticker, so filter by tickers the user holds
  const userHoldings = await prisma.holding.findMany({
    where: { userId },
    select: { ticker: true, shares: true },
  });
  if (userHoldings.length === 0) return 0;

  const tickerMap = new Map(userHoldings.map(h => [h.ticker.toUpperCase(), h.shares]));
  const events = await prisma.dividendEvent.findMany({
    where: {
      ticker: { in: [...tickerMap.keys()] },
      payDate: { gte: startDate, lte: endDate },
    },
  });

  return events.reduce((sum, e) => {
    const shares = tickerMap.get(e.ticker.toUpperCase()) ?? 0;
    return sum + e.amountPerShare * shares;
  }, 0);
}

export async function deleteDividendEvent(id: string) {
  // Prevent deletion if credits have been posted (affects other users' cash balances)
  const creditCount = await prisma.dividendCredit.count({
    where: { dividendEventId: id },
  });
  if (creditCount > 0) {
    const err = new Error('Cannot delete dividend event with posted credits');
    (err as Error & { code?: string }).code = 'HAS_CREDITS';
    throw err;
  }
  return prisma.dividendEvent.delete({
    where: { id },
  });
}

