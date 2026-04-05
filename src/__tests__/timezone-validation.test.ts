import { describe, expect, it } from 'vitest';
import { isValidTimezone } from '../controllers/social.controller';

describe('isValidTimezone', () => {
  it('accepts common IANA timezones', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('Australia/Sydney')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects garbage strings', () => {
    expect(isValidTimezone('Not/A/Zone')).toBe(false);
    expect(isValidTimezone('garbage')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('America/Nowhere')).toBe(false);
  });

  it('rejects SQL/script injection attempts', () => {
    expect(isValidTimezone("'; DROP TABLE User; --")).toBe(false);
    expect(isValidTimezone('<script>alert(1)</script>')).toBe(false);
    expect(isValidTimezone('America/New_York; DROP TABLE User')).toBe(false);
  });

  it('accepts non-canonical casing (ICU normalizes internally)', () => {
    // Intl.DateTimeFormat accepts any casing and normalizes internally.
    // The UI dropdown always provides canonical names, so this is a minor
    // UX concern only for users POSTing directly to the API.
    expect(isValidTimezone('america/new_york')).toBe(true);
    expect(isValidTimezone('EUROPE/LONDON')).toBe(true);
  });

  it('accepts the output of Intl.DateTimeFormat().resolvedOptions().timeZone', () => {
    // Whatever the current runtime reports as its zone must validate,
    // so auto-detect in the UI always round-trips cleanly.
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(isValidTimezone(detected)).toBe(true);
  });
});
