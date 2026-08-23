import { describe, expect, it } from 'vitest';
import { logSafe, redactPii } from '../utils/log-safe';

describe('logSafe', () => {
  it('strips control characters so a crafted value cannot forge a second log line', () => {
    expect(logSafe('victim\n[Admin] FAKE SUCCESS')).toBe('victim?[Admin] FAKE SUCCESS');
  });

  it('truncates and handles nullish input', () => {
    expect(logSafe('x'.repeat(300), 10)).toHaveLength(10);
    expect(logSafe(null)).toBe('unknown');
  });
});

describe('redactPii', () => {
  it('masks the email local-part but keeps the domain for triage', () => {
    expect(redactPii('send to alice.smith+tag@gmail.com failed'))
      .toBe('send to [email]@gmail.com failed');
  });

  it('masks bearer and basic credentials', () => {
    expect(redactPii('Authorization: Bearer abcdef0123456789')).toContain('Bearer [redacted]');
    expect(redactPii('Basic YWxpY2U6c2VjcmV0Cg==')).toContain('Basic [redacted]');
  });

  it('redacts camelCase secret names — the shape this codebase actually uses', () => {
    // A `\b` before the name alternation would miss all of these, because there
    // is no word boundary before `Secret`/`Key` in a camelCase identifier. The
    // config object is written in exactly this style, so an error echoing it
    // would have leaked verbatim.
    // Fixture deliberately avoids a real provider key prefix — secret scanners
    // block pushes on those patterns even when the value is obviously fake.
    expect(redactPii('stripeSecretKey=EXAMPLEnotarealkey0123456789')).not.toContain('EXAMPLEnotarealkey0123456789');
    expect(redactPii('jwtSecret: 0123456789abcdef0123')).not.toContain('0123456789abcdef0123');
    expect(redactPii('{"apiToken":"abcdef0123456789xyz"}')).not.toContain('abcdef0123456789xyz');
  });

  it('redacts snake_case and spaced assignments too', () => {
    expect(redactPii('api_key = "abcdef0123456789"')).not.toContain('abcdef0123456789');
    expect(redactPii('password: hunter2hunter2hunter2')).not.toContain('hunter2hunter2hunter2');
  });

  it('leaves opaque identifiers alone so events stay correlatable', () => {
    // The previous length-based rule redacted any long hex run, destroying the
    // Sentry trace_id used to tie an event to a Railway log line, plus git SHAs
    // and SHA-256 hashes.
    const traceId = 'a'.repeat(32);
    const commitSha = 'b'.repeat(40);
    expect(redactPii(`trace ${traceId} at ${commitSha}`)).toContain(traceId);
    expect(redactPii(`trace ${traceId} at ${commitSha}`)).toContain(commitSha);
  });

  it('bounds the work it will do on a huge attacker-supplied string', () => {
    const huge = `x@${'a'.repeat(200_000)}`;
    const out = redactPii(huge);
    expect(out.length).toBeLessThan(21_000);
    expect(out).toContain('[truncated');
  });

  it('is not fooled into leaving a real address unmasked inside noise', () => {
    const out = redactPii('err {"to":"bob@nala.test","code":500}');
    expect(out).not.toContain('bob@');
    expect(out).toContain('@nala.test');
  });
});
