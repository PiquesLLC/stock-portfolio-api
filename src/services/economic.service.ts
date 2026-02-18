/**
 * Economic Indicators Service
 *
 * US: Fetches CPI, Fed Funds Rate, Treasury Yield, Unemployment, GDP from Alpha Vantage.
 * International: Fetches GDP Growth, Inflation, Unemployment from World Bank API (EU + Japan).
 * Caches to Prisma/SQLite. Refreshes daily via background jobs.
 */

import prisma from '../utils/prisma';
import {
  fetchCPI,
  fetchFedFundsRate,
  fetchTreasuryYield,
  fetchUnemployment,
  fetchGDP,
  AVEconomicData,
} from '../utils/alpha-vantage';
import { fetchWorldBankIndicator } from '../utils/world-bank';



const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface EconomicIndicator {
  name: string;
  latestValue: number | null;
  latestDate: string;
  previousValue: number | null;
  previousDate: string;
  change: number | null;
  changePercent: number | null;
  unit: string;
  history: { date: string; value: number }[];
}

export interface EconomicDashboard {
  indicators: {
    cpi: EconomicIndicator | null;
    fedFundsRate: EconomicIndicator | null;
    treasuryYield10Y: EconomicIndicator | null;
    unemployment: EconomicIndicator | null;
    gdp: EconomicIndicator | null;
  };
  lastUpdated: string;
  dataAge: 'fresh' | 'cached' | 'stale';
}

const INDICATOR_CONFIG = [
  { key: 'CPI', name: 'Consumer Price Index', unit: 'index', fetcher: fetchCPI },
  { key: 'FEDERAL_FUNDS_RATE', name: 'Federal Funds Rate', unit: 'percent', fetcher: fetchFedFundsRate },
  { key: 'TREASURY_YIELD_10Y', name: '10-Year Treasury Yield', unit: 'percent', fetcher: () => fetchTreasuryYield('10year') },
  { key: 'UNEMPLOYMENT', name: 'Unemployment Rate', unit: 'percent', fetcher: fetchUnemployment },
  { key: 'REAL_GDP', name: 'Real GDP', unit: 'billions of dollars', fetcher: fetchGDP },
] as const;

function parseIndicatorData(raw: AVEconomicData): { history: { date: string; value: number }[] } {
  const history = raw.data
    .filter(d => d.value && d.value !== '.')
    .slice(0, 24)
    .map(d => ({ date: d.date, value: parseFloat(d.value) }))
    .filter(d => !isNaN(d.value));
  return { history };
}

function buildIndicator(
  name: string,
  unit: string,
  history: { date: string; value: number }[],
): EconomicIndicator {
  const latest = history[0] ?? null;
  const previous = history[1] ?? null;
  const change = latest && previous ? +(latest.value - previous.value).toFixed(4) : null;
  const changePercent = latest && previous && previous.value !== 0
    ? +((change! / previous.value) * 100).toFixed(2)
    : null;

  return {
    name,
    latestValue: latest?.value ?? null,
    latestDate: latest?.date ?? '',
    previousValue: previous?.value ?? null,
    previousDate: previous?.date ?? '',
    change,
    changePercent,
    unit,
    history: history.slice().reverse(), // chronological order for sparkline
  };
}

/** Get the full economic dashboard, serving from cache when possible. */
export async function getEconomicDashboard(): Promise<EconomicDashboard> {
  const cached = await prisma.economicIndicatorCache.findMany();
  const cacheMap = new Map(cached.map(c => [c.indicator, c]));

  // Determine data age from the oldest cache entry
  let oldestFetch = Date.now();
  for (const c of cached) {
    const fetchTime = new Date(c.lastFetchedAt).getTime();
    if (fetchTime < oldestFetch) oldestFetch = fetchTime;
  }

  const ageMs = Date.now() - oldestFetch;
  const dataAge: 'fresh' | 'cached' | 'stale' =
    cached.length === 0 ? 'stale' :
    ageMs < CACHE_MAX_AGE_MS ? 'fresh' :
    ageMs < CACHE_MAX_AGE_MS * 7 ? 'cached' : 'stale';

  const indicators: Record<string, EconomicIndicator | null> = {
    cpi: null,
    fedFundsRate: null,
    treasuryYield10Y: null,
    unemployment: null,
    gdp: null,
  };

  const keyToField: Record<string, string> = {
    CPI: 'cpi',
    FEDERAL_FUNDS_RATE: 'fedFundsRate',
    TREASURY_YIELD_10Y: 'treasuryYield10Y',
    UNEMPLOYMENT: 'unemployment',
    REAL_GDP: 'gdp',
  };

  for (const cfg of INDICATOR_CONFIG) {
    const row = cacheMap.get(cfg.key);
    if (row) {
      const history: { date: string; value: number }[] = JSON.parse(row.historyJson || '[]');
      indicators[keyToField[cfg.key]] = buildIndicator(row.name, row.unit, history);
    }
  }

  return {
    indicators: indicators as EconomicDashboard['indicators'],
    lastUpdated: cached.length > 0
      ? new Date(Math.max(...cached.map(c => new Date(c.lastFetchedAt).getTime()))).toISOString()
      : '',
    dataAge,
  };
}

/** Refresh all 5 economic indicators from Alpha Vantage. Uses 5 API calls. */
export async function refreshEconomicIndicators(): Promise<void> {
  console.log('[AV Economic] Starting refresh of all indicators...');

  for (const cfg of INDICATOR_CONFIG) {
    try {
      const raw = await cfg.fetcher();
      if (!raw || !raw.data || raw.data.length === 0) {
        console.warn(`[AV Economic] No data returned for ${cfg.key}`);
        continue;
      }

      const { history } = parseIndicatorData(raw);
      if (history.length === 0) {
        console.warn(`[AV Economic] All values empty for ${cfg.key}`);
        continue;
      }

      await prisma.economicIndicatorCache.upsert({
        where: { indicator: cfg.key },
        update: {
          name: cfg.name,
          unit: cfg.unit,
          latestValue: history[0]?.value ?? null,
          latestDate: history[0]?.date ?? null,
          historyJson: JSON.stringify(history),
          lastFetchedAt: new Date(),
        },
        create: {
          indicator: cfg.key,
          name: cfg.name,
          unit: cfg.unit,
          latestValue: history[0]?.value ?? null,
          latestDate: history[0]?.date ?? null,
          historyJson: JSON.stringify(history),
          lastFetchedAt: new Date(),
        },
      });

      console.log(`[AV Economic] Updated ${cfg.key}: ${history[0]?.value}`);
    } catch (err) {
      console.error(`[AV Economic] Failed ${cfg.key}:`, (err as Error).message);
      // Continue to next indicator â€” don't let one failure block others
    }
  }

  console.log('[AV Economic] Refresh complete');
}

// â”€â”€â”€ International Economic Data (World Bank API) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface InternationalEconomicDashboard {
  regions: {
    us: {
      name: string;
      indicators: {
        gdpGrowth: EconomicIndicator | null;
      };
    };
    eu: {
      name: string;
      indicators: {
        gdpGrowth: EconomicIndicator | null;
        inflation: EconomicIndicator | null;
        unemployment: EconomicIndicator | null;
        gdp: EconomicIndicator | null;
      };
    };
    japan: {
      name: string;
      indicators: {
        gdpGrowth: EconomicIndicator | null;
        inflation: EconomicIndicator | null;
        unemployment: EconomicIndicator | null;
        gdp: EconomicIndicator | null;
      };
    };
  };
  lastUpdated: string;
  dataAge: 'fresh' | 'cached' | 'stale';
}

const INTL_INDICATOR_CONFIG = [
  { key: 'WB_US_GDP_GROWTH', name: 'GDP Growth', unit: 'percent', country: 'USA', wbCode: 'NY.GDP.MKTP.KD.ZG' },
  { key: 'WB_EU_GDP_GROWTH', name: 'GDP Growth', unit: 'percent', country: 'EUU', wbCode: 'NY.GDP.MKTP.KD.ZG' },
  { key: 'WB_EU_INFLATION', name: 'Inflation Rate', unit: 'percent', country: 'EUU', wbCode: 'FP.CPI.TOTL.ZG' },
  { key: 'WB_EU_UNEMPLOYMENT', name: 'Unemployment Rate', unit: 'percent', country: 'EUU', wbCode: 'SL.UEM.TOTL.ZS' },
  { key: 'WB_EU_GDP', name: 'GDP', unit: 'current usd', country: 'EUU', wbCode: 'NY.GDP.MKTP.CD' },
  { key: 'WB_JPN_GDP_GROWTH', name: 'GDP Growth', unit: 'percent', country: 'JPN', wbCode: 'NY.GDP.MKTP.KD.ZG' },
  { key: 'WB_JPN_INFLATION', name: 'Inflation Rate', unit: 'percent', country: 'JPN', wbCode: 'FP.CPI.TOTL.ZG' },
  { key: 'WB_JPN_UNEMPLOYMENT', name: 'Unemployment Rate', unit: 'percent', country: 'JPN', wbCode: 'SL.UEM.TOTL.ZS' },
  { key: 'WB_JPN_GDP', name: 'GDP', unit: 'current usd', country: 'JPN', wbCode: 'NY.GDP.MKTP.CD' },
];

const INTL_KEY_TO_FIELD: Record<string, { region: 'us' | 'eu' | 'japan'; field: string }> = {
  WB_US_GDP_GROWTH: { region: 'us', field: 'gdpGrowth' },
  WB_EU_GDP_GROWTH: { region: 'eu', field: 'gdpGrowth' },
  WB_EU_INFLATION: { region: 'eu', field: 'inflation' },
  WB_EU_UNEMPLOYMENT: { region: 'eu', field: 'unemployment' },
  WB_EU_GDP: { region: 'eu', field: 'gdp' },
  WB_JPN_GDP_GROWTH: { region: 'japan', field: 'gdpGrowth' },
  WB_JPN_INFLATION: { region: 'japan', field: 'inflation' },
  WB_JPN_UNEMPLOYMENT: { region: 'japan', field: 'unemployment' },
  WB_JPN_GDP: { region: 'japan', field: 'gdp' },
};

/** Get international economic dashboard, serving from cache. */
export async function getInternationalEconomicDashboard(): Promise<InternationalEconomicDashboard> {
  const intlKeys = INTL_INDICATOR_CONFIG.map(c => c.key);
  const cached = await prisma.economicIndicatorCache.findMany({
    where: { indicator: { in: intlKeys } },
  });
  const cacheMap = new Map(cached.map(c => [c.indicator, c]));

  // Determine data age
  let oldestFetch = Date.now();
  for (const c of cached) {
    const fetchTime = new Date(c.lastFetchedAt).getTime();
    if (fetchTime < oldestFetch) oldestFetch = fetchTime;
  }
  const ageMs = Date.now() - oldestFetch;
  const dataAge: 'fresh' | 'cached' | 'stale' =
    cached.length === 0 ? 'stale' :
    ageMs < CACHE_MAX_AGE_MS ? 'fresh' :
    ageMs < CACHE_MAX_AGE_MS * 7 ? 'cached' : 'stale';

  const result: InternationalEconomicDashboard = {
    regions: {
      us: {
        name: 'United States',
        indicators: { gdpGrowth: null },
      },
      eu: {
        name: 'European Union',
        indicators: { gdpGrowth: null, inflation: null, unemployment: null, gdp: null },
      },
      japan: {
        name: 'Japan',
        indicators: { gdpGrowth: null, inflation: null, unemployment: null, gdp: null },
      },
    },
    lastUpdated: cached.length > 0
      ? new Date(Math.max(...cached.map(c => new Date(c.lastFetchedAt).getTime()))).toISOString()
      : '',
    dataAge,
  };

  for (const cfg of INTL_INDICATOR_CONFIG) {
    const row = cacheMap.get(cfg.key);
    if (!row) continue;
    const mapping = INTL_KEY_TO_FIELD[cfg.key];
    if (!mapping) continue;

    const history: { date: string; value: number }[] = JSON.parse(row.historyJson || '[]');
    const indicator = buildIndicator(row.name, row.unit, history);
    (result.regions[mapping.region].indicators as any)[mapping.field] = indicator;
  }

  return result;
}

/** Refresh international economic indicators from World Bank API. 6 API calls. */
export async function refreshInternationalIndicators(): Promise<void> {
  console.log('[WB International] Starting refresh of all indicators...');

  for (const cfg of INTL_INDICATOR_CONFIG) {
    try {
      const data = await fetchWorldBankIndicator(cfg.country, cfg.wbCode);

      if (data.length === 0) {
        console.warn(`[WB International] No data returned for ${cfg.key}`);
        continue;
      }

      // Data is already sorted chronologically (oldest first) from world-bank.ts
      // For buildIndicator, we need newest-first (history[0] = latest)
      const historyNewestFirst = data
        .map(d => ({ date: d.date, value: d.value }))
        .reverse();

      await prisma.economicIndicatorCache.upsert({
        where: { indicator: cfg.key },
        update: {
          name: cfg.name,
          unit: cfg.unit,
          latestValue: historyNewestFirst[0]?.value ?? null,
          latestDate: historyNewestFirst[0]?.date ?? null,
          historyJson: JSON.stringify(historyNewestFirst),
          lastFetchedAt: new Date(),
        },
        create: {
          indicator: cfg.key,
          name: cfg.name,
          unit: cfg.unit,
          latestValue: historyNewestFirst[0]?.value ?? null,
          latestDate: historyNewestFirst[0]?.date ?? null,
          historyJson: JSON.stringify(historyNewestFirst),
          lastFetchedAt: new Date(),
        },
      });

      console.log(`[WB International] Updated ${cfg.key}: ${historyNewestFirst[0]?.value}`);
    } catch (err) {
      console.error(`[WB International] Failed ${cfg.key}:`, (err as Error).message);
    }
  }

  console.log('[WB International] Refresh complete');
}

