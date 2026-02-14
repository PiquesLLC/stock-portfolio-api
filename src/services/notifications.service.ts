import prisma from '../utils/prisma';
import { getEarningsData } from './earnings.service';

type NotificationType = 'earnings_alert';

function normalizeDate(dateStr?: string | null): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function getUpcomingEarningsDate(quarterly: { reportedDate: string; fiscalDateEnding: string }[], windowEnd: Date): Date | null {
  const now = new Date();
  let candidate: Date | null = null;

  for (const q of quarterly) {
    const d = normalizeDate(q.reportedDate) ?? normalizeDate(q.fiscalDateEnding);
    if (!d) continue;
    if (d < now || d > windowEnd) continue;
    if (!candidate || d < candidate) candidate = d;
  }

  return candidate;
}

export async function logNotification(input: {
  userId: string;
  type: NotificationType;
  status: 'sent' | 'failed' | 'skipped';
  channel?: string;
  title?: string;
  message?: string;
  refKey?: string;
  payload?: Record<string, unknown>;
  sentAt?: Date;
}): Promise<boolean> {
  try {
    await prisma.notificationAuditLog.create({
      data: {
        userId: input.userId,
        type: input.type,
        status: input.status,
        channel: input.channel,
        title: input.title,
        message: input.message,
        refKey: input.refKey,
        payload: input.payload ? JSON.stringify(input.payload) : null,
        sentAt: input.sentAt ?? new Date(),
      },
    });
    return true;
  } catch (err: any) {
    if (err?.code === 'P2002') return false;
    console.error('[Notifications] Log failed:', err);
    return false;
  }
}

export async function getNotificationStatus(userId: string): Promise<{
  earnings: { lastSentAt: string | null; lastStatus: string | null; lastMessage: string | null; lastRefKey: string | null };
}> {
  const last = await prisma.notificationAuditLog.findFirst({
    where: { userId, type: 'earnings_alert', status: 'sent' },
    orderBy: { sentAt: 'desc' },
  });

  return {
    earnings: {
      lastSentAt: last?.sentAt?.toISOString() ?? null,
      lastStatus: last?.status ?? null,
      lastMessage: last?.message ?? null,
      lastRefKey: last?.refKey ?? null,
    },
  };
}

export async function sendEarningsAlerts(windowDays = 7): Promise<{ sent: number; skipped: number; failed: number }> {
  const holdings = await prisma.holding.findMany({
    select: { userId: true, ticker: true },
  });

  const byUser = new Map<string, string[]>();
  for (const h of holdings) {
    if (!h.userId) continue;
    const list = byUser.get(h.userId) ?? [];
    list.push(h.ticker.toUpperCase());
    byUser.set(h.userId, list);
  }

  if (byUser.size === 0) return { sent: 0, skipped: 0, failed: 0 };

  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const [userId, tickers] of byUser.entries()) {
    const uniqueTickers = Array.from(new Set(tickers));

    for (const ticker of uniqueTickers) {
      try {
        const earnings = await getEarningsData(ticker);
        const nextDate = getUpcomingEarningsDate(earnings.quarterly, windowEnd);
        if (!nextDate) {
          skipped++;
          continue;
        }

        const refKey = `${ticker}:${nextDate.toISOString().slice(0, 10)}`;

        const logged = await logNotification({
          userId,
          type: 'earnings_alert',
          status: 'sent',
          channel: 'in_app',
          title: `${ticker} earnings coming up`,
          message: `${ticker} reports earnings on ${nextDate.toISOString().slice(0, 10)}.`,
          refKey,
          payload: { ticker, earningsDate: nextDate.toISOString() },
          sentAt: new Date(),
        });
        if (logged) sent++;
        else skipped++;
      } catch (err) {
        failed++;
        console.error(`[Notifications] Earnings alert failed for ${ticker}:`, err);
      }
    }
  }

  if (sent > 0 || failed > 0) {
    console.log(`[Notifications] Earnings alerts: ${sent} sent, ${skipped} skipped, ${failed} failed`);
  }

  return { sent, skipped, failed };
}
