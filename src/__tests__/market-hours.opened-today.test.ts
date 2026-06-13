import { describe, expect, it } from 'vitest';
import { isOpenedTodayET } from '../utils/market-hours';

// BUG-002 helper: "was this position opened on the current ET calendar day?"
// Anchors day P&L at cost basis for same-day positions. Keyed to America/New_York.
describe('isOpenedTodayET', () => {
  it('is true when createdAt and now are the same ET calendar day', () => {
    const now = new Date('2026-06-12T18:00:00Z'); // 2:00 PM ET (EDT)
    const sameDay = new Date('2026-06-12T13:35:00Z'); // 9:35 AM ET
    expect(isOpenedTodayET(sameDay, now)).toBe(true);
  });

  it('is false when createdAt was a prior ET day', () => {
    const now = new Date('2026-06-12T18:00:00Z');
    const yesterday = new Date('2026-06-11T18:00:00Z');
    expect(isOpenedTodayET(yesterday, now)).toBe(false);
  });

  it('uses the ET calendar boundary, not UTC: late-UTC but same ET day counts as today', () => {
    // 2026-06-13T02:00:00Z is still 2026-06-12 (10:00 PM) in ET.
    const now = new Date('2026-06-13T02:00:00Z');
    const earlierEtSameDay = new Date('2026-06-12T20:00:00Z'); // 4:00 PM ET, June 12
    expect(isOpenedTodayET(earlierEtSameDay, now)).toBe(true);
  });

  it('a UTC instant that is "tomorrow" in UTC but "today" in ET is still today', () => {
    // now = 11:30 PM ET June 12 (= June 13 04:30 UTC); created 9:30 AM ET June 12.
    const now = new Date('2026-06-13T03:30:00Z');
    const created = new Date('2026-06-12T13:30:00Z');
    expect(isOpenedTodayET(created, now)).toBe(true);
  });

  it('returns false (safe default) for missing or invalid createdAt', () => {
    const now = new Date('2026-06-12T18:00:00Z');
    expect(isOpenedTodayET(undefined as unknown as Date, now)).toBe(false);
    expect(isOpenedTodayET(null as unknown as Date, now)).toBe(false);
    expect(isOpenedTodayET(new Date('not-a-date'), now)).toBe(false);
  });
});
