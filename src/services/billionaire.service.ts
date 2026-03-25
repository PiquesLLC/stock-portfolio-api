import prisma from '../utils/prisma';
import { fetchPrices, fetchDailyCandles, fetchIntradayCandles } from './market.service';

interface BillionaireHolding {
  ticker: string;
  shares: number;
  note?: string;
}

/**
 * Compute real-time net worth for a single billionaire from live stock prices.
 * publicWealth = sum(shares * currentPrice) for each holding
 * computedNetWorth = baseNetWorthUsd + publicWealth
 * dayChange = sum(shares * stockDayChange)
 */
export async function computeBillionaireNetWorth(id: string): Promise<void> {
  const b = await prisma.billionaire.findUnique({ where: { id } });
  if (!b) return;

  let holdings: BillionaireHolding[];
  try { holdings = JSON.parse(b.holdings); } catch { return; }

  const validHoldings = holdings.filter(h => h.ticker && h.shares);
  if (validHoldings.length === 0) {
    // No public holdings — net worth is just the base
    await prisma.billionaire.update({
      where: { id },
      data: {
        computedNetWorth: b.baseNetWorthUsd,
        dayChange: 0,
        dayChangePct: 0,
        computedAt: new Date(),
      },
    });
    return;
  }

  // Batch-fetch all ticker quotes at once (Polygon primary, Yahoo overlay, Finnhub fallback)
  const tickers = validHoldings.map(h => h.ticker.toUpperCase());
  const { quotes } = await fetchPrices(tickers);

  let publicValue = 0;
  let dayDelta = 0;

  for (const h of validHoldings) {
    const quote = quotes.get(h.ticker.toUpperCase());
    if (!quote || !quote.currentPrice) continue;
    publicValue += h.shares * quote.currentPrice;
    dayDelta += h.shares * (quote.change || 0);
  }

  const computedNetWorth = b.baseNetWorthUsd + publicValue;
  const prevNetWorth = computedNetWorth - dayDelta;
  const dayChangePct = prevNetWorth > 0 ? (dayDelta / prevNetWorth) * 100 : 0;

  await prisma.billionaire.update({
    where: { id },
    data: {
      computedNetWorth,
      dayChange: dayDelta,
      dayChangePct,
      computedAt: new Date(),
    },
  });
}

/**
 * Refresh all billionaires' net worth. Called every 60s during market hours.
 */
export async function refreshAllBillionaires(): Promise<void> {
  const billionaires = await prisma.billionaire.findMany({ select: { id: true } });
  for (const b of billionaires) {
    await computeBillionaireNetWorth(b.id).catch(err =>
      console.error(`[Billionaire] Refresh failed for ${b.id.slice(0, 8)}:`, err.message)
    );
  }
  // Recompute ranks after all net worths are updated
  await recomputeRanks();
  // Compute period changes (week/month/ytd) from snapshot history
  await computePeriodChanges().catch(err =>
    console.error('[Billionaire] Period change computation failed:', err.message)
  );
}

/**
 * Recompute ranks based on computedNetWorth descending.
 */
async function recomputeRanks(): Promise<void> {
  const sorted = await prisma.billionaire.findMany({
    where: { computedNetWorth: { not: null } },
    orderBy: { computedNetWorth: 'desc' },
    select: { id: true, rank: true },
  });
  for (let i = 0; i < sorted.length; i++) {
    const newRank = i + 1;
    if (sorted[i].rank !== newRank) {
      await prisma.billionaire.update({
        where: { id: sorted[i].id },
        data: { previousRank: sorted[i].rank, rank: newRank },
      });
    }
  }
}

/**
 * Compute week/month/ytd changes from the most recent snapshot near each boundary.
 */
async function computePeriodChanges(): Promise<void> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const monthAgo = new Date(now.getTime() - 30 * 86400000);
  const jan1 = new Date(now.getFullYear(), 0, 1);

  const billionaires = await prisma.billionaire.findMany({
    where: { computedNetWorth: { not: null } },
    select: { id: true, computedNetWorth: true },
  });

  for (const b of billionaires) {
    const currentNW = b.computedNetWorth!;
    // Find closest snapshot to each boundary
    const [weekSnap, monthSnap, ytdSnap] = await Promise.all([
      prisma.billionaireSnapshot.findFirst({
        where: { billionaireId: b.id, timestamp: { gte: new Date(weekAgo.getTime() - 86400000), lte: new Date(weekAgo.getTime() + 86400000) } },
        orderBy: { timestamp: 'asc' },
        select: { netWorth: true },
      }),
      prisma.billionaireSnapshot.findFirst({
        where: { billionaireId: b.id, timestamp: { gte: new Date(monthAgo.getTime() - 86400000), lte: new Date(monthAgo.getTime() + 86400000) } },
        orderBy: { timestamp: 'asc' },
        select: { netWorth: true },
      }),
      prisma.billionaireSnapshot.findFirst({
        where: { billionaireId: b.id, timestamp: { gte: new Date(jan1.getTime() - 86400000), lte: new Date(jan1.getTime() + 86400000) } },
        orderBy: { timestamp: 'asc' },
        select: { netWorth: true },
      }),
    ]);

    await prisma.billionaire.update({
      where: { id: b.id },
      data: {
        weekChange: weekSnap ? currentNW - weekSnap.netWorth : null,
        monthChange: monthSnap ? currentNW - monthSnap.netWorth : null,
        ytdChange: ytdSnap ? currentNW - ytdSnap.netWorth : null,
      },
    });
  }
}

/**
 * Snapshot all billionaires' current net worth for chart history.
 * Called every 30 minutes.
 */
export async function snapshotBillionaires(): Promise<void> {
  const billionaires = await prisma.billionaire.findMany({
    where: { computedNetWorth: { not: null } },
    select: { id: true, computedNetWorth: true },
  });
  if (billionaires.length === 0) return;

  await prisma.billionaireSnapshot.createMany({
    data: billionaires.map(b => ({
      billionaireId: b.id,
      netWorth: b.computedNetWorth!,
    })),
  });
}

/**
 * Get the full leaderboard sorted by net worth descending.
 */
export async function getBillionaireLeaderboard() {
  return prisma.billionaire.findMany({
    orderBy: { rank: 'asc' },
    select: {
      id: true, name: true, slug: true, photoUrl: true, company: true, title: true,
      country: true, industry: true, computedNetWorth: true, dayChange: true,
      dayChangePct: true, rank: true, previousRank: true, computedAt: true,
    },
  });
}

/**
 * Get a single billionaire by slug with holdings breakdown.
 */
export async function getBillionaireBySlug(slug: string) {
  const b = await prisma.billionaire.findUnique({ where: { slug } });
  if (!b) return null;

  let holdings: BillionaireHolding[] = [];
  try { holdings = JSON.parse(b.holdings); } catch {}

  return {
    ...b,
    holdingsParsed: holdings,
  };
}

/**
 * Get chart data for a billionaire — reconstructed from actual stock price candles.
 * Net worth at each candle = baseNetWorthUsd + sum(shares × close) for each holding.
 */
export async function getBillionaireChart(slug: string, period: string) {
  const b = await prisma.billionaire.findUnique({ where: { slug } });
  if (!b) return null;

  let holdings: BillionaireHolding[];
  try { holdings = JSON.parse(b.holdings); } catch { holdings = []; }
  const validHoldings = holdings.filter(h => h.ticker && h.shares);

  if (validHoldings.length === 0) {
    // No public holdings — flat line at base net worth
    return {
      points: [{ time: Date.now(), value: b.baseNetWorthUsd }],
      periodStartValue: b.baseNetWorthUsd,
    };
  }

  const ytdDays = Math.ceil((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000);
  const periodDays: Record<string, number> = {
    '1D': 1, '1W': 7, '1M': 30, '3M': 90, '6M': 180, 'YTD': ytdDays, '1Y': 365,
  };
  const days = periodDays[period] || 30;

  // Fetch candles for all holdings in parallel
  const tickers = validHoldings.map(h => h.ticker.toUpperCase());
  const candleResults = await Promise.all(
    tickers.map(t =>
      (period === '1D'
        ? fetchIntradayCandles(t)
        : fetchDailyCandles(t, days)
      ).catch(() => [])
    )
  );

  // Build a map of ticker → candles (time as ms, close as number)
  const candleMap = new Map<string, { time: number; close: number }[]>();
  tickers.forEach((t, i) => {
    const candles = candleResults[i]
      .filter((c: any) => c.close > 0)
      .map((c: any) => ({ time: typeof c.time === 'string' ? new Date(c.time).getTime() : c.time, close: c.close }));
    if (candles.length > 0) candleMap.set(t, candles);
  });

  if (candleMap.size === 0) {
    return {
      points: [{ time: Date.now(), value: b.computedNetWorth ?? b.baseNetWorthUsd }],
      periodStartValue: b.computedNetWorth ?? b.baseNetWorthUsd,
    };
  }

  // Find the ticker with the most candles — use its timestamps as the time axis
  let maxCandles: { time: number; close: number }[] = [];
  for (const candles of candleMap.values()) {
    if (candles.length > maxCandles.length) maxCandles = candles;
  }

  // For each timestamp, compute net worth = baseNetWorthUsd + sum(shares × closest price)
  const points: { time: number; value: number }[] = [];
  for (const ref of maxCandles) {
    let publicValue = 0;
    for (const h of validHoldings) {
      const candles = candleMap.get(h.ticker.toUpperCase());
      if (!candles) continue;
      // Find closest candle by time
      let closest = candles[0];
      for (const c of candles) {
        if (Math.abs(c.time - ref.time) < Math.abs(closest.time - ref.time)) closest = c;
      }
      publicValue += h.shares * closest.close;
    }
    points.push({ time: ref.time, value: b.baseNetWorthUsd + publicValue });
  }

  // periodStartValue = value at the start of the requested period
  // For YTD, find the closest point to Jan 1; for others, use the first point
  let periodStartValue = points.length > 0 ? points[0].value : b.baseNetWorthUsd;
  if (period === 'YTD' && points.length > 1) {
    const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();
    let closest = points[0];
    for (const p of points) {
      if (Math.abs(p.time - jan1) < Math.abs(closest.time - jan1)) closest = p;
    }
    periodStartValue = closest.value;
  }

  return { points, periodStartValue };
}

/**
 * Get today's biggest movers (gainers + losers).
 */
export async function getBillionaireMovers() {
  const all = await prisma.billionaire.findMany({
    where: { dayChange: { not: null } },
    orderBy: { dayChange: 'desc' },
    select: {
      name: true, slug: true, company: true, photoUrl: true,
      computedNetWorth: true, dayChange: true, dayChangePct: true,
    },
  });

  return {
    gainers: all.filter(b => (b.dayChange ?? 0) > 0).slice(0, 5),
    losers: all.filter(b => (b.dayChange ?? 0) < 0).reverse().slice(0, 5),
  };
}
