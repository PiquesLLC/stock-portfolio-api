import prisma from '../utils/prisma';
import { sendPushToUser } from './push.service';



const _ALERT_TYPES = ['drawdown', 'underperform_spy', '52w_high', '52w_low', 'ath', 'atl'] as const;
type AlertType = (typeof _ALERT_TYPES)[number];

const DEFAULT_ALERTS: { type: AlertType; threshold: number | null }[] = [
  { type: 'drawdown', threshold: 10 },        // Alert if drawdown > 10%
  { type: 'underperform_spy', threshold: 7 },  // Alert after 7 consecutive days underperforming SPY
  { type: '52w_high', threshold: null },
  { type: '52w_low', threshold: null },
  { type: 'ath', threshold: null },            // All-time high
  { type: 'atl', threshold: null },            // All-time low
];

export async function ensureDefaultAlerts(userId: string): Promise<void> {
  const existing = await prisma.alert.findMany({ where: { userId } });
  if (existing.length > 0) return;

  await prisma.alert.createMany({
    data: DEFAULT_ALERTS.map(a => ({
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
        // 52w_high, 52w_low, underperform_spy would need candle data
        // Skipping complex checks for now â€” they can be added when candle cache is richer
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

      // Fire-and-forget push notification
      sendPushToUser(userId, {
        title: 'Portfolio Alert',
        body: alertMessage,
        tag: `alert-${alertId}`,
        data: { type: 'alert', url: '/' },
      }).catch(() => {});
    }
  }
}


