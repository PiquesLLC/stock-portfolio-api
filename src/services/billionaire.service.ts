import prisma from '../utils/prisma';
import { fetchPrices } from './market.service';

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
 * Get chart data (snapshots) for a billionaire.
 */
export async function getBillionaireChart(slug: string, period: string) {
  const b = await prisma.billionaire.findUnique({ where: { slug }, select: { id: true } });
  if (!b) return null;

  const periodMs: Record<string, number> = {
    '1D': 24 * 60 * 60 * 1000,
    '1W': 7 * 24 * 60 * 60 * 1000,
    '1M': 30 * 24 * 60 * 60 * 1000,
    '3M': 90 * 24 * 60 * 60 * 1000,
    '6M': 180 * 24 * 60 * 60 * 1000,
    '1Y': 365 * 24 * 60 * 60 * 1000,
    'ALL': 10 * 365 * 24 * 60 * 60 * 1000,
  };

  const since = new Date(Date.now() - (periodMs[period] || periodMs['1M']));

  const snapshots = await prisma.billionaireSnapshot.findMany({
    where: { billionaireId: b.id, timestamp: { gte: since } },
    orderBy: { timestamp: 'asc' },
    select: { netWorth: true, timestamp: true },
  });

  return {
    points: snapshots.map(s => ({ time: s.timestamp.getTime(), value: s.netWorth })),
    periodStartValue: snapshots.length > 0 ? snapshots[0].netWorth : 0,
  };
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
