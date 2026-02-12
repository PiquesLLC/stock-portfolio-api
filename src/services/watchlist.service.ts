import prisma from '../utils/prisma';
import { fetchPrices } from './market.service';

const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

export interface WatchlistSummary {
  totalValue: number;
  totalCost: number;
  totalPL: number;
  totalPLPercent: number;
  dayChange: number;
  dayChangePercent: number;
  holdingsCount: number;
}

export interface WatchlistHoldingView {
  ticker: string;
  shares: number;
  averageCost: number;
  currentPrice: number;
  currentValue: number;
  profitLoss: number;
  profitLossPercent: number;
  dayChange: number;
  dayChangePercent: number;
}

export async function getWatchlists(userId: string = SYSTEM_USER_ID) {
  const watchlists = await prisma.watchlist.findMany({
    where: { userId },
    include: {
      _count: { select: { holdings: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return watchlists.map(w => ({
    id: w.id,
    name: w.name,
    description: w.description,
    color: w.color,
    holdingsCount: w._count.holdings,
    createdAt: w.createdAt,
  }));
}

export async function getWatchlistDetail(id: string, userId: string = SYSTEM_USER_ID) {
  const watchlist = await prisma.watchlist.findFirst({
    where: { id, userId },
    include: { holdings: true },
  });

  if (!watchlist) return null;

  const tickers = watchlist.holdings.map(h => h.ticker.toUpperCase());
  const { quotes } = tickers.length > 0 ? await fetchPrices(tickers) : { quotes: new Map() as Map<string, any> };

  let totalValue = 0;
  let totalCost = 0;
  let dayChange = 0;

  const holdings: WatchlistHoldingView[] = watchlist.holdings.map(h => {
    const quote = quotes.get(h.ticker.toUpperCase());
    const currentPrice = quote?.currentPrice ?? 0;
    const previousClose = quote?.previousClose ?? currentPrice;
    const hasValidPrice = currentPrice > 0;

    const currentValue = hasValidPrice ? h.shares * currentPrice : 0;
    const holdingCost = h.shares * h.averageCost;
    const profitLoss = hasValidPrice ? currentValue - holdingCost : 0;
    const profitLossPercent = hasValidPrice && holdingCost > 0 ? (profitLoss / holdingCost) * 100 : 0;

    const previousValue = hasValidPrice ? h.shares * previousClose : 0;
    const holdingDayChange = hasValidPrice ? currentValue - previousValue : 0;
    const holdingDayChangePercent = hasValidPrice && previousValue > 0
      ? (holdingDayChange / previousValue) * 100
      : 0;

    if (hasValidPrice) {
      totalValue += currentValue;
      dayChange += holdingDayChange;
    }
    totalCost += holdingCost;

    return {
      ticker: h.ticker,
      shares: h.shares,
      averageCost: h.averageCost,
      currentPrice,
      currentValue,
      profitLoss,
      profitLossPercent,
      dayChange: holdingDayChange,
      dayChangePercent: holdingDayChangePercent,
    };
  });

  const totalPL = totalValue - totalCost;
  const totalPLPercent = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;
  const previousTotalValue = totalValue - dayChange;
  const dayChangePercent = previousTotalValue > 0 ? (dayChange / previousTotalValue) * 100 : 0;

  const summary: WatchlistSummary = {
    totalValue,
    totalCost,
    totalPL,
    totalPLPercent,
    dayChange,
    dayChangePercent,
    holdingsCount: watchlist.holdings.length,
  };

  return {
    id: watchlist.id,
    name: watchlist.name,
    description: watchlist.description,
    color: watchlist.color,
    holdings,
    summary,
  };
}

export async function createWatchlist(
  userId: string = SYSTEM_USER_ID,
  input: { name: string; description?: string; color?: string }
) {
  return prisma.watchlist.create({
    data: {
      userId,
      name: input.name,
      description: input.description ?? null,
      color: input.color ?? undefined,
    },
  });
}

export async function updateWatchlist(
  id: string,
  userId: string = SYSTEM_USER_ID,
  input: { name?: string; description?: string | null; color?: string }
) {
  const existing = await prisma.watchlist.findFirst({ where: { id, userId } });
  if (!existing) return null;

  return prisma.watchlist.update({
    where: { id },
    data: {
      name: input.name ?? undefined,
      description: input.description ?? undefined,
      color: input.color ?? undefined,
    },
  });
}

export async function deleteWatchlist(id: string, userId: string = SYSTEM_USER_ID) {
  const existing = await prisma.watchlist.findFirst({ where: { id, userId } });
  if (!existing) return null;
  await prisma.watchlist.delete({ where: { id } });
  return true;
}

async function ensureWatchlistOwned(watchlistId: string, userId: string) {
  const watchlist = await prisma.watchlist.findFirst({ where: { id: watchlistId, userId } });
  return watchlist ?? null;
}

export async function addWatchlistHolding(
  watchlistId: string,
  userId: string = SYSTEM_USER_ID,
  input: { ticker: string; shares: number; averageCost: number }
) {
  const watchlist = await ensureWatchlistOwned(watchlistId, userId);
  if (!watchlist) return null;

  const ticker = input.ticker.toUpperCase();

  const existing = await prisma.watchlistHolding.findFirst({
    where: { watchlistId, ticker },
  });

  if (existing) {
    return prisma.watchlistHolding.update({
      where: { id: existing.id },
      data: { shares: input.shares, averageCost: input.averageCost },
    });
  }

  return prisma.watchlistHolding.create({
    data: {
      watchlistId,
      ticker,
      shares: input.shares,
      averageCost: input.averageCost,
    },
  });
}

export async function updateWatchlistHolding(
  watchlistId: string,
  userId: string = SYSTEM_USER_ID,
  ticker: string,
  input: { shares?: number; averageCost?: number }
) {
  const watchlist = await ensureWatchlistOwned(watchlistId, userId);
  if (!watchlist) return null;

  const existing = await prisma.watchlistHolding.findFirst({
    where: { watchlistId, ticker: ticker.toUpperCase() },
  });
  if (!existing) return null;

  return prisma.watchlistHolding.update({
    where: { id: existing.id },
    data: {
      shares: input.shares ?? undefined,
      averageCost: input.averageCost ?? undefined,
    },
  });
}

export async function removeWatchlistHolding(
  watchlistId: string,
  userId: string = SYSTEM_USER_ID,
  ticker: string
) {
  const watchlist = await ensureWatchlistOwned(watchlistId, userId);
  if (!watchlist) return null;

  const existing = await prisma.watchlistHolding.findFirst({
    where: { watchlistId, ticker: ticker.toUpperCase() },
  });
  if (!existing) return null;

  await prisma.watchlistHolding.delete({ where: { id: existing.id } });
  return true;
}
