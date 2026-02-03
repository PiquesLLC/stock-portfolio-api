import { PrismaClient } from '@prisma/client';
import { fetchPrices } from './market.service';
import { Portfolio } from '../types';
import { getMarketSession } from '../utils/market-hours';

const prisma = new PrismaClient();

export async function getUserPortfolio(userId: string): Promise<Portfolio | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { settings: true },
  });

  if (!user) return null;

  const holdings = await prisma.holding.findMany({
    where: { userId },
    orderBy: { ticker: 'asc' },
  });

  const cashBalance = user.settings?.cashBalance ?? 0;
  const marginDebt = user.settings?.marginDebt ?? 0;

  if (holdings.length === 0) {
    return {
      holdings: [],
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
    // During extended hours, prefer extendedPrice (premarket/after-hours)
    const currentPrice = (quote?.extendedPrice && quote.extendedPrice > 0)
      ? quote.extendedPrice
      : (quote?.currentPrice ?? h.averageCost);
    const currentValue = currentPrice * h.shares;
    const cost = h.averageCost * h.shares;
    const pl = currentValue - cost;
    const plPct = cost > 0 ? (pl / cost) * 100 : 0;
    const previousClose = quote?.previousClose ?? quote?.currentPrice ?? h.averageCost;
    const dc = (currentPrice - previousClose) * h.shares;
    const dcPct = previousClose > 0 ? ((currentPrice - previousClose) / previousClose) * 100 : 0;

    const regClose = quote?.regularClose ?? currentPrice;
    const regValue = regClose * h.shares;
    regularHoldingsValue += regValue;
    regularDayChange += regValue - (previousClose * h.shares);
    afterHoursChange += currentValue - regValue;

    holdingsValue += currentValue;
    totalCost += cost;
    dayChange += dc;

    return {
      id: h.id,
      ticker: h.ticker,
      shares: h.shares,
      averageCost: h.averageCost,
      createdAt: h.createdAt,
      updatedAt: h.updatedAt,
      currentPrice,
      currentValue,
      totalCost: cost,
      profitLoss: pl,
      profitLossPercent: plPct,
      dayChange: dc,
      dayChangePercent: dcPct,
      priceUnavailable: !quote,
      session,
    };
  });

  const totalAssets = holdingsValue + cashBalance;
  const netEquity = totalAssets - marginDebt;
  const totalPL = holdingsValue - totalCost;
  const totalPLPercent = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;
  const dayChangePercent = holdingsValue > 0 ? (dayChange / (holdingsValue - dayChange)) * 100 : 0;

  return {
    holdings: enrichedHoldings,
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
    regularDayChangePercent: (holdingsValue - dayChange) > 0 ? (regularDayChange / (holdingsValue - dayChange)) * 100 : 0,
    afterHoursChange,
    afterHoursChangePercent: regularHoldingsValue > 0 ? (afterHoursChange / regularHoldingsValue) * 100 : 0,
    session,
    quotesMeta: {
      anyRepricing: quotesResult.repricingCount > 0,
      quoteTimestamp: Date.now(),
      provider: quotesResult.provider,
      staleCount: quotesResult.staleCount,
      failedTickers: quotesResult.failedTickers,
    },
  };
}
