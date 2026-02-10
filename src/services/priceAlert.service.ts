import { PrismaClient } from '@prisma/client';
import { fetchPrices } from './market.service';

const prisma = new PrismaClient();

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

export async function getPriceAlertById(id: string) {
  return prisma.priceAlert.findUnique({
    where: { id },
    include: {
      events: {
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
    },
  });
}

export async function updatePriceAlert(id: string, data: UpdatePriceAlertInput) {
  return prisma.priceAlert.update({
    where: { id },
    data,
  });
}

export async function deletePriceAlert(id: string) {
  await prisma.priceAlert.delete({
    where: { id },
  });
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

export async function markEventRead(eventId: string) {
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

  // Get all enabled, non-triggered alerts (or repeat alerts that haven't triggered recently)
  const alerts = await prisma.priceAlert.findMany({
    where: {
      enabled: true,
      OR: [
        { triggered: false },
        { repeatAlert: true }, // Include repeat alerts even if triggered before
      ],
    },
  });

  if (alerts.length === 0) {
    return;
  }

  // Filter out expired alerts and disable them
  const activeAlerts = [];
  for (const alert of alerts) {
    if (alert.expiresAt && alert.expiresAt < now) {
      // Disable expired alert
      await prisma.priceAlert.update({
        where: { id: alert.id },
        data: { enabled: false },
      });
      console.log(`[Price Alerts] Expired and disabled: ${alert.ticker} alert`);
      continue;
    }
    activeAlerts.push(alert);
  }

  if (activeAlerts.length === 0) {
    return;
  }

  // Get unique tickers
  const tickers = [...new Set(activeAlerts.map(a => a.ticker))];

  // Fetch current quotes
  const { quotes, failedTickers } = await fetchPrices(tickers);

  if (failedTickers.length > 0) {
    console.log(`[Price Alerts] Could not fetch quotes for: ${failedTickers.join(', ')}`);
  }

  // Evaluate each alert
  for (const alert of activeAlerts) {
    // For repeat alerts that already triggered, skip if triggered within last hour
    if (alert.repeatAlert && alert.triggered && alert.triggeredAt) {
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      if (alert.triggeredAt > hourAgo) {
        continue; // Don't spam repeat alerts
      }
    }

    const quote = quotes.get(alert.ticker);
    if (!quote) {
      continue; // Skip if quote unavailable
    }

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
          const targetPrice = alert.referencePrice * (1 + alert.percentChange / 100);
          if (currentPrice >= targetPrice) {
            triggered = true;
            const actualPctChange = ((currentPrice - alert.referencePrice) / alert.referencePrice) * 100;
            message = `${alert.ticker} up ${actualPctChange.toFixed(1)}% from $${alert.referencePrice.toFixed(2)} (now $${currentPrice.toFixed(2)})`;
          }
        }
        break;

      case 'pct_down':
        if (alert.referencePrice !== null && alert.percentChange !== null) {
          const targetPrice = alert.referencePrice * (1 - alert.percentChange / 100);
          if (currentPrice <= targetPrice) {
            triggered = true;
            const actualPctChange = ((alert.referencePrice - currentPrice) / alert.referencePrice) * 100;
            message = `${alert.ticker} down ${actualPctChange.toFixed(1)}% from $${alert.referencePrice.toFixed(2)} (now $${currentPrice.toFixed(2)})`;
          }
        }
        break;
    }

    if (triggered) {
      // Update alert as triggered and create event
      await prisma.$transaction([
        prisma.priceAlert.update({
          where: { id: alert.id },
          data: {
            triggered: true,
            triggeredAt: new Date(),
          },
        }),
        prisma.priceAlertEvent.create({
          data: {
            priceAlertId: alert.id,
            triggerPrice: currentPrice,
            message,
            read: false,
          },
        }),
      ]);

      console.log(`[Price Alerts] Triggered: ${message}${alert.repeatAlert ? ' (repeat)' : ''}`);
    }
  }
}
