import prisma from '../utils/prisma';
import { getETFHoldings } from '../utils/yahoo-finance';
import { fetchPrices } from './market.service';

const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

function resolveUserId(userId?: string | null): string {
  return userId ?? SYSTEM_USER_ID;
}

function round(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

type OverlapHolding = {
  ticker: string;
  name: string | null;
  weightPct: number;
  exposureValue: number;
};

export async function getEtfOverlap(userId?: string | null) {
  const targetUserId = resolveUserId(userId);

  const holdings = await prisma.holding.findMany({
    where: { userId: targetUserId, shares: { gt: 0 } },
    select: { ticker: true, shares: true },
  });

  if (holdings.length === 0) {
    return {
      etfs: [],
      overlapMatrix: [],
      exposures: [],
      warnings: [],
    };
  }

  const tickers = holdings.map(h => h.ticker.toUpperCase());
  const quotes = await fetchPrices(tickers);

  // Identify ETFs and get holdings data
  const etfData = new Map<string, Awaited<ReturnType<typeof getETFHoldings>>>();
  for (const ticker of tickers) {
    const data = await getETFHoldings(ticker);
    if (data?.isETF) {
      etfData.set(ticker, data);
    }
  }

  const etfs: any[] = [];
  const exposureMap = new Map<string, { total: number; sources: Array<{ source: string; etf?: string }> }>();

  let portfolioValue = 0;

  for (const holding of holdings) {
    const ticker = holding.ticker.toUpperCase();
    const quote = quotes.quotes.get(ticker);
    const price = quote?.currentPrice ?? 0;
    const value = holding.shares * price;
    portfolioValue += value;

    const etfHoldings = etfData.get(ticker);
    if (!etfHoldings) {
      const existing = exposureMap.get(ticker) ?? { total: 0, sources: [] };
      existing.total += value;
      existing.sources.push({ source: 'direct' });
      exposureMap.set(ticker, existing);
      continue;
    }

    const topHoldings = (etfHoldings.topHoldings || []).map(h => ({
      ticker: h.symbol.toUpperCase(),
      name: h.holdingName || null,
      weightPct: h.holdingPercent,
      exposureValue: round(value * (h.holdingPercent / 100), 2),
    }));

    for (const h of topHoldings) {
      const existing = exposureMap.get(h.ticker) ?? { total: 0, sources: [] };
      existing.total += h.exposureValue;
      existing.sources.push({ source: 'etf', etf: ticker });
      exposureMap.set(h.ticker, existing);
    }

    const unknownPct = Math.max(0, 100 - (etfHoldings.totalHoldingsPercent ?? 0));
    const unknownExposureValue = round(value * (unknownPct / 100), 2);

    etfs.push({
      ticker,
      value: round(value, 2),
      asOfDate: etfHoldings.asOfDate,
      totalHoldingsPercent: etfHoldings.totalHoldingsPercent ?? 0,
      holdings: topHoldings,
      unknownExposureValue,
    });
  }

  // Build overlap matrix between ETFs
  const overlapMatrix: any[] = [];
  for (let i = 0; i < etfs.length; i++) {
    for (let j = i + 1; j < etfs.length; j++) {
      const a = etfs[i];
      const b = etfs[j];
      const aMap = new Map<string, number>(a.holdings.map((h: OverlapHolding) => [h.ticker, h.weightPct]));
      const shared: Array<{ ticker: string; overlapPct: number }> = [];
      let overlapPct = 0;
      for (const h of b.holdings as OverlapHolding[]) {
        const aWeight = aMap.get(h.ticker);
        if (aWeight !== undefined) {
          const minWeight = Math.min(aWeight, h.weightPct);
          overlapPct += minWeight;
          shared.push({ ticker: h.ticker, overlapPct: round(minWeight, 2) });
        }
      }
      if (shared.length > 0) {
        overlapMatrix.push({
          etfA: a.ticker,
          etfB: b.ticker,
          overlapPercent: round(overlapPct, 2),
          sharedHoldings: shared,
        });
      }
    }
  }

  // Compute exposures and warnings
  const exposures = Array.from(exposureMap.entries()).map(([ticker, data]) => {
    const pct = portfolioValue > 0 ? (data.total / portfolioValue) * 100 : 0;
    return {
      ticker,
      totalExposureValue: round(data.total, 2),
      exposurePct: round(pct, 2),
      sources: data.sources,
    };
  }).sort((a, b) => b.totalExposureValue - a.totalExposureValue);

  const warnings = exposures
    .filter(e => e.exposurePct >= 10)
    .map(e => ({
      ticker: e.ticker,
      exposurePct: e.exposurePct,
      message: `High concentration: ${e.ticker} is ${e.exposurePct}% of portfolio exposure`,
    }));

  return {
    etfs,
    overlapMatrix,
    exposures,
    warnings,
  };
}
