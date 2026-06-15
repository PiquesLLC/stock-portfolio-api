import prisma from '../utils/prisma';
import { fetchPrices } from './market.service';
import { Portfolio } from '../types';
import { getMarketSession, isOpenedTodayET } from '../utils/market-hours';



// User-specific portfolio used for public profiles/leaderboards (not the system/default portfolio).
export async function getUserPortfolio(userId: string): Promise<Portfolio | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      settings: {
        select: { cashBalance: true, marginDebt: true },
      },
    },
  });

  if (!user) return null;

  const scopedHoldings = await prisma.holding.findMany({
    where: { userId, portfolioId: { not: null } },
    orderBy: { ticker: 'asc' },
  });

  const holdings = scopedHoldings.length > 0
    ? scopedHoldings
    : await prisma.holding.findMany({
        where: { userId },
        orderBy: { ticker: 'asc' },
      });

  const cashBalance = user.settings?.cashBalance ?? 0;
  const marginDebt = user.settings?.marginDebt ?? 0;

  if (holdings.length === 0) {
    return {
      holdings: [],
      options: [],
      cashBalance,
      marginDebt,
      holdingsValue: 0,
      totalAssets: cashBalance,
      netEquity: cashBalance - marginDebt,
      totalValue: cashBalance,
      totalCost: 0,
      totalPL: 0,
      totalPLPercent: 0,
      dayChange: 0,
      dayChangePercent: 0,
      regularDayChange: 0,
      regularDayChangePercent: 0,
      afterHoursChange: 0,
      afterHoursChangePercent: 0,
    };
  }

  const tickers = holdings.map((h) => h.ticker);
  const quotesResult = await fetchPrices(tickers);
  const session = getMarketSession();

  let holdingsValue = 0;
  let regularHoldingsValue = 0;
  let totalCost = 0;
  let dayChange = 0;
  let regularDayChange = 0;
  let afterHoursChange = 0;

  const enrichedHoldings = holdings.map((h) => {
    const quote = quotesResult.quotes.get(h.ticker);
    const priceUnavailable = !quote;
    const priceIsStale = quote?.isStale ?? false;
    const isRepricing = quote?.isRepricing ?? priceUnavailable;
    const quoteAgeSeconds = quote?.quoteAgeSeconds;

    // CRITICAL: Never use averageCost as fallback â€” it inflates portfolio value
    // If we don't have a quote, mark as unavailable but don't calculate incorrect values
    const currentPrice = (quote?.extendedPrice && quote.extendedPrice > 0)
      ? quote.extendedPrice
      : (quote?.currentPrice ?? 0);
    const previousClose = quote?.previousClose ?? (quote?.currentPrice ?? currentPrice);

    // Only calculate market values if we have a valid price
    const hasValidPrice = quote && currentPrice > 0;

    const currentValue = hasValidPrice ? h.shares * currentPrice : 0;
    const cost = h.averageCost * h.shares;

    // If price is unavailable, don't compute P/L (it would be misleading)
    const pl = hasValidPrice ? currentValue - cost : 0;
    const plPct = hasValidPrice && cost > 0 ? (pl / cost) * 100 : 0;

    // Day P&L anchor: positions opened today anchor at cost basis, not
    // previousClose (the holder didn't own them at yesterday's close). Mirrors
    // getPortfolio so the profile page and dashboard show the same "today" — and
    // so the dailyPL this path persists via createUserSnapshotIfNeeded agrees
    // with the leaderboard-refresh writer for the same snapshot.
    const dayAnchor = isOpenedTodayET(h.createdAt) && h.averageCost > 0 ? h.averageCost : previousClose;
    const previousValue = hasValidPrice ? h.shares * dayAnchor : 0;
    const dc = hasValidPrice ? currentValue - previousValue : 0;
    const dcPct = hasValidPrice && previousValue > 0
      ? (dc / previousValue) * 100
      : 0;

    // Only add to totals if we have valid price data
    if (hasValidPrice) {
      holdingsValue += currentValue;
      dayChange += dc;

      const regClose = quote?.regularClose ?? currentPrice;
      const regValue = h.shares * regClose;
      regularHoldingsValue += regValue;
      regularDayChange += regValue - previousValue;
      afterHoursChange += currentValue - regValue;
      // Only count cost for priced holdings — mirrors getPortfolio (portfolio.service.ts)
      // so the public profile and the owner's dashboard show the same total return
      // when a quote is missing.
      totalCost += cost;
    }

    return {
      id: h.id,
      ticker: h.ticker,
      shares: h.shares,
      averageCost: h.averageCost,
      createdAt: h.createdAt,
      updatedAt: h.updatedAt,
      currentPrice: hasValidPrice ? currentPrice : 0,
      currentValue,
      totalCost: cost,
      profitLoss: pl,
      profitLossPercent: plPct,
      dayChange: dc,
      dayChangePercent: dcPct,
      priceUnavailable,
      priceIsStale,
      isRepricing,
      quoteAgeSeconds,
      session,
    };
  });

  const totalAssets = holdingsValue + cashBalance;
  const netEquity = totalAssets - marginDebt;
  const totalPL = holdingsValue - totalCost;
  const totalPLPercent = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

  // Day change percent: divide by previous holdings value (matching portfolio.service.ts)
  const previousHoldingsValue = holdingsValue - dayChange;
  const dayChangePercent = previousHoldingsValue > 0 ? (dayChange / previousHoldingsValue) * 100 : 0;

  // Regular-hours and after-hours change percents
  const regularDayChangePercent = previousHoldingsValue > 0 ? (regularDayChange / previousHoldingsValue) * 100 : 0;
  const afterHoursChangePercent = regularHoldingsValue > 0 ? (afterHoursChange / regularHoldingsValue) * 100 : 0;

  return {
    holdings: enrichedHoldings,
    options: [],
    cashBalance,
    marginDebt,
    holdingsValue,
    totalAssets,
    netEquity,
    totalValue: totalAssets,
    totalCost,
    totalPL,
    totalPLPercent,
    dayChange,
    dayChangePercent,
    regularDayChange,
    regularDayChangePercent,
    afterHoursChange,
    afterHoursChangePercent,
    session,
    quotesMeta: {
      anyRepricing: quotesResult.repricingCount > 0 || quotesResult.failedTickers.length > 0,
      quoteTimestamp: Date.now(),
      provider: quotesResult.provider,
      staleCount: quotesResult.staleCount,
      failedTickers: quotesResult.failedTickers.length > 0 ? quotesResult.failedTickers : undefined,
    },
  };
}

