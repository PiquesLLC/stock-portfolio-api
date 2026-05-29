import { describe, expect, it } from 'vitest';
import { logSafe } from '../log-safe';

describe('logSafe', () => {
  it('passes through ordinary strings unchanged', () => {
    expect(logSafe('hello')).toBe('hello');
    expect(logSafe('user_abc123')).toBe('user_abc123');
  });

  it('returns "unknown" for null/undefined', () => {
    expect(logSafe(null)).toBe('unknown');
    expect(logSafe(undefined)).toBe('unknown');
  });

  it('coerces non-strings via String()', () => {
    expect(logSafe(42)).toBe('42');
    expect(logSafe(true)).toBe('true');
    expect(logSafe({ a: 1 })).toBe('[object Object]');
  });

  it('strips newlines, carriage returns, NUL, DEL', () => {
    expect(logSafe('a\nb')).toBe('a?b');
    expect(logSafe('a\rb')).toBe('a?b');
    expect(logSafe('a\x00b')).toBe('a?b');
    expect(logSafe('a\x7fb')).toBe('a?b');
  });

  it('strips all C0 control chars (0x00-0x1f)', () => {
    for (let code = 0; code < 0x20; code++) {
      const input = `x${String.fromCharCode(code)}y`;
      expect(logSafe(input)).toBe('x?y');
    }
  });

  it('defends against log-injection attack pattern', () => {
    const malicious = 'victim\n[Admin Ledger] FAKE SUCCESS credited attacker amount=50000';
    const out = logSafe(malicious);
    expect(out).not.toContain('\n');
    expect(out).toMatch(/^victim\?\[Admin Ledger\]/);
  });

  it('truncates to default max length (128 chars)', () => {
    const long = 'a'.repeat(200);
    expect(logSafe(long)).toHaveLength(128);
  });

  it('truncates to caller-supplied max length', () => {
    expect(logSafe('abcdefgh', 4)).toBe('abcd');
  });

  it('preserves tab characters? No — they are C0 controls and must be stripped', () => {
    // Tabs would break Datadog log parsing if a downstream pipeline used
    // tab-delimited extraction. Strip them for safety.
    expect(logSafe('col1\tcol2')).toBe('col1?col2');
  });
});
