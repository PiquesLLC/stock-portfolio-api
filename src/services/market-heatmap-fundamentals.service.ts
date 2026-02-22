import prisma from '../utils/prisma';
import { getDailyCallsRemaining } from '../utils/alpha-vantage';
import { refreshFundamentalsForTicker } from './fundamentals.service';
import { subSectorGroups } from '../utils/sectors';

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CALLS_PER_TICKER = 4;

function collectHeatmapTickers(): string[] {
  const tickers: string[] = [];
  for (const sector of Object.values(subSectorGroups)) {
    for (const list of Object.values(sector)) {
      for (const t of list) tickers.push(t.toUpperCase());
    }
  }
  return Array.from(new Set(tickers));
}

export async function backfillHeatmapFundamentals(): Promise<void> {
  const tickers = collectHeatmapTickers();
  const total = tickers.length;

  const cachedRows = await prisma.fundamentalsCache.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, lastFetchedAt: true },
  });

  const cachedMap = new Map(cachedRows.map(r => [r.ticker, r.lastFetchedAt]));
  const now = Date.now();

  const staleOrMissing = tickers.filter((t) => {
    const last = cachedMap.get(t);
    if (!last) return true;
    const age = now - new Date(last).getTime();
    return age > CACHE_MAX_AGE_MS;
  });

  const cachedCount = total - staleOrMissing.length;
  const remainingCalls = await getDailyCallsRemaining();
  const maxTickers = Math.floor(remainingCalls / CALLS_PER_TICKER);
  const toBackfill = staleOrMissing.slice(0, maxTickers);

  let backfilled = 0;
  let failed = 0;

  for (const ticker of toBackfill) {
    try {
      await refreshFundamentalsForTicker(ticker);
      backfilled += 1;
    } catch (err) {
      failed += 1;
      console.error(`[Heatmap Fundamentals] Backfill failed for ${ticker}:`, (err as Error).message);
    }
  }

  console.log(
    `[Heatmap Fundamentals] ${cachedCount}/${total} cached, ${backfilled} backfilled, ${failed} failed`
  );
}
