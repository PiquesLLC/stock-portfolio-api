/**
 * Market Screener Service — separate from `market-heatmap.service.ts` because
 * the Screener tab needs a much wider ticker universe (~945+ from Finviz +
 * curated sub-sectors) and cannot afford the per-period candle fetches that
 * the heatmap does (those bottleneck around ~50 tickers/sec).
 *
 * Universe = union of:
 *   - ScreenerUniverse table rows (Finviz themes ingestion + future sources)
 *   - subSectorGroups curated 276 (so existing behavior is preserved)
 *
 * For each ticker we return:
 *   - live price + 1D change% (from fetchPrices Polygon snapshot, batched)
 *   - market cap from FundamentalsCache.overviewJson (Yahoo backfill on null)
 *   - P/E / dividend / beta / 52W from ScreenerCache
 *   - sector from subSectorGroups lookup, falling back to overview.sector
 *
 * No candle fetches → no period changes → keeps the response cheap. Cached 120s.
 */
import NodeCache from 'node-cache';
import prisma from '../utils/prisma';
import { subSectorGroups, getSector } from '../utils/sectors';
import { fetchPrices } from './market.service';
import { yahooGet } from '../utils/yahoo-http';
import { getPolygonSnapshotVolumes } from '../utils/polygon';

const screenerCache = new NodeCache({ stdTTL: 120 });
const yahooFundamentalsCache = new NodeCache({ stdTTL: 6 * 60 * 60 }); // 6h

// Concurrency guards: prevent thundering-herd on cache miss and unbounded
// background Yahoo work when many concurrent cold requests land.
let inflightBuild: Promise<ScreenerResponse> | null = null;
let inflightYahooBackfill: Promise<unknown> | null = null;

export interface ScreenerStock {
  ticker: string;
  name: string;
  price: number;
  changePercent: number;
  dayChange: number;
  marketCapB: number;
  volume: number;
  sector?: string;
  subSector?: string;
  pe?: number | null;
  dividendYield?: number | null;
  beta?: number | null;
  week52High?: number | null;
  week52Low?: number | null;
  themes?: string[];
}

export interface ScreenerResponse {
  stocks: ScreenerStock[];
  generated: number;
  universeSize: number;
}

function parseMarketCapB(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const num = parseFloat(raw.replace(/[$,]/g, ''));
    if (Number.isFinite(num)) return num;
  }
  return null;
}

/** Coerce a possibly-stringified number from cache JSON to a finite number, else null. */
function asFiniteNumberOrNull(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const num = parseFloat(raw);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function resolveMarketCapB(overview: unknown): number | null {
  const o = overview as Record<string, unknown> | null;
  const direct = parseMarketCapB(o?.marketCapB);
  if (direct != null) return direct;
  const rawCap = parseMarketCapB(o?.marketCap ?? o?.MarketCapitalization);
  if (rawCap != null) return rawCap / 1_000_000_000;
  return null;
}

function resolveName(overview: unknown, fallbackTicker: string): string {
  const o = overview as Record<string, unknown> | null;
  return (o?.companyName as string) || (o?.name as string) || (o?.Name as string) || fallbackTicker;
}

function resolveSector(ticker: string, overview: unknown): string | undefined {
  const curated = getSector(ticker);
  if (curated && curated !== 'Other') return curated;
  const o = overview as Record<string, unknown> | null;
  const sec = (o?.sector as string) || (o?.Sector as string);
  if (sec && sec.trim()) return sec.trim();
  return curated; // may be 'Other' or undefined
}

function curatedTickers(): Set<string> {
  const set = new Set<string>();
  for (const subs of Object.values(subSectorGroups)) {
    for (const list of Object.values(subs)) {
      for (const t of list) set.add(t.toUpperCase());
    }
  }
  return set;
}

interface YahooFundamentals { name: string; marketCapB: number }

async function fetchYahooFundamentals(ticker: string): Promise<YahooFundamentals | null> {
  const upper = ticker.toUpperCase();
  const cacheKey = `screener-yh-fund:${upper}`;
  const cached = yahooFundamentalsCache.get<YahooFundamentals>(cacheKey);
  if (cached) return cached;
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(upper)}?modules=price`;
    const resp = await yahooGet(url, 8000);
    const price = resp.data?.quoteSummary?.result?.[0]?.price;
    if (!price) return null;
    const name = price.shortName || price.longName || upper;
    const mc = price.marketCap?.raw;
    if (typeof mc !== 'number' || !isFinite(mc) || mc <= 0) return null;
    const result: YahooFundamentals = { name, marketCapB: mc / 1_000_000_000 };
    yahooFundamentalsCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

async function fetchYahooFundamentalsBatch(tickers: string[]): Promise<Map<string, YahooFundamentals>> {
  const result = new Map<string, YahooFundamentals>();
  if (tickers.length === 0) return result;
  const BATCH_SIZE = 30;
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(t => fetchYahooFundamentals(t)));
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      if (r.status === 'fulfilled' && r.value) {
        result.set(batch[j].toUpperCase(), r.value);
      }
    }
  }
  return result;
}

export async function getScreenerData(): Promise<ScreenerResponse> {
  const cacheKey = `screener-v1`;
  const cached = screenerCache.get<ScreenerResponse>(cacheKey);
  if (cached) return cached;
  // Single-flight: if a build is already in progress, every concurrent caller
  // shares its promise. Prevents N parallel cold-fetches after TTL expiry.
  if (inflightBuild) return inflightBuild;

  // Capture into a local first so a synchronous throw before the first await
  // (or any path that clears `inflightBuild` in `finally` before our return)
  // can't leave us returning `null`.
  const buildPromise: Promise<ScreenerResponse> = (async (): Promise<ScreenerResponse> => {
    try {
      // Universe: ScreenerUniverse ∪ curated subSectorGroups
      const universeRows = await prisma.screenerUniverse.findMany({
        select: { ticker: true, themesJson: true },
      });

      const universe = new Set<string>(curatedTickers());
      const themesByTicker = new Map<string, string[]>();
      for (const row of universeRows) {
        const t = row.ticker.toUpperCase();
        universe.add(t);
        if (row.themesJson) {
          try {
            const parsed = JSON.parse(row.themesJson) as Array<{ theme: string }>;
            themesByTicker.set(t, parsed.map(p => p.theme));
          } catch { /* ignore malformed JSON */ }
        }
      }
      const tickers = Array.from(universe);

      // Phase 1 fan-out — quotes + volumes + DB caches in parallel.
      const [{ quotes }, polygonVolumes, fundamentals, screenerRows] = await Promise.all([
        fetchPrices(tickers),
        getPolygonSnapshotVolumes(tickers),
        prisma.fundamentalsCache.findMany({
          where: { ticker: { in: tickers } },
          select: { ticker: true, overviewJson: true },
        }),
        prisma.screenerCache.findMany({
          where: { ticker: { in: tickers } },
        }),
      ]);

      const fundamentalsMap = new Map<string, unknown>();
      for (const row of fundamentals) {
        if (!row.overviewJson) continue;
        try { fundamentalsMap.set(row.ticker, JSON.parse(row.overviewJson)); }
        catch { /* malformed cache */ }
      }
      const screenerMap = new Map(screenerRows.map(r => [r.ticker, r]));

      // First, hydrate from any Yahoo data already cached by a prior fire-and-forget
      // pass. Without this, the first cold build always returns `marketCapB: 0` for
      // ~700 tickers, and subsequent builds within the 6h Yahoo TTL would re-fetch
      // unnecessarily — but worse, the in-memory build cache (120s) would persist
      // the zeros across many user requests even after Yahoo populated.
      for (const ticker of tickers) {
        if (resolveMarketCapB(fundamentalsMap.get(ticker)) != null) continue;
        const cached = yahooFundamentalsCache.get<YahooFundamentals>(`screener-yh-fund:${ticker}`);
        if (!cached) continue;
        const existing = (fundamentalsMap.get(ticker) ?? {}) as Record<string, unknown>;
        fundamentalsMap.set(ticker, {
          ...existing,
          companyName: existing.companyName ?? existing.name ?? cached.name,
          marketCapB: cached.marketCapB,
        });
      }

      // Yahoo backfill for tickers whose cap can't be resolved from cache. Same
      // policy as the heatmap service: synchronous when small, fire-and-forget
      // when large so the response never stalls. The fire-and-forget path is
      // single-flight at module level so concurrent cold requests don't each
      // spawn a 700-ticker fan-out.
      const tickersNeedingCap = tickers.filter(t => resolveMarketCapB(fundamentalsMap.get(t)) == null);
      if (tickersNeedingCap.length > 0 && tickersNeedingCap.length < 30) {
        const yahooFallbacks = await fetchYahooFundamentalsBatch(tickersNeedingCap);
        for (const [ticker, data] of yahooFallbacks) {
          const existing = (fundamentalsMap.get(ticker) ?? {}) as Record<string, unknown>;
          fundamentalsMap.set(ticker, {
            ...existing,
            companyName: existing.companyName ?? existing.name ?? data.name,
            marketCapB: data.marketCapB,
          });
        }
      } else if (tickersNeedingCap.length >= 30 && !inflightYahooBackfill) {
        inflightYahooBackfill = fetchYahooFundamentalsBatch(tickersNeedingCap)
          .catch(() => undefined)
          .finally(() => { inflightYahooBackfill = null; });
      }

      // Build response rows.
      const stocks: ScreenerStock[] = [];
      for (const ticker of tickers) {
        const upper = ticker.toUpperCase();
        const quote = quotes.get(upper);
        const overview = fundamentalsMap.get(upper) as Record<string, unknown> | undefined;
        const screener = screenerMap.get(upper);
        const currentPrice = quote?.currentPrice ?? 0;
        if (currentPrice <= 0) continue; // drop tickers with no price (delisted / illiquid)

        const marketCapB = resolveMarketCapB(overview) ?? 0;
        const changePercent = quote?.changePercent ?? 0;
        const dayChange = quote?.change ?? 0;

        // Coerce defensively — overviewJson can store stringified numbers from
        // some upstream sources, and a string sneaking into a `number | null`
        // field silently breaks downstream `pe < 15` comparisons.
        let pe = asFiniteNumberOrNull(overview?.peRatio);
        let dividendYield = asFiniteNumberOrNull(overview?.dividendYield);
        let beta = asFiniteNumberOrNull(overview?.beta);
        let week52High = asFiniteNumberOrNull(overview?.fiftyTwoWeekHigh);
        let week52Low = asFiniteNumberOrNull(overview?.fiftyTwoWeekLow);
        if (screener) {
          if (screener.eps != null && screener.eps > 0 && currentPrice > 0) {
            pe = Math.round((currentPrice / screener.eps) * 100) / 100;
          }
          if (screener.annualDividend != null && screener.annualDividend > 0 && currentPrice > 0) {
            dividendYield = Math.round((screener.annualDividend / currentPrice) * 10000) / 100;
          }
          if (screener.beta != null) beta = screener.beta;
          if (screener.week52High != null) week52High = screener.week52High;
          if (screener.week52Low != null) week52Low = screener.week52Low;
        }

        const themes = themesByTicker.get(upper);

        stocks.push({
          ticker: upper,
          name: resolveName(overview, upper),
          price: currentPrice,
          changePercent,
          dayChange,
          marketCapB,
          volume: polygonVolumes.get(upper) ?? 0,
          sector: resolveSector(upper, overview),
          // subSector is required on the shared HeatmapStock type — default to
          // first theme if Finviz tagged it, else the curated sub-sector if known,
          // else empty string so consumers (e.g. localeCompare in sort) are safe.
          subSector: themes?.[0] ?? '',
          pe,
          dividendYield,
          beta,
          week52High,
          week52Low,
          themes,
        });
      }

      const response: ScreenerResponse = {
        stocks,
        generated: Date.now(),
        universeSize: tickers.length,
      };
      screenerCache.set(cacheKey, response, 120);
      return response;
    } finally {
      inflightBuild = null;
    }
  })();
  inflightBuild = buildPromise;
  return buildPromise;
}
