import { describe, expect, it } from 'vitest';
import { isUSMarketHoliday, isUSTradingDay } from '../utils/market-holidays';

describe('market-holidays', () => {
  it('recognizes Good Friday 2026 as a holiday', () => {
    // Apr 3 2026 at 15:00 UTC = Apr 3 11:00 AM ET
    const goodFriday = new Date('2026-04-03T15:00:00Z');
    expect(isUSMarketHoliday(goodFriday)).toBe(true);
    expect(isUSTradingDay(goodFriday)).toBe(false);
  });

  it('recognizes Thanksgiving 2026 as a holiday', () => {
    const thanksgiving = new Date('2026-11-26T15:00:00Z');
    expect(isUSMarketHoliday(thanksgiving)).toBe(true);
    expect(isUSTradingDay(thanksgiving)).toBe(false);
  });

  it('treats regular weekday as trading day', () => {
    // Tuesday Apr 7 2026 at 15:00 UTC = 11:00 AM ET
    const tuesday = new Date('2026-04-07T15:00:00Z');
    expect(isUSMarketHoliday(tuesday)).toBe(false);
    expect(isUSTradingDay(tuesday)).toBe(true);
  });

  it('treats weekend as non-trading day (not marked as holiday)', () => {
    // Saturday Apr 4 2026
    const saturday = new Date('2026-04-04T15:00:00Z');
    expect(isUSMarketHoliday(saturday)).toBe(false);
    expect(isUSTradingDay(saturday)).toBe(false);
  });

  it('handles timezone edge case: Jan 1 before midnight UTC is still NYE in ET', () => {
    // 2026-01-01T02:00:00Z = 2025-12-31T21:00:00 ET (NYE, not Jan 1 yet in ET)
    const lateNYE = new Date('2026-01-01T02:00:00Z');
    expect(isUSMarketHoliday(lateNYE)).toBe(false); // Still Dec 31 in ET
  });
});
