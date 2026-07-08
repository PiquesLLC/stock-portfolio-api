import { describe, it, expect } from 'vitest';
import { etDate, etDateHour, etMidnightUtc } from '../utils/date';

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
