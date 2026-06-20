/**
 * Shared candle period-window helpers.
 *
 * THE bug this centralizes: several services anchored "price N days ago" by
 * TIMESTAMP — `new Date(candle.time).getTime() >= Date.now() - days*86_400_000`.
 * A daily bar is stamped at the START of its day, but that cutoff carries the
 * current time-of-day, so the candle exactly N days ago fell just before the
 * cutoff and was SKIPPED — measuring ~N-1 days and understating multi-day
 * returns (e.g. AMAT's Top 100 "7D" read +5.35% vs the chart's correct +9.21%).
 *
 * Anchor by DATE instead (first candle whose calendar date is on/after the
 * cutoff date), exactly mirroring the stock chart (useStockChart). Every period
 * change must use these so the number can't diverge by screen.
 */

/** Date string (YYYY-MM-DD, UTC) for a candle timestamp; '' when missing/invalid. */
export function candleDateStr(time: unknown): string {
  if (time == null) return '';
  const d = new Date(time as string | number);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** UTC date string for "N days ago" from now (the window cutoff). */
export function windowCutoffDate(days: number): string {
  return candleDateStr(Date.now() - days * 86_400_000);
}

/**
 * Close of the first candle whose calendar date is on/after `cutoffDate`
 * (YYYY-MM-DD). Falls back to the oldest candle; null when there are no candles.
 * Use this when the window start is a specific date (e.g. YTD = Jan 1).
 */
export function periodStartCloseByDate(
  candles: { time?: unknown; close: number }[] | null | undefined,
  cutoffDate: string,
): number | null {
  if (!candles || candles.length === 0) return null;
  const start = candles.find((c) => {
    const d = candleDateStr(c.time);
    return d !== '' && d >= cutoffDate;
  }) ?? candles[0];
  return start.close;
}

/**
 * Close of the first candle on/after (today - `days`), date-anchored. The
 * date-based replacement for the buggy `candle.time.getTime() >= now - days*ms`.
 */
export function periodStartClose(
  candles: { time?: unknown; close: number }[] | null | undefined,
  days: number,
): number | null {
  return periodStartCloseByDate(candles, windowCutoffDate(days));
}

/**
 * Same date-anchored start close, but for parallel close[]/timestamp[] arrays
 * (timestamps in UNIX SECONDS, ascending) — e.g. raw Polygon aggregate responses.
 */
export function periodStartCloseFromArrays(
  closes: number[] | null | undefined,
  timestampsSec: number[] | null | undefined,
  days: number,
): number | null {
  if (!closes || closes.length === 0 || !timestampsSec) return null;
  const cutoff = windowCutoffDate(days);
  const n = Math.min(closes.length, timestampsSec.length);
  for (let i = 0; i < n; i++) {
    if (candleDateStr(timestampsSec[i] * 1000) >= cutoff) return closes[i];
  }
  return closes[0];
}
