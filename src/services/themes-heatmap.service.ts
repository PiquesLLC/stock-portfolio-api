import { fetchPrices, fetchDailyCandles } from './market.service';
import themesData from '../data/finviz-themes-detailed.json';
import type { HeatmapPeriod } from './market-heatmap.service';
import { runJob } from './job-runner.service';
import { periodStartClose } from '../utils/candle-window';

// ── Types (matches HeatmapResponse shape from market-heatmap.service) ──

interface HeatmapStock {
  ticker: string;
  name: string;
  price: number;
  changePercent: number;
  dayChange: number;
  marketCapB: number;
  subSector: string;
  noTradeData?: boolean;
}

interface HeatmapSubSector {
  name: string;
  stocks: HeatmapStock[];
  totalMarketCapB: number;
  avgChangePercent: number;
}

interface HeatmapSector {
  name: string;
  stocks: HeatmapStock[];
  subSectors: HeatmapSubSector[];
  totalMarketCapB: number;
  avgChangePercent: number;
  gainers: number;
  losers: number;
}

interface HeatmapResponse {
  sectors: HeatmapSector[];
  period: string;
  generated: number;
}

// ── Cache ──────────────────────────────────────────────────────

type QuoteSource = 'regular' | 'extended' | 'prevClose';

let quotesCache = new Map<string, { changePercent: number; price: number; source: QuoteSource }>();
let cacheUpdatedAt: number | null = null;
let refreshInProgress = false;

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE = 100;
const BATCH_DELAY = 500; // 500ms between batches

const PERIOD_DAYS: Record<HeatmapPeriod, number> = {
  '1D': 0, '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1Y': 365,
};

// Cache for non-1D period changes (keyed by period)
import NodeCache from 'node-cache';
const periodChangesCache = new NodeCache({ stdTTL: 300 }); // 5 min

// ── Background refresh ─────────────────────────────────────────

function getAllUniqueTickers(): string[] {
  const set = new Set<string>();
  for (const theme of themesData.themes) {
    for (const sub of theme.subthemes) {
      for (const t of sub.tickers) set.add(t);
    }
  }
  return [...set];
}

async function refreshQuotesBackground(): Promise<void> {
  if (refreshInProgress) return;
  refreshInProgress = true;

  try {
    const allTickers = getAllUniqueTickers();
    const newCache = new Map<string, { changePercent: number; price: number; source: QuoteSource }>();

    for (let i = 0; i < allTickers.length; i += BATCH_SIZE) {
      const batch = allTickers.slice(i, i + BATCH_SIZE);
      try {
        const result = await fetchPrices(batch, { preferPolygon: true });
        for (const [ticker, quote] of result.quotes) {
          // Prefer extended-hours data (Yahoo enrichment) during PRE/POST/CLOSED
          const hasExtended = quote.extendedChangePercent != null && quote.extendedPrice != null;
          const price = hasExtended ? quote.extendedPrice! : quote.currentPrice;

          // During extended hours, compute TOTAL change from previous close
          // (not just the after-hours delta). This matches Finviz behavior.
          let changePercent: number;
          if (hasExtended && quote.previousClose > 0) {
            changePercent = ((quote.extendedPrice! - quote.previousClose) / quote.previousClose) * 100;
          } else {
            changePercent = quote.changePercent;
          }

          // Detect prevClose fallback: price equals previousClose and change is 0
          const isPrevCloseFallback = !hasExtended
            && quote.changePercent === 0
            && quote.change === 0
            && quote.currentPrice === quote.previousClose
            && quote.previousClose > 0;

          const source: QuoteSource = hasExtended ? 'extended'
            : isPrevCloseFallback ? 'prevClose'
            : 'regular';

          newCache.set(ticker, { changePercent, price, source });
        }
      } catch (err) {
        console.error(`[ThemesHeatmap] Batch ${i}-${i + batch.length} failed:`, err);
      }

      if (i + BATCH_SIZE < allTickers.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }
    }

    if (newCache.size > 0) {
      quotesCache = newCache;
      cacheUpdatedAt = Date.now();
    }

    console.log(`[ThemesHeatmap] Refreshed ${newCache.size}/${allTickers.length} quotes`);
  } finally {
    refreshInProgress = false;
  }
}

const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
const shouldScheduleBackgroundRefresh = !isTestEnv;

if (shouldScheduleBackgroundRefresh) {
  // Start background refresh on module load
  runJob({ name: 'themes_heatmap_refresh', fn: refreshQuotesBackground, maxAttempts: 1 });

  // Refresh every 5 minutes
  setInterval(() => {
    runJob({ name: 'themes_heatmap_refresh', fn: refreshQuotesBackground, maxAttempts: 1 });
  }, CACHE_TTL);
}

// ── Historical period changes ─────────────────────────────────

async function fetchThemePeriodChanges(
  tickers: string[],
  days: number,
): Promise<Map<string, number>> {
  const changes = new Map<string, number>();
  const HIST_BATCH = 20;

  for (let i = 0; i < tickers.length; i += HIST_BATCH) {
    const batch = tickers.slice(i, i + HIST_BATCH);
    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        const candles = await fetchDailyCandles(ticker, days);
        if (candles.length < 2) return { ticker, change: 0 };
        // Date-anchored start ("price N days ago") via the shared helper — the old
        // timestamp anchor skipped the boundary day and understated the change.
        const startPrice = periodStartClose(candles, days);
        const endPrice = candles[candles.length - 1].close;
        if (startPrice == null || startPrice <= 0) return { ticker, change: 0 };
        return { ticker, change: Math.round(((endPrice - startPrice) / startPrice) * 10000) / 100 };
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') changes.set(r.value.ticker, r.value.change);
    }
  }
  return changes;
}

// ── Public API — returns HeatmapResponse shape ─────────────────
// Each theme = sector, each subtheme = a visible tile (HeatmapStock)
// with avgChangePercent across its constituent tickers.
// Individual tickers live inside subSector.stocks for tooltip display.

export async function getThemesHeatmapData(period: HeatmapPeriod = '1D'): Promise<HeatmapResponse> {
  const cacheKey = `themes-${period}`;
  const cached = periodChangesCache.get<HeatmapResponse>(cacheKey);
  if (cached) return cached;

  // If quotes cache is empty (cold start / post-deploy), wait for background refresh
  if (quotesCache.size === 0 && !isTestEnv) {
    console.log('[ThemesHeatmap] Quotes cache empty, waiting for background refresh...');
    const maxWait = 45000; // 45s max
    const start = Date.now();
    while (quotesCache.size === 0 && Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[ThemesHeatmap] Cache warmed: ${quotesCache.size} quotes in ${Date.now() - start}ms`);
  }

  // For non-1D periods, fetch historical changes
  let periodChangeMap: Map<string, number> | null = null;
  const days = PERIOD_DAYS[period];
  if (days > 0) {
    const allTickers = getAllUniqueTickers();
    periodChangeMap = await fetchThemePeriodChanges(allTickers, days);
  }

  const sectors: HeatmapSector[] = themesData.themes.map(theme => {
    // Build subSectors with real ticker data inside each
    const subSectors: HeatmapSubSector[] = theme.subthemes.map(sub => {
      const tickerStocks: HeatmapStock[] = sub.tickers.map(t => {
        const q = quotesCache.get(t);
        const changePercent = periodChangeMap
          ? (periodChangeMap.get(t) ?? 0)
          : (q?.changePercent ?? 0);
        const stock: HeatmapStock = {
          ticker: t,
          name: t,
          price: q?.price ?? 0,
          changePercent,
          dayChange: 0,
          marketCapB: 1,
          subSector: sub.name,
        };
        if (!periodChangeMap && q?.source === 'prevClose') stock.noTradeData = true;
        return stock;
      });

      const validChanges = tickerStocks
        .filter(s => !s.noTradeData && (periodChangeMap ? periodChangeMap.has(s.ticker) : quotesCache.has(s.ticker)))
        .map(s => s.changePercent);
      const avg = validChanges.length > 0
        ? validChanges.reduce((s, c) => s + c, 0) / validChanges.length
        : 0;

      return {
        name: sub.name,
        stocks: tickerStocks,
        totalMarketCapB: sub.tickers.length,
        avgChangePercent: Math.round(avg * 100) / 100,
      };
    });

    // Each subtheme becomes a visible tile (HeatmapStock) at the sector level
    const stocks: HeatmapStock[] = subSectors.map(sub => ({
      ticker: sub.name,        // subtheme name shown as tile label
      name: sub.name,
      price: 0,
      changePercent: sub.avgChangePercent,
      dayChange: 0,
      marketCapB: sub.stocks.length, // weight by ticker count
      subSector: sub.name,     // must match subSector name for tooltip lookup
    }));

    const allChanges = subSectors
      .flatMap(sub => sub.stocks)
      .filter(s => !s.noTradeData && (periodChangeMap ? periodChangeMap.has(s.ticker) : quotesCache.has(s.ticker)))
      .map(s => s.changePercent);
    const themeAvg = allChanges.length > 0
      ? allChanges.reduce((s, c) => s + c, 0) / allChanges.length
      : 0;

    return {
      name: theme.theme,
      stocks,
      subSectors,
      totalMarketCapB: stocks.reduce((s, st) => s + st.marketCapB, 0),
      avgChangePercent: Math.round(themeAvg * 100) / 100,
      gainers: allChanges.filter(c => c > 0).length,
      losers: allChanges.filter(c => c < 0).length,
    };
  });

  const result: HeatmapResponse = {
    sectors,
    period,
    generated: cacheUpdatedAt ?? Date.now(),
  };

  // Cache non-1D results for 5 min, 1D for 1 min
  periodChangesCache.set(cacheKey, result, days > 0 ? 300 : 60);

  return result;
}
