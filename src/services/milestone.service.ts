import prisma from '../utils/prisma';
import { getPolygonQuotes } from '../utils/polygon';
import { get52WeekRange, getAllTimeRange } from '../utils/yahoo-finance';



// Track which milestones we've already notified (ticker-userId-type -> timestamp)
// This prevents spam if a stock hovers near a milestone
const recentNotifications = new Map<string, number>();
const NOTIFICATION_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

interface TickerHolders {
  ticker: string;
  userIds: string[];
}

/**
 * Check all portfolio holdings for 52-week and all-time high/low milestones.
 * Automatically checks every holding across all users - no manual alert setup required.
 */
export async function checkMilestoneAlerts(): Promise<void> {
  console.log('[Milestone] Starting automatic check for all holdings...');

  try {
    // Get all holdings grouped by ticker, with their user IDs
    const holdings = await prisma.holding.findMany({
      where: {
        shares: { gt: 0 }, // Only holdings with positive shares
      },
      select: {
        ticker: true,
        userId: true,
      },
    });

    if (holdings.length === 0) {
      console.log('[Milestone] No holdings found');
      return;
    }

    // Build map of ticker -> userIds who hold it
    const tickerHoldersMap = new Map<string, Set<string>>();
    for (const holding of holdings) {
      if (!holding.userId) continue;
      const ticker = holding.ticker.toUpperCase();
      if (!tickerHoldersMap.has(ticker)) {
        tickerHoldersMap.set(ticker, new Set());
      }
      tickerHoldersMap.get(ticker)!.add(holding.userId);
    }

    const tickerHolders: TickerHolders[] = Array.from(tickerHoldersMap.entries()).map(
      ([ticker, userIds]) => ({ ticker, userIds: Array.from(userIds) })
    );

    console.log(`[Milestone] Checking ${tickerHolders.length} tickers across ${holdings.length} holdings`);

    // Fetch quotes for all tickers
    const allTickers = tickerHolders.map(t => t.ticker);
    const { quotes } = await getPolygonQuotes(allTickers);

    // Process each ticker
    for (const { ticker, userIds } of tickerHolders) {
      const quote = quotes.get(ticker);
      if (!quote || quote.currentPrice <= 0) continue;

      const currentPrice = quote.currentPrice;

      // Get 52-week data from Yahoo Finance (accurate data)
      let week52High: number | null = null;
      let week52Low: number | null = null;

      try {
        const range = await get52WeekRange(ticker);
        if (range) {
          week52High = range.week52High;
          week52Low = range.week52Low;
        }
      } catch (err) {
        console.error(`[Milestone] Failed to get 52-week range for ${ticker}`);
      }

      // Get all-time data from Yahoo Finance (max range)
      let allTimeHigh: number | null = null;
      let allTimeLow: number | null = null;

      try {
        const allTimeData = await getAllTimeRange(ticker);
        if (allTimeData) {
          allTimeHigh = allTimeData.allTimeHigh;
          allTimeLow = allTimeData.allTimeLow;
        }
      } catch (err) {
        console.error(`[Milestone] Failed to get all-time range for ${ticker}`);
      }

      // Check milestones and create events for each user who holds this ticker
      const milestones = [
        { type: '52w_high', threshold: week52High, check: (p: number, t: number) => p >= t * 0.995, isHigh: true },
        { type: '52w_low', threshold: week52Low, check: (p: number, t: number) => p <= t * 1.005, isHigh: false },
        { type: 'ath', threshold: allTimeHigh, check: (p: number, t: number) => p >= t * 0.995, isHigh: true },
        { type: 'atl', threshold: allTimeLow, check: (p: number, t: number) => t > 0 && p <= t * 1.005, isHigh: false },
      ];

      for (const { type, threshold, check, isHigh } of milestones) {
        if (!threshold || !check(currentPrice, threshold)) continue;

        const isNewRecord = isHigh ? currentPrice > threshold : currentPrice < threshold;

        for (const userId of userIds) {
          const notificationKey = `${ticker}-${userId}-${type}`;
          const lastNotified = recentNotifications.get(notificationKey) || 0;
          const now = Date.now();

          // Skip if we've notified recently
          if (now - lastNotified < NOTIFICATION_COOLDOWN_MS) continue;

          // Check if we already have a recent event in the database
          const recentEvent = await prisma.milestoneEvent.findFirst({
            where: {
              userId,
              ticker,
              eventType: type,
              createdAt: { gte: new Date(now - NOTIFICATION_COOLDOWN_MS) },
            },
          });

          if (recentEvent) continue;

          // Create the milestone event
          const typeLabels: Record<string, string> = {
            '52w_high': '52-week high',
            '52w_low': '52-week low',
            'ath': 'all-time high',
            'atl': 'all-time low',
          };

          const message = isNewRecord
            ? `${ticker} hit a new ${typeLabels[type]} of $${currentPrice.toFixed(2)}`
            : `${ticker} is at its ${typeLabels[type]} of $${currentPrice.toFixed(2)}`;

          await prisma.milestoneEvent.create({
            data: {
              userId,
              ticker,
              eventType: type,
              message,
              currentPrice,
              thresholdPrice: threshold,
              isNewRecord,
            },
          });

          recentNotifications.set(notificationKey, now);
          console.log(`[Milestone] ${message} (user: ${userId.slice(0, 8)}...)`);
        }
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log('[Milestone] Check complete');
  } catch (err) {
    console.error('[Milestone] Error:', err);
    throw err;
  }
}

/**
 * Get milestone events for a user
 */
export async function getMilestoneEvents(userId: string, limit = 50): Promise<any[]> {
  return prisma.milestoneEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/**
 * Get unread milestone event count for a user
 */
export async function getUnreadMilestoneCount(userId: string): Promise<number> {
  return prisma.milestoneEvent.count({
    where: { userId, read: false },
  });
}

/**
 * Mark a milestone event as read
 */
export async function markMilestoneEventRead(eventId: string): Promise<void> {
  await prisma.milestoneEvent.update({
    where: { id: eventId },
    data: { read: true },
  });
}

/**
 * Mark all milestone events as read for a user
 */
export async function markAllMilestoneEventsRead(userId: string): Promise<void> {
  await prisma.milestoneEvent.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
}

