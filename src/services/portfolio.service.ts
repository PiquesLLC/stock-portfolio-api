import prisma from '../utils/prisma';
import { fetchPrices } from './market.service';
import { Holding, HoldingInput, HoldingWithQuote, OptionWithQuote, Portfolio, Settings, SettingsUpdateInput, QuotesMeta } from '../types';
import { getMarketSession } from '../utils/market-hours';
import { getOptionQuotes } from './options.service';
import { daysToExpiry, formatOptionDisplay } from '../utils/occ-parser';
import { PlanLimitError } from '../utils/plan-limit.error';



export async function getHoldings(userId: string): Promise<Holding[]> {
  return prisma.holding.findMany({
    where: { userId },
    orderBy: { ticker: 'asc' },
  });
}

export async function upsertHolding(input: HoldingInput, userId: string): Promise<Holding> {
  const ticker = input.ticker.toUpperCase();
  const uid = userId;

  const existing = await prisma.holding.findFirst({
    where: { ticker, userId: uid },
  });

  if (existing) {
    return prisma.holding.update({
      where: { id: existing.id },
      data: {
        shares: input.shares,
        averageCost: input.averageCost,
      },
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { plan: true },
  });
  const plan = user?.plan ?? 'free';
  if (plan === 'free') {
    const currentCount = await prisma.holding.count({ where: { userId: uid } });
    if (currentCount >= 10) {
      throw new PlanLimitError(10, 'free');
    }
  }

  return prisma.holding.create({
    data: {
      ticker,
      shares: input.shares,
      averageCost: input.averageCost,
      userId: uid,
    },
  });
}

export async function deleteHolding(ticker: string, userId: string): Promise<void> {
  const existing = await prisma.holding.findFirst({
    where: { ticker: ticker.toUpperCase(), userId },
  });
  if (existing) {
    await prisma.holding.delete({ where: { id: existing.id } });
  }
}

export async function getSettings(userId: string): Promise<Settings> {
  // Read from per-user UserSettings table
  const userSettings = await prisma.userSettings.findUnique({ where: { userId } });
  if (userSettings) {
    return {
      id: 'default',
      cashBalance: userSettings.cashBalance,
      marginDebt: userSettings.marginDebt ?? 0,
      cashInterestRate: userSettings.cashInterestRate ?? 0,
    } as Settings;
  }

  // If no UserSettings yet, create one with defaults
  const created = await prisma.userSettings.create({
    data: { userId, cashBalance: 0, marginDebt: 0 },
  });
  return {
    id: 'default',
    cashBalance: created.cashBalance,
    marginDebt: created.marginDebt ?? 0,
    cashInterestRate: created.cashInterestRate ?? 0,
  } as Settings;
}

export async function updateCashBalance(userId: string, cashBalance: number): Promise<Settings> {
  const result = await prisma.userSettings.upsert({
    where: { userId },
    update: { cashBalance },
    create: { userId, cashBalance, marginDebt: 0 },
  });

  return {
    id: 'default',
    cashBalance: result.cashBalance,
    marginDebt: result.marginDebt ?? 0,
    cashInterestRate: result.cashInterestRate ?? 0,
  } as Settings;
}

export async function updateSettings(userId: string, input: SettingsUpdateInput): Promise<Settings> {
  const updateData: Record<string, number> = {};

  if (input.cashBalance !== undefined) {
    updateData.cashBalance = input.cashBalance;
  }
  if (input.marginDebt !== undefined) {
    updateData.marginDebt = input.marginDebt;
  }
  if (input.cashInterestRate !== undefined) {
    updateData.cashInterestRate = input.cashInterestRate;
  }

  const result = await prisma.userSettings.upsert({
    where: { userId },
    update: updateData,
    create: {
      userId,
      cashBalance: input.cashBalance ?? 0,
      marginDebt: input.marginDebt ?? 0,
      cashInterestRate: input.cashInterestRate ?? 0,
    },
  });

  return {
    id: 'default',
    cashBalance: result.cashBalance,
    marginDebt: result.marginDebt ?? 0,
    cashInterestRate: result.cashInterestRate ?? 0,
  } as Settings;
}

export async function getPortfolio(userId: string, options?: { preferPolygon?: boolean }): Promise<Portfolio> {
  const [holdings, settings] = await Promise.all([getHoldings(userId), getSettings(userId)]);

  const marginDebt = settings.marginDebt ?? 0;
  const session = getMarketSession();

  // Split holdings into equities and options
  const equityHoldings = holdings.filter(h => h.holdingType !== 'option');
  const optionHoldings = holdings.filter(h => h.holdingType === 'option');

  if (holdings.length === 0) {
    // totalAssets = holdings + cash (NO marginDebt - used for performance tracking)
    const totalAssets = settings.cashBalance;
    // netEquity = totalAssets - marginDebt (for display only)
    const netEquity = totalAssets - marginDebt;
    return {
      holdings: [],
      options: [],
      cashBalance: settings.cashBalance,
      marginDebt,
      holdingsValue: 0,
      totalAssets,
      netEquity,
      totalValue: totalAssets, // for snapshot compatibility (assets only)
      totalCost: 0,
      totalPL: 0,
      totalPLPercent: 0,
      dayChange: 0,
      dayChangePercent: 0,
      regularDayChange: 0,
      regularDayChangePercent: 0,
      afterHoursChange: 0,
      afterHoursChangePercent: 0,
      quotesStale: false,
      quotesUnavailableCount: 0,
      quotesMeta: {
        anyRepricing: false,
        quoteTimestamp: Date.now(),
        provider: 'polygon',
      },
      session,
    };
  }

  const tickers = equityHoldings.map((h) => h.ticker);
  const { quotes, staleCount, repricingCount, failedTickers, provider } = tickers.length > 0
    ? await fetchPrices(tickers, options)
    : { quotes: new Map(), staleCount: 0, repricingCount: 0, failedTickers: [] as string[], provider: 'none' };

  let holdingsValue = 0;
  let regularHoldingsValue = 0;
  let totalCost = 0;
  let dayChange = 0;
  let regularDayChange = 0;
  let afterHoursChange = 0;
  let hasStaleQuotes = staleCount > 0;
  let hasRepricingQuotes = repricingCount > 0;
  let unavailableCount = failedTickers.length;

  const holdingsWithQuotes: HoldingWithQuote[] = equityHoldings.map((holding) => {
    const quote = quotes.get(holding.ticker);
    const priceUnavailable = !quote;
    const priceIsStale = quote?.isStale ?? false;
    const isRepricing = quote?.isRepricing ?? priceUnavailable;
    const quoteAgeSeconds = quote?.quoteAgeSeconds;

    // CRITICAL: Never use 0 as a fallback price
    // If we don't have a quote, mark as unavailable but don't calculate incorrect values
    // During extended hours, use extendedPrice if available (premarket/after-hours price)
    const currentPrice = (quote?.extendedPrice && quote.extendedPrice > 0)
      ? quote.extendedPrice
      : (quote?.currentPrice ?? 0);
    const previousClose = quote?.previousClose ?? (quote?.currentPrice ?? currentPrice);

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
    const holdingDayChangePercent = hasValidPrice && previousValue > 0
      ? (holdingDayChange / previousValue) * 100
      : 0;

    // Only add to totals if we have valid price data
    if (hasValidPrice) {
      holdingsValue += currentValue;
      dayChange += holdingDayChange;

      // Separate regular-hours vs after-hours change
      const regClose = quote?.regularClose ?? currentPrice;
      const regValue = holding.shares * regClose;
      regularHoldingsValue += regValue;
      regularDayChange += regValue - previousValue;
      afterHoursChange += currentValue - regValue;
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
      dayChangePercent: holdingDayChangePercent,
      priceUnavailable,
      priceIsStale,
      isRepricing,
      quoteAgeSeconds,
      session: quote?.session,
    };
  });

  // Calculate portfolio totals
  // totalAssets = holdingsValue + cashBalance (NO marginDebt - for performance tracking)
  const totalAssets = holdingsValue + settings.cashBalance;
  // netEquity = totalAssets - marginDebt (for balance sheet display only)
  const netEquity = totalAssets - marginDebt;

  // Total P/L is unrealized P/L from holdings (market value - cost basis)
  const totalPL = holdingsValue - totalCost;
  const totalPLPercent = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

  // Day change is based on holdings price movement
  const previousHoldingsValue = holdingsValue - dayChange;
  const dayChangePercent = previousHoldingsValue > 0 ? (dayChange / previousHoldingsValue) * 100 : 0;

  // Regular-hours and after-hours change percents
  const regularDayChangePercent = previousHoldingsValue > 0 ? (regularDayChange / previousHoldingsValue) * 100 : 0;
  const afterHoursChangePercent = regularHoldingsValue > 0 ? (afterHoursChange / regularHoldingsValue) * 100 : 0;

  // Price options via Finnhub option chain
  let optionsWithQuotes: OptionWithQuote[] = [];
  if (optionHoldings.length > 0) {
    const optionPositions = optionHoldings
      .filter(h => h.optionUnderlying && h.optionExpiry && h.optionStrike != null && h.optionType)
      .map(h => ({
        ticker: h.ticker,
        underlying: h.optionUnderlying!,
        expiry: h.optionExpiry!,
        strike: h.optionStrike!,
        type: h.optionType as 'call' | 'put',
      }));

    const optionQuotes = await getOptionQuotes(optionPositions);

    optionsWithQuotes = optionHoldings.map(holding => {
      const oq = optionQuotes.get(holding.ticker);
      const priceUnavailable = !oq;
      // Options are priced per share but traded in contracts of 100 shares
      const price = oq ? oq.midPrice : 0;
      const contractMultiplier = 100;
      const currentValue = price * holding.shares * contractMultiplier;
      const holdingTotalCost = holding.shares * holding.averageCost;
      const profitLoss = priceUnavailable ? 0 : currentValue - holdingTotalCost;
      const profitLossPercent = !priceUnavailable && holdingTotalCost > 0
        ? (profitLoss / holdingTotalCost) * 100
        : 0;

      if (!priceUnavailable) {
        holdingsValue += currentValue;
        totalCost += holdingTotalCost;
      }

      const dte = holding.optionExpiry ? daysToExpiry(holding.optionExpiry) : 0;
      const display = holding.optionUnderlying && holding.optionStrike != null && holding.optionExpiry && holding.optionType
        ? formatOptionDisplay({
            underlying: holding.optionUnderlying,
            strike: holding.optionStrike,
            expiry: holding.optionExpiry,
            type: holding.optionType as 'call' | 'put',
          })
        : holding.ticker;

      return {
        ...holding,
        currentPrice: price,
        currentValue,
        totalCost: holdingTotalCost,
        profitLoss,
        profitLossPercent,
        bid: oq?.bid ?? 0,
        ask: oq?.ask ?? 0,
        impliedVolatility: oq?.impliedVolatility ?? 0,
        openInterest: oq?.openInterest ?? 0,
        volume: oq?.volume ?? 0,
        change: oq?.change ?? 0,
        percentChange: oq?.percentChange ?? 0,
        daysToExpiry: dte,
        displayName: display,
        priceUnavailable,
      };
    });
  }

  // Build quotes metadata
  const quotesMeta: QuotesMeta = {
    anyRepricing: hasRepricingQuotes || unavailableCount > 0,
    quoteTimestamp: Date.now(),
    provider,
    staleCount,
    failedTickers: failedTickers.length > 0 ? failedTickers : undefined,
  };

  return {
    holdings: holdingsWithQuotes,
    options: optionsWithQuotes,
    cashBalance: settings.cashBalance,
    marginDebt,
    holdingsValue,
    totalAssets,
    netEquity,
    totalValue: totalAssets, // for snapshot compatibility (assets only, NO marginDebt)
    totalCost,
    totalPL,
    totalPLPercent,
    dayChange,
    dayChangePercent,
    regularDayChange,
    regularDayChangePercent,
    afterHoursChange,
    afterHoursChangePercent,
    quotesStale: hasStaleQuotes,
    quotesUnavailableCount: unavailableCount,
    quotesMeta,
    session,
  };
}

