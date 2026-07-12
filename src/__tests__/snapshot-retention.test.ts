import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { runSnapshotRetention, snapshotRetentionEnabled } from '../services/snapshot-retention.service';
import { alertOnCorruption } from '../services/job-runner.service';

const raw = () => prismaMock.$executeRawUnsafe as ReturnType<typeof vi.fn>;

describe('snapshot-retention.service', () => {
  beforeEach(() => {
    raw().mockReset();
    raw().mockResolvedValue(0);
  });

  afterEach(() => {
    delete process.env.SNAPSHOT_RETENTION_ENABLED;
  });

  it('is a no-op when the flag is off', async () => {
    const res = await runSnapshotRetention();
    expect(res.skipped).toBe(true);
    expect(raw()).not.toHaveBeenCalled();
    expect(snapshotRetentionEnabled()).toBe(false);
  });

  it('runs the full prune sequence when enabled', async () => {
    process.env.SNAPSHOT_RETENTION_ENABLED = 'true';
    const res = await runSnapshotRetention();

    expect(res.skipped).toBe(false);
    const sqls = raw().mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => s.includes('DELETE FROM "PortfolioSnapshot"') && s.includes('MAX(p2."timestamp")'))).toBe(true);
    expect(sqls.some(s => s.includes('DELETE FROM "HoldingSnapshot"'))).toBe(true);
    expect(sqls.some(s => s.includes('DELETE FROM "RefreshToken"'))).toBe(true);
    expect(sqls.some(s => s.includes('DELETE FROM "BackgroundJobRun"'))).toBe(true);
    expect(sqls.some(s => s.includes('wal_checkpoint'))).toBe(true);
    // Full VACUUM must never run here (needs ~1x DB size free)
    expect(sqls.some(s => s.trim() === 'VACUUM')).toBe(false);
  });

  it('keeps deleting chunks until a partial chunk returns', async () => {
    process.env.SNAPSHOT_RETENTION_ENABLED = 'true';
    // First delete statement (PortfolioSnapshot) returns two full chunks then a partial
    raw()
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(123)
      .mockResolvedValue(0);

    const res = await runSnapshotRetention();
    expect(res.log.some(l => l.includes('PortfolioSnapshot') && l.includes('10123'))).toBe(true);
  });

  it('survives a mid-sequence failure and reports partial progress', async () => {
    process.env.SNAPSHOT_RETENTION_ENABLED = 'true';
    raw()
      .mockResolvedValueOnce(10)   // PortfolioSnapshot chunk (partial -> stop)
      .mockRejectedValueOnce(new Error('SQLITE_CORRUPT: database disk image is malformed'));

    const res = await runSnapshotRetention();
    expect(res.skipped).toBe(false);
    expect(res.log.some(l => l.includes('PortfolioSnapshot'))).toBe(true);
  });
});

describe('alertOnCorruption', () => {
  it('ignores non-corruption errors', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    alertOnCorruption('test', 'ordinary timeout');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('fires loudly on SQLITE_CORRUPT and throttles repeats', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The throttle is module-level and an earlier test already tripped it —
    // jump past the window instead of poking module internals.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    alertOnCorruption('test', 'SQLITE_CORRUPT: database disk image is malformed');
    const after = spy.mock.calls.length;
    expect(after).toBeGreaterThan(0);
    // Second call within the hour is throttled
    alertOnCorruption('test', 'SQLITE_CORRUPT: database disk image is malformed');
    expect(spy.mock.calls.length).toBe(after);
    vi.useRealTimers();
    spy.mockRestore();
  });
});
