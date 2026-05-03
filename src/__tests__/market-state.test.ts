import { describe, it, expect } from 'vitest';
import { getMarketStateET, getETDateBucket, isNyseHolidayET } from '../utils/market-state';

// Use Date constructed via toLocaleString round-trip would be flaky; instead build absolute UTC instants.
// America/New_York is UTC-4 in May (EDT), UTC-5 in November (EST).

describe('getMarketStateET', () => {
  it('returns "intraday" at 10:30 AM ET on a weekday (May 1 2026, Friday, EDT)', () => {
    // 10:30 EDT = 14:30 UTC
    const t = new Date('2026-05-01T14:30:00Z');
    expect(getMarketStateET(t)).toBe('intraday');
  });

  it('returns "intraday" exactly at 9:30 AM ET (open bell)', () => {
    const t = new Date('2026-05-01T13:30:00Z'); // 9:30 EDT
    expect(getMarketStateET(t)).toBe('intraday');
  });

  it('returns "post_close" exactly at 4:00 PM ET (closing bell)', () => {
    const t = new Date('2026-05-01T20:00:00Z'); // 16:00 EDT
    expect(getMarketStateET(t)).toBe('post_close');
  });

  it('returns "pre_open" at 8:00 AM ET on a weekday', () => {
    const t = new Date('2026-05-01T12:00:00Z'); // 08:00 EDT
    expect(getMarketStateET(t)).toBe('pre_open');
  });

  it('returns "pre_open" exactly at 4:00 AM ET', () => {
    const t = new Date('2026-05-01T08:00:00Z'); // 04:00 EDT
    expect(getMarketStateET(t)).toBe('pre_open');
  });

  it('returns "post_close" at 5:00 PM ET on a weekday (extended hours block)', () => {
    const t = new Date('2026-05-01T21:00:00Z'); // 17:00 EDT
    expect(getMarketStateET(t)).toBe('post_close');
  });

  it('returns "post_close" at 2:00 AM ET (overnight block treated as post_close per spec)', () => {
    const t = new Date('2026-05-01T06:00:00Z'); // 02:00 EDT
    expect(getMarketStateET(t)).toBe('post_close');
  });

  it('returns "weekend" on Saturday at noon ET', () => {
    const t = new Date('2026-05-02T16:00:00Z'); // Sat 12:00 EDT
    expect(getMarketStateET(t)).toBe('weekend');
  });

  it('returns "weekend" on Sunday at 11:00 AM ET', () => {
    const t = new Date('2026-05-03T15:00:00Z'); // Sun 11:00 EDT
    expect(getMarketStateET(t)).toBe('weekend');
  });

  it('handles EST (winter) — Mon Jan 5 2026 at 10:30 EST is intraday', () => {
    // EST = UTC-5, so 10:30 EST = 15:30 UTC
    const t = new Date('2026-01-05T15:30:00Z');
    expect(getMarketStateET(t)).toBe('intraday');
  });
});

describe('NYSE holiday handling', () => {
  it('returns "weekend" on a weekday holiday (Thanksgiving 2026, Thursday)', () => {
    // Nov 26 2026 is Thursday Thanksgiving — full closure
    const t = new Date('2026-11-26T15:30:00Z'); // 10:30 EST
    expect(isNyseHolidayET(t)).toBe(true);
    expect(getMarketStateET(t)).toBe('weekend');
  });

  it('returns "weekend" on Christmas 2026 (Friday)', () => {
    const t = new Date('2026-12-25T15:30:00Z'); // 10:30 EST
    expect(getMarketStateET(t)).toBe('weekend');
  });

  it('returns "intraday" on a normal trading day (control)', () => {
    const t = new Date('2026-11-25T15:30:00Z'); // Wed before Thanksgiving, 10:30 EST
    expect(isNyseHolidayET(t)).toBe(false);
    expect(getMarketStateET(t)).toBe('intraday');
  });
});

describe('getETDateBucket', () => {
  it('returns YYYY-MM-DD in ET (May 1 2026 at 10:30 EDT)', () => {
    const t = new Date('2026-05-01T14:30:00Z');
    expect(getETDateBucket(t)).toBe('2026-05-01');
  });

  it('does not roll the date at 11:00 PM ET (still same ET day)', () => {
    const t = new Date('2026-05-02T03:00:00Z'); // May 1 23:00 EDT
    expect(getETDateBucket(t)).toBe('2026-05-01');
  });

  it('rolls to next day at midnight ET', () => {
    const t = new Date('2026-05-02T04:00:00Z'); // May 2 00:00 EDT
    expect(getETDateBucket(t)).toBe('2026-05-02');
  });
});
