import { describe, it, expect } from 'vitest';
import {
  candleDateStr,
  periodStartClose,
  periodStartCloseByDate,
  periodStartCloseFromArrays,
  periodStartCloseFromDateStrings,
} from '../utils/candle-window';

const DAY_MS = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS).toISOString();

describe('candle-window — date-anchored period start (the bug that hit Top 100 / heatmaps / watchlist)', () => {
  it('candleDateStr returns the UTC date, or "" for missing/invalid', () => {
    expect(candleDateStr('2026-06-12T00:00:00Z')).toBe('2026-06-12');
    expect(candleDateStr(undefined)).toBe('');
    expect(candleDateStr('not-a-date')).toBe('');
  });

  it('INCLUDES the candle exactly N days ago, stamped at day-start (the timestamp-skip bug)', () => {
    const sevenDaysAgoDate = new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10);
    const candles = [
      { time: sevenDaysAgoDate + 'T00:00:00Z', close: 100 }, // exactly 7d ago, day-start
      { time: iso(3), close: 110 },
      { time: iso(0.2), close: 120 },
    ];
    // Date anchoring includes the $100 bar; the old timestamp compare skipped it → $110.
    expect(periodStartClose(candles, 7)).toBe(100);
  });

  it('drops the over-fetch buffer (candles older than the window)', () => {
    const candles = [
      { time: iso(16), close: 271 }, // buffer
      { time: iso(6), close: 245 },  // true ~1w start
      { time: iso(0.2), close: 246 },
    ];
    expect(periodStartClose(candles, 7)).toBe(245);
  });

  it('falls back to the oldest candle when none are within the window; null when empty', () => {
    expect(periodStartClose([{ time: iso(40), close: 90 }, { time: iso(35), close: 95 }], 7)).toBe(90);
    expect(periodStartClose([], 7)).toBeNull();
  });

  it('periodStartCloseByDate anchors at an explicit cutoff date (e.g. YTD = Jan 1)', () => {
    const candles = [
      { time: '2026-01-02T00:00:00Z', close: 50 },
      { time: '2026-03-01T00:00:00Z', close: 60 },
    ];
    expect(periodStartCloseByDate(candles, '2026-01-01')).toBe(50);
    expect(periodStartCloseByDate(candles, '2026-02-01')).toBe(60);
  });

  it('periodStartCloseFromArrays handles parallel closes[]/timestamps[] (unix seconds)', () => {
    const dayStartSec = Math.floor(
      new Date(new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10) + 'T00:00:00Z').getTime() / 1000,
    );
    const closes = [100, 110, 120];
    const timestamps = [dayStartSec, Math.floor((Date.now() - 3 * DAY_MS) / 1000), Math.floor((Date.now() - 0.2 * DAY_MS) / 1000)];
    expect(periodStartCloseFromArrays(closes, timestamps, 7)).toBe(100);
    expect(periodStartCloseFromArrays([], [], 7)).toBeNull();
  });

  it('periodStartCloseFromDateStrings handles parallel closes[]/dates[] (date strings)', () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10);
    const closes = [100, 110, 120];
    const dates = [
      sevenDaysAgo,
      new Date(Date.now() - 3 * DAY_MS).toISOString().slice(0, 10),
      new Date(Date.now() - 0.2 * DAY_MS).toISOString().slice(0, 10),
    ];
    // Includes the bar exactly 7d ago (date-anchored), mirroring periodStartCloseFromArrays.
    expect(periodStartCloseFromDateStrings(closes, dates, 7)).toBe(100);
    // Falls back to the oldest close when none are within the window; null when empty.
    expect(periodStartCloseFromDateStrings([90, 95], ['2020-01-01', '2020-01-02'], 7)).toBe(90);
    expect(periodStartCloseFromDateStrings([], [], 7)).toBeNull();
  });
});
