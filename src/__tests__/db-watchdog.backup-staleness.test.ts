import { describe, it, expect } from 'vitest';
import { isBackupStale } from '../services/db-watchdog.service';

// The backup-staleness watchdog closes the "wedged cron" hole a failure-only
// alert can't see: a backup that never fires leaves yesterday's `ok` sidecar.
describe('isBackupStale (backup-staleness watchdog)', () => {
  const now = new Date('2026-07-24T12:00:00.000Z').getTime();
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

  it('is stale when there is no backup status at all', () => {
    expect(isBackupStale(null, now).stale).toBe(true);
  });

  it('is NOT stale for a recent successful backup', () => {
    const status = { at: hoursAgo(2), ok: true, sizeMB: 100, note: 'ok' };
    expect(isBackupStale(status, now).stale).toBe(false);
  });

  it('is stale for a successful backup older than the daily + grace window', () => {
    const status = { at: hoursAgo(30), ok: true, sizeMB: 100, note: 'ok' };
    expect(isBackupStale(status, now).stale).toBe(true);
  });

  it('is stale when the last backup FAILED even if recent', () => {
    const status = { at: hoursAgo(1), ok: false, sizeMB: null, note: 'ENOSPC' };
    expect(isBackupStale(status, now).stale).toBe(true);
  });

  it('is stale (not silently fresh) when the timestamp is unparseable', () => {
    const status = { at: 'not-a-date', ok: true, sizeMB: 100, note: 'ok' };
    expect(isBackupStale(status, now).stale).toBe(true);
  });
});
