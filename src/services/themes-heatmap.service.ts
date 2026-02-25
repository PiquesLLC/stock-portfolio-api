import { fetchPrices } from './market.service';
import themesData from '../data/finviz-themes-detailed.json';

// ── Types (matches HeatmapResponse shape from market-heatmap.service) ──

interface HeatmapStock {
  ticker: string;
  name: string;
  price: number;
  changePercent: number;
  dayChange: number;
  marketCapB: number;
  subSector: string;
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

let quotesCache = new Map<string, { changePercent: number; price: number }>();
let cacheUpdatedAt: number | null = null;
let refreshInProgress = false;

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE = 80;
const BATCH_DELAY = 2000; // 2s between batches

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
    const newCache = new Map<string, { changePercent: number; price: number }>();

    for (let i = 0; i < allTickers.length; i += BATCH_SIZE) {
      const batch = allTickers.slice(i, i + BATCH_SIZE);
      try {
        const result = await fetchPrices(batch, { preferPolygon: true });
        for (const [ticker, quote] of result.quotes) {
          newCache.set(ticker, {
            changePercent: quote.changePercent,
            price: quote.currentPrice,
          });
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

// Start background refresh on module load
refreshQuotesBackground();

// Refresh every 5 minutes
setInterval(() => {
  refreshQuotesBackground();
}, CACHE_TTL);

// ── Public API — returns HeatmapResponse shape ─────────────────
// Each theme = sector, each subtheme = a visible tile (HeatmapStock)
// with avgChangePercent across its constituent tickers.
// Individual tickers live inside subSector.stocks for tooltip display.

export function getThemesHeatmapData(): HeatmapResponse {
  const sectors: HeatmapSector[] = themesData.themes.map(theme => {
    // Build subSectors with real ticker data inside each
    const subSectors: HeatmapSubSector[] = theme.subthemes.map(sub => {
      const tickerStocks: HeatmapStock[] = sub.tickers.map(t => {
        const q = quotesCache.get(t);
        return {
          ticker: t,
          name: t,
          price: q?.price ?? 0,
          changePercent: q?.changePercent ?? 0,
          dayChange: 0,
          marketCapB: 1,
          subSector: sub.name,
        };
      });

      const validChanges = tickerStocks
        .filter(s => quotesCache.has(s.ticker))
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
      .filter(s => quotesCache.has(s.ticker))
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

  return {
    sectors,
    period: '1D',
    generated: cacheUpdatedAt ?? Date.now(),
  };
}
