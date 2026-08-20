import { describe, it, expect } from 'vitest';
import { buildYahooChartUrl, trimToLastSessions, mergeTrailingPartialBar } from '../services/market.service';
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

describe('mergeTrailingPartialBar', () => {
  // Yahoo appends the live quote stamped at the CURRENT time, not on the bar
  // grid. Measured on AAPL 1D/15m 2026-08-20: bars 0-43 on :00/:15/:30/:45,
  // then bar 44 at 14:49 with open == close. Four minutes is a fraction of a
  // 15m slot, so it rendered on top of the previous candle.
  const M15 = 15 * 60_000;

  function ohlc(iso: string, o: number, h: number, l: number, c: number, v = 100): IntradayCandle {
    return { time: iso, open: o, high: h, low: l, close: c, volume: v };
  }

  it('folds a short straggler into the bar it belongs to', () => {
    const out = mergeTrailingPartialBar([
      ohlc('2026-08-20T18:30:00Z', 316.6, 316.7, 316.2, 316.3),
      ohlc('2026-08-20T18:45:00Z', 315.63, 315.8, 315.1, 315.23),
      ohlc('2026-08-20T18:49:00Z', 315.40, 315.40, 315.40, 315.40, 0), // the live element
    ], M15);

    expect(out).toHaveLength(2);
    const forming = out[1];
    // Keeps the GRID bar's identity...
    expect(forming.time).toBe('2026-08-20T18:45:00Z');
    expect(forming.open).toBe(315.63);
    // ...but takes the newer close and the widened range.
    expect(forming.close).toBe(315.40);
    expect(forming.high).toBe(315.8);
    expect(forming.low).toBe(315.1);
  });

  it('extends high/low when the live print is a new extreme', () => {
    const out = mergeTrailingPartialBar([
      ohlc('2026-08-20T18:45:00Z', 100, 101, 99, 100),
      ohlc('2026-08-20T18:52:00Z', 105, 105, 98, 105, 0),
    ], M15);
    expect(out[0].high).toBe(105);
    expect(out[0].low).toBe(98);
    expect(out[0].close).toBe(105);
  });

  it('leaves a legitimate full-interval bar alone', () => {
    const bars = [
      ohlc('2026-08-20T18:30:00Z', 1, 1, 1, 1),
      ohlc('2026-08-20T18:45:00Z', 2, 2, 2, 2),
      ohlc('2026-08-20T19:00:00Z', 3, 3, 3, 3),
    ];
    expect(mergeTrailingPartialBar(bars, M15)).toEqual(bars);
  });

  it('takes max volume, never the sum — the stub would double-count the bar', () => {
    const out = mergeTrailingPartialBar([
      ohlc('2026-08-20T18:45:00Z', 1, 1, 1, 1, 5000),
      ohlc('2026-08-20T18:49:00Z', 1, 1, 1, 1, 0),
    ], M15);
    expect(out[0].volume).toBe(5000);
  });

  it('is a no-op on degenerate input', () => {
    expect(mergeTrailingPartialBar([], M15)).toEqual([]);
    const one = [ohlc('2026-08-20T18:45:00Z', 1, 1, 1, 1)];
    expect(mergeTrailingPartialBar(one, M15)).toEqual(one);
    expect(mergeTrailingPartialBar(one, 0)).toEqual(one);
  });

  it('does not merge a bar that is out of order', () => {
    const bars = [
      ohlc('2026-08-20T18:45:00Z', 1, 1, 1, 1),
      ohlc('2026-08-20T18:40:00Z', 2, 2, 2, 2),
    ];
    expect(mergeTrailingPartialBar(bars, M15)).toEqual(bars);
  });

  it('scales with the interval — 4min is a straggler at 15m but a real bar at 1m', () => {
    const bars = [
      ohlc('2026-08-20T18:45:00Z', 1, 1, 1, 1),
      ohlc('2026-08-20T18:49:00Z', 2, 2, 2, 2),
    ];
    expect(mergeTrailingPartialBar(bars, M15)).toHaveLength(1);
    expect(mergeTrailingPartialBar(bars, 60_000)).toHaveLength(2);
  });
});
