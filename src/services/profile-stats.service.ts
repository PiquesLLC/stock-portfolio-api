import prisma from '../utils/prisma';

// In-memory lock to prevent thundering herd on concurrent profile views
const computeLocks = new Map<string, Promise<void>>();

/**
 * Compute win rate from PortfolioTrade sell events.
 * Uses aggregate cost per ticker (not lot-matched).
 */
export async function computeWinRate(userId: string): Promise<{ winRate: number | null; totalTrades: number; soldTickers: string[]; tickerMatchedCost: Map<string, number>; tickerSellProceeds: Map<string, number> }> {
  const sells = await prisma.portfolioTrade.findMany({
    where: { userId, type: 'sell' },
    orderBy: { date: 'asc' },
  });

  if (sells.length === 0) return { winRate: null, totalTrades: 0, soldTickers: [], tickerMatchedCost: new Map(), tickerSellProceeds: new Map() };

  const soldTickers = [...new Set(sells.map(s => s.ticker))];
  const buys = await prisma.portfolioTrade.findMany({
    where: { userId, type: 'buy', ticker: { in: soldTickers } },
    orderBy: { date: 'asc' },
  });

  // Aggregate buy cost AND shares per ticker so we can derive an average cost per
  // share and match it to the shares actually SOLD (realized cost basis).
  const buyCost = new Map<string, number>();
  const buyShares = new Map<string, number>();
  for (const b of buys) {
    buyCost.set(b.ticker, (buyCost.get(b.ticker) || 0) + b.shares * b.price);
    buyShares.set(b.ticker, (buyShares.get(b.ticker) || 0) + b.shares);
  }

  const tickerSellProceeds = new Map<string, number>();
  const sellShares = new Map<string, number>();
  for (const s of sells) {
    tickerSellProceeds.set(s.ticker, (tickerSellProceeds.get(s.ticker) || 0) + s.shares * s.price);
    sellShares.set(s.ticker, (sellShares.get(s.ticker) || 0) + s.shares);
  }

  // Realized cost of the SOLD shares = min(soldShares, boughtShares) * avgBuyCost.
  // Comparing FULL buy cost (including still-held shares) against only-sold proceeds
  // made every profitable trim book as a loss (win rate 0%, profit factor 0). F-H-4.
  const tickerMatchedCost = new Map<string, number>();
  let wins = 0;
  let total = 0;
  for (const ticker of soldTickers) {
    const totalBuyShares = buyShares.get(ticker) || 0;
    const totalBuyCost = buyCost.get(ticker) || 0;
    if (totalBuyShares <= 0 || totalBuyCost <= 0) continue; // no cost basis (transfer/short)
    const avgCost = totalBuyCost / totalBuyShares;
    const sold = Math.min(sellShares.get(ticker) || 0, totalBuyShares);
    const matchedCost = sold * avgCost;
    tickerMatchedCost.set(ticker, matchedCost);
    const proceeds = tickerSellProceeds.get(ticker) || 0;
    total++;
    if (proceeds > matchedCost) wins++;
  }

  return {
    winRate: total > 0 ? (wins / total) * 100 : null,
    totalTrades: sells.length,
    soldTickers,
    tickerMatchedCost,
    tickerSellProceeds,
  };
}

/**
 * Compute average hold period in days.
 * Returns null if no completed (buy+sell) round-trips exist.
 */
export async function computeAvgHoldPeriod(userId: string): Promise<number | null> {
  const trades = await prisma.portfolioTrade.findMany({
    where: { userId, type: { in: ['buy', 'sell'] } },
    orderBy: { date: 'asc' },
    select: { ticker: true, type: true, date: true },
  });

  if (trades.length === 0) return null;

  const firstBuy = new Map<string, Date>();
  const firstSell = new Map<string, Date>();

  for (const t of trades) {
    if (t.type === 'buy' && !firstBuy.has(t.ticker)) firstBuy.set(t.ticker, t.date);
    if (t.type === 'sell' && !firstSell.has(t.ticker)) firstSell.set(t.ticker, t.date);
  }

  let totalDays = 0;
  let count = 0;
  for (const [ticker, buyDate] of firstBuy) {
    const sellDate = firstSell.get(ticker);
    if (sellDate && sellDate > buyDate) {
      totalDays += (sellDate.getTime() - buyDate.getTime()) / (1000 * 60 * 60 * 24);
      count++;
    }
  }

  return count > 0 ? totalDays / count : null;
}

/**
 * Compute and upsert performance badges for a user.
 */
export async function computePerformanceBadges(userId: string): Promise<void> {
  const badges: { badge: string; window: string }[] = [];

  const stats = await prisma.profileStatsCache.findUnique({ where: { userId } });

  if (stats?.winRate != null && stats.winRate > 60) {
    badges.push({ badge: 'high_win_rate', window: 'ALL' });
  }

  if (stats?.avgHoldDays != null && stats.avgHoldDays > 180) {
    badges.push({ badge: 'diamond_hands', window: 'ALL' });
  }

  const holdings = await prisma.holding.findMany({
    where: { userId, shares: { gt: 0 } },
    select: { ticker: true },
  });
  if (holdings.length >= 10) {
    badges.push({ badge: 'diversified', window: 'ALL' });
  }

  const leaderboardEntry = await prisma.leaderboardCache.findFirst({
    where: { userId, window: '1Y' },
  });
  if (leaderboardEntry?.twrPct != null) {
    const totalEntries = await prisma.leaderboardCache.count({ where: { window: '1Y' } });
    const betterCount = await prisma.leaderboardCache.count({
      where: { window: '1Y', twrPct: { gt: leaderboardEntry.twrPct } },
    });
    if (totalEntries > 0 && (betterCount / totalEntries) < 0.1) {
      badges.push({ badge: 'top_10_pct', window: '1Y' });
    }
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Upsert earned badges
  for (const { badge, window } of badges) {
    await prisma.performanceBadge.upsert({
      where: { userId_badge_window: { userId, badge, window } },
      update: { earnedAt: now, expiresAt },
      create: { userId, badge, window, earnedAt: now, expiresAt },
    });
  }

  // Remove badges the user no longer qualifies for (don't let them linger)
  const earnedBadgeKeys = new Set(badges.map(b => `${b.badge}:${b.window}`));
  const existingBadges = await prisma.performanceBadge.findMany({
    where: { userId },
    select: { id: true, badge: true, window: true },
  });
  const toRemove = existingBadges.filter(b => !earnedBadgeKeys.has(`${b.badge}:${b.window}`));
  if (toRemove.length > 0) {
    await prisma.performanceBadge.deleteMany({
      where: { id: { in: toRemove.map(b => b.id) } },
    });
  }
}

/**
 * Refresh all profile stats for a user.
 * Reuses buy/sell data from computeWinRate to avoid redundant queries.
 */
export async function refreshProfileStats(userId: string): Promise<void> {
  const { winRate, totalTrades, tickerMatchedCost, tickerSellProceeds } = await computeWinRate(userId);
  const avgHoldDays = await computeAvgHoldPeriod(userId);

  // Compute profit factor from already-fetched data (no extra queries).
  // Uses the SOLD-share matched cost (not full buy cost) so a partial profitable
  // trim isn't scored as a loss — same root cause as the win-rate fix. F-H-4.
  let grossProfit = 0;
  let grossLoss = 0;
  for (const [ticker, proceeds] of tickerSellProceeds) {
    const cost = tickerMatchedCost.get(ticker) || 0;
    if (cost <= 0) continue; // Skip tickers with no buy cost (transferred/short)
    const pnl = proceeds - cost;
    if (pnl > 0) grossProfit += pnl;
    else grossLoss += Math.abs(pnl);
  }
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  await prisma.profileStatsCache.upsert({
    where: { userId },
    update: { winRate, totalTrades, avgHoldDays, profitFactor, computedAt: new Date() },
    create: { userId, winRate, totalTrades, avgHoldDays, profitFactor },
  });

  await computePerformanceBadges(userId);
}

/**
 * Get profile stats from cache. Recomputes if stale (>24h).
 * Uses in-memory lock to prevent thundering herd on concurrent requests.
 */
export async function getProfileStats(userId: string) {
  const cache = await prisma.profileStatsCache.findUnique({ where: { userId } });

  const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;
  if (!cache || cache.computedAt.getTime() < staleThreshold) {
    // Acquire lock: only one concurrent recomputation per user
    const existing = computeLocks.get(userId);
    if (existing) {
      await existing;
    } else {
      const promise = refreshProfileStats(userId).finally(() => computeLocks.delete(userId));
      computeLocks.set(userId, promise);
      await promise;
    }
    const refreshed = await prisma.profileStatsCache.findUnique({ where: { userId } });
    const badges = await prisma.performanceBadge.findMany({
      where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { badge: true, window: true, earnedAt: true },
    });
    return { stats: refreshed, badges };
  }

  const badges = await prisma.performanceBadge.findMany({
    where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { badge: true, window: true, earnedAt: true },
  });
  return { stats: cache, badges };
}
