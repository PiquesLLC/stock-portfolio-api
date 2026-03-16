import NodeCache from 'node-cache';
import { fetchDailyCandles, fetchPrices } from './market.service';

const periodReturnsCache = new NodeCache({ stdTTL: 1800 });
const POLYGON_BATCH_SIZE = 5;
const POLYGON_BATCH_DELAY_MS = 1000;

type HoldingReturnPeriod = 'daily' | 'weekly' | 'monthly' | 'ytd' | '1y';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getPeriodStartDate(period: Exclude<HoldingReturnPeriod, 'daily'>): Date {
  const now = new Date();

  switch (period) {
    case 'weekly': {
      return new Date(now.getTime() - 7 * 86400000);
    }
    case 'monthly': {
      return new Date(now.getTime() - 30 * 86400000);
    }
    case 'ytd': {
      return new Date(now.getFullYear(), 0, 1);
    }
    case '1y': {
      return new Date(now.getTime() - 365 * 86400000);
    }
  }
}

function getLookbackDays(period: Exclude<HoldingReturnPeriod, 'daily'>): number {
  const startDate = getPeriodStartDate(period);
  return Math.max(1, Math.ceil((Date.now() - startDate.getTime()) / 86400000));
}

function getPeriodStartClose(candles: { time: string; close: number }[], startMs: number): number | null {
  const sorted = candles
    .filter(candle => Number.isFinite(candle.close) && candle.close > 0)
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const firstOnOrAfter = sorted.find(candle => new Date(candle.time).getTime() >= startMs);
  return firstOnOrAfter?.close ?? null;
}

export async function getHoldingPeriodReturns(
  tickers: string[],
  period: HoldingReturnPeriod,
): Promise<Map<string, number>> {
  const normalizedTickers = Array.from(
    new Set(
      tickers
        .map(ticker => ticker.trim().toUpperCase())
        .filter(Boolean),
    ),
  );

  if (normalizedTickers.length === 0) {
    return new Map();
  }

  if (period === 'daily') {
    return new Map();
  }

  const cacheKey = `period-returns:${period}:${[...normalizedTickers].sort().join(',')}`;
  const cached = periodReturnsCache.get<[string, number][]>(cacheKey);
  if (cached) {
    return new Map(cached);
  }

  const startDate = getPeriodStartDate(period);
  const startMs = startDate.getTime();
  const lookbackDays = getLookbackDays(period);

  const quotesResult = await fetchPrices(normalizedTickers, { preferPolygon: true });
  const quoteMap = quotesResult.quotes;
  const returns = new Map<string, number>();

  for (let i = 0; i < normalizedTickers.length; i += POLYGON_BATCH_SIZE) {
    const batch = normalizedTickers.slice(i, i + POLYGON_BATCH_SIZE);
    const candleResults = await Promise.allSettled(
      batch.map(async (ticker) => {
        const candles = await fetchDailyCandles(ticker, lookbackDays);
        return { ticker, candles };
      }),
    );

    for (const result of candleResults) {
      if (result.status !== 'fulfilled') {
        continue;
      }

      const { ticker, candles } = result.value;
      const quote = quoteMap.get(ticker);
      const currentPrice = quote?.currentPrice;
      const periodStartPrice = getPeriodStartClose(candles, startMs);

      if (!Number.isFinite(currentPrice) || !currentPrice || !periodStartPrice) {
        returns.set(ticker, 0);
        continue;
      }

      const periodReturn = ((currentPrice - periodStartPrice) / periodStartPrice) * 100;
      returns.set(ticker, Number.isFinite(periodReturn) ? periodReturn : 0);
    }

    if (i + POLYGON_BATCH_SIZE < normalizedTickers.length) {
      await sleep(POLYGON_BATCH_DELAY_MS);
    }
  }

  for (const ticker of normalizedTickers) {
    if (!returns.has(ticker)) {
      returns.set(ticker, 0);
    }
  }

  periodReturnsCache.set(cacheKey, Array.from(returns.entries()));
  return returns;
}
