import { describe, it, expect } from 'vitest';
import { buildYahooChartUrl, trimToLastSessions } from '../services/market.service';
import type { IntradayCandle } from '../types';

/**
 * Guards for the two candle-window defects found in the 2026-08-20 audit.
 * Both were silent: the charts rendered, the numbers were real, and only
 * counting bars or comparing two intervals side by side revealed them.
 */

function bar(iso: string, close = 100): IntradayCandle {
  return { time: iso, open: close, high: close, low: close, close, volume: 1 };
}

describe('buildYahooChartUrl — MAX must not use range=max', () => {
  it('asks MAX by epoch window, never by range', () => {
    // range=max makes Yahoo IGNORE interval=1d and return quarterly bars
    // (dataGranularity '3mo'). Measured: AAPL range=max -> 168 points;
    // period1=0 -> 11,514 daily bars back to 1980-12-12.
    const url = buildYahooChartUrl('AAPL', 'MAX', '1D', 1_800_000_000)!;
    expect(url).toContain('period1=0');
    expect(url).toContain('period2=1800000000');
    expect(url).not.toContain('range=');
    expect(url).toContain('interval=1d');
  });

  it('still uses range for every other period', () => {
    for (const [period, expected] of [['1Y', '1y'], ['6M', '6mo'], ['YTD', 'ytd'], ['3M', '3mo']] as const) {
      const url = buildYahooChartUrl('AAPL', period, '1D')!;
      expect(url, `${period} should use range`).toContain(`range=${expected}`);
      expect(url).not.toContain('period1=');
    }
  });

  it('serves 1W from Yahoo on BOTH intraday intervals, with the same range', () => {
    // The bug: getYahooRange had no '1W' case under '1h', so 1W/1h alone fell
    // through to Polygon and got 9 CALENDAR days while 1W/5m got 5 TRADING
    // days from Yahoo. One period button, two windows.
    const fiveMin = buildYahooChartUrl('AAPL', '1W', '5m');
    const hourly = buildYahooChartUrl('AAPL', '1W', '1h');
    expect(fiveMin).toContain('range=5d');
    expect(hourly).toContain('range=5d');
    expect(hourly).toContain('interval=60m');
  });

  it('returns null where Yahoo genuinely cannot serve the combination', () => {
    expect(buildYahooChartUrl('AAPL', '1Y', '1m')).toBeNull();
    expect(buildYahooChartUrl('AAPL', 'MAX', '1h')).toBeNull();
  });

  it('encodes tickers that need it', () => {
    expect(buildYahooChartUrl('BRK.B', '1Y', '1D')).toContain('BRK.B');
    expect(buildYahooChartUrl('A&B', '1Y', '1D')).toContain('A%26B');
  });
});

describe('trimToLastSessions', () => {
  // Normalises the window whichever source answered: Yahoo returns exactly 5
  // sessions for range=5d, the Polygon fallback asks for a generous calendar
  // range and would otherwise hand back more.
  const series = [
    bar('2026-08-11T14:00:00Z'), bar('2026-08-11T18:00:00Z'),
    bar('2026-08-12T14:00:00Z'),
    bar('2026-08-13T14:00:00Z'),
    bar('2026-08-14T14:00:00Z'),
    bar('2026-08-17T14:00:00Z'),
    bar('2026-08-18T14:00:00Z'),
  ];

  it('keeps only the most recent N sessions, and all bars within them', () => {
    const out = trimToLastSessions(series, 3);
    const days = [...new Set(out.map(c => c.time.slice(0, 10)))];
    expect(days).toEqual(['2026-08-14', '2026-08-17', '2026-08-18']);
    expect(out).toHaveLength(3);
  });

  it('counts SESSIONS not bars — a multi-bar day is one session', () => {
    const out = trimToLastSessions(series, 7);
    // Only 6 distinct days exist, so nothing is dropped even though n < length.
    expect(out).toHaveLength(series.length);
  });

  it('drops the extra days a 9-calendar-day Polygon reply carries', () => {
    const out = trimToLastSessions(series, 5);
    expect([...new Set(out.map(c => c.time.slice(0, 10)))]).toEqual([
      '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18',
    ]);
  });

  it('is a no-op when the series already fits', () => {
    expect(trimToLastSessions(series, 99)).toEqual(series);
  });

  it('handles empty and degenerate input without throwing', () => {
    expect(trimToLastSessions([], 5)).toEqual([]);
    expect(trimToLastSessions(series, 0)).toEqual(series);
    expect(trimToLastSessions(series, -1)).toEqual(series);
  });

  it('does not assume the series is sorted', () => {
    const shuffled = [series[6], series[0], series[3], series[5], series[1]];
    const days = [...new Set(trimToLastSessions(shuffled, 2).map(c => c.time.slice(0, 10)))].sort();
    expect(days).toEqual(['2026-08-17', '2026-08-18']);
  });
});
