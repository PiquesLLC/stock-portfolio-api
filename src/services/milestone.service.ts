import prisma from '../utils/prisma';
import { getPolygonQuotes } from '../utils/polygon';
import { get52WeekRange, getAllTimeRange } from '../utils/yahoo-finance';
import { getMarketSession } from '../utils/market-hours';



// Track which milestones we've already notified (ticker-userId-type -> timestamp)
// This prevents spam if a stock hovers near a milestone
const recentNotifications = new Map<string, number>();

// Cooldowns per event type — ATH/ATL/52W use 4 hours to avoid spam during
// rapid price movements while still catching genuinely new records later in the day
const COOLDOWN_MS: Record<string, number> = {
  'ath': 4 * 60 * 60 * 1000,       // 4 hours
  'atl': 4 * 60 * 60 * 1000,       // 4 hours
  '52w_high': 4 * 60 * 60 * 1000,  // 4 hours
  '52w_low': 4 * 60 * 60 * 1000,   // 4 hours
};
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours fallback

interface TickerHolders {
  ticker: string;
  userIds: string[];
}

/**
 * Check all portfolio holdings for 52-week and all-time high/low milestones.
 * Automatically checks every holding across all users - no manual alert setup required.
 */
export async function checkMilestoneAlerts(): Promise<void> {
  // Skip on weekends — prices are stale Friday closes, not real milestones
  const session = getMarketSession();
  if (session === 'CLOSED') {
    const etDay = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    if (etDay === 'Sat' || etDay === 'Sun') {
      console.log('[Milestone] Skipping — market closed (weekend)');
      return;
    }
  }

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
      } catch (_err) {
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
      } catch (_err) {
        console.error(`[Milestone] Failed to get all-time range for ${ticker}`);
      }

      // Check milestones and create events for each user who holds this ticker.
      // ATH/ATL are checked FIRST so we can suppress redundant 52W notifications:
      //   - ATH firing suppresses 52W_HIGH (ATH implies 52-week high)
      //   - ATL firing suppresses 52W_LOW  (ATL implies 52-week low)
      const milestones = [
        { type: 'ath', threshold: allTimeHigh, check: (p: number, t: number) => p >= t, isHigh: true },
        { type: 'atl', threshold: allTimeLow, check: (p: number, t: number) => t > 0 && p <= t, isHigh: false },
        { type: '52w_high', threshold: week52High, check: (p: number, t: number) => p >= t * 0.998, isHigh: true },
        { type: '52w_low', threshold: week52Low, check: (p: number, t: number) => p <= t * 1.002, isHigh: false },
      ];

      // Track which users got ATH/ATL for this ticker in this cycle,
      // so we can suppress the redundant 52W counterpart
      const athFiredForUser = new Set<string>();
      const atlFiredForUser = new Set<string>();

      const typeLabels: Record<string, string> = {
        '52w_high': '52-week high',
        '52w_low': '52-week low',
        'ath': 'all-time high',
        'atl': 'all-time low',
      };

      for (const { type, threshold, check, isHigh } of milestones) {
        if (!threshold || !check(currentPrice, threshold)) continue;

        const isNewRecord = isHigh ? currentPrice > threshold : currentPrice < threshold;

        for (const userId of userIds) {
          // Suppress 52W_HIGH if ATH already fired for this ticker+user
          if (type === '52w_high' && athFiredForUser.has(userId)) {
            continue;
          }
          // Suppress 52W_LOW if ATL already fired for this ticker+user
          if (type === '52w_low' && atlFiredForUser.has(userId)) {
            continue;
          }

          const notificationKey = `${ticker}-${userId}-${type}`;
          const lastNotified = recentNotifications.get(notificationKey) || 0;
          const now = Date.now();
          const cooldown = COOLDOWN_MS[type] ?? DEFAULT_COOLDOWN_MS;

          // Skip if we've notified recently (in-memory cooldown)
          if (now - lastNotified < cooldown) continue;

          // Check if we already have a recent event in the database
          const recentEvent = await prisma.milestoneEvent.findFirst({
            where: {
              userId,
              ticker,
              eventType: type,
              createdAt: { gte: new Date(now - cooldown) },
            },
          });

          if (recentEvent) continue;

          // For 52W_HIGH suppression: also check if an ATH was recently created
          // in the DB (covers cases where ATH fired in a previous cycle within cooldown)
          if (type === '52w_high') {
            const recentAth = await prisma.milestoneEvent.findFirst({
              where: {
                userId,
                ticker,
                eventType: 'ath',
                createdAt: { gte: new Date(now - cooldown) },
              },
            });
            if (recentAth) continue;
          }
          if (type === '52w_low') {
            const recentAtl = await prisma.milestoneEvent.findFirst({
              where: {
                userId,
                ticker,
                eventType: 'atl',
                createdAt: { gte: new Date(now - cooldown) },
              },
            });
            if (recentAtl) continue;
          }

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

          // Record that ATH/ATL fired for this user so 52W counterpart is suppressed
          if (type === 'ath') athFiredForUser.add(userId);
          if (type === 'atl') atlFiredForUser.add(userId);

          console.log(`[Milestone] ${message}`);
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
 * Mark a milestone event as read (with ownership verification)
 */
export async function markMilestoneEventRead(eventId: string, userId: string): Promise<boolean> {
  const event = await prisma.milestoneEvent.findFirst({
    where: { id: eventId, userId },
  });
  if (!event) return false;
  await prisma.milestoneEvent.update({
    where: { id: eventId },
    data: { read: true },
  });
  return true;
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

