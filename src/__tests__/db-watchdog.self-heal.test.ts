import { describe, it, expect } from 'vitest';
import { decideWriteLockAction } from '../services/db-watchdog.service';

// The write-lock self-heal ladder. Both the 2026-07-24 and 2026-08-22 wedges
// ended only when a human noticed a Sentry alert and redeployed by hand; these
// cases pin the automation that replaces that human — and, just as importantly,
// every case where it must deliberately do nothing. This code can kill
// production, so "refuses to act" is the behaviour under test as much as "acts".
describe('decideWriteLockAction (write-lock self-heal ladder)', () => {
  const base = {
    consecutiveFailures: 0,
    detail: 'SQLITE_BUSY: database is locked',
    selfHealEnabled: true,
    poolAlreadyReset: false,
    poolRearmFailed: false,
    rearmAttempts: 0,
    restartsInWindow: 0,
  };

  describe('escalation ladder', () => {
    it('does nothing while failures are below the reset threshold', () => {
      // 4 ticks ~ 4 minutes. The alert has fired at 3; healing must not pre-empt
      // the human's chance to see the incident.
      expect(decideWriteLockAction({ ...base, consecutiveFailures: 4 }).action).toBe('none');
    });

    it('resets the pool at the reset threshold', () => {
      expect(decideWriteLockAction({ ...base, consecutiveFailures: 5 }).action).toBe('reset');
    });

    it('does NOT reset twice for the same outage', () => {
      expect(decideWriteLockAction({ ...base, consecutiveFailures: 7, poolAlreadyReset: true }).action).toBe('none');
    });

    it('restarts once the reset has been tried and failures reach the restart threshold', () => {
      expect(decideWriteLockAction({ ...base, consecutiveFailures: 10, poolAlreadyReset: true }).action).toBe('restart');
    });

    it('tries the cheap fix first even when it arrives late to a long outage', () => {
      // Self-heal enabled mid-outage (or a threshold change on deploy): the pool
      // reset is untried, so it must run before anything kills the process.
      expect(decideWriteLockAction({ ...base, consecutiveFailures: 30 }).action).toBe('reset');
    });
  });

  describe('refusals', () => {
    it('never acts when self-heal is disabled, however long the outage', () => {
      const result = decideWriteLockAction({
        ...base,
        consecutiveFailures: 100,
        poolAlreadyReset: true,
        selfHealEnabled: false,
      });
      expect(result.action).toBe('none');
      expect(result.reason).toContain('disabled');
    });

    it('never restarts for a MISSING database file — no restart remounts a volume', () => {
      const result = decideWriteLockAction({
        ...base,
        consecutiveFailures: 60,
        poolAlreadyReset: true,
        detail: 'database file does not exist at /data/prod.db — volume not mounted?',
      });
      expect(result.action).toBe('none');
      expect(result.reason).toContain('remount');
    });

    // The allowlist is the guard against turning a survivable fault into an
    // indefinite crash loop. Each of these fails BEGIN IMMEDIATE permanently and
    // is unfixable by restarting; today's behaviour (degraded, still serving
    // reads, one alert an hour) is strictly better than exiting every 10 minutes.
    it.each([
      ['read-only volume', 'SQLITE_READONLY: attempt to write a readonly database'],
      ['unopenable file', 'SQLITE_CANTOPEN: unable to open database file'],
      ['full disk', 'SQLITE_FULL: database or disk is full'],
      ['corruption', 'SQLITE_CORRUPT: database disk image is malformed'],
    ])('refuses to act on %s — a restart cannot fix it', (_label, detail) => {
      const result = decideWriteLockAction({ ...base, consecutiveFailures: 40, poolAlreadyReset: true, detail });
      expect(result.action).toBe('none');
      expect(result.reason).toContain('signature');
    });

    it('stands down once the self-restart budget is spent', () => {
      // A service that reboots itself hourly forever is its own outage. Past the
      // budget this must escalate to a human rather than restart again.
      const result = decideWriteLockAction({
        ...base,
        consecutiveFailures: 10,
        poolAlreadyReset: true,
        restartsInWindow: 3,
      });
      expect(result.action).toBe('none');
      expect(result.reason).toContain('budget');
    });

    it('still restarts while the budget has room left', () => {
      const result = decideWriteLockAction({
        ...base,
        consecutiveFailures: 10,
        poolAlreadyReset: true,
        restartsInWindow: 2,
      });
      expect(result.action).toBe('restart');
    });
  });

  // A pool dropped but not brought back with its pragmas leaves writers with no
  // busy_timeout — worse than the wedge, and it outlives it. Re-arming means
  // $connect plus pragmas against a database that is by definition wedged, so
  // failing is the EXPECTED case here; escalating on the first miss would
  // collapse the ladder into "restart at 5" during the exact incident it exists
  // for, and route around the restart budget while doing it.
  describe('failed pool re-arm', () => {
    const rearmFailed = { ...base, consecutiveFailures: 6, poolAlreadyReset: true, poolRearmFailed: true };

    it('retries the re-arm rather than escalating on the first failure', () => {
      const result = decideWriteLockAction({ ...rearmFailed, rearmAttempts: 1 });
      expect(result.action).toBe('reset');
      expect(result.reason).toContain('retrying');
    });

    it('keeps retrying up to the attempt limit', () => {
      expect(decideWriteLockAction({ ...rearmFailed, rearmAttempts: 2 }).action).toBe('reset');
    });

    it('restarts once the re-arm has failed the maximum number of times', () => {
      const result = decideWriteLockAction({ ...rearmFailed, rearmAttempts: 3 });
      expect(result.action).toBe('restart');
      expect(result.reason).toContain('busy_timeout');
    });

    it('still honours the restart budget — the re-arm path must not route around it', () => {
      const result = decideWriteLockAction({ ...rearmFailed, rearmAttempts: 3, restartsInWindow: 3 });
      expect(result.action).toBe('none');
      expect(result.reason).toContain('budget');
    });

    // An un-armed pool is a property of THIS PROCESS, not of whatever the probe
    // last failed on. If the lock clears and the next failure is something the
    // ladder cannot fix, the pool is still un-armed and the escalation must not
    // be dropped on the way past the signature gate. Bounded in practice: a
    // fresh process starts armed, so this cannot become a loop — and the budget
    // caps it regardless.
    it('escalates an un-armed pool even when the current failure is not a wedge', () => {
      const result = decideWriteLockAction({
        ...rearmFailed,
        rearmAttempts: 3,
        detail: 'SQLITE_CORRUPT: database disk image is malformed',
      });
      expect(result.action).toBe('restart');
    });

    it('still refuses when the database file is missing — that outranks an un-armed pool', () => {
      // Nothing a restart does remounts a volume, so this stays a stand-down
      // even though the pool needs repairing.
      const result = decideWriteLockAction({
        ...rearmFailed,
        rearmAttempts: 3,
        detail: 'database file does not exist at /data/prod.db — volume not mounted?',
      });
      expect(result.action).toBe('none');
      expect(result.reason).toContain('remount');
    });

    it('escalates on an empty detail — the recovery path has no current probe error', () => {
      // reconcilePoolArming calls the ladder with '' after the lock recovers but
      // the pool is still un-armed.
      const result = decideWriteLockAction({ ...rearmFailed, rearmAttempts: 3, detail: '' });
      expect(result.action).toBe('restart');
    });
  });

  describe('wedge signature matching', () => {
    // SQLITE_BUSY is what the probe's own client produces and is the only one of
    // these that can reach this path today. SQLITE_LOCKED is listed separately
    // because its message is "database TABLE is locked" — it does NOT contain
    // "database is locked". SQLITE_PROTOCOL is the broken lock state a crashed
    // writer leaves behind, which is exactly what a restart cures. The Prisma and
    // adapter wordings are defensive: `detail` is built solely from the probe's
    // libsql client today, so they are guarding against that changing.
    it.each([
      'SQLITE_BUSY: database is locked',
      'SQLITE_BUSY_SNAPSHOT: database is locked',
      'SQLITE_LOCKED: database table is locked',
      'SQLITE_PROTOCOL: locking protocol',
      'Operation has timed out',
      'DriverAdapterError: SocketTimeout',
      'P1008: Operation has timed out',
    ])('recognises %s as a wedge', (detail) => {
      expect(decideWriteLockAction({ ...base, consecutiveFailures: 5, detail }).action).toBe('reset');
    });

    it('matches case-insensitively — driver wording is not a stable contract', () => {
      const result = decideWriteLockAction({ ...base, consecutiveFailures: 5, detail: 'sqlite_busy: Database Is Locked' });
      expect(result.action).toBe('reset');
    });
  });
});
