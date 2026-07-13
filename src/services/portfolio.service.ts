import prisma from '../utils/prisma';
import type { Prisma } from '../generated/prisma/client';
import { fetchPrices } from './market.service';
import { Holding, HoldingInput, HoldingWithQuote, OptionWithQuote, Portfolio, Settings, SettingsUpdateInput, QuotesMeta } from '../types';
import { getSector } from '../utils/sectors';
import { getMarketSession, isOpenedTodayET } from '../utils/market-hours';
import { getOptionQuotes } from './options.service';
import { daysToExpiry, formatOptionDisplay } from '../utils/occ-parser';
import { PlanLimitError } from '../utils/plan-limit.error';



export async function getHoldings(userId: string, portfolioId?: string): Promise<Holding[]> {
  const { getOrCreateDefaultPortfolio } = await import('./portfolio-management.service');
  await getOrCreateDefaultPortfolio(userId);

  if (portfolioId) {
    return prisma.holding.findMany({
      where: { portfolioId },
      orderBy: { ticker: 'asc' },
    });
  }

  // Aggregate: prefer properly scoped holdings once a user has any portfolio-assigned rows.
  const scopedHoldings = await prisma.holding.findMany({
    where: { userId, portfolioId: { not: null } },
    orderBy: { ticker: 'asc' },
  });

  if (scopedHoldings.length > 0) {
    return scopedHoldings;
  }

  return prisma.holding.findMany({
    where: { userId },
    orderBy: { ticker: 'asc' },
  });
}

/** Either the global client or an in-flight interactive transaction — lets a
 *  caller make a holding write atomic with its compensating TWR Transaction. */
type DbClient = Prisma.TransactionClient | typeof prisma;

export async function upsertHolding(
  input: HoldingInput,
  userId: string,
  mode: 'replace' | 'add' = 'replace',
  portfolioId?: string,
  db: DbClient = prisma,
): Promise<Holding> {
  if (!Number.isFinite(input.shares) || input.shares <= 0) {
    throw new Error('shares must be a positive number');
  }
  if (!Number.isFinite(input.averageCost) || input.averageCost <= 0) {
    throw new Error('averageCost must be a positive number');
  }
  const ticker = input.ticker.toUpperCase();
  const uid = userId;

  // Resolve portfolioId to user's default if not specified
  let resolvedPortfolioId = portfolioId;
  if (!resolvedPortfolioId) {
    // Dynamic import to avoid circular dependency
    const { getOrCreateDefaultPortfolio } = await import('./portfolio-management.service');
    const defaultPortfolio = await getOrCreateDefaultPortfolio(uid);
    resolvedPortfolioId = defaultPortfolio.id;
  }

  const existing = await db.holding.findFirst({
    where: { ticker, portfolioId: resolvedPortfolioId },
  });

  if (existing) {
    if (mode === 'add') {
      // Weighted-average cost basis blending
      const totalShares = existing.shares + input.shares;
      const blendedCost = totalShares > 0
        ? (existing.shares * existing.averageCost + input.shares * input.averageCost) / totalShares
        : input.averageCost;
      return db.holding.update({
        where: { id: existing.id },
        data: {
          shares: totalShares,
          averageCost: Math.round(blendedCost * 100) / 100,
        },
      });
    }
    // mode === 'replace': explicit overwrite
    return db.holding.update({
      where: { id: existing.id },
      data: {
        shares: input.shares,
        averageCost: input.averageCost,
      },
    });
  }

  // Wrap count check + create in a transaction to prevent TOCTOU race
  // (two concurrent requests both reading count=9, both passing, both creating → 11 holdings).
  // When the caller already supplied a transaction client, run on it directly —
  // interactive transactions do not nest.
  const createWithPlanLimit = async (tx: Prisma.TransactionClient): Promise<Holding> => {
    const user = await tx.user.findUnique({
      where: { id: uid },
      select: { plan: true },
    });
    const plan = user?.plan ?? 'free';
    if (plan === 'free') {
      const currentCount = await tx.holding.count({ where: { userId: uid } });
      if (currentCount >= 10) {
        throw new PlanLimitError(10, 'free');
      }
    }

    return tx.holding.create({
      data: {
        ticker,
        shares: input.shares,
        averageCost: input.averageCost,
        userId: uid,
        portfolioId: resolvedPortfolioId,
      },
    });
  };

  if (db === prisma) {
    return prisma.$transaction(createWithPlanLimit);
  }
  return createWithPlanLimit(db as Prisma.TransactionClient);
}

export async function deleteHolding(ticker: string, userId: string, portfolioId?: string, db: DbClient = prisma): Promise<void> {
  const normalizedTicker = ticker.toUpperCase();

  let existing;
  if (portfolioId) {
    existing = await db.holding.findFirst({
      where: { ticker: normalizedTicker, portfolioId },
    });
  } else {
    // Resolve to default portfolio
    const { getOrCreateDefaultPortfolio } = await import('./portfolio-management.service');
    const defaultPortfolio = await getOrCreateDefaultPortfolio(userId);
    existing = await db.holding.findFirst({
      where: { ticker: normalizedTicker, portfolioId: defaultPortfolio.id },
    });
  }

  if (existing) {
    const cascade = async (tx: Prisma.TransactionClient) => {
      // Cascade cleanup: lots, trades, and dividend records tied to this ticker.
      // ONLY when this is the user's ONLY holding of the ticker. Lot/PortfolioTrade/
      // DividendCredit/DividendReinvestment carry no portfolioId, so a (ticker,userId)
      // delete would wipe the SAME ticker's history in the user's OTHER portfolios
      // (M-17 data loss). When the ticker is in >1 portfolio we skip the cascade and
      // leave harmless orphan rows rather than lose data. Full per-portfolio fix:
      // docs/M17-migration-draft.md.
      const holdingCount = await tx.holding.count({ where: { userId, ticker: normalizedTicker } });
      if (holdingCount <= 1) {
        await tx.lot.deleteMany({ where: { ticker: normalizedTicker, userId } });
        await tx.portfolioTrade.deleteMany({ where: { ticker: normalizedTicker, userId } });
        await tx.dividendCredit.deleteMany({ where: { ticker: normalizedTicker, userId } });
        await tx.dividendReinvestment.deleteMany({ where: { ticker: normalizedTicker, userId } });
      }
      await tx.holding.delete({ where: { id: existing.id } });
    };
    // Interactive transactions do not nest — reuse the caller's when given.
    if (db === prisma) {
      await prisma.$transaction(cascade);
    } else {
      await cascade(db as Prisma.TransactionClient);
    }
  }
}

export async function getSettings(userId: string, portfolioId?: string): Promise<Settings> {
  // Read non-portfolio fields from UserSettings
  const userSettings = await prisma.userSettings.findUnique({ where: { userId } });

  if (portfolioId) {
    // Scoped: read cash/margin from the specific Portfolio record
    const portfolio = await prisma.portfolio.findFirst({ where: { id: portfolioId, userId } });
    if (portfolio) {
      return {
        id: 'default',
        cashBalance: portfolio.cashBalance,
        marginDebt: portfolio.marginDebt,
        cashInterestRate: userSettings?.cashInterestRate ?? 0,
      } as Settings;
    }
  }

  // Aggregate: sum cash/margin across all user portfolios
  const portfolios = await prisma.portfolio.findMany({
    where: { userId },
    select: { cashBalance: true, marginDebt: true },
  });

  if (portfolios.length > 0) {
    const totalCash = portfolios.reduce((sum, p) => sum + p.cashBalance, 0);
    const totalMargin = portfolios.reduce((sum, p) => sum + p.marginDebt, 0);
    return {
      id: 'default',
      cashBalance: totalCash,
      marginDebt: totalMargin,
      cashInterestRate: userSettings?.cashInterestRate ?? 0,
    } as Settings;
  }

  // Fallback: no portfolios exist (pre-migration), read from UserSettings
  if (userSettings) {
    return {
      id: 'default',
      cashBalance: userSettings.cashBalance,
      marginDebt: userSettings.marginDebt ?? 0,
      cashInterestRate: userSettings.cashInterestRate ?? 0,
    } as Settings;
  }

  // If no UserSettings yet, create one with defaults (upsert to handle races)
  try {
    const created = await prisma.userSettings.upsert({
      where: { userId },
      update: {},
      create: { userId, cashBalance: 0, marginDebt: 0 },
    });
    return {
      id: 'default',
      cashBalance: created.cashBalance,
      marginDebt: created.marginDebt ?? 0,
      cashInterestRate: created.cashInterestRate ?? 0,
    } as Settings;
  } catch {
    // FK constraint failure = user doesn't exist, return safe defaults
    return { id: 'default', cashBalance: 0, marginDebt: 0, cashInterestRate: 0 } as Settings;
  }
}

export async function updateCashBalance(userId: string, cashBalance: number, portfolioId?: string): Promise<Settings> {
  let targetPortfolioId = portfolioId;
  if (!targetPortfolioId) {
    // Update default portfolio's cash balance
    const { getOrCreateDefaultPortfolio } = await import('./portfolio-management.service');
    const defaultPortfolio = await getOrCreateDefaultPortfolio(userId);
    targetPortfolioId = defaultPortfolio.id;
  }

  // Atomic: the portfolio balance and its UserSettings mirror (the fallback
  // getSettings reads when a user has no portfolio rows) must not diverge.
  await prisma.$transaction([
    prisma.portfolio.update({
      where: { id: targetPortfolioId },
      data: { cashBalance },
    }),
    // Also keep UserSettings in sync for backward compatibility
    prisma.userSettings.upsert({
      where: { userId },
      update: { cashBalance },
      create: { userId, cashBalance, marginDebt: 0 },
    }),
  ]);

  // Return aggregated settings
  return getSettings(userId);
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

export async function getPortfolio(userId: string, options?: { preferPolygon?: boolean; portfolioId?: string }): Promise<Portfolio> {
  const portfolioId = options?.portfolioId;
  const [holdings, settings] = await Promise.all([getHoldings(userId, portfolioId), getSettings(userId, portfolioId)]);

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

    // Day P&L anchor: for a position opened TODAY the holder didn't own it at
    // yesterday's close, so anchor at their cost basis instead of previousClose
    // (otherwise a position only ever up can show a red "today" loss). Falls
    // back to previousClose when cost basis is unusable (0 / gifted / transfer).
    // The regular/after-hours split below is all relative to previousValue, so
    // it stays internally consistent (regularDayChange + afterHoursChange always
    // equals the total dayChange) regardless of which anchor is used.
    const dayAnchor = isOpenedTodayET(holding.createdAt) && holding.averageCost > 0
      ? holding.averageCost
      : previousClose;
    const previousValue = hasValidPrice ? holding.shares * dayAnchor : 0;
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
      totalCost += holdingTotalCost;
    }

    return {
      ...holding,
      sector: getSector(holding.ticker),
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

  // Price options via Finnhub option chain (BEFORE computing portfolio totals,
  // so holdingsValue/totalCost include options)
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

  // Calculate portfolio totals AFTER options are included in holdingsValue/totalCost
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

