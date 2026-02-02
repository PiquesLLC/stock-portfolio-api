/**
 * Dividend Posting Service
 * Credits dividends to user portfolios on pay date.
 * Idempotent — safe to run multiple times per day.
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Post dividends for all events with payDate on the given date.
 * For each event, finds users holding that ticker and credits them.
 */
export async function postDividendsForDate(date: Date = new Date()): Promise<{ posted: number; skipped: number }> {
  // Normalize to start/end of day
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  // Find all dividend events with payDate = today that haven't been fully posted
  const events = await prisma.dividendEvent.findMany({
    where: {
      payDate: { gte: dayStart, lte: dayEnd },
      status: { in: ['confirmed', 'preliminary'] },
    },
  });

  if (events.length === 0) return { posted: 0, skipped: 0 };

  let posted = 0;
  let skipped = 0;

  for (const event of events) {
    // Find all holdings of this ticker (across all users)
    const holdings = await prisma.holding.findMany({
      where: { ticker: event.ticker },
    });

    for (const holding of holdings) {
      const sharesEligible = holding.shares;
      if (sharesEligible <= 0) continue;

      const amountGross = Math.round(sharesEligible * event.amountPerShare * 100) / 100;

      try {
        // Use a transaction: create credit + update cash balance atomically
        await prisma.$transaction(async (tx) => {
          // Create dividend credit (unique constraint prevents double-posting)
          await tx.dividendCredit.create({
            data: {
              userId: holding.userId,
              ticker: event.ticker,
              dividendEventId: event.id,
              sharesEligible,
              amountGross,
              creditedAt: event.payDate,
              status: 'posted',
            },
          });

          // Increment cash balance
          if (holding.userId) {
            // Multi-user: update UserSettings
            await tx.userSettings.upsert({
              where: { userId: holding.userId },
              create: {
                userId: holding.userId,
                cashBalance: amountGross,
                marginDebt: 0,
              },
              update: {
                cashBalance: { increment: amountGross },
              },
            });
          } else {
            // Default user: update Settings
            await tx.settings.update({
              where: { id: 'default' },
              data: {
                cashBalance: { increment: amountGross },
              },
            });
          }
        });

        posted++;
        console.log(`[Dividend Post] Credited $${amountGross} to ${holding.userId ?? 'default'} for ${event.ticker} (${sharesEligible} shares × $${event.amountPerShare})`);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // Unique constraint violation — already posted, skip silently
          skipped++;
        } else {
          console.error(`[Dividend Post] Error posting for ${event.ticker} user=${holding.userId}:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  if (posted > 0 || skipped > 0) {
    console.log(`[Dividend Post] Date ${dayStart.toISOString().slice(0, 10)}: ${posted} posted, ${skipped} skipped (already posted)`);
  }

  return { posted, skipped };
}

/**
 * Backfill all missed dividend postings for events with payDate in the past.
 * Iterates each unique past payDate and calls postDividendsForDate.
 * Idempotent — safe to run multiple times.
 */
export async function backfillMissedDividends(): Promise<{ totalPosted: number; totalSkipped: number; datesProcessed: number }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Find all distinct past payDates that have unposted events
  const pastEvents = await prisma.dividendEvent.findMany({
    where: {
      payDate: { lt: today },
      status: { in: ['confirmed', 'preliminary'] },
    },
    select: { payDate: true },
    distinct: ['payDate'],
    orderBy: { payDate: 'asc' },
  });

  let totalPosted = 0;
  let totalSkipped = 0;

  for (const { payDate } of pastEvents) {
    const { posted, skipped } = await postDividendsForDate(payDate);
    totalPosted += posted;
    totalSkipped += skipped;
  }

  console.log(`[Dividend Backfill] Processed ${pastEvents.length} dates: ${totalPosted} posted, ${totalSkipped} skipped`);
  return { totalPosted, totalSkipped, datesProcessed: pastEvents.length };
}

/**
 * Get dividend summary for a user.
 */
export async function getDividendSummary(userId?: string | null): Promise<{
  totalYTD: number;
  totalAllTime: number;
  byTicker: { ticker: string; total: number; count: number }[];
}> {
  const ytdStart = new Date(new Date().getFullYear(), 0, 1);

  const credits = await prisma.dividendCredit.findMany({
    where: {
      userId: userId ?? null,
      status: 'posted',
    },
    orderBy: { creditedAt: 'desc' },
  });

  const totalAllTime = credits.reduce((sum, c) => sum + c.amountGross, 0);
  const totalYTD = credits
    .filter(c => c.creditedAt >= ytdStart)
    .reduce((sum, c) => sum + c.amountGross, 0);

  // Group by ticker
  const tickerMap = new Map<string, { total: number; count: number }>();
  for (const c of credits) {
    const existing = tickerMap.get(c.ticker) ?? { total: 0, count: 0 };
    existing.total += c.amountGross;
    existing.count++;
    tickerMap.set(c.ticker, existing);
  }

  const byTicker = Array.from(tickerMap.entries())
    .map(([ticker, data]) => ({ ticker, ...data }))
    .sort((a, b) => b.total - a.total);

  return {
    totalYTD: Math.round(totalYTD * 100) / 100,
    totalAllTime: Math.round(totalAllTime * 100) / 100,
    byTicker,
  };
}

/**
 * Get dividend credits (history) for a user.
 */
export async function getDividendCredits(userId?: string | null, ticker?: string): Promise<any[]> {
  return prisma.dividendCredit.findMany({
    where: {
      userId: userId ?? null,
      ...(ticker ? { ticker: ticker.toUpperCase() } : {}),
      status: 'posted',
    },
    include: {
      dividendEvent: true,
    },
    orderBy: { creditedAt: 'desc' },
  });
}
