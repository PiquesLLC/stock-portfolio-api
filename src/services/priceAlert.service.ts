import prisma from '../utils/prisma';
import { getPolygonQuotes } from '../utils/polygon';



export type PriceAlertCondition = 'above' | 'below' | 'pct_up' | 'pct_down';
export type ReferencePriceType = 'current' | 'open' | 'avgCost';

export interface CreatePriceAlertInput {
  ticker: string;
  condition: PriceAlertCondition;
  targetPrice?: number;
  percentChange?: number;
  referencePrice?: number;
  referencePriceType?: ReferencePriceType;
  repeatAlert?: boolean;
  expiresAt?: string; // ISO date string
  userId?: string;
}

export interface UpdatePriceAlertInput {
  targetPrice?: number;
  percentChange?: number;
  enabled?: boolean;
}

export async function createPriceAlert(input: CreatePriceAlertInput) {
  const { ticker, condition, targetPrice, percentChange, referencePrice, referencePriceType, repeatAlert, expiresAt, userId } = input;

  // Validate based on condition type
  if ((condition === 'above' || condition === 'below') && targetPrice === undefined) {
    throw new Error('targetPrice is required for above/below conditions');
  }
  if ((condition === 'pct_up' || condition === 'pct_down') && percentChange === undefined) {
    throw new Error('percentChange is required for pct_up/pct_down conditions');
  }

  return prisma.priceAlert.create({
    data: {
      ticker: ticker.toUpperCase(),
      condition,
      targetPrice,
      percentChange,
      referencePrice,
      referencePriceType,
      repeatAlert: repeatAlert ?? false,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      userId,
      enabled: true,
      triggered: false,
    },
  });
}

export async function getPriceAlerts(ticker?: string, userId?: string) {
  const where: { ticker?: string; userId?: string } = {};
  if (ticker) where.ticker = ticker.toUpperCase();
  if (userId) where.userId = userId;

  return prisma.priceAlert.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      events: {
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
    },
  });
}

export async function getPriceAlertById(id: string, userId?: string) {
  return prisma.priceAlert.findFirst({
    where: { id, ...(userId ? { userId } : {}) },
    include: {
      events: {
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
    },
  });
}

export async function updatePriceAlert(id: string, data: UpdatePriceAlertInput, userId: string) {
  // Verify ownership first
  const alert = await prisma.priceAlert.findFirst({ where: { id, userId } });
  if (!alert) return null;
  return prisma.priceAlert.update({ where: { id }, data });
}

export async function deletePriceAlert(id: string, userId: string): Promise<boolean> {
  // Verify ownership first
  const alert = await prisma.priceAlert.findFirst({ where: { id, userId } });
  if (!alert) return false;
  await prisma.priceAlert.delete({ where: { id } });
  return true;
}

export async function getPriceAlertEvents(limit = 50, userId?: string) {
  // Include events for the user OR global alerts (userId is null)
  const where = userId
    ? { priceAlert: { OR: [{ userId }, { userId: null }] } }
    : {};

  return prisma.priceAlertEvent.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      priceAlert: {
        select: {
          ticker: true,
          condition: true,
          targetPrice: true,
          percentChange: true,
        },
      },
    },
  });
}

export async function markEventRead(eventId: string, userId: string) {
  // Verify event belongs to user's alert
  const event = await prisma.priceAlertEvent.findFirst({
    where: { id: eventId, priceAlert: { userId } },
  });
  if (!event) return null;
  return prisma.priceAlertEvent.update({
    where: { id: eventId },
    data: { read: true },
  });
}

export async function getUnreadCount(userId?: string): Promise<number> {
  // Include unread events for the user OR global alerts (userId is null)
  const where = userId
    ? { priceAlert: { OR: [{ userId }, { userId: null }] }, read: false }
    : { read: false };

  return prisma.priceAlertEvent.count({ where });
}

/**
 * Evaluate all active price alerts against current quotes.
 * Called periodically by the scheduler (every 60 seconds).
 */
export async function evaluatePriceAlerts(): Promise<void> {
  const now = new Date();

  const alerts = await prisma.priceAlert.findMany({
    where: {
      enabled: true,
      OR: [
        { triggered: false },
        { repeatAlert: true },
      ],
    },
  });

  if (alerts.length === 0) return;

  const activeAlerts = [];
  for (const alert of alerts) {
    if (alert.expiresAt && alert.expiresAt < now) {
      await prisma.priceAlert.update({
        where: { id: alert.id },
        data: { enabled: false },
      });
      continue;
    }
    activeAlerts.push(alert);
  }

  if (activeAlerts.length === 0) return;

  const tickers = [...new Set(activeAlerts.map(a => a.ticker))];
  const { quotes, failedTickers } = await getPolygonQuotes(tickers);

  if (failedTickers.length > 0) {
    console.log(`[Price Alerts] Could not fetch quotes for: ${failedTickers.join(', ')}`);
  }

  for (const alert of activeAlerts) {
    if (alert.repeatAlert && alert.triggered && alert.triggeredAt) {
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      if (alert.triggeredAt > hourAgo) continue;
    }

    const quote = quotes.get(alert.ticker);
    if (!quote) continue;

    const currentPrice = quote.currentPrice;
    let triggered = false;
    let message = '';

    switch (alert.condition) {
      case 'above':
        if (alert.targetPrice !== null && currentPrice >= alert.targetPrice) {
          triggered = true;
          message = `${alert.ticker} crossed above $${alert.targetPrice.toFixed(2)} (now $${currentPrice.toFixed(2)})`;
        }
        break;
      case 'below':
        if (alert.targetPrice !== null && currentPrice <= alert.targetPrice) {
          triggered = true;
          message = `${alert.ticker} crossed below $${alert.targetPrice.toFixed(2)} (now $${currentPrice.toFixed(2)})`;
        }
        break;
      case 'pct_up':
        if (alert.referencePrice !== null && alert.percentChange !== null) {
          const target = alert.referencePrice * (1 + alert.percentChange / 100);
          if (currentPrice >= target) {
            triggered = true;
            const actual = ((currentPrice - alert.referencePrice) / alert.referencePrice) * 100;
            message = `${alert.ticker} up ${actual.toFixed(1)}% from $${alert.referencePrice.toFixed(2)} (now $${currentPrice.toFixed(2)})`;
          }
        }
        break;
      case 'pct_down':
        if (alert.referencePrice !== null && alert.percentChange !== null) {
          const target = alert.referencePrice * (1 - alert.percentChange / 100);
          if (currentPrice <= target) {
            triggered = true;
            const actual = ((alert.referencePrice - currentPrice) / alert.referencePrice) * 100;
            message = `${alert.ticker} down ${actual.toFixed(1)}% from $${alert.referencePrice.toFixed(2)} (now $${currentPrice.toFixed(2)})`;
          }
        }
        break;
    }

    if (triggered) {
      await prisma.$transaction([
        prisma.priceAlert.update({
          where: { id: alert.id },
          data: { triggered: true, triggeredAt: new Date() },
        }),
        prisma.priceAlertEvent.create({
          data: { priceAlertId: alert.id, triggerPrice: currentPrice, message, read: false },
        }),
      ]);
    }
  }
}
