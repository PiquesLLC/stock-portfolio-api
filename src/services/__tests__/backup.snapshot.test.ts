// Unit tests for the backup snapshot path rewritten after the 2026-07-14
// outage: fs.copyFileSync (event-loop-freezing 1.2GB copy) was replaced with
// VACUUM INTO on a dedicated libsql connection, and the fixed 500MB disk
// floor was replaced with a real requirement check (~DB size + margin).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryRawUnsafeMock = vi.hoisted(() => vi.fn());
const sentryCaptureMock = vi.hoisted(() => vi.fn());
const libsqlExecuteMock = vi.hoisted(() => vi.fn());
const libsqlCloseMock = vi.hoisted(() => vi.fn());
const createClientMock = vi.hoisted(() =>
  vi.fn(() => ({ execute: libsqlExecuteMock, close: libsqlCloseMock })),
);
const existsSyncMock = vi.hoisted(() => vi.fn());
const statSyncMock = vi.hoisted(() => vi.fn());
const statfsSyncMock = vi.hoisted(() => vi.fn());
const mkdirSyncMock = vi.hoisted(() => vi.fn());
const unlinkSyncMock = vi.hoisted(() => vi.fn());
const readdirSyncMock = vi.hoisted(() => vi.fn());
const copyFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/prisma', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));
vi.mock('@sentry/node', () => ({ captureMessage: sentryCaptureMock }));
vi.mock('@libsql/client', () => ({ createClient: createClientMock }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: existsSyncMock,
    statSync: statSyncMock,
    statfsSync: statfsSyncMock,
    mkdirSync: mkdirSyncMock,
    unlinkSync: unlinkSyncMock,
    readdirSync: readdirSyncMock,
    copyFileSync: copyFileSyncMock,
  };
});

import { backupDatabase, DB_PATH } from '../backup.service';

const GB = 1024 * 1024 * 1024;

describe('backupDatabase snapshot path', () => {
  // The same-day guard checks existsSync(backupPath) BEFORE the snapshot and
  // the partial-cleanup checks it AFTER a failed one — model the file as
  // "exists once a VACUUM INTO has been attempted".
  let vacuumAttempted = false;

  const setFreeBytes = (free: number) => {
    statfsSyncMock.mockReturnValue({ bsize: 4096, bavail: Math.floor(free / 4096), blocks: 1170000 });
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    queryRawUnsafeMock.mockReset();
    sentryCaptureMock.mockReset();
    libsqlExecuteMock.mockReset();
    libsqlCloseMock.mockReset();
    createClientMock.mockClear();
    existsSyncMock.mockReset();
    statSyncMock.mockReset();
    statfsSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    unlinkSyncMock.mockReset();
    readdirSyncMock.mockReset();
    copyFileSyncMock.mockReset();
    vacuumAttempted = false;

    // Default world: live DB exists (1.2GB), /data exists, backup dir exists,
    // today's backup absent, plenty of free space, snapshot + verify succeed.
    existsSyncMock.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s === DB_PATH) return true;
      if (s === '/data') return true;
      if (s.includes('backups') && s.endsWith('.db')) return vacuumAttempted;
      if (s.includes('backups')) return true; // BACKUP_DIR
      return false;
    });
    statSyncMock.mockReturnValue({ size: 1.2 * GB });
    statfsSyncMock.mockReturnValue({ bsize: 4096, bavail: 1000000, blocks: 1170000 });
    readdirSyncMock.mockReturnValue([]);
    // quick_check on the copy (verifyBackup) + post-snapshot PASSIVE drain
    libsqlExecuteMock.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.startsWith('VACUUM INTO')) vacuumAttempted = true;
      return Promise.resolve({ rows: [{ quick_check: 'ok' }] });
    });
    queryRawUnsafeMock.mockResolvedValue([{ busy: 0, log: 0, checkpointed: 0 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('snapshots via VACUUM INTO on a dedicated client (never fs.copyFileSync)', async () => {
    setFreeBytes(3 * GB);

    await backupDatabase();

    expect(copyFileSyncMock).not.toHaveBeenCalled();
    expect(createClientMock).toHaveBeenCalled();
    const vacuumCalls = libsqlExecuteMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('VACUUM INTO'),
    );
    expect(vacuumCalls).toHaveLength(1);
    expect(libsqlCloseMock).toHaveBeenCalled();
  });

  it('skips with a CRITICAL alert when free space cannot fit a snapshot', async () => {
    setFreeBytes(0.5 * GB); // < 1.2GB * 1.05 + 64MB

    await backupDatabase();

    const vacuumCalls = libsqlExecuteMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('VACUUM INTO'),
    );
    expect(vacuumCalls).toHaveLength(0);
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    expect(String(sentryCaptureMock.mock.calls[0][0])).toMatch(/daily backups are NOT running/);
  });

  it('attempts a WAL-truncate reclaim before giving up on tight space', async () => {
    // First measurement is short; after checkpointWal the space is enough.
    let call = 0;
    statfsSyncMock.mockImplementation(() => {
      call += 1;
      const free = call === 1 ? 1.0 * GB : 2.0 * GB;
      return { bsize: 4096, bavail: Math.floor(free / 4096), blocks: 1170000 };
    });

    await backupDatabase();

    // checkpointWal ran (TRUNCATE) and the snapshot proceeded
    expect(queryRawUnsafeMock).toHaveBeenCalledWith('PRAGMA wal_checkpoint(TRUNCATE)');
    const vacuumCalls = libsqlExecuteMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('VACUUM INTO'),
    );
    expect(vacuumCalls).toHaveLength(1);
  });

  it('cleans up the partial file and alerts when the snapshot fails', async () => {
    setFreeBytes(3 * GB);
    libsqlExecuteMock.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.startsWith('VACUUM INTO')) {
        vacuumAttempted = true;
        return Promise.reject(new Error('disk I/O error'));
      }
      return Promise.resolve({ rows: [{ quick_check: 'ok' }] });
    });

    await backupDatabase();

    expect(unlinkSyncMock).toHaveBeenCalled(); // partial artifact removed
    expect(sentryCaptureMock).toHaveBeenCalled();
    expect(String(sentryCaptureMock.mock.calls[0][0])).toMatch(/snapshot failed/);
  });
});
