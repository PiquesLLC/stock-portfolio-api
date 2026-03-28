import { insightsCache } from '../utils/finnhub';
import { getPortfolio } from './portfolio.service';
import { getEarningsData } from './earnings.service';

const CACHE_TTL_SECONDS = 30 * 60;
const UPCOMING_WINDOW_DAYS = 90;

export interface EarningsSummaryItem {
  ticker: string;
  reportDate: string;
  estimatedEPS: number | null;
  reportedEPS: number | null;
  daysUntil: number;
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysUntil(target: Date, now: Date): number {
  const ms = target.getTime() - now.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export async function getEarningsSummary(userId: string, portfolioId?: string): Promise<{ results: EarningsSummaryItem[]; partial: boolean }> {
  const cacheKey = `earnings-summary:${userId}${portfolioId ? `:${portfolioId}` : ''}`;
  const cached = insightsCache.get<{ results: EarningsSummaryItem[]; partial: boolean }>(cacheKey);
  if (cached) return cached;

  const portfolio = await getPortfolio(userId, { portfolioId });

  // Skip ETFs/funds that don't have earnings — avoids expensive fallback chains
  const ETF_PATTERNS = /^(SPY|QQQ|DIA|IWM|EEM|VTI|VOO|VEA|VWO|BND|AGG|TLT|GLD|SLV|XL[A-Z]|IGV|FEZ|ARKK|ARKG|HYG|LQD|IVV|IEFA|IEMG|VNQ|SCHD)$/;
  const tickers = portfolio.holdings
    .map(h => h.ticker.toUpperCase())
    .filter(t => !ETF_PATTERNS.test(t));
  if (tickers.length === 0) {
    const empty = { results: [], partial: false };
    insightsCache.set(cacheKey, empty, CACHE_TTL_SECONDS);
    return empty;
  }

  const now = new Date();
  const maxDate = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Process in batches of 5 to prevent connection pool exhaustion
  const BATCH_SIZE = 5;
  const results: PromiseSettledResult<EarningsSummaryItem[]>[] = [];
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (ticker) => {
        const data = await getEarningsData(ticker);
        const upcoming = (data.quarterly || [])
          .map(q => {
            const date = parseDate(q.reportedDate) || parseDate(q.fiscalDateEnding);
            return { ...q, date };
          })
          .filter(q => q.date && q.reportedEPS == null)
          .filter(q => q.date! >= now && q.date! <= maxDate)
          .map(q => ({
            ticker,
            reportDate: q.date!.toISOString().slice(0, 10),
            estimatedEPS: q.estimatedEPS ?? null,
            reportedEPS: null,
            daysUntil: daysUntil(q.date!, now),
          }));
        return upcoming;
      })
    );
    results.push(...batchResults);
  }

  const flattened: EarningsSummaryItem[] = [];
  let partial = false;

  results.forEach((result) => {
    if (result.status === 'fulfilled') {
      flattened.push(...result.value);
    } else {
      partial = true;
    }
  });

  flattened.sort((a, b) => {
    if (a.reportDate === b.reportDate) return a.ticker.localeCompare(b.ticker);
    return a.reportDate.localeCompare(b.reportDate);
  });

  const payload = { results: flattened, partial };
  insightsCache.set(cacheKey, payload, CACHE_TTL_SECONDS);
  return payload;
}
