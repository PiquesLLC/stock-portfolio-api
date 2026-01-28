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
    };
  }

  const tickers = holdings.map((h) => h.ticker);
  const quotesResult = await fetchPrices(tickers);
  const session = getMarketSession();

  let holdingsValue = 0;
  let totalCost = 0;
  let dayChange = 0;

  const enrichedHoldings = holdings.map((h) => {
    const quote = quotesResult.quotes.get(h.ticker);
    const currentPrice = quote?.currentPrice ?? h.averageCost;
    const currentValue = currentPrice * h.shares;
    const cost = h.averageCost * h.shares;
    const pl = currentValue - cost;
    const plPct = cost > 0 ? (pl / cost) * 100 : 0;
    const dc = quote ? (quote.change ?? 0) * h.shares : 0;
    const dcPct = quote?.changePercent ?? 0;

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
