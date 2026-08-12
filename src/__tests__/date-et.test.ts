import { describe, it, expect } from 'vitest';
import { etDate, etDateHour, etMidnightUtc, etMinutesOfDay, isEtWeekend, previousEtDay } from '../utils/date';

// These tests pin the ET market-calendar helpers against fixed instants so
// they pass regardless of the machine's local timezone (CI runs UTC, dev
// machines may run ET or anything else).
describe('etDate', () => {
  it('rolls the calendar day on ET, not UTC', () => {
    // 2026-07-08T02:00Z is 10 PM ET on July 7 (EDT)
    expect(etDate(new Date('2026-07-08T02:00:00Z'))).toBe('2026-07-07');
    // 2026-07-08T05:00Z is 1 AM ET on July 8
    expect(etDate(new Date('2026-07-08T05:00:00Z'))).toBe('2026-07-08');
  });
});

describe('etDateHour', () => {
  it('buckets by ET hour', () => {
    expect(etDateHour(new Date('2026-07-08T02:30:00Z'))).toBe('2026-07-07 22');
    expect(etDateHour(new Date('2026-01-15T14:30:00Z'))).toBe('2026-01-15 09');
  });

  it('renders ET midnight as hour 00 (h23, never 24)', () => {
    // 04:00Z on an EDT day == 00:00 ET
    expect(etDateHour(new Date('2026-07-07T04:00:00Z'))).toBe('2026-07-07 00');
  });
});

describe('etMidnightUtc', () => {
  it('returns 04:00Z during EDT (summer)', () => {
    const mid = etMidnightUtc(new Date('2026-07-07T15:00:00Z'));
    expect(mid.toISOString()).toBe('2026-07-07T04:00:00.000Z');
  });

  it('returns 05:00Z during EST (winter)', () => {
    const mid = etMidnightUtc(new Date('2026-01-15T12:00:00Z'));
    expect(mid.toISOString()).toBe('2026-01-15T05:00:00.000Z');
  });

  it('anchors to the ET day, not the UTC day, late in the ET evening', () => {
    // 02:00Z July 8 == 10 PM ET July 7 → midnight of July 7 ET
    const mid = etMidnightUtc(new Date('2026-07-08T02:00:00Z'));
    expect(mid.toISOString()).toBe('2026-07-07T04:00:00.000Z');
  });

  it('handles the spring-forward day (midnight is still EST)', () => {
    // DST starts 2026-03-08 at 2 AM ET; midnight that day is EST (-05:00)
    const mid = etMidnightUtc(new Date('2026-03-08T18:00:00Z'));
    expect(mid.toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });

  it('handles the fall-back day (midnight is still EDT)', () => {
    // DST ends 2026-11-01 at 2 AM ET; midnight that day is EDT (-04:00)
    const mid = etMidnightUtc(new Date('2026-11-01T18:00:00Z'));
    expect(mid.toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });

  it('round-trips: the returned instant renders as 00:xx on the same ET day', () => {
    for (const iso of ['2026-02-01T23:59:00Z', '2026-06-15T03:59:00Z', '2026-12-31T05:00:00Z']) {
      const input = new Date(iso);
      const mid = etMidnightUtc(input);
      expect(etDate(mid)).toBe(etDate(input));
      expect(etDateHour(mid).endsWith(' 00')).toBe(true);
    }
  });
});

describe('etMinutesOfDay', () => {
  it('counts from ET midnight, not UTC midnight', () => {
    expect(etMinutesOfDay(new Date('2026-07-07T04:00:00Z'))).toBe(0);          // 00:00 EDT
    expect(etMinutesOfDay(new Date('2026-07-07T13:30:00Z'))).toBe(9 * 60 + 30); // 09:30 EDT — the open
    expect(etMinutesOfDay(new Date('2026-07-08T03:59:00Z'))).toBe(23 * 60 + 59); // 23:59 EDT
  });

  it('tracks the EST/EDT offset rather than a fixed one', () => {
    expect(etMinutesOfDay(new Date('2026-01-15T14:30:00Z'))).toBe(9 * 60 + 30); // EST = UTC-5
    expect(etMinutesOfDay(new Date('2026-07-15T13:30:00Z'))).toBe(9 * 60 + 30); // EDT = UTC-4
  });

  it('renders midnight as 0, never 1440', () => {
    expect(etMinutesOfDay(new Date('2026-01-15T05:00:00Z'))).toBe(0); // 00:00 EST
  });
});

describe('previousEtDay', () => {
  it('steps back one calendar day', () => {
    expect(previousEtDay('2026-08-12')).toBe('2026-08-11');
  });

  it('crosses month, year, and DST boundaries', () => {
    expect(previousEtDay('2026-08-01')).toBe('2026-07-31');
    expect(previousEtDay('2026-01-01')).toBe('2025-12-31');
    expect(previousEtDay('2026-03-09')).toBe('2026-03-08'); // day after spring-forward
    expect(previousEtDay('2026-11-02')).toBe('2026-11-01'); // day after fall-back
    expect(previousEtDay('2028-03-01')).toBe('2028-02-29'); // leap day
  });
});

describe('isEtWeekend', () => {
  it('identifies Saturday and Sunday', () => {
    expect(isEtWeekend('2026-08-15')).toBe(true);  // Saturday
    expect(isEtWeekend('2026-08-16')).toBe(true);  // Sunday
  });

  it('rejects weekdays', () => {
    expect(isEtWeekend('2026-08-14')).toBe(false); // Friday
    expect(isEtWeekend('2026-08-17')).toBe(false); // Monday
    expect(isEtWeekend('2026-08-12')).toBe(false); // Wednesday
  });
});
