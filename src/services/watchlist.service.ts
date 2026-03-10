import prisma from '../utils/prisma';
import { fetchPrices } from './market.service';
import { fetchPolygonAggs } from '../utils/yahoo-http';
import NodeCache from 'node-cache';
import { PlanLimitError } from '../utils/plan-limit.error';


// Cache performance data for 15 minutes — balances freshness vs rate-limit protection
const perfCache = new NodeCache({ stdTTL: 900 });

export interface WatchlistSummary {
  totalValue: number;
  totalCost: number;
  totalPL: number;
  totalPLPercent: number;
  dayChange: number;
  dayChangePercent: number;
  regularDayChange: number;
  regularDayChangePercent: number;
  afterHoursChange: number;
  afterHoursChangePercent: number;
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
  weekChangePercent: number;
  monthChangePercent: number;
  yearChangePercent: number;
  peRatio: number | null;
}

interface TickerPerf { weekChangePercent: number; monthChangePercent: number; yearChangePercent: number }

function dateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

async function fetchTickerPerf(ticker: string): Promise<TickerPerf> {
  const cacheKey = `wl-perf:${ticker}`;
  const cached = perfCache.get<TickerPerf>(cacheKey);
  if (cached) return cached;

  const today = new Date().toISOString().split('T')[0];
  const yearAgo = dateDaysAgo(370); // slightly over 1yr to ensure we get data

  try {
    const data = await fetchPolygonAggs(ticker, 1, 'day', yearAgo, today);
    if (!data || data.closes.length < 2) {
      return { weekChangePercent: 0, monthChangePercent: 0, yearChangePercent: 0 };
    }

    const closes = data.closes;
    const current = closes[closes.length - 1];

    // ~5 trading days back for 1 week
    const weekIdx = Math.max(0, closes.length - 6);
    const weekAgoPrice = closes[weekIdx];

    // ~21 trading days back for 1 month
    const monthIdx = Math.max(0, closes.length - 22);
    const monthAgoPrice = closes[monthIdx];

    // First data point = ~1 year ago
    const yearAgoPrice = closes[0];

    const perf: TickerPerf = {
      weekChangePercent: weekAgoPrice > 0 ? ((current - weekAgoPrice) / weekAgoPrice) * 100 : 0,
      monthChangePercent: monthAgoPrice > 0 ? ((current - monthAgoPrice) / monthAgoPrice) * 100 : 0,
      yearChangePercent: yearAgoPrice > 0 ? ((current - yearAgoPrice) / yearAgoPrice) * 100 : 0,
    };

    perfCache.set(cacheKey, perf);
    return perf;
  } catch {
    return { weekChangePercent: 0, monthChangePercent: 0, yearChangePercent: 0 };
  }
}

/**
 * Batch-fetch performance data for multiple tickers.
 * Checks cache first, then fetches uncached tickers in parallel (max 6 concurrent).
 */
async function fetchBatchTickerPerf(tickers: string[]): Promise<Map<string, TickerPerf>> {
  const result = new Map<string, TickerPerf>();
  const uncached: string[] = [];

  for (const t of tickers) {
    const cached = perfCache.get<TickerPerf>(`wl-perf:${t}`);
    if (cached) {
      result.set(t, cached);
    } else {
      uncached.push(t);
    }
  }

  if (uncached.length > 0) {
    // Fetch uncached tickers in parallel, limited to 6 concurrent
    const BATCH = 6;
    for (let i = 0; i < uncached.length; i += BATCH) {
      const batch = uncached.slice(i, i + BATCH);
      const settled = await Promise.allSettled(
        batch.map(async t => {
          const perf = await fetchTickerPerf(t);
          return [t, perf] as const;
        })
      );
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          result.set(r.value[0], r.value[1]);
        }
      }
    }
  }

  // Fill missing with zeros
  const zero: TickerPerf = { weekChangePercent: 0, monthChangePercent: 0, yearChangePercent: 0 };
  for (const t of tickers) {
    if (!result.has(t)) result.set(t, zero);
  }

  return result;
}

async function fetchPERatios(tickers: string[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (tickers.length === 0) return result;

  const rows = await prisma.fundamentalsCache.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, overviewJson: true },
  });

  for (const row of rows) {
    try {
      const overview = typeof row.overviewJson === 'string'
        ? JSON.parse(row.overviewJson)
        : row.overviewJson;
      const pe = overview?.PERatio ? parseFloat(overview.PERatio) : null;
      result.set(row.ticker, pe && !isNaN(pe) ? pe : null);
    } catch {
      result.set(row.ticker, null);
    }
  }

  // Fill missing tickers with null
  for (const t of tickers) {
    if (!result.has(t)) result.set(t, null);
  }

  return result;
}

export async function getWatchlists(userId: string) {
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

export async function getWatchlistDetail(id: string, userId: string) {
  const watchlist = await prisma.watchlist.findFirst({
    where: { id, userId },
    include: { holdings: true },
  });

  if (!watchlist) return null;

  const tickers = watchlist.holdings.map(h => h.ticker.toUpperCase());
  const [{ quotes }, perfMap, peMap] = await Promise.all([
    tickers.length > 0 ? fetchPrices(tickers) : { quotes: new Map() as Map<string, any> },
    fetchBatchTickerPerf(tickers),
    fetchPERatios(tickers),
  ]);

  let totalValue = 0;
  let totalCost = 0;
  let dayChange = 0;
  let regularDayChange = 0;
  let afterHoursChange = 0;
  let regularHoldingsValue = 0;
  let previousHoldingsValue = 0;

  const holdings: WatchlistHoldingView[] = watchlist.holdings.map(h => {
    const upperTicker = h.ticker.toUpperCase();
    const quote = quotes.get(upperTicker);
    // During extended hours, use extendedPrice if available (premarket/after-hours price)
    const currentPrice = (quote?.extendedPrice && quote.extendedPrice > 0)
      ? quote.extendedPrice
      : (quote?.currentPrice ?? 0);
    const previousClose = quote?.previousClose ?? (quote?.currentPrice ?? currentPrice);
    const hasValidPrice = currentPrice > 0;
    const perf = perfMap.get(upperTicker) ?? { weekChangePercent: 0, monthChangePercent: 0, yearChangePercent: 0 };

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

      // Split regular vs after-hours using regularClose when available
      const regClose = (quote as any)?.regularClose ?? currentPrice;
      const regValue = h.shares * regClose;
      regularDayChange += regValue - previousValue;
      afterHoursChange += currentValue - regValue;
      regularHoldingsValue += regValue;
      previousHoldingsValue += previousValue;
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
      weekChangePercent: perf.weekChangePercent,
      monthChangePercent: perf.monthChangePercent,
      yearChangePercent: perf.yearChangePercent,
      peRatio: peMap.get(upperTicker) ?? null,
    };
  });

  const totalPL = totalValue - totalCost;
  const totalPLPercent = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;
  const previousTotalValue = totalValue - dayChange;
  const dayChangePercent = previousTotalValue > 0 ? (dayChange / previousTotalValue) * 100 : 0;

  const regularDayChangePercent = previousHoldingsValue > 0 ? (regularDayChange / previousHoldingsValue) * 100 : 0;
  const afterHoursChangePercent = regularHoldingsValue > 0 ? (afterHoursChange / regularHoldingsValue) * 100 : 0;

  const summary: WatchlistSummary = {
    totalValue,
    totalCost,
    totalPL,
    totalPLPercent,
    dayChange,
    dayChangePercent,
    regularDayChange,
    regularDayChangePercent,
    afterHoursChange,
    afterHoursChangePercent,
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
  userId: string,
  input: { name: string; description?: string; color?: string }
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true },
  });
  const plan = user?.plan ?? 'free';
  if (plan === 'free') {
    const count = await prisma.watchlist.count({ where: { userId } });
    if (count >= 1) {
      throw new PlanLimitError(1, 'free');
    }
  }

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
  userId: string,
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

export async function deleteWatchlist(id: string, userId: string) {
  const existing = await prisma.watchlist.findFirst({ where: { id, userId } });
  if (!existing) return null;
  await prisma.watchlist.delete({ where: { id } });
  return true;
}

async function ensureWatchlistOwned(watchlistId: string, userId: string) {
  const watchlist = await prisma.watchlist.findFirst({ where: { id: watchlistId, userId } });
  return watchlist ?? null;
}

const MAX_HOLDINGS_PER_WATCHLIST = 200;

export async function addWatchlistHolding(
  watchlistId: string,
  userId: string,
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

  // Cap holdings per watchlist to prevent API rate limit exhaustion
  const count = await prisma.watchlistHolding.count({ where: { watchlistId } });
  if (count >= MAX_HOLDINGS_PER_WATCHLIST) {
    throw new Error(`Watchlist limited to ${MAX_HOLDINGS_PER_WATCHLIST} holdings`);
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
  userId: string,
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
  userId: string,
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
