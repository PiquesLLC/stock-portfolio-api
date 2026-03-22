import prisma from '../utils/prisma';
import { sendPushToUser, sendNativePushToUser } from './push.service';



const _ALERT_TYPES = ['drawdown', 'underperform_spy', '52w_high', '52w_low', 'ath', 'atl', 'congress_trade'] as const;
type AlertType = (typeof _ALERT_TYPES)[number];

const DEFAULT_ALERTS: { type: AlertType; threshold: number | null }[] = [
  { type: 'drawdown', threshold: 10 },        // Alert if drawdown > 10%
  { type: 'underperform_spy', threshold: 7 },  // Alert after 7 consecutive days underperforming SPY
  { type: '52w_high', threshold: null },
  { type: '52w_low', threshold: null },
  { type: 'ath', threshold: null },            // All-time high
  { type: 'atl', threshold: null },            // All-time low
  { type: 'congress_trade', threshold: null }, // Congress member trades your holdings
];

export async function ensureDefaultAlerts(userId: string): Promise<void> {
  const existing = await prisma.alert.findMany({ where: { userId } });
  const existingTypes = new Set(existing.map(a => a.type));

  // Add any missing alert types (handles new types added after user was created)
  const missing = DEFAULT_ALERTS.filter(a => !existingTypes.has(a.type));
  if (missing.length === 0) return;

  await prisma.alert.createMany({
    data: missing.map(a => ({
      userId,
      type: a.type,
      threshold: a.threshold,
      enabled: true,
    })),
  });
}

export async function getUserAlerts(userId: string) {
  await ensureDefaultAlerts(userId);
  return prisma.alert.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function updateAlert(alertId: string, data: { threshold?: number | null; enabled?: boolean }, userId: string) {
  // Verify ownership
  const alert = await prisma.alert.findFirst({ where: { id: alertId, userId } });
  if (!alert) return null;
  return prisma.alert.update({ where: { id: alertId }, data });
}

export async function getAlertEvents(userId: string, limit = 50) {
  return prisma.alertEvent.findMany({
    where: {
      alert: { userId },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { alert: { select: { type: true } } },
  });
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.alertEvent.count({
    where: {
      alert: { userId },
      read: false,
    },
  });
}

export async function markEventRead(eventId: string, userId: string) {
  // Verify event belongs to user's alert
  const event = await prisma.alertEvent.findFirst({
    where: { id: eventId, alert: { userId } },
  });
  if (!event) return null;
  return prisma.alertEvent.update({ where: { id: eventId }, data: { read: true } });
}

export async function markAllRead(userId: string) {
  await prisma.alertEvent.updateMany({
    where: {
      alert: { userId },
      read: false,
    },
    data: { read: true },
  });
}

/**
 * Evaluate alerts for a user. Called periodically (e.g., on snapshot refresh).
 * Checks enabled alerts and creates events when conditions are met.
 */
export async function evaluateAlerts(userId: string): Promise<void> {
  const alerts = await prisma.alert.findMany({
    where: { userId, enabled: true },
  });

  for (const alert of alerts) {
    try {
      switch (alert.type) {
        case 'drawdown':
          await checkDrawdown(alert.id, userId, alert.threshold ?? 10);
          break;
        case 'congress_trade':
          break; // Handled by separate checkCongressTradeAlerts job
      }
    } catch (err) {
      console.error(`Alert evaluation failed for ${alert.type}:`, err);
    }
  }
}

async function checkDrawdown(alertId: string, userId: string, thresholdPct: number): Promise<void> {
  // Get recent snapshots to compute drawdown
  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: { userId },
    orderBy: { timestamp: 'desc' },
    take: 100,
  });

  if (snapshots.length < 2) return;

  const values = snapshots.map(s => s.netEquity ?? s.totalValue).reverse();
  let peak = values[0];
  let maxDrawdown = 0;

  for (const v of values) {
    if (v > peak) peak = v;
    const dd = ((peak - v) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  if (maxDrawdown >= thresholdPct) {
    // Only create event if we haven't already in the last 24h
    const recent = await prisma.alertEvent.findFirst({
      where: {
        alertId,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });

    if (!recent) {
      const alertMessage = `Portfolio drawdown reached ${maxDrawdown.toFixed(1)}% (threshold: ${thresholdPct}%)`;
      await prisma.alertEvent.create({
        data: {
          alertId,
          message: alertMessage,
          data: JSON.stringify({ maxDrawdown, threshold: thresholdPct }),
        },
      });

      // Fire-and-forget push notification (web + native for iOS)
      const pushPayload = {
        title: 'Portfolio Alert',
        body: alertMessage,
        tag: `alert-${alertId}`,
        data: { type: 'alert', url: '/' },
      };
      sendPushToUser(userId, pushPayload).catch(() => {});
      sendNativePushToUser(userId, pushPayload).catch(() => {});
    }
  }
}

/**
 * Check for recent congress trades matching user holdings.
 * Runs periodically (e.g., every 2 hours). Creates alert events and
 * sends push notifications for any new trades in the last 24 hours.
 */
export async function checkCongressTradeAlerts(): Promise<void> {
  // Staleness guard: skip if congress data is too old (sync may be broken)
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const latestTrade = await prisma.congressTrade.findFirst({
    where: { fetchedAt: { gte: sixHoursAgo } },
    select: { id: true },
  });
  if (!latestTrade) {
    console.warn('[Congress Alert] Skipping — no congress data fetched in last 6h (sync may be failing)');
    return;
  }

  // Find all users with congress_trade alert enabled
  const alerts = await prisma.alert.findMany({
    where: { type: 'congress_trade', enabled: true, userId: { not: null } },
    select: { id: true, userId: true },
  });

  if (alerts.length === 0) return;

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Use filingDate (disclosure date) instead of fetchedAt to avoid re-alerting
  // on the same trades being re-fetched by congress_sync
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  for (const alert of alerts) {
    const userId = alert.userId!;
    try {
      // Get user's holding tickers
      const holdings = await prisma.holding.findMany({
        where: { userId, shares: { gt: 0 } },
        select: { ticker: true },
      });

      if (holdings.length === 0) continue;

      const tickers = holdings.map(h => h.ticker.toUpperCase());

      // Query CongressTrade for matching tickers filed in last 7 days
      // (filingDate is when the trade was disclosed, not when we fetched it)
      const recentTrades = await prisma.congressTrade.findMany({
        where: {
          ticker: { in: tickers },
          filingDate: { gte: sevenDaysAgo },
        },
        orderBy: { tradeDate: 'desc' },
      });

      if (recentTrades.length === 0) continue;

      // 7-day dedup check — skip if we already fired an alert for this alertId in the
      // same filing window. Prevents the same trades from triggering daily notifications.
      const recentEvent = await prisma.alertEvent.findFirst({
        where: {
          alertId: alert.id,
          createdAt: { gte: sevenDaysAgo },
        },
      });

      if (recentEvent) continue;

      // Build summary from all matching trades
      const tradeDescriptions = recentTrades.slice(0, 5).map(t =>
        `Congress member ${t.politician} ${t.transactionType} ${t.ticker}`
      );
      const alertMessage = tradeDescriptions.length === 1
        ? tradeDescriptions[0]
        : `${tradeDescriptions[0]} (+${recentTrades.length - 1} more)`;

      await prisma.alertEvent.create({
        data: {
          alertId: alert.id,
          message: alertMessage,
          data: JSON.stringify({
            trades: recentTrades.slice(0, 10).map(t => ({
              politician: t.politician,
              ticker: t.ticker,
              transactionType: t.transactionType,
              chamber: t.chamber,
              tradeDate: t.tradeDate,
            })),
          }),
        },
      });

      // Fire-and-forget push notifications (truncate body for APNs 4KB limit)
      const pushPayload = {
        title: 'Congress Trade Alert',
        body: alertMessage.slice(0, 200),
        tag: `congress-trade-${alert.id}`,
        data: { type: 'congress_trade', url: '/congress' },
      };
      sendPushToUser(userId, pushPayload).catch(() => {});
      sendNativePushToUser(userId, pushPayload).catch(() => {});
    } catch (err) {
      console.error(`[Congress Alert] Error for user ${userId.slice(0, 8)}:`, err);
    }
  }
}
