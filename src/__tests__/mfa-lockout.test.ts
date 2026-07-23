import { describe, it, expect, beforeEach } from 'vitest';
import { checkMfaLockout, recordMfaFailure, clearMfaFailures } from '../services/mfa.service';

// Regression for audit finding F-AUTH2 (2026-07-12): MFA login verification had no
// account-bound attempt ceiling. The only throttle was an IP-keyed limiter, which
// a password-known attacker defeats by rotating IPs (or a spoofed CF-Connecting-IP)
// while freely minting fresh challenges — allowing brute-force of the 6-digit code
// and full MFA bypass. This locks the per-account limiter to 5 attempts.
describe('MFA per-account lockout (F-AUTH2)', () => {
  const user = 'user-auth2-regression';
  beforeEach(() => clearMfaFailures(user));

  it('does not lock before the 5th failed attempt', () => {
    for (let i = 0; i < 4; i++) {
      recordMfaFailure(user);
      expect(checkMfaLockout(user).locked).toBe(false);
    }
  });

  it('locks the account on the 5th failed attempt with a positive Retry-After', () => {
    for (let i = 0; i < 5; i++) recordMfaFailure(user);
    const state = checkMfaLockout(user);
    expect(state.locked).toBe(true);
    expect(state.retryAfterSec).toBeGreaterThan(0);
  });

  it('a successful verification clears the counter (no lock from stale failures)', () => {
    recordMfaFailure(user);
    recordMfaFailure(user);
    clearMfaFailures(user); // simulates a successful verify
    for (let i = 0; i < 4; i++) recordMfaFailure(user);
    expect(checkMfaLockout(user).locked).toBe(false); // 4 fresh, not 6
  });

  it('an account that never failed is never locked', () => {
    expect(checkMfaLockout('user-never-seen').locked).toBe(false);
  });
});
