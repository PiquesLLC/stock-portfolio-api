import { describe, expect, it } from 'vitest';
import { isLocalSundaySixAm, isLocalFirstSixAm, getLocalParts, resolveTimezone } from '../services/brief-scheduler.service';

describe('brief-scheduler time checks', () => {
  describe('isLocalSundaySixAm', () => {
    it('returns true at 06:00 Sunday in NY timezone', () => {
      // 2026-04-05 10:00 UTC = 2026-04-05 06:00 EDT (Sunday)
      const d = new Date('2026-04-05T10:00:00Z');
      expect(isLocalSundaySixAm('America/New_York', d)).toBe(true);
    });

    it('returns true at 06:59 Sunday (still within the hour)', () => {
      const d = new Date('2026-04-05T10:59:00Z');
      expect(isLocalSundaySixAm('America/New_York', d)).toBe(true);
    });

    it('returns false at 07:00 Sunday (past the hour)', () => {
      const d = new Date('2026-04-05T11:00:00Z');
      expect(isLocalSundaySixAm('America/New_York', d)).toBe(false);
    });

    it('returns false at 05:59 Sunday (before the hour)', () => {
      const d = new Date('2026-04-05T09:59:00Z');
      expect(isLocalSundaySixAm('America/New_York', d)).toBe(false);
    });

    it('returns false on Saturday 06:00', () => {
      // 2026-04-04 10:00 UTC = Saturday 06:00 EDT
      const d = new Date('2026-04-04T10:00:00Z');
      expect(isLocalSundaySixAm('America/New_York', d)).toBe(false);
    });

    it('is timezone-aware: same UTC moment fires for Tokyo, skips for NY', () => {
      // 2026-04-05 21:00 UTC = Monday 06:00 JST, Sunday 17:00 EDT
      // Wait — we need Sunday 06:00 in Tokyo. That's Saturday 21:00 UTC.
      const d = new Date('2026-04-04T21:00:00Z');
      // In Tokyo: Sunday 2026-04-05 06:00
      expect(isLocalSundaySixAm('Asia/Tokyo', d)).toBe(true);
      // In NY at the same UTC moment: Saturday 2026-04-04 17:00
      expect(isLocalSundaySixAm('America/New_York', d)).toBe(false);
    });
  });

  describe('isLocalFirstSixAm', () => {
    it('returns true at 06:00 on the 1st in NY timezone', () => {
      // 2026-05-01 10:00 UTC = 2026-05-01 06:00 EDT (Friday, 1st of May)
      const d = new Date('2026-05-01T10:00:00Z');
      expect(isLocalFirstSixAm('America/New_York', d)).toBe(true);
    });

    it('returns false at 06:00 on the 2nd', () => {
      const d = new Date('2026-05-02T10:00:00Z');
      expect(isLocalFirstSixAm('America/New_York', d)).toBe(false);
    });

    it('returns false at 05:00 on the 1st', () => {
      const d = new Date('2026-05-01T09:00:00Z');
      expect(isLocalFirstSixAm('America/New_York', d)).toBe(false);
    });

    it('is timezone-aware: fires on local 1st even if UTC is still the 30th', () => {
      // 2026-04-30 20:00 UTC = 2026-05-01 06:00 JST
      const d = new Date('2026-04-30T21:00:00Z');
      expect(isLocalFirstSixAm('Asia/Tokyo', d)).toBe(true);
      expect(isLocalFirstSixAm('America/New_York', d)).toBe(false);
    });
  });

  describe('resolveTimezone (invalid-TZ guard)', () => {
    it('returns the tz unchanged when valid', () => {
      expect(resolveTimezone('Europe/Paris')).toBe('Europe/Paris');
      expect(resolveTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
    });

    it('falls back to America/New_York for null/empty/garbage', () => {
      expect(resolveTimezone(null)).toBe('America/New_York');
      expect(resolveTimezone(undefined)).toBe('America/New_York');
      expect(resolveTimezone('')).toBe('America/New_York');
      expect(resolveTimezone('Not/A/Zone')).toBe('America/New_York');
    });

    it('isLocalSundaySixAm does not throw on invalid timezone', () => {
      // Prior bug: RangeError crashed the whole cycle loop before the
      // per-user try/catch could swallow it.
      expect(() => isLocalSundaySixAm('Not/A/Zone', new Date('2026-04-05T10:00:00Z'))).not.toThrow();
    });
  });

  describe('getLocalParts', () => {
    it('returns expected shape with padded hour', () => {
      const d = new Date('2026-04-05T10:00:00Z');
      const parts = getLocalParts('America/New_York', d);
      expect(parts.weekday).toBe('Sun');
      expect(parts.day).toBe('5');
      expect(parts.hour).toBe('06');
    });
  });
});
