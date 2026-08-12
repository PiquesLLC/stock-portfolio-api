import { getQuote, getQuotes, QuotesResult, searchSymbols, getStockProfile, getStockMetrics } from '../utils/finnhub';
import { getPolygonQuotes, getPolygonQuote } from '../utils/polygon';
import { Quote, SymbolSearchResponse, StockProfile, StockMetrics, StockDetailsResponse } from '../types';
import { getMarketSession, getMarketSessionForTicker, tradesOnWeekends, tradesWithinEtCalendarDay } from '../utils/market-hours';
import NodeCache from 'node-cache';
import { yahooGet, fetchPolygonAggs } from '../utils/yahoo-http';
import { etDate, etMinutesOfDay, isEtWeekend, previousEtDay } from '../utils/date';

const yahooCache = new NodeCache({ stdTTL: 86400 }); // 24h cache for daily candles
const yahooIntradayCache = new NodeCache({ stdTTL: 10 }); // 10s cache for intraday
export const STOCK_DETAILS_OPTIONAL_TIMEOUT_MS = 1200;

async function withSoftTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>(resolve => {
        timeout = setTimeout(() => {
          console.warn(`[Market] ${label} timed out after ${timeoutMs}ms`);
          resolve(fallback);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn(`[Market] ${label} failed:`, error instanceof Error ? error.message : String(error));
    return fallback;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchStockDetailCandles(ticker: string): Promise<StockDetailsResponse['candles']> {
  const cacheKey = `detail-daily:${ticker}`;
  const cached = yahooCache.get<StockDetailsResponse['candles']>(cacheKey);
  if (cached) return cached;

  // Polygon.io primary — 10 years of daily candles (paid plan)
  const today = etDate();
  const tenYearsAgo = etDate(new Date(Date.now() - 10 * 365.25 * 86400000));
  const pg = await fetchPolygonAggs(ticker, 1, 'day', tenYearsAgo, today);
  if (pg && pg.closes.length > 0) {
    const candles: StockDetailsResponse['candles'] = {
      closes: pg.closes,
      dates: pg.timestamps.map(t => new Date(t * 1000).toISOString().slice(0, 10)),
      highs: pg.highs,
      lows: pg.lows,
      opens: pg.opens,
      volumes: pg.volumes,
    };
    yahooCache.set(cacheKey, candles);
    return candles;
  }

  // Yahoo Finance fallback
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 10 * 365 * 24 * 60 * 60;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${from}&period2=${now}&interval=1d&includePrePost=true`;
    const resp = await yahooGet(url);

    const result = resp.data?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]) return null;

    const timestamps: number[] = result.timestamp;
    const q = result.indicators.quote[0];
    const closes: number[] = [];
    const dates: string[] = [];
    const highs: number[] = [];
    const lows: number[] = [];
    const opens: number[] = [];
    const volumes: number[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      if (q.close[i] != null) {
        closes.push(q.close[i]);
        dates.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
        highs.push(q.high?.[i] ?? 0);
        lows.push(q.low?.[i] ?? 0);
        opens.push(q.open?.[i] ?? 0);
        volumes.push(q.volume?.[i] ?? 0);
      }
    }

    if (closes.length === 0) return null;
    const candles: StockDetailsResponse['candles'] = { closes, dates, highs, lows, opens, volumes };
    yahooCache.set(cacheKey, candles);
    return candles;
  } catch {
    return null;
  }
}

export interface IntradayCandle {
  time: string; // ISO timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const candleCache = new NodeCache();

type CandlePeriod = '1D' | '1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y' | 'MAX';
type CandleInterval = '1m' | '5m' | '15m' | '1h' | '1D' | '1W' | '1M';

function isRegularHours(isoTime: string): boolean {
  const d = new Date(isoTime);
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960;
}

function mapBarsToCandles(
  timestamps: number[],
  q: {
    open?: Array<number | null>;
    high?: Array<number | null>;
    low?: Array<number | null>;
    close?: Array<number | null>;
    volume?: Array<number | null>;
  },
): IntradayCandle[] {
  const candles: IntradayCandle[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const close = q.close?.[i];
    if (!Number.isFinite(close)) continue;

    candles.push({
      time: new Date(timestamps[i] * 1000).toISOString(),
      open: q.open?.[i] ?? close!,
      high: q.high?.[i] ?? close!,
      low: q.low?.[i] ?? close!,
      close: close!,
      volume: q.volume?.[i] ?? 0,
    });
  }

  return candles;
}

function filterRegularHoursIfNeeded(candles: IntradayCandle[], interval: CandleInterval, period?: CandlePeriod): IntradayCandle[] {
  // Daily/weekly/monthly intervals never need filtering
  if (interval === '1D' || interval === '1W' || interval === '1M') return candles;
  // 1D period: show all candles including pre/post market (matches line chart 4AM-8PM behavior)
  if (period === '1D') return candles;
  // Multi-day periods: filter to regular hours only to avoid overnight gaps
  return candles.filter((candle) => isRegularHours(candle.time));
}

/** Newest bar time in a series (0 when empty). Scans instead of trusting the
 *  last element — provider ordering is not ours to assume. */
function newestCandleMs(candles: IntradayCandle[]): number {
  let newest = 0;
  for (const candle of candles) {
    const ms = Date.parse(candle.time);
    if (ms > newest) newest = ms;
  }
  return newest;
}

/** ET calendar day of the newest bar in a series ('' when empty). */
function latestCandleDay(candles: IntradayCandle[]): string {
  const newest = newestCandleMs(candles);
  return newest === 0 ? '' : etDate(new Date(newest));
}

// Polygon's plan is 15-min delayed and providers publish a session's opening
// bars late, so "nothing for today yet" stays normal past the 9:30 open. Only
// after this point can today be the yardstick a provider is measured against.
// Calibrated for US equities; a market trading earlier in ET terms just goes
// unmonitored until then, which costs detections, never correctness.
const FIRST_BARS_EXPECTED_ET = 9 * 60 + 50; // 9:50 AM ET

/**
 * The most recent ET day that should already have bars for `ticker`. Today
 * counts once the session has run long enough to print; otherwise the yardstick
 * is the previous day the market was open.
 *
 * Market holidays aren't modelled anywhere in this codebase, so a holiday reads
 * as a session day. The chart stays correct (every source agrees on the prior
 * session) at the cost of one redundant fallback fetch per cache miss.
 */
function lastExpectedSessionDay(ticker: string, now: Date): string {
  const today = etDate(now);

  // Markets that run through the weekend print around the clock, so today is
  // always the yardstick. (Futures are shut Saturday, which this over-counts by
  // one wasted fallback fetch — the same price a holiday costs.)
  if (tradesOnWeekends(ticker)) return today;

  let day = etMinutesOfDay(now) < FIRST_BARS_EXPECTED_ET ? previousEtDay(today) : today;
  for (let guard = 0; guard < 3 && isEtWeekend(day); guard++) day = previousEtDay(day);
  return day;
}

/** `lastExpectedSessionDay` without the ability to fail a request: the ET clock
 *  helpers throw on unparseable output, and a chart must not 500 over that. */
function lastExpectedSessionDayOrNull(ticker: string, now: Date): string | null {
  try {
    return lastExpectedSessionDay(ticker, now);
  } catch (error) {
    // Deduped: this failure mode would be persistent, not transient, so an
    // undeduped warn would print on every candle request for the rest of the day.
    if (firstTimeToday(`clock-failure:${ticker}`, new Date().toISOString().slice(0, 10))) {
      console.warn(`[Market] session-day check failed for ${ticker}:`, error instanceof Error ? error.message : String(error));
    }
    return null;
  }
}

/**
 * True when a series stops short of the last session that should have produced
 * bars. Providers occasionally lag a single ticker by an entire session
 * (Polygon had no DE bars at all on 2026-08-12), and a stale series is
 * indistinguishable from a fresh one by bar count alone.
 */
function isStaleForSession(ticker: string, latestDay: string, now: Date = new Date()): boolean {
  if (!latestDay) return true;
  const expected = lastExpectedSessionDayOrNull(ticker, now);
  return expected !== null && latestDay < expected;
}

/**
 * Narrow a series to the single ET day its newest bar falls on — but only where
 * a session actually fits inside one: for crypto, futures and Asia-Pacific
 * listings the straddle IS the session, and trimming would lop off its open.
 */
function singleSessionOnly(ticker: string, candles: IntradayCandle[], day: string): IntradayCandle[] {
  if (candles.length === 0 || !day || !tradesWithinEtCalendarDay(ticker)) return candles;
  return candles.filter(candle => etDate(new Date(candle.time)) === day);
}

/**
 * Keep the primary series' history and graft on only the bars a fallback source
 * reaches beyond it. A fresher fallback must never truncate the primary: a short
 * Yahoo 6M response would otherwise replace a full Polygon one just to gain the
 * current session.
 */
function appendFresherTail(primary: IntradayCandle[], fallback: IntradayCandle[]): IntradayCandle[] {
  if (primary.length === 0) return fallback;
  if (fallback.length === 0) return primary;
  const newestPrimary = newestCandleMs(primary);
  // Nothing parseable in the primary: it can't anchor a graft, so let the
  // fallback stand alone rather than concatenating two unordered series.
  if (newestPrimary === 0) return fallback;
  const tail = fallback.filter(candle => Date.parse(candle.time) > newestPrimary);
  return tail.length > 0 ? [...primary, ...tail] : primary;
}

const candleLogSeen = new Map<string, string>();

/** True the first time `key` comes up on an ET day. Bounded by evicting from the
 *  front of the Map's insertion order; above the cap the once-a-day guarantee
 *  degrades to "occasionally repeats", which is the right way to fail. */
function firstTimeToday(key: string, today: string): boolean {
  if (candleLogSeen.get(key) === today) return false;
  while (candleLogSeen.size >= 500) {
    const oldest = candleLogSeen.keys().next().value;
    if (oldest === undefined) break;
    candleLogSeen.delete(oldest);
  }
  candleLogSeen.set(key, today);
  return true;
}

// One stale ticker is noise — a delisted holding, or a foreign listing on its
// own market's holiday. Several tickers stuck on the same expected session is a
// stall worth waking up to. Track distinct tickers per expected day and log once
// the count clears this bar; a single lagging symbol can then neither raise a
// false alarm nor claim the day's one log line and mask a real one.
const STALE_ALERT_MIN_TICKERS = 3;
const staleTickersByDay = new Map<string, Set<string>>();

/** One line per ET day, once enough distinct tickers are behind to mean it. */
function warnIfStaleCandles(ticker: string, range: string, latestDay: string, now: Date = new Date()): void {
  if (!latestDay) return;
  // Weekend-trading markets are excluded: futures are shut on Saturdays, so
  // "today should have bars" over-counts them, and three futures contracts would
  // otherwise raise a guaranteed false alarm every weekend — and consume the
  // day's single alert. Their per-ticker lag logging still applies.
  if (tradesOnWeekends(ticker)) return;
  const expected = lastExpectedSessionDayOrNull(ticker, now);
  if (expected === null || latestDay >= expected) return;

  let tickers = staleTickersByDay.get(expected);
  if (!tickers) {
    // Expected day varies per ticker (a weekday boundary, a weekend walk-back),
    // so several can be live at once; clearing on every new key let two classes
    // of ticker wipe each other's counts and never reach the threshold.
    while (staleTickersByDay.size >= 4) {
      const oldest = staleTickersByDay.keys().next().value;
      if (oldest === undefined) break;
      staleTickersByDay.delete(oldest);
    }
    tickers = new Set<string>();
    staleTickersByDay.set(expected, tickers);
  }
  if (tickers.size >= STALE_ALERT_MIN_TICKERS) return; // already logged for this day
  tickers.add(ticker);
  if (tickers.size < STALE_ALERT_MIN_TICKERS) return;

  console.warn(
    `[Market] candles are stale for ${tickers.size}+ tickers (${[...tickers].join(', ')}) — ` +
    `${ticker} ${range} newest bar is ${latestDay}, expected ${expected}`,
  );
}

/**
 * One line per ticker+range per ET day when one source fell a whole session
 * behind a session it should have printed. This is the DE-on-2026-08-12
 * signature: the chart is now correct, but a provider silently missing a single
 * ticker is worth seeing.
 */
function logLaggingSource(ticker: string, range: string, source: string, laggedTo: string, servedTo: string): void {
  // Not merely a day apart — Polygon's 15-min delay makes that routine right
  // after the 4 AM ET pre-market open. Only a genuinely missed session counts.
  if (!isStaleForSession(ticker, laggedTo)) return;
  if (!firstTimeToday(`lag:${ticker}:${range}`, etDate())) return;
  console.warn(`[Market] ${ticker} ${range}: ${source} lagged to ${laggedTo}, serving through ${servedTo}`);
}

function getPeriodDays(period: CandlePeriod): number {
  switch (period) {
    case '1D':
      return 5;
    case '1W':
      return 9;
    case '1M':
      return 35;
    case '3M':
      return 95;
    case '6M':
      return 185;
    case '1Y':
      return 370;
    case 'MAX':
      return 3650;
    case 'YTD':
      return Math.ceil((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000) + 5;
  }
}

function getDateRange(period: CandlePeriod): { from: string; to: string } {
  const to = etDate();
  if (period === 'YTD') {
    return { from: `${new Date().getFullYear()}-01-01`, to };
  }

  const from = etDate(new Date(Date.now() - getPeriodDays(period) * 86400000));
  return { from, to };
}

function getYahooRange(period: CandlePeriod, interval: CandleInterval): string | null {
  switch (interval) {
    case '1m':
      return period === '1D' ? '1d' : null;
    case '5m':
      if (period === '1D') return '1d';
      if (period === '1W') return '5d';
      return null;
    case '15m':
      if (period === '1W') return '5d';
      if (period === '1M') return '1mo';
      return null;
    case '1h':
      if (period === '1M') return '1mo';
      if (period === '3M') return '3mo';
      return null;
    case '1D':
      if (period === '1D') return '5d';
      if (period === '1W') return '5d';
      if (period === '1M') return '1mo';
      if (period === '3M') return '3mo';
      if (period === '6M') return '6mo';
      if (period === 'YTD') return 'ytd';
      if (period === '1Y') return '1y';
      if (period === 'MAX') return '10y';
      return null;
    default:
      return null;
  }
}

async function fetchYahooCandles(ticker: string, period: CandlePeriod, interval: CandleInterval): Promise<IntradayCandle[]> {
  const range = getYahooRange(period, interval);
  if (!range) return [];

  const yahooInterval = interval === '1h' ? '60m' : interval === '1D' ? '1d' : interval;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${yahooInterval}&range=${range}&includePrePost=true`;

  try {
    const resp = await yahooGet(url);
    const result = resp.data?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]) return [];

    const candles = mapBarsToCandles(result.timestamp, result.indicators.quote[0]);
    return filterRegularHoursIfNeeded(candles, interval, period);
  } catch {
    return [];
  }
}

async function fetchPolygonCandles(ticker: string, period: CandlePeriod, interval: CandleInterval, cacheTTL: number): Promise<IntradayCandle[]> {
  const mapping: Record<CandleInterval, { multiplier: number; timespan: string }> = {
    '1m': { multiplier: 1, timespan: 'minute' },
    '5m': { multiplier: 5, timespan: 'minute' },
    '15m': { multiplier: 15, timespan: 'minute' },
    '1h': { multiplier: 1, timespan: 'hour' },
    '1D': { multiplier: 1, timespan: 'day' },
    '1W': { multiplier: 1, timespan: 'week' },
    '1M': { multiplier: 1, timespan: 'month' },
  };
  const { from, to } = getDateRange(period);
  const { multiplier, timespan } = mapping[interval];
  const pg = await fetchPolygonAggs(ticker, multiplier, timespan, from, to, cacheTTL);
  if (!pg?.closes.length) return [];

  const candles = pg.timestamps.map((t, i) => ({
    time: new Date(t * 1000).toISOString(),
    open: pg.opens[i],
    high: pg.highs[i],
    low: pg.lows[i],
    close: pg.closes[i],
    volume: pg.volumes[i],
  }));

  return filterRegularHoursIfNeeded(candles, interval, period);
}

export async function fetchCandles(ticker: string, period: string, interval: string): Promise<IntradayCandle[]> {
  const upperTicker = ticker.toUpperCase();
  const normalizedPeriod = period.toUpperCase() as CandlePeriod;
  const normalizedInterval = interval as CandleInterval;
  const cacheKey = `candle:${upperTicker}:${normalizedPeriod}:${normalizedInterval}`;
  const cacheTTL = normalizedInterval === '1D' || normalizedInterval === '1W' || normalizedInterval === '1M' ? 3600 : 15;
  const cached = candleCache.get<IntradayCandle[]>(cacheKey);
  if (cached) return cached;

  const yahooSupported = normalizedInterval === '1m' || normalizedInterval === '5m' || normalizedInterval === '15m' || normalizedInterval === '1h' || normalizedInterval === '1D';
  let candles: IntradayCandle[] = [];
  if (yahooSupported) {
    candles = await fetchYahooCandles(upperTicker, normalizedPeriod, normalizedInterval);
  }
  if (candles.length === 0) {
    candles = await fetchPolygonCandles(upperTicker, normalizedPeriod, normalizedInterval, cacheTTL);
  }

  // For 1D period with intraday intervals, keep only the last trading day
  if (normalizedPeriod === '1D' && candles.length > 0 && normalizedInterval !== '1D' && normalizedInterval !== '1W' && normalizedInterval !== '1M') {
    const lastDate = etDate(new Date(candles[candles.length - 1].time));
    candles = candles.filter(c => etDate(new Date(c.time)) === lastDate);
  }

  if (candles.length > 0) {
    candleCache.set(cacheKey, candles, cacheTTL);
  }

  return candles;
}

export async function fetchIntradayCandles(ticker: string): Promise<IntradayCandle[]> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `intra:${upperTicker}`;
  const cached = yahooIntradayCache.get<IntradayCandle[]>(cacheKey);
  if (cached) return cached;

  // Fetch BOTH sources in parallel — pick whichever has better coverage
  const today = etDate();
  const daysAgo = etDate(new Date(Date.now() - 5 * 86400000));

  const [pg, yahooCandles] = await Promise.all([
    fetchPolygonAggs(upperTicker, 5, 'minute', daysAgo, today, 60),
    (async (): Promise<IntradayCandle[]> => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(upperTicker)}?interval=5m&range=1d&includePrePost=true`;
        const resp = await yahooGet(url);
        const result = resp.data?.chart?.result?.[0];
        if (result?.timestamp && result?.indicators?.quote?.[0]) {
          const timestamps: number[] = result.timestamp;
          const q = result.indicators.quote[0];
          const candles: IntradayCandle[] = [];
          for (let i = 0; i < timestamps.length; i++) {
            if (q.close[i] != null) {
              candles.push({
                time: new Date(timestamps[i] * 1000).toISOString(),
                open: q.open?.[i] ?? q.close[i],
                high: q.high?.[i] ?? q.close[i],
                low: q.low?.[i] ?? q.close[i],
                close: q.close[i],
                volume: q.volume?.[i] ?? 0,
              });
            }
          }
          return candles;
        }
      } catch { /* Yahoo failed */ }
      return [];
    })(),
  ]);

  // Build Polygon candles filtered to latest trading day
  let polygonCandles: IntradayCandle[] = [];
  if (pg && pg.closes.length > 0) {
    const raw: IntradayCandle[] = pg.timestamps.map((t, i) => ({
      time: new Date(t * 1000).toISOString(),
      open: pg.opens[i],
      high: pg.highs[i],
      low: pg.lows[i],
      close: pg.closes[i],
      volume: pg.volumes[i],
    }));
    if (raw.length > 0) {
      const lastDateET = etDate(new Date(raw[raw.length - 1].time));
      const todayOnly = raw.filter(c => etDate(new Date(c.time)) === lastDateET);
      polygonCandles = todayOnly.length > 0 ? todayOnly : raw;
    }
  }

  // Prefer whichever source reaches the LATEST trading day; only when both sit on
  // the same day does bar count decide (better pre-market coverage). Picking by
  // count alone silently served a stale session: on 2026-08-12 Polygon carried no
  // DE bars at all, so its complete Aug-11 session (86 bars) outvoted Yahoo's live
  // 39-bar Aug-12 session and the 1D chart rendered yesterday under today's quote.
  const polygonDay = latestCandleDay(polygonCandles);
  const yahooDay = latestCandleDay(yahooCandles);
  // Trim Yahoo to one session BEFORE comparing: Polygon is already filtered to
  // its own last ET day above, and getIntraday anchors this chart on yesterday's
  // close, so Yahoo's `range=1d` straddling two days would both win the count on
  // bars it shouldn't be showing and then draw them against the wrong baseline.
  const yahooSession = singleSessionOnly(upperTicker, yahooCandles, yahooDay);
  const best = polygonDay && yahooDay && polygonDay !== yahooDay
    ? (polygonDay > yahooDay ? polygonCandles : yahooSession) // ISO days sort lexicographically
    : (polygonCandles.length >= yahooSession.length ? polygonCandles : yahooSession);

  if (best.length > 0) {
    const bestDay = latestCandleDay(best);
    if (polygonDay && yahooDay && polygonDay !== yahooDay) {
      const laggingSource = polygonDay > yahooDay ? 'Yahoo' : 'Polygon';
      logLaggingSource(upperTicker, '1D', laggingSource, polygonDay > yahooDay ? yahooDay : polygonDay, bestDay);
    }
    warnIfStaleCandles(upperTicker, '1D', bestDay);
    yahooIntradayCache.set(cacheKey, best);
    return best;
  }

  return [];
}

const HOURLY_TTL_SECONDS = 300;
// A series we know is a session behind gets a short lease, so the next request
// retries the fallback instead of pinning the chart on it for five minutes.
const HOURLY_STALE_TTL_SECONDS = 20;
// Both sources came back empty: brief negative caching keeps a hard outage from
// re-running the whole two-provider path on every single request.
const HOURLY_EMPTY_TTL_SECONDS = 30;

const yahooHourlyCache = new NodeCache({ stdTTL: HOURLY_TTL_SECONDS }); // 5min cache for hourly candles

/**
 * Fetch hourly candles for 1W (15m bars, 5 days), 1M/6M/YTD (60m bars).
 * Polygon.io primary, Yahoo Finance fallback.
 */
export async function fetchHourlyCandles(ticker: string, period: '1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y'): Promise<IntradayCandle[]> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `hourly:${upperTicker}:${period}`;
  const cached = yahooHourlyCache.get<IntradayCandle[]>(cacheKey);
  if (cached) return cached;

  // Polygon.io primary — proper resolution per period
  const today = etDate();
  const rangeDays = period === '1W' ? 7 : period === '1M' ? 30 : period === '3M' ? 90 : period === '6M' ? 180 : period === '1Y' ? 365 : Math.ceil((Date.now() - new Date(`${new Date().getFullYear()}-01-01`).getTime()) / 86400000) + 5;
  const fromDate = period === 'YTD' ? `${new Date().getFullYear()}-01-01` : etDate(new Date(Date.now() - rangeDays * 86400000));
  const [multiplier, timespan] = period === '1W' ? [15, 'minute'] : [1, 'hour'];

  const pg = await fetchPolygonAggs(upperTicker, multiplier, timespan, fromDate, today, 300);
  const polygonCandles: IntradayCandle[] = pg && pg.closes.length > 0
    ? pg.timestamps.map((t, i) => ({
      time: new Date(t * 1000).toISOString(),
      open: pg.opens[i],
      high: pg.highs[i],
      low: pg.lows[i],
      close: pg.closes[i],
      volume: pg.volumes[i],
    }))
    : [];

  // Polygon stays primary, but it can lag a single ticker by an entire session
  // (DE on 2026-08-12). A stale-but-non-empty response used to short-circuit the
  // Yahoo fallback, leaving every multi-day chart missing the current session —
  // so when Polygon's newest bar predates a session that should have printed,
  // fall through and graft whatever the fallback reaches beyond it.
  if (polygonCandles.length > 0 && !isStaleForSession(upperTicker, latestCandleDay(polygonCandles))) {
    yahooHourlyCache.set(cacheKey, polygonCandles);
    return polygonCandles;
  }

  // Yahoo Finance fallback
  try {
    const params = period === '1W'
      ? 'interval=15m&range=5d&includePrePost=true'
      : period === '3M'
      ? 'interval=60m&range=3mo&includePrePost=true'
      : period === '6M'
      ? 'interval=60m&range=6mo&includePrePost=true'
      : period === 'YTD'
      ? 'interval=60m&range=ytd&includePrePost=true'
      : period === '1Y'
      ? 'interval=60m&range=1y&includePrePost=true'
      : 'interval=60m&range=1mo&includePrePost=true';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(upperTicker)}?${params}`;
    // When Polygon is merely stale we already have a chart to serve, so a slow
    // fallback must not stall the request — one request can fan out over a dozen
    // tickers. When Polygon gave us nothing (its permanent state for crypto,
    // futures and most foreign listings) Yahoo is the only source there is, so
    // it gets the generous cap: yahooGet's own worst case runs to ~33s once a
    // cold cookie handshake is included, which is too long to hold a request but
    // too close to call at 2.5s.
    const timeoutMs = polygonCandles.length === 0 ? 15_000 : 2_500;
    const resp = await withSoftTimeout(
      yahooGet(url).catch(() => null),
      timeoutMs,
      null,
      `hourly Yahoo fallback for ${upperTicker}`,
    );
    const result = resp?.data?.chart?.result?.[0];
    if (result?.timestamp && result?.indicators?.quote?.[0]) {
      const timestamps: number[] = result.timestamp;
      const q = result.indicators.quote[0];
      const candles: IntradayCandle[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (q.close[i] != null) {
          candles.push({
            time: new Date(timestamps[i] * 1000).toISOString(),
            open: q.open?.[i] ?? q.close[i],
            high: q.high?.[i] ?? q.close[i],
            low: q.low?.[i] ?? q.close[i],
            close: q.close[i],
            volume: q.volume?.[i] ?? 0,
          });
        }
      }
      if (candles.length > 0) {
        const best = appendFresherTail(polygonCandles, candles);
        const bestDay = latestCandleDay(best);
        const polygonDay = latestCandleDay(polygonCandles);
        if (polygonDay && bestDay > polygonDay) {
          logLaggingSource(upperTicker, period, 'Polygon', polygonDay, bestDay);
        }
        warnIfStaleCandles(upperTicker, period, bestDay);
        // Even after the graft the series can still be a session behind; cache
        // by how current it actually is, not by which branch produced it.
        const ttl = isStaleForSession(upperTicker, bestDay) ? HOURLY_STALE_TTL_SECONDS : HOURLY_TTL_SECONDS;
        yahooHourlyCache.set(cacheKey, best, ttl);
        return best;
      }
    }
  } catch { /* Yahoo also failed */ }

  if (polygonCandles.length > 0) {
    // Reached only when Polygon was judged stale and the fallback couldn't cover
    // for it. Serving that series is the least-bad option, on a short lease.
    warnIfStaleCandles(upperTicker, period, latestCandleDay(polygonCandles));
    yahooHourlyCache.set(cacheKey, polygonCandles, HOURLY_STALE_TTL_SECONDS);
    return polygonCandles;
  }

  yahooHourlyCache.set(cacheKey, [] as IntradayCandle[], HOURLY_EMPTY_TTL_SECONDS);
  return [];
}

const dailyCandleCache = new NodeCache({ stdTTL: 3600 }); // 1hr cache for daily candles

export async function fetchDailyCandles(ticker: string, days: number): Promise<IntradayCandle[]> {
  const upperTicker = ticker.toUpperCase();
  const cacheKey = `daily:${upperTicker}:${days}`;
  const cached = dailyCandleCache.get<IntradayCandle[]>(cacheKey);
  if (cached) return cached;

  const today = etDate();
  const fromDate = etDate(new Date(Date.now() - (days + 10) * 86400000));

  const pg = await fetchPolygonAggs(upperTicker, 1, 'day', fromDate, today);
  if (pg && pg.closes.length > 0) {
    const candles: IntradayCandle[] = pg.timestamps.map((t, i) => ({
      time: new Date(t * 1000).toISOString(),
      open: pg.opens[i],
      high: pg.highs[i],
      low: pg.lows[i],
      close: pg.closes[i],
      volume: pg.volumes[i],
    }));
    dailyCandleCache.set(cacheKey, candles);
    return candles;
  }

  return [];
}

/**
 * Build Quote objects from daily candles for tickers that failed live-quote fetch.
 * Used as a fallback when Polygon's snapshot endpoint drops tickers on weekends.
 * Historical daily candles are stable archived data (via Polygon Aggregates endpoint,
 * unrelated to the flaky snapshot endpoint).
 *
 * "Change" is computed as (last close - prior close) / prior close — i.e., the
 * last trading day's move. On Saturday, this is Thursday vs Wednesday.
 */
export async function fetchQuotesFromCandles(tickers: string[]): Promise<Map<string, Quote>> {
  const quotes = new Map<string, Quote>();
  if (tickers.length === 0) return quotes;

  const session = getMarketSession();
  const BATCH_SIZE = 50;

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        const candles = await fetchDailyCandles(ticker, 5);
        if (candles.length < 2) return null;
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        if (last.close <= 0 || prev.close <= 0) return null;
        const change = last.close - prev.close;
        const changePercent = (change / prev.close) * 100;
        const upper = ticker.toUpperCase();
        const quote: Quote = {
          ticker: upper,
          currentPrice: last.close,
          change,
          changePercent,
          high: last.high,
          low: last.low,
          open: last.open,
          previousClose: prev.close,
          timestamp: Math.floor(new Date(last.time).getTime() / 1000),
          updatedAt: new Date(last.time).getTime(),
          isStale: true,
          isRepricing: false,
          quoteAgeSeconds: Math.floor((Date.now() - new Date(last.time).getTime()) / 1000),
          session,
        };
        return { upper, quote };
      }),
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        quotes.set(result.value.upper, result.value.quote);
      }
    }
  }

  return quotes;
}

// Dynamic TTL: 15s during market hours, 15min when closed (prices don't change on weekends/overnight)
function getQuoteCacheTTL(): number {
  const session = getMarketSession();
  return session === 'REG' || session === 'PRE' || session === 'POST' ? 15 : 900;
}
const yahooQuoteCache = new NodeCache({ stdTTL: 15 }); // default 15s, overridden per-set when markets closed
const YAHOO_BATCH_SIZE = 200;

// Hardcoded ETF reference data for common ETFs where Finnhub free tier returns nulls.
// Values are approximate as of early 2026 — better than showing nothing.
// TODO: Replace with paid API data before public release.
interface ETFRefData {
  aumB?: number;       // Assets under management in billions
  expenseRatio?: number; // Annual expense ratio as percentage (e.g. 0.09 = 0.09%)
  peRatio?: number;
  dividendYield?: number;
  beta?: number;
}

export const ETF_REFERENCE_DATA: Record<string, ETFRefData> = {
  // S&P 500 trackers
  SPY:  { aumB: 550, expenseRatio: 0.0945, peRatio: 23.5, dividendYield: 1.2, beta: 1.0 },
  VOO:  { aumB: 430, expenseRatio: 0.03,   peRatio: 23.5, dividendYield: 1.2, beta: 1.0 },
  IVV:  { aumB: 500, expenseRatio: 0.03,   peRatio: 23.5, dividendYield: 1.2, beta: 1.0 },
  // Total market
  VTI:  { aumB: 420, expenseRatio: 0.03,   peRatio: 22.0, dividendYield: 1.2, beta: 1.0 },
  ITOT: { aumB: 55,  expenseRatio: 0.03,   peRatio: 22.0, dividendYield: 1.2, beta: 1.0 },
  // Nasdaq 100
  QQQ:  { aumB: 300, expenseRatio: 0.20,   peRatio: 32.0, dividendYield: 0.5, beta: 1.15 },
  QQQM: { aumB: 30,  expenseRatio: 0.15,   peRatio: 32.0, dividendYield: 0.5, beta: 1.15 },
  // Dow Jones
  DIA:  { aumB: 35,  expenseRatio: 0.16,   peRatio: 19.0, dividendYield: 1.6, beta: 0.95 },
  // Dividend-focused
  SCHD: { aumB: 60,  expenseRatio: 0.06,   dividendYield: 3.3, beta: 0.85 },
  VYM:  { aumB: 55,  expenseRatio: 0.06,   dividendYield: 2.7, beta: 0.85 },
  DVY:  { aumB: 20,  expenseRatio: 0.38,   dividendYield: 3.5, beta: 0.80 },
  HDV:  { aumB: 10,  expenseRatio: 0.08,   dividendYield: 3.2, beta: 0.80 },
  // Sector ETFs
  XLK:  { aumB: 65,  expenseRatio: 0.09,   peRatio: 30.0, beta: 1.15 },
  XLF:  { aumB: 45,  expenseRatio: 0.09,   peRatio: 15.0, beta: 1.10 },
  XLE:  { aumB: 35,  expenseRatio: 0.09,   peRatio: 12.0, dividendYield: 3.0, beta: 1.20 },
  XLV:  { aumB: 40,  expenseRatio: 0.09,   peRatio: 18.0, dividendYield: 1.5, beta: 0.75 },
  XLI:  { aumB: 18,  expenseRatio: 0.09,   peRatio: 20.0, beta: 1.05 },
  XLC:  { aumB: 18,  expenseRatio: 0.09,   peRatio: 20.0, beta: 1.10 },
  VGT:  { aumB: 70,  expenseRatio: 0.10,   peRatio: 30.0, beta: 1.15 },
  // Growth / Innovation
  ARKK: { aumB: 6,   expenseRatio: 0.75,   beta: 1.80 },
  VUG:  { aumB: 120, expenseRatio: 0.04,   peRatio: 32.0, beta: 1.15 },
  IWF:  { aumB: 90,  expenseRatio: 0.19,   peRatio: 30.0, beta: 1.10 },
  // Value
  VTV:  { aumB: 120, expenseRatio: 0.04,   peRatio: 16.0, dividendYield: 2.2, beta: 0.90 },
  IWD:  { aumB: 55,  expenseRatio: 0.19,   peRatio: 16.0, dividendYield: 1.8, beta: 0.90 },
  // Small Cap
  IWM:  { aumB: 60,  expenseRatio: 0.19,   peRatio: 15.0, beta: 1.20 },
  VB:   { aumB: 50,  expenseRatio: 0.05,   peRatio: 16.0, beta: 1.15 },
  // International
  VXUS: { aumB: 65,  expenseRatio: 0.07,   peRatio: 14.0, dividendYield: 3.0, beta: 0.85 },
  EFA:  { aumB: 55,  expenseRatio: 0.32,   peRatio: 14.0, dividendYield: 2.8, beta: 0.85 },
  EEM:  { aumB: 18,  expenseRatio: 0.68,   peRatio: 12.0, dividendYield: 2.5, beta: 0.95 },
  VWO:  { aumB: 75,  expenseRatio: 0.08,   peRatio: 12.0, dividendYield: 2.8, beta: 0.90 },
  // Bonds
  AGG:  { aumB: 100, expenseRatio: 0.03,   dividendYield: 4.2, beta: 0.05 },
  BND:  { aumB: 105, expenseRatio: 0.03,   dividendYield: 4.2, beta: 0.05 },
  TLT:  { aumB: 55,  expenseRatio: 0.15,   dividendYield: 4.0, beta: 0.10 },
  SHY:  { aumB: 25,  expenseRatio: 0.15,   dividendYield: 4.5, beta: 0.02 },
  // Commodities
  GLD:  { aumB: 65,  expenseRatio: 0.40 },
  SLV:  { aumB: 12,  expenseRatio: 0.50 },
  IAU:  { aumB: 30,  expenseRatio: 0.25 },
  // Real Estate
  VNQ:  { aumB: 35,  expenseRatio: 0.12,   peRatio: 35.0, dividendYield: 3.5, beta: 0.90 },
  XLRE: { aumB: 6,   expenseRatio: 0.09,   dividendYield: 3.2, beta: 0.85 },
  // Leveraged (no PE/yield — too volatile)
  TQQQ: { aumB: 25,  expenseRatio: 0.86,   beta: 3.0 },
  SQQQ: { aumB: 5,   expenseRatio: 0.95,   beta: -3.0 },
  SPXL: { aumB: 4,   expenseRatio: 0.91,   beta: 3.0 },
};

export interface YahooBatchQuote {
  price: number;
  previousClose: number;
  regularMarketPrice: number;
  marketState: string;
  // Last after-hours trade. Unlike `price` (which reverts to the regular
  // close once marketState is CLOSED), this stays the frozen 8PM ET price —
  // the stock header's at-close/after-hours split reads it evenings/weekends.
  postMarketPrice?: number;
  dayHigh?: number;
  dayLow?: number;
  volume?: number;
  regularMarketTime?: number;
}

function getYahooV8MarketState(meta: any): string {
  const marketTime = Number(meta?.regularMarketTime);
  const periods = meta?.currentTradingPeriod;

  if (!Number.isFinite(marketTime) || !periods) {
    return 'REGULAR';
  }

  const preStart = Number(periods?.pre?.start);
  const preEnd = Number(periods?.pre?.end);
  if (Number.isFinite(preStart) && Number.isFinite(preEnd) && marketTime >= preStart && marketTime < preEnd) {
    return 'PRE';
  }

  const regularStart = Number(periods?.regular?.start);
  const regularEnd = Number(periods?.regular?.end);
  if (Number.isFinite(regularStart) && Number.isFinite(regularEnd) && marketTime >= regularStart && marketTime < regularEnd) {
    return 'REGULAR';
  }

  const postStart = Number(periods?.post?.start);
  const postEnd = Number(periods?.post?.end);
  if (Number.isFinite(postStart) && Number.isFinite(postEnd) && marketTime >= postStart && marketTime < postEnd) {
    return 'POST';
  }

  return 'REGULAR';
}

/**
 * Fetch extended-hours capable batch quotes from Yahoo Finance quote endpoint.
 * Returns price + previousClose + regularMarketPrice + marketState for each resolved ticker.
 */
export async function fetchYahooBatchQuotes(
  tickers: string[],
  options?: { skipCache?: boolean },
): Promise<Map<string, YahooBatchQuote>> {
  const results = new Map<string, YahooBatchQuote>();
  if (tickers.length === 0) return results;

  const uniqueTickers = Array.from(new Set(tickers.map(t => t.toUpperCase())));
  const uncached: string[] = [];

  if (!options?.skipCache) {
    for (const ticker of uniqueTickers) {
      const cached = yahooQuoteCache.get<YahooBatchQuote>(`yahoo-quote:${ticker}`);
      if (cached) {
        results.set(ticker, cached);
      } else {
        uncached.push(ticker);
      }
    }
  } else {
    uncached.push(...uniqueTickers);
  }

  for (let i = 0; i < uncached.length; i += YAHOO_BATCH_SIZE) {
    const batch = uncached.slice(i, i + YAHOO_BATCH_SIZE);
    const symbols = batch.join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;

    try {
      const resp = await yahooGet(url, 8000);
      const quoteResults = resp.data?.quoteResponse?.result;
      if (!Array.isArray(quoteResults)) continue;

      for (const item of quoteResults) {
        const symbol = String(item?.symbol || '').toUpperCase();
        if (!symbol) continue;

        const previousCloseRaw =
          item?.regularMarketPreviousClose ??
          item?.previousClose ??
          item?.chartPreviousClose ??
          item?.regularMarketPrice;
        const previousClose = Number(previousCloseRaw);
        if (!Number.isFinite(previousClose) || previousClose <= 0) continue;

        const marketState = String(item?.marketState || 'REGULAR');

        // Pick price based on market state to avoid stale cross-session data
        let candidates: unknown[];
        if (marketState === 'PRE') {
          candidates = [item?.preMarketPrice, item?.regularMarketPrice, item?.bid, item?.ask];
        } else if (marketState === 'POST' || marketState === 'POSTPOST') {
          candidates = [item?.postMarketPrice, item?.regularMarketPrice, item?.bid, item?.ask];
        } else {
          candidates = [item?.regularMarketPrice, item?.postMarketPrice, item?.preMarketPrice, item?.bid, item?.ask];
        }
        const numericPrice = candidates
          .map((value: unknown) => Number(value))
          .find((value: number) => Number.isFinite(value) && value > 0);
        if (!numericPrice) continue;

        // regularMarketPrice = today's 4 PM close (during POST) or yesterday's close (during PRE)
        const rawRegularPrice = Number(item?.regularMarketPrice);
        const regularMarketPrice = Number.isFinite(rawRegularPrice) && rawRegularPrice > 0
          ? rawRegularPrice
          : previousClose;

        const rawPostMarket = Number(item?.postMarketPrice);
        const parsed: YahooBatchQuote = {
          price: numericPrice,
          previousClose,
          regularMarketPrice,
          marketState,
          postMarketPrice: Number.isFinite(rawPostMarket) && rawPostMarket > 0 ? rawPostMarket : undefined,
        };
        results.set(symbol, parsed);
        yahooQuoteCache.set(`yahoo-quote:${symbol}`, parsed, getQuoteCacheTTL());
      }
    } catch {
      // Best-effort by batch. Caller handles partial misses.
      continue;
    }
  }

  return results;
}

export async function fetchYahooV8BatchQuotes(
  tickers: string[],
  options?: { skipCache?: boolean },
): Promise<Map<string, YahooBatchQuote>> {
  const results = new Map<string, YahooBatchQuote>();
  if (tickers.length === 0) return results;

  const uniqueTickers = Array.from(new Set(tickers.map(t => t.toUpperCase())));
  const uncached: string[] = [];

  if (!options?.skipCache) {
    for (const ticker of uniqueTickers) {
      const cached = yahooQuoteCache.get<YahooBatchQuote>(`yahoo-v8-quote:${ticker}`);
      if (cached) {
        results.set(ticker, cached);
      } else {
        uncached.push(ticker);
      }
    }
  } else {
    uncached.push(...uniqueTickers);
  }

  const chunkSize = 10;

  for (let i = 0; i < uncached.length; i += chunkSize) {
    const chunk = uncached.slice(i, i + chunkSize);

    const chunkResults = await Promise.allSettled(
      chunk.map(async (ticker) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`;
        const resp = await yahooGet(url, 8000);
        const chartResult = resp.data?.chart?.result?.[0];
        const meta = chartResult?.meta;

        const regularMarketPrice = Number(meta?.regularMarketPrice);
        const previousClose = Number(meta?.chartPreviousClose);
        if (!Number.isFinite(regularMarketPrice) || regularMarketPrice <= 0 || !Number.isFinite(previousClose) || previousClose <= 0) {
          return null;
        }

        // During extended hours, regularMarketPrice = 4PM close.
        // The actual live price is the last candle in the chart data.
        const marketState = getYahooV8MarketState(meta);
        let livePrice = regularMarketPrice;
        let lastExtendedClose: number | undefined;

        if (marketState === 'PRE' || marketState === 'POST' || marketState === 'CLOSED') {
          const closes = chartResult?.indicators?.quote?.[0]?.close as number[] | undefined;
          if (closes && closes.length > 0) {
            // Walk backwards to find last non-null close
            for (let ci = closes.length - 1; ci >= 0; ci--) {
              if (Number.isFinite(closes[ci]) && closes[ci] > 0) {
                lastExtendedClose = closes[ci];
                break;
              }
            }
          }
          // `price` keeps its existing semantics: live extended price during
          // PRE/POST, regular close when CLOSED (consumers rely on that).
          if (lastExtendedClose !== undefined && (marketState === 'PRE' || marketState === 'POST')) {
            livePrice = lastExtendedClose;
          }
        }

        const parsed: YahooBatchQuote = {
          price: livePrice,
          previousClose,
          regularMarketPrice,
          marketState,
          // With includePrePost the last candle under POST/CLOSED is the most
          // recent after-hours trade (frozen 8PM price once closed).
          postMarketPrice: (marketState === 'POST' || marketState === 'CLOSED') ? lastExtendedClose : undefined,
          dayHigh: Number.isFinite(Number(meta?.regularMarketDayHigh)) ? Number(meta.regularMarketDayHigh) : undefined,
          dayLow: Number.isFinite(Number(meta?.regularMarketDayLow)) ? Number(meta.regularMarketDayLow) : undefined,
          volume: Number.isFinite(Number(meta?.regularMarketVolume)) ? Number(meta.regularMarketVolume) : undefined,
          regularMarketTime: Number.isFinite(Number(meta?.regularMarketTime)) ? Number(meta.regularMarketTime) : undefined,
        };

        return { ticker, quote: parsed };
      }),
    );

    for (const result of chunkResults) {
      if (result.status !== 'fulfilled' || !result.value) continue;

      const { ticker, quote } = result.value;
      results.set(ticker, quote);
      yahooQuoteCache.set(`yahoo-v8-quote:${ticker}`, quote, getQuoteCacheTTL());
    }
  }

  return results;
}

/**
 * Fetch extended hours price from Yahoo Finance.
 * Returns { price, previousClose, regularMarketPrice, marketState } or null if unavailable.
 */
async function fetchYahooExtendedPrice(ticker: string): Promise<YahooBatchQuote | null> {
  const quotes = await fetchYahooBatchQuotes([ticker]);
  return quotes.get(ticker.toUpperCase()) || null;
}

export async function fetchPrice(ticker: string): Promise<Quote> {
  try {
    return await getPolygonQuote(ticker);
  } catch {
    return getQuote(ticker);
  }
}

// NOTE: `preferPolygon` is vestigial — Polygon is now unconditionally the
// primary source with a Yahoo overlay, so the option is accepted but ignored
// (kept for call-site compatibility).
export async function fetchPrices(tickers: string[], _options?: { preferPolygon?: boolean }): Promise<QuotesResult> {
  // Polygon is always primary — paid plan provides batch snapshots with
  // lastTrade.p (extended hours), prevDay.c (correct previousClose), and
  // no rate limit issues. Finnhub free tier (60 calls/min) is only used
  // as fallback for tickers Polygon misses.
  let result: QuotesResult;

  try {
    const polygonResult = await getPolygonQuotes(tickers);
    result = { ...polygonResult };
  } catch {
    // Polygon completely failed — fall back to Finnhub
    result = await getQuotes(tickers);
  }

  // Finnhub fallback for any tickers Polygon missed
  if (result.failedTickers.length > 0) {
    try {
      const finnhubResult = await getQuotes(result.failedTickers);
      for (const [ticker, quote] of finnhubResult.quotes) {
        result.quotes.set(ticker, quote);
        result.failedTickers = result.failedTickers.filter(t => t !== ticker);
      }
    } catch { /* Finnhub also failed */ }
  }

  // Yahoo real-time overlay — during regular hours, always fetch fresh Yahoo
  // (skip cache) so stale cached prices don't overwrite fresh Polygon data.
  // During PRE/POST/CLOSED, cache is fine since prices change slowly.
  try {
    const currentSession = getMarketSession();
    const allTickers = [...result.quotes.keys(), ...result.failedTickers];
    if (allTickers.length > 0) {
      const yahooBatch = await fetchYahooBatchQuotes(allTickers, { skipCache: currentSession === 'REG' });
      for (const [ticker, yahooData] of yahooBatch) {
        const existing = result.quotes.get(ticker);
        if (!existing) {
          // Yahoo has it, Polygon didn't — use Yahoo
          const change = yahooData.price - yahooData.previousClose;
          const changePercent = yahooData.previousClose > 0 ? (change / yahooData.previousClose) * 100 : 0;
          const session = getMarketSessionForTicker(ticker);
          const newQuote: Quote = {
            ticker,
            currentPrice: yahooData.price,
            change,
            changePercent,
            high: yahooData.price,
            low: yahooData.price,
            open: yahooData.price,
            previousClose: yahooData.previousClose,
            timestamp: Math.floor(Date.now() / 1000),
            updatedAt: Date.now(),
            isStale: false,
            isRepricing: false,
            quoteAgeSeconds: 0,
            session,
          };
          // Set regularClose/extendedPrice for PRE/POST portfolio split
          if (session === 'PRE' || session === 'POST') {
            newQuote.regularClose = yahooData.regularMarketPrice || yahooData.previousClose;
            newQuote.extendedPrice = yahooData.price;
          }
          result.quotes.set(ticker, newQuote);
          result.failedTickers = result.failedTickers.filter(t => t !== ticker);
        } else if (yahooData.price > 0 && existing.currentPrice > 0) {
          // A successful Yahoo quote is live confirmation of the price, so this quote is
          // NOT stale/repricing even when we DON'T overwrite it (PRE/POST with <=0.5%
          // divergence: Yahoo agrees with the cached Polygon price). getPolygonQuotes may
          // have flagged an aged cache entry stale/repricing; Yahoo's fresh confirmation
          // clears it. (staleCount/repricingCount are recomputed from the final quotes below.)
          existing.isStale = false;
          existing.isRepricing = false;
          existing.quoteAgeSeconds = 0;

          // During REGULAR hours: always prefer Yahoo (near-real-time) over Polygon (~15-min delayed).
          // During PRE/POST: only override on >0.5% divergence (extended hours data is spottier).
          const alwaysPreferYahoo = currentSession === 'REG';
          const divergence = Math.abs(yahooData.price - existing.currentPrice) / existing.currentPrice;
          if (alwaysPreferYahoo || divergence > 0.005) {
            existing.currentPrice = yahooData.price;
            existing.previousClose = yahooData.previousClose;
            existing.change = existing.currentPrice - existing.previousClose;
            existing.changePercent = existing.previousClose > 0
              ? (existing.change / existing.previousClose) * 100 : 0;
            existing.updatedAt = Date.now();
            existing.timestamp = Math.floor(Date.now() / 1000);
            // Set regularClose/extendedPrice for PRE/POST portfolio split
            const tickerSession = getMarketSessionForTicker(ticker);
            if (tickerSession === 'PRE' || tickerSession === 'POST') {
              existing.regularClose = yahooData.regularMarketPrice || existing.previousClose;
              existing.extendedPrice = yahooData.price;
            }
          }
        }
      }
    }
  } catch { /* Yahoo overlay failed — keep Polygon data */ }

  // Set per-ticker session info
  const session = getMarketSession();
  if (session === 'PRE' || session === 'POST' || session === 'CLOSED') {
    for (const [ticker, quote] of result.quotes.entries()) {
      quote.session = getMarketSessionForTicker(ticker);
    }
  }

  // When market is CLOSED: for any ticker Polygon/Finnhub/Yahoo failed to
  // return, fall back to historical daily candles. Candles are stable archived
  // data and don't suffer the snapshot-endpoint drop issue. This fixes the
  // weekend "no data" problem for portfolio holdings + heatmap tickers.
  if (session === 'CLOSED' && result.failedTickers.length > 0) {
    try {
      const candleQuotes = await fetchQuotesFromCandles(result.failedTickers);
      for (const [ticker, quote] of candleQuotes.entries()) {
        quote.session = getMarketSessionForTicker(ticker);
        result.quotes.set(ticker, quote);
      }
      result.failedTickers = result.failedTickers.filter((t) => !candleQuotes.has(t.toUpperCase()));
    } catch { /* Candle fallback failed — leave failedTickers as-is */ }
  }

  // Recompute stale/repricing counts from the FINAL quote set. getPolygonQuotes set these
  // from its cache snapshot, but the Yahoo overlay (and Finnhub/candle fallbacks) above may
  // have refreshed or live-confirmed quotes it flagged stale/repricing — e.g. a fresh Yahoo
  // quote that CONFIRMS the cached price during PRE/POST (<=0.5%, no overwrite) still proves
  // the price is current. Counting the post-overlay flags keeps the "Repricing..." signal
  // honest: it only clears when we actually have fresh data, and never masks a real outage.
  let finalStaleCount = 0;
  let finalRepricingCount = 0;
  for (const quote of result.quotes.values()) {
    if (quote.isStale) finalStaleCount++;
    if (quote.isRepricing) finalRepricingCount++;
  }
  result.staleCount = finalStaleCount;
  result.repricingCount = finalRepricingCount;

  return result;
}

// Symbols with no live feed on ANY provider (delistings, closed acquisitions —
// e.g. K→Mars, KLG→Ferrero, EXAS). Users still hold/watch them. Serving the
// final traded bar keeps portfolios and detail pages rendering instead of
// 500ing, and the negative cache stops dead symbols from burning the shared
// Finnhub 60/min budget on every request (their collateral 429s were knocking
// out quotes for healthy tickers). 1h TTLs so a transient all-provider outage
// misclassifying a live ticker self-heals within the hour.
const lastKnownQuoteCache = new NodeCache({ stdTTL: 3600 });
const deadSymbolCache = new NodeCache({ stdTTL: 3600 });

async function fetchLastKnownQuote(ticker: string): Promise<Quote | null> {
  const upper = ticker.toUpperCase();
  const cached = lastKnownQuoteCache.get<Quote>(`last:${upper}`);
  if (cached) {
    return {
      ...cached,
      quoteAgeSeconds: Math.floor((Date.now() - (cached.updatedAt || 0)) / 1000),
    };
  }

  // Wide window: a symbol delisted months ago still returns its final bars.
  // Bounded: this path also runs for genuinely-unknown symbols (typos), and
  // fetchStockDetails' no-quote disambiguation must not hang behind a stalled
  // aggs call — 1s is generous for one Polygon daily-aggs roundtrip.
  const candles = await withSoftTimeout(
    fetchDailyCandles(upper, 370),
    1000,
    [] as IntradayCandle[],
    `${upper} last-known candles`,
  );
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2] : last;
  if (last.close <= 0) return null;

  const change = last.close - prev.close;
  const updatedAt = new Date(last.time).getTime();
  const quote: Quote = {
    ticker: upper,
    currentPrice: last.close,
    change,
    changePercent: prev.close > 0 ? (change / prev.close) * 100 : 0,
    high: last.high,
    low: last.low,
    open: last.open,
    previousClose: prev.close,
    timestamp: Math.floor(updatedAt / 1000),
    updatedAt,
    isStale: true,
    isRepricing: false,
    quoteAgeSeconds: Math.floor((Date.now() - updatedAt) / 1000),
    session: getMarketSessionForTicker(upper),
  };
  lastKnownQuoteCache.set(`last:${upper}`, quote);
  return quote;
}

export async function fetchQuote(ticker: string): Promise<Quote> {
  let quote: Quote;

  const upperTicker = ticker.toUpperCase();
  // Known-dead symbol: skip the live-provider gauntlet entirely — each pass
  // costs Finnhub retries plus 60s of rate-limit poisoning for other tickers.
  if (deadSymbolCache.has(`dead:${upperTicker}`)) {
    const lastKnown = await fetchLastKnownQuote(upperTicker);
    if (lastKnown) return lastKnown;
    throw new Error(`No quote available for ${upperTicker}`);
  }

  // Polygon primary — paid plan, handles extended hours natively via lastTrade
  try {
    quote = await getPolygonQuote(ticker);
  } catch {
    // Polygon failed — fall back to Finnhub
    try {
      quote = await getQuote(ticker);
    } catch {
      // Both failed — try Yahoo as last resort
      const yahooQuote = await fetchYahooQuote(ticker);
      if (yahooQuote) {
        quote = yahooQuote;
      } else {
        // No live feed anywhere. Serve the final traded bar (frozen, isStale)
        // if we have one. Sticky-mark the symbol dead ONLY when that bar is
        // itself old — a live ticker caught in a momentary all-provider
        // outage has a fresh bar and must keep retrying the live chain, and
        // a symbol with no bar at all (typo, Yahoo-only symbology) must never
        // be sticky-marked off a single failure.
        const lastKnown = await fetchLastKnownQuote(upperTicker);
        if (!lastKnown) throw new Error(`No quote available for ${ticker}`);
        const lastBarAgeMs = Date.now() - (lastKnown.updatedAt || 0);
        if (lastBarAgeMs > 7 * 86400000) {
          deadSymbolCache.set(`dead:${upperTicker}`, true);
          console.warn(
            `[Quote] ${upperTicker} has no live feed and its last bar is ${Math.round(lastBarAgeMs / 86400000)}d old — serving frozen close (${lastKnown.currentPrice}), pausing live fetches for 1h`,
          );
        } else {
          console.warn(
            `[Quote] ${upperTicker}: all live providers failed — serving last known close (${lastKnown.currentPrice}) without pausing live fetches`,
          );
        }
        return lastKnown;
      }
    }
  }

  // Override session with per-ticker market hours (international/commodity aware)
  const session = getMarketSessionForTicker(ticker);
  quote.session = session;

  // During extended hours, Polygon/Finnhub often return stale regular-session prices.
  // Yahoo's quote endpoint has real-time extended-hours data.
  //
  // CLOSED is included for the regular/after-hours SPLIT FIELDS ONLY: after
  // 8 PM ET the split used to vanish (fields unset), collapsing the stock
  // header to one blended day change. In CLOSED we never touch currentPrice/
  // previousClose/change/changePercent — every other consumer (heatmap,
  // portfolio, sectors) keeps the exact quote it gets today; a Yahoo failure
  // just leaves the split fields unset (UI falls back to the blended line).
  if (session === 'PRE' || session === 'POST' || session === 'CLOSED') {
    const polygonPrice = quote.currentPrice; // Capture Polygon's price before overlay
    let yahooExtended = await fetchYahooExtendedPrice(ticker);
    if (session === 'CLOSED' && (!yahooExtended || !yahooExtended.postMarketPrice)) {
      // v7 sometimes misses (or lacks postMarketPrice once CLOSED); the v8
      // chart endpoint carries the frozen after-hours candles reliably.
      yahooExtended = (await fetchYahooV8BatchQuotes([ticker])).get(ticker.toUpperCase()) || yahooExtended;
    }
    if (yahooExtended && yahooExtended.price > 0) {
      if (session !== 'CLOSED') {
        quote.currentPrice = yahooExtended.price;
        quote.previousClose = yahooExtended.previousClose || quote.previousClose;
        quote.change = quote.currentPrice - quote.previousClose;
        quote.changePercent = quote.previousClose !== 0
          ? (quote.change / quote.previousClose) * 100
          : 0;
        quote.updatedAt = Date.now();
        quote.timestamp = Math.floor(quote.updatedAt / 1000);
        quote.isStale = false;
        quote.quoteAgeSeconds = 0;
      }

      // Set extended hours fields for consistent portfolio regular/extended split.
      // regularClose = most recent completed regular-session close.
      // During POST/CLOSED: regularMarketPrice = today's 4 PM close.
      // During PRE: regularMarketPrice = yesterday's 4 PM close.
      // previousClose = regularMarketPreviousClose from Yahoo = the day BEFORE regularMarketPrice.
      // In CLOSED, `yahooExtended.price` is the regular close, so the
      // extended price must come from postMarketPrice — no AH data → leave
      // the split fields unset and the UI falls back to the blended line.
      const extPrice = session === 'CLOSED' ? yahooExtended.postMarketPrice : yahooExtended.price;
      if (extPrice && extPrice > 0) {
        quote.regularClose = yahooExtended.regularMarketPrice || polygonPrice || quote.previousClose;
        quote.extendedPrice = extPrice;
        quote.extendedChange = quote.extendedPrice - (quote.regularClose || quote.previousClose);
        quote.extendedChangePercent = (quote.regularClose || quote.previousClose) > 0
          ? (quote.extendedChange / (quote.regularClose || quote.previousClose)) * 100
          : 0;
      }
    }
  }

  return quote;
}

/**
 * Fetch a basic quote from Yahoo Finance as fallback when Finnhub has no data.
 *
 * `includeExtendedSplit` (OFF by default) additionally populates
 * regularClose/extendedPrice/extendedChange for the stock-header's
 * at-close/after-hours split. It exists for the fast-quote path only (stock
 * detail first paint) — the plain fallback path must NOT set these fields
 * (see the warning above `return quote` about the portfolio split).
 */
async function fetchYahooQuote(ticker: string, options?: { includeExtendedSplit?: boolean }): Promise<Quote | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`;
    const resp = await yahooGet(url);

    const meta = resp.data?.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice) return null;

    const timestamps = resp.data.chart.result[0].timestamp;
    const closes = resp.data.chart.result[0].indicators?.quote?.[0]?.close;

    // Find last non-null close for extended hours
    let lastPrice = meta.regularMarketPrice;
    if (timestamps && closes) {
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null) {
          lastPrice = closes[i];
          break;
        }
      }
    }

    const session = getMarketSessionForTicker(ticker);
    const previousClose = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
    const currentPrice = lastPrice;
    const change = currentPrice - previousClose;
    const changePercent = previousClose !== 0 ? (change / previousClose) * 100 : 0;

    const quote: Quote = {
      ticker: ticker.toUpperCase(),
      currentPrice,
      change,
      changePercent,
      high: meta.regularMarketDayHigh || currentPrice,
      low: meta.regularMarketDayLow || currentPrice,
      open: meta.regularMarketOpen || currentPrice,
      previousClose,
      timestamp: Math.floor(Date.now() / 1000),
      updatedAt: Date.now(),
      isStale: false,
      isRepricing: false,
      quoteAgeSeconds: 0,
      session,
    };

    // Yahoo is a last-resort fallback behind Polygon. Don't set regularClose
    // here by default — it causes a bogus afterHoursChange split in the
    // portfolio. Polygon handles extended hours natively via lastTrade.p
    // without needing a regularClose/extendedPrice split.
    //
    // The stock detail page's first paint (fetchFastQuote) opts in: outside
    // regular hours meta.regularMarketPrice is the frozen official close and
    // lastPrice is the newest extended-hours candle, which is exactly the
    // at-close/after-hours split the header renders.
    if (
      options?.includeExtendedSplit
      && session !== 'REG'
      && meta.regularMarketPrice > 0
      && lastPrice !== meta.regularMarketPrice
    ) {
      quote.regularClose = meta.regularMarketPrice;
      quote.extendedPrice = lastPrice;
      quote.extendedChange = lastPrice - meta.regularMarketPrice;
      quote.extendedChangePercent = (quote.extendedChange / meta.regularMarketPrice) * 100;
    }

    return quote;
  } catch {
    return null;
  }
}

/**
 * Fast quote fetch — Yahoo primary (most accurate real-time), Polygon/Finnhub fallback.
 * Used for progressive loading to show price immediately.
 */
export async function fetchFastQuote(ticker: string): Promise<Quote | null> {
  // Yahoo first — more accurate real-time pricing during market hours.
  // includeExtendedSplit: the stock header needs regularClose/extendedPrice
  // on FIRST paint (this quote), not just after the first /market/quote poll.
  try {
    const yahoo = await fetchYahooQuote(ticker, { includeExtendedSplit: true });
    if (yahoo && yahoo.currentPrice > 0) return yahoo;
  } catch { /* fall through */ }
  // Polygon/Finnhub fallback
  try {
    return await fetchQuote(ticker);
  } catch {
    return null;
  }
}

// Thrown when no provider has a quote for the ticker — the controller maps it
// to a 404 (it used to surface as a generic 500 for any mistyped symbol).
export class TickerNotFoundError extends Error {
  constructor(ticker: string) {
    super(`No quote data available for ${ticker}`);
    this.name = 'TickerNotFoundError';
  }
}

/**
 * Resolve market cap in BILLIONS from a cached fundamentals overview, mirroring the
 * heatmap's resolveMarketCapB (direct marketCapB else absolute marketCap / 1e9). Kept
 * local to avoid a circular import with market-heatmap.service.
 */
function resolveCapBFromOverview(overview: any): number | null {
  const directB = overview?.marketCapB;
  if (typeof directB === 'number' && Number.isFinite(directB)) return directB;
  const raw = overview?.marketCap ?? overview?.MarketCapitalization;
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' ? parseFloat(raw.replace(/[$,]/g, '')) : NaN);
  if (Number.isFinite(n)) return n / 1_000_000_000;
  return null;
}

export async function fetchStockDetails(ticker: string): Promise<StockDetailsResponse> {
  const upperTicker = ticker.toUpperCase();

  // Return the required quote fast, and treat fundamentals/history as best-effort.
  const [quote, profileRaw, metricsRaw, candles, fundRow] = await Promise.all([
    fetchFastQuote(upperTicker),
    withSoftTimeout(getStockProfile(upperTicker), STOCK_DETAILS_OPTIONAL_TIMEOUT_MS, null, `${upperTicker} profile`),
    withSoftTimeout(getStockMetrics(upperTicker), STOCK_DETAILS_OPTIONAL_TIMEOUT_MS, null, `${upperTicker} metrics`),
    withSoftTimeout(fetchStockDetailCandles(upperTicker), STOCK_DETAILS_OPTIONAL_TIMEOUT_MS, null, `${upperTicker} detail candles`),
    (async () => {
      try {
        const { default: prisma } = await import('../utils/prisma');
        return (await prisma.fundamentalsCache.findUnique({ where: { ticker: upperTicker } })) ?? null;
      } catch { return null; }
    })(),
  ]);

  if (!quote) {
    // A null quote means EITHER the symbol doesn't exist OR every quote
    // provider transiently failed for a real symbol. Only the first should
    // 404 (a sticky "not found"); the second must stay a retryable 5xx.
    // A real symbol still resolves in search when the quote providers blip,
    // so use an exact search match to disambiguate — and fail toward
    // "retryable" on any ambiguity (search itself erroring, etc.).
    let confirmedUnknown = false;
    try {
      // meta.partial is set whenever the search providers themselves failed
      // (Polygon/Finnhub error or rate-limit) — results are then unreliable, so
      // a partial search must NOT be read as "no such symbol". Only a complete
      // search that returns no exact symbol match confirms the ticker unknown.
      const { results, meta } = await searchTickers(upperTicker);
      confirmedUnknown = !meta.partial && !results.some((r) => r.symbol.toUpperCase() === upperTicker);
    } catch {
      confirmedUnknown = false;
    }
    if (confirmedUnknown) {
      throw new TickerNotFoundError(upperTicker);
    }
    throw new Error(`No quote data available for ${upperTicker} (transient)`);
  }

  // Map profile
  let profile: StockProfile | null = null;
  if (profileRaw) {
    // Market cap: prefer the canonical Polygon/Yahoo cap (the SAME fundamentalsCache the
    // heatmap reads) so a ticker shows the same cap on the heatmap tile and the detail
    // page; fall back to Finnhub's profile cap when the cache has none. Kept in millions
    // to match the existing marketCapM unit / formatLargeNumber.
    let marketCapM = profileRaw.marketCapitalization || 0;
    if (fundRow?.overviewJson) {
      try {
        const capB = resolveCapBFromOverview(JSON.parse(fundRow.overviewJson));
        if (capB != null && capB > 0) marketCapM = Math.round(capB * 1000);
      } catch { /* keep Finnhub cap */ }
    }
    profile = {
      ticker: upperTicker,
      name: profileRaw.name || upperTicker,
      description: '', // profile2 doesn't include description
      logo: profileRaw.logo || '',
      industry: profileRaw.finnhubIndustry || '',
      marketCapM,
      ipoDate: profileRaw.ipo || '',
      weburl: profileRaw.weburl || '',
      country: profileRaw.country || '',
      exchange: profileRaw.exchange || '',
      phone: profileRaw.phone || '',
    };
  }

  // Map metrics
  let metrics: StockMetrics | null = null;
  if (metricsRaw?.metric) {
    const m = metricsRaw.metric;
    metrics = {
      ticker: upperTicker,
      peRatio: m.peBasicExclExtraTTM ?? null,
      week52High: m['52WeekHigh'] ?? null,
      week52Low: m['52WeekLow'] ?? null,
      dividendYield: m.dividendYieldIndicatedAnnual ?? null,
      avgVolume10D: m['10DayAverageTradingVolume'] ?? null,
      beta: m.beta ?? null,
      eps: m.epsBasicExclExtraItemsTTM ?? null,
      expenseRatio: null,
      aumB: null,
    };
  }

  // Enrich with hardcoded ETF reference data where Finnhub returns nulls
  const etfRef = ETF_REFERENCE_DATA[upperTicker];
  if (etfRef) {
    if (!metrics) {
      metrics = {
        ticker: upperTicker,
        peRatio: etfRef.peRatio ?? null,
        week52High: null,
        week52Low: null,
        dividendYield: etfRef.dividendYield ?? null,
        avgVolume10D: null,
        beta: etfRef.beta ?? null,
        eps: null,
        expenseRatio: etfRef.expenseRatio ?? null,
        aumB: etfRef.aumB ?? null,
      };
    } else {
      // Fill in nulls with ETF reference data
      if (metrics.peRatio === null && etfRef.peRatio != null) metrics.peRatio = etfRef.peRatio;
      if (metrics.dividendYield === null && etfRef.dividendYield != null) metrics.dividendYield = etfRef.dividendYield;
      if (metrics.beta === null && etfRef.beta != null) metrics.beta = etfRef.beta;
      metrics.expenseRatio = etfRef.expenseRatio ?? null;
      metrics.aumB = etfRef.aumB ?? null;
    }
  }

  return { ticker: upperTicker, quote, profile, metrics, candles };
}

/**
 * Warm the quote cache on startup by pre-fetching prices for all held tickers.
 * Runs in background — non-blocking. Uses Polygon (saves Finnhub quota).
 * Capped at MAX_WARM_TICKERS to bound startup work as user count grows.
 */
const MAX_WARM_TICKERS = 100;

export async function warmHoldingsCache(): Promise<void> {
  const prisma = (await import('../utils/prisma')).default;

  const holdings = await prisma.holding.findMany({
    select: { ticker: true },
    distinct: ['ticker'],
    where: { shares: { gt: 0 } },
  });

  const tickers = [...new Set(holdings.map(h => h.ticker.toUpperCase()))];
  // Register active tickers so quote persistence only saves holdings (not random searches)
  const { setActiveQuoteTickers } = await import('../utils/polygon');
  setActiveQuoteTickers(tickers);
  if (tickers.length === 0) {
    console.log('[Startup] No holdings to warm');
    return;
  }

  const toWarm = tickers.slice(0, MAX_WARM_TICKERS);
  console.log(`[Startup] Warming holdings cache: ${toWarm.length} tickers${tickers.length > MAX_WARM_TICKERS ? ` (capped from ${tickers.length})` : ''}`);

  const startTime = Date.now();
  let succeeded = 0;

  // Fetch in batches of 10 using Polygon (no Finnhub queue pressure)
  const batchSize = 10;
  for (let i = 0; i < toWarm.length; i += batchSize) {
    const batch = toWarm.slice(i, i + batchSize);
    try {
      const result = await fetchPrices(batch, { preferPolygon: true });
      succeeded += result.quotes.size;
    } catch (err) {
      console.warn(`[Startup] Batch ${i}-${i + batch.length} warm failed:`, (err as Error).message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Startup] Warmed ${succeeded}/${toWarm.length} tickers in ${elapsed}s`);
}

export async function searchTickers(
  query: string,
  heldTickers: string[] = []
): Promise<SymbolSearchResponse> {
  const { results, partial, cached, advPending } = await searchSymbols(query, heldTickers);

  return {
    results,
    meta: {
      query,
      count: results.length,
      partial,
      cached,
      advPending,
    },
  };
}
