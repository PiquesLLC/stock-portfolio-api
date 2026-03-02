/**
 * DRIP (Dividend Reinvestment Plan) Service
 * Handles automatic dividend reinvestment into additional shares.
 */

import prisma from '../utils/prisma';
import { yahooGet } from '../utils/yahoo-http';

/**
 * Check if DRIP is enabled for a user.
 */
export async function isDripEnabled(userId: string): Promise<boolean> {
  const userSettings = await prisma.userSettings.findUnique({
    where: { userId },
  });
  return userSettings?.dripEnabled ?? false;
}

/**
 * Update DRIP settings for a user.
 */
export async function updateDripSettings(userId: string, enabled: boolean): Promise<void> {
  await prisma.userSettings.upsert({
    where: { userId },
    create: {
      userId,
      cashBalance: 0,
      marginDebt: 0,
      dripEnabled: enabled,
    },
    update: {
      dripEnabled: enabled,
    },
  });
}

/**
 * Fetch current stock price from Yahoo Finance.
 */
async function fetchCurrentPrice(ticker: string): Promise<number> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
  const resp = await yahooGet(url);

  const meta = resp.data?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) {
    throw new Error(`Could not fetch price for ${ticker}`);
  }
  return meta.regularMarketPrice;
}

/**
 * Reinvest a dividend credit into additional shares.
 * Creates a DividendReinvestment record, updates Holding shares and averageCost,
 * creates a Lot with source='drip', and deducts from cash balance.
 */
export async function reinvestDividend(
  creditId: string,
  userId: string
): Promise<{
  id: string;
  ticker: string;
  sharesPurchased: number;
  pricePerShare: number;
  totalAmount: number;
  fillDate: Date;
  status: string;
}> {
  // Get the dividend credit — scoped to the authenticated user's holdings
  const targetUserId = userId;
  const credit = await prisma.dividendCredit.findFirst({
    where: { id: creditId, userId: targetUserId },
    include: { reinvestment: true },
  });

  if (!credit) {
    throw new Error('Dividend credit not found');
  }

  if (credit.reinvestment) {
    throw new Error('Dividend already reinvested');
  }

  const ticker = credit.ticker;
  const amountToReinvest = credit.amountGross;

  // Fetch current stock price
  const pricePerShare = await fetchCurrentPrice(ticker);

  // Calculate shares to purchase (fractional shares allowed)
  const sharesPurchased = amountToReinvest / pricePerShare;

  // Get current holding to calculate new weighted average cost
  const holding = await prisma.holding.findFirst({
    where: {
      ticker,
      userId: userId,
    },
  });

  if (!holding) {
    throw new Error(`No holding found for ${ticker}`);
  }

  const now = new Date();

  // Perform the reinvestment in a transaction
  const reinvestment = await prisma.$transaction(async (tx) => {
    // 1. Create DividendReinvestment record
    const drip = await tx.dividendReinvestment.create({
      data: {
        userId: userId,
        dividendCreditId: creditId,
        ticker,
        sharesPurchased,
        pricePerShare,
        totalAmount: amountToReinvest,
        fillDate: now,
        status: 'completed',
      },
    });

    // 2. Update Holding: add shares and recalculate weighted average cost
    const newTotalShares = holding.shares + sharesPurchased;
    const oldTotalCost = holding.shares * holding.averageCost;
    const newTotalCost = oldTotalCost + amountToReinvest;
    const newAverageCost = newTotalShares > 0 ? newTotalCost / newTotalShares : 0;

    await tx.holding.update({
      where: { id: holding.id },
      data: {
        shares: newTotalShares,
        averageCost: Math.round(newAverageCost * 100) / 100,
      },
    });

    // 3. Create Lot record for the reinvested shares
    await tx.lot.create({
      data: {
        userId: userId,
        ticker,
        shares: sharesPurchased,
        costPerShare: pricePerShare,
        totalCost: amountToReinvest,
        acquiredAt: now,
        source: 'drip',
        notes: `DRIP from dividend credit ${creditId}`,
      },
    });

    // 4. Deduct from cash balance (dividend was already credited to cash)
    await tx.userSettings.update({
      where: { userId },
      data: {
        cashBalance: { decrement: amountToReinvest },
      },
    });

    return drip;
  });

  console.log(
    `[DRIP] Reinvested $${amountToReinvest.toFixed(2)} for ${ticker}: ` +
    `${sharesPurchased.toFixed(6)} shares @ $${pricePerShare.toFixed(2)}`
  );

  return {
    id: reinvestment.id,
    ticker: reinvestment.ticker,
    sharesPurchased: reinvestment.sharesPurchased,
    pricePerShare: reinvestment.pricePerShare,
    totalAmount: reinvestment.totalAmount,
    fillDate: reinvestment.fillDate,
    status: reinvestment.status,
  };
}

/**
 * Get all dividend reinvestments for a user.
 */
export async function getReinvestments(
  userId: string,
  ticker?: string
): Promise<Array<{
  id: string;
  dividendCreditId: string;
  ticker: string;
  sharesPurchased: number;
  pricePerShare: number;
  totalAmount: number;
  fillDate: Date;
  status: string;
  createdAt: Date;
}>> {
  const reinvestments = await prisma.dividendReinvestment.findMany({
    where: {
      userId: userId,
      ...(ticker ? { ticker: ticker.toUpperCase() } : {}),
    },
    orderBy: { fillDate: 'desc' },
  });

  return reinvestments.map((r) => ({
    id: r.id,
    dividendCreditId: r.dividendCreditId,
    ticker: r.ticker,
    sharesPurchased: r.sharesPurchased,
    pricePerShare: r.pricePerShare,
    totalAmount: r.totalAmount,
    fillDate: r.fillDate,
    status: r.status,
    createdAt: r.createdAt,
  }));
}

export interface DividendTimelineStep {
  date: string;
  completed: boolean;
}

export interface DividendReinvestmentStep {
  date: string | null;
  completed: boolean;
  sharesPurchased: number | null;
  pricePerShare: number | null;
}

export interface DividendTimeline {
  creditId: string;
  ticker: string;
  sharesEligible: number;
  amountPerShare: number;
  totalAmount: number;
  steps: {
    announced: DividendTimelineStep;
    payment: DividendTimelineStep;
    reinvestment: DividendReinvestmentStep | null;
  };
}

/**
 * Get the timeline for a dividend credit (for UI display).
 * Shows: Announced â†’ Payment â†’ Reinvestment
 */
export async function getDividendTimeline(creditId: string, userId: string): Promise<DividendTimeline> {
  const credit = await prisma.dividendCredit.findFirst({
    where: { id: creditId, userId },
    include: {
      dividendEvent: true,
      reinvestment: true,
    },
  });

  if (!credit) {
    throw new Error('Dividend credit not found');
  }

  const event = credit.dividendEvent;
  const now = new Date();

  const timeline: DividendTimeline = {
    creditId: credit.id,
    ticker: credit.ticker,
    sharesEligible: credit.sharesEligible,
    amountPerShare: event.amountPerShare,
    totalAmount: credit.amountGross,
    steps: {
      announced: {
        date: event.exDate.toISOString(),
        completed: event.exDate <= now,
      },
      payment: {
        date: event.payDate.toISOString(),
        completed: credit.status === 'posted',
      },
      reinvestment: null,
    },
  };

  // Add reinvestment step if DRIP was used
  if (credit.reinvestment) {
    timeline.steps.reinvestment = {
      date: credit.reinvestment.fillDate.toISOString(),
      completed: credit.reinvestment.status === 'completed',
      sharesPurchased: credit.reinvestment.sharesPurchased,
      pricePerShare: credit.reinvestment.pricePerShare,
    };
  }

  return timeline;
}

/**
 * Get DRIP settings for a user.
 */
export async function getDripSettings(userId: string): Promise<{ enabled: boolean }> {
  const enabled = await isDripEnabled(userId);
  return { enabled };
}

