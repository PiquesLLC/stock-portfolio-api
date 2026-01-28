import { PrismaClient } from '@prisma/client';
import { fetchPrices } from './market.service';
import { Holding, HoldingInput, HoldingWithQuote, Portfolio, Settings, SettingsUpdateInput } from '../types';

const prisma = new PrismaClient();

export async function getHoldings(): Promise<Holding[]> {
  return prisma.holding.findMany({
    orderBy: { ticker: 'asc' },
  });
}

export async function upsertHolding(input: HoldingInput): Promise<Holding> {
  const ticker = input.ticker.toUpperCase();

  return prisma.holding.upsert({
    where: { ticker },
    update: {
      shares: input.shares,
      averageCost: input.averageCost,
    },
    create: {
      ticker,
      shares: input.shares,
      averageCost: input.averageCost,
    },
  });
}

export async function deleteHolding(ticker: string): Promise<void> {
  await prisma.holding.delete({
    where: { ticker: ticker.toUpperCase() },
  });
}

export async function getSettings(): Promise<Settings> {
  let settings = await prisma.settings.findUnique({
    where: { id: 'default' },
  });

  if (!settings) {
    settings = await prisma.settings.create({
      data: { id: 'default', cashBalance: 0, marginDebt: 0 },
    });
  }

  return settings as Settings;
}

export async function updateCashBalance(cashBalance: number): Promise<Settings> {
  const result = await prisma.settings.upsert({
    where: { id: 'default' },
    update: { cashBalance },
    create: { id: 'default', cashBalance, marginDebt: 0 },
  });
  return result as Settings;
}

export async function updateSettings(input: SettingsUpdateInput): Promise<Settings> {
  const updateData: Record<string, number> = {};

  if (input.cashBalance !== undefined) {
    updateData.cashBalance = input.cashBalance;
  }
  if (input.marginDebt !== undefined) {
    updateData.marginDebt = input.marginDebt;
  }

  const result = await prisma.settings.upsert({
    where: { id: 'default' },
    update: updateData,
    create: { id: 'default', cashBalance: input.cashBalance ?? 0, marginDebt: input.marginDebt ?? 0 },
  });
  return result as Settings;
}

export async function getPortfolio(): Promise<Portfolio> {
  const [holdings, settings] = await Promise.all([getHoldings(), getSettings()]);

  const marginDebt = settings.marginDebt ?? 0;

  if (holdings.length === 0) {
    const netEquity = settings.cashBalance - marginDebt;
    return {
      holdings: [],
      cashBalance: settings.cashBalance,
      marginDebt,
      holdingsValue: 0,
      netEquity,
      totalValue: netEquity,
      totalCost: 0,
      totalPL: 0,
      totalPLPercent: 0,
      dayChange: 0,
      dayChangePercent: 0,
      quotesStale: false,
      quotesUnavailableCount: 0,
    };
  }

  const tickers = holdings.map((h) => h.ticker);
  const { quotes, staleCount, failedTickers } = await fetchPrices(tickers);

  let holdingsValue = 0;
  let totalCost = 0;
  let dayChange = 0;
  let hasStaleQuotes = staleCount > 0;
  let unavailableCount = failedTickers.length;

  const holdingsWithQuotes: HoldingWithQuote[] = holdings.map((holding) => {
    const quote = quotes.get(holding.ticker);
    const priceUnavailable = !quote;
    const priceIsStale = quote?.isStale ?? false;

    // CRITICAL: Never use 0 as a fallback price
    // If we don't have a quote, mark as unavailable but don't calculate incorrect values
    const currentPrice = quote?.currentPrice ?? 0;
    const previousClose = quote?.previousClose ?? currentPrice;

    // Only calculate market values if we have a valid price
    const hasValidPrice = quote && currentPrice > 0;

    const currentValue = hasValidPrice ? holding.shares * currentPrice : 0;
    const holdingTotalCost = holding.shares * holding.averageCost;

    // If price is unavailable, don't compute P/L (it would be misleading)
    const profitLoss = hasValidPrice ? currentValue - holdingTotalCost : 0;
    const profitLossPercent = hasValidPrice && holdingTotalCost > 0
      ? (profitLoss / holdingTotalCost) * 100
      : 0;

    const previousValue = hasValidPrice ? holding.shares * previousClose : 0;
    const holdingDayChange = hasValidPrice ? currentValue - previousValue : 0;
    const dayChangePercent = hasValidPrice && previousValue > 0
      ? (holdingDayChange / previousValue) * 100
      : 0;

    // Only add to totals if we have valid price data
    if (hasValidPrice) {
      holdingsValue += currentValue;
      dayChange += holdingDayChange;
    }
    totalCost += holdingTotalCost;

    return {
      ...holding,
      currentPrice: hasValidPrice ? currentPrice : 0,
      currentValue,
      totalCost: holdingTotalCost,
      profitLoss,
      profitLossPercent,
      dayChange: holdingDayChange,
      dayChangePercent,
      priceUnavailable,
      priceIsStale,
    };
  });

  // Calculate portfolio totals
  // netEquity = holdingsValue + cashBalance - marginDebt
  const netEquity = holdingsValue + settings.cashBalance - marginDebt;

  // Total P/L is unrealized P/L from holdings (market value - cost basis)
  const totalPL = holdingsValue - totalCost;
  const totalPLPercent = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

  // Day change is based on holdings price movement
  const previousHoldingsValue = holdingsValue - dayChange;
  const dayChangePercent = previousHoldingsValue > 0 ? (dayChange / previousHoldingsValue) * 100 : 0;

  return {
    holdings: holdingsWithQuotes,
    cashBalance: settings.cashBalance,
    marginDebt,
    holdingsValue,
    netEquity,
    totalValue: netEquity, // backward compatibility
    totalCost,
    totalPL,
    totalPLPercent,
    dayChange,
    dayChangePercent,
    quotesStale: hasStaleQuotes,
    quotesUnavailableCount: unavailableCount,
  };
}
