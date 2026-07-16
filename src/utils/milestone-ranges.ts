import NodeCache from 'node-cache';
import { yahooGet } from './yahoo-http';
import { etDate } from './date';

/**
 * Record thresholds for milestone alerts, computed EXCLUDING today's session.
 *
 * The general-purpose helpers in yahoo-finance.ts (get52WeekRange /
 * getAllTimeRange) include the current session's bar, so the moment their
 * cache refreshes mid-session the threshold chases the live price and
 * "price >= high" stops meaning "new high". Milestone notifications need the
 * record as it stood at YESTERDAY's close: beating THAT is what makes today's
 * print a new high/low, and it keeps the threshold stable across the whole
 * trading day.
 */

const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

export interface ChartBars {
  /** Unix seconds, one entry per bar */
  timestamps: number[];
  highs: Array<number | null>;
  lows: Array<number | null>;
}

export interface PriorThresholds {
  week52High: number | null;
  week52Low: number | null;
  allTimeHigh: number | null;
  allTimeLow: number | null;
}

export interface RegularMarketClose {
  close: number;
  /** ET calendar day the close belongs to — reject stale closes (holidays) by comparing to today */
  closedOnEtDate: string;
}

const _etWeekdayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
});

const DAYS_SINCE_MONDAY: Record<string, number> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

function isoAddDays(iso: string, days: number): string {
  const [y, m, dd] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd) + days * 86400000).toISOString().slice(0, 10);
}

/**
 * YYYY-MM-DD of the Monday of the ET week containing `d`. Pure calendar math
 * on the ET date parts (DST-immune) — used to decide whether a weekly bar
 * belongs to the current, still-forming week.
 */
export function etWeekMonday(d: Date): string {
  const day = etDate(d);
  const back = DAYS_SINCE_MONDAY[_etWeekdayFmt.format(d)] ?? 0;
  return isoAddDays(day, -back);
}

/**
 * Compute record thresholds as of yesterday's ET close.
 *
 * - 52-week high/low: daily bars strictly before today's ET session.
 * - All-time high/low: completed prior weeks' weekly bars, PLUS this week's
 *   daily bars before today. The current week's weekly bar is excluded because
 *   it already contains today's session; the daily bridge restores the
 *   Monday..yesterday portion of this week so a record set on Monday still
 *   counts by Wednesday.
 */
export function computePriorThresholds(
  daily: ChartBars | null,
  weekly: ChartBars | null,
  now: Date = new Date(),
): PriorThresholds {
  const today = etDate(now);
  const weekMonday = etWeekMonday(now);

  const collect = (bars: ChartBars | null, keep: (barDate: Date) => boolean) => {
    const highs: number[] = [];
    const lows: number[] = [];
    if (!bars || !Array.isArray(bars.timestamps)) return { highs, lows };
    const n = Math.min(bars.timestamps.length, bars.highs?.length ?? 0, bars.lows?.length ?? 0);
    for (let i = 0; i < n; i++) {
      const ts = bars.timestamps[i];
      if (!Number.isFinite(ts)) continue;
      if (!keep(new Date(ts * 1000))) continue;
      const h = bars.highs[i];
      const l = bars.lows[i];
      if (typeof h === 'number' && h > 0) highs.push(h);
      if (typeof l === 'number' && l > 0) lows.push(l);
    }
    return { highs, lows };
  };

  // YYYY-MM-DD strings compare correctly as strings
  const dailyPrior = collect(daily, (bd) => etDate(bd) < today);
  // Belt-and-braces for the current-week test: Yahoo stamps weekly bars at the
  // Monday session open, but if one ever arrived stamped Monday-00:00 UTC it
  // would render as SUNDAY evening ET and etWeekMonday() would file it under
  // the PRIOR week — leaking today's high into the record. The extra cutoff
  // (anything on/after the Sunday before this week's Monday is "current week")
  // blocks that; genuinely completed weeks sit 7+ days back and are unaffected.
  const weekCutoff = isoAddDays(weekMonday, -1);
  const weeklyPrior = collect(weekly, (bd) => etWeekMonday(bd) < weekMonday && etDate(bd) < weekCutoff);
  const dailyThisWeekPrior = collect(daily, (bd) => {
    const d = etDate(bd);
    return d >= weekMonday && d < today;
  });

  const max = (v: number[]) => (v.length ? Math.max(...v) : null);
  const min = (v: number[]) => (v.length ? Math.min(...v) : null);

  // All-time values require BOTH sources: without the daily bridge, a record
  // set on Monday would be missing from the threshold by Wednesday, and a
  // "new all-time high" claim must never be optimistic.
  let allTimeHigh: number | null = null;
  let allTimeLow: number | null = null;
  if (daily && weekly) {
    allTimeHigh = max([...weeklyPrior.highs, ...dailyThisWeekPrior.highs]);
    allTimeLow = min([...weeklyPrior.lows, ...dailyThisWeekPrior.lows]);
  }

  return {
    week52High: max(dailyPrior.highs),
    week52Low: min(dailyPrior.lows),
    allTimeHigh,
    allTimeLow,
  };
}

async function fetchChartBars(ticker: string, params: string, timeoutMs: number): Promise<ChartBars | null> {
  try {
    const response = await yahooGet(`${YAHOO_CHART_URL}/${ticker}?${params}`, timeoutMs);
    const result = response.data?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    if (!result?.timestamp?.length || !quote?.high || !quote?.low) return null;
    return { timestamps: result.timestamp, highs: quote.high, lows: quote.low };
  } catch (err) {
    console.error(`[MilestoneRanges] Chart fetch failed for ${ticker} (${params}):`, err instanceof Error ? err.message : err);
    return null;
  }
}

// Keyed by ET day so thresholds roll over exactly at the market-calendar
// boundary instead of a floating 24h TTL; stale keys evict via TTL.
const thresholdCache = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 3600 });

/**
 * Yesterday-exclusive 52-week and all-time thresholds for a ticker.
 * Returns null when no chart data is available at all.
 */
export async function getPriorThresholds(ticker: string, now: Date = new Date()): Promise<PriorThresholds | null> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `prior:${upperTicker}:${etDate(now)}`;
  const cached = thresholdCache.get<PriorThresholds>(cacheKey);
  if (cached) return cached;

  const [daily, weekly] = await Promise.all([
    fetchChartBars(upperTicker, 'interval=1d&range=1y', 10000),
    fetchChartBars(upperTicker, 'interval=1wk&range=max', 15000),
  ]);
  if (!daily && !weekly) return null;

  const thresholds = computePriorThresholds(daily, weekly, now);
  // Only cache complete fetches — a transient failure of one chart call must
  // not lock this ticker out of ATH/ATL checks for the rest of the day.
  if (daily && weekly) thresholdCache.set(cacheKey, thresholds);
  return thresholds;
}

const closeCache = new NodeCache({ stdTTL: 15 * 60, checkperiod: 120 });

/**
 * Official regular-session close. `meta.regularMarketPrice` is the last
 * regular-session trade, so after 4 PM ET it is the closing print — never an
 * after-hours tick. Callers must verify `closedOnEtDate` matches today to
 * reject holiday/stale data.
 */
export async function getRegularMarketClose(ticker: string, now: Date = new Date()): Promise<RegularMarketClose | null> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `close:${upperTicker}:${etDate(now)}`;
  const cached = closeCache.get<RegularMarketClose>(cacheKey);
  if (cached) return cached;

  try {
    const response = await yahooGet(`${YAHOO_CHART_URL}/${upperTicker}?interval=1d&range=1d`, 8000);
    const meta = response.data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const time = meta?.regularMarketTime;
    if (typeof price !== 'number' || price <= 0 || typeof time !== 'number') return null;
    const close: RegularMarketClose = {
      close: price,
      closedOnEtDate: etDate(new Date(time * 1000)),
    };
    closeCache.set(cacheKey, close);
    return close;
  } catch (err) {
    console.error(`[MilestoneRanges] Close fetch failed for ${upperTicker}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
