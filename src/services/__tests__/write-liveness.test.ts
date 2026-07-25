// Tests for the write-liveness probe added after the 2026-07-25 outage, where
// prod could not write for 23 minutes and NOTHING alerted: the WAL watchdog
// early-returns whenever the WAL is small, and that outage had a 0-byte WAL for
// its entire duration. These assert the probe both stays quiet when healthy and
// actually pages when the write lock is unobtainable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());
const createClientMock = vi.hoisted(() => vi.fn(() => ({ execute: executeMock, close: closeMock })));
const sentryCaptureMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => true));
const statSyncMock = vi.hoisted(() => vi.fn(() => ({ size: 0 })));

vi.mock('@libsql/client', () => ({ createClient: createClientMock }));
vi.mock('@sentry/node', () => ({ captureMessage: sentryCaptureMock }));
vi.mock('../../utils/prisma', () => ({ default: { $queryRawUnsafe: vi.fn() } }));
vi.mock('../backup.service', () => ({
  DB_PATH: '/data/nala.db',
  getLastBackupStatus: () => null,
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: existsSyncMock, statSync: statSyncMock };
});

async function load() {
  vi.resetModules();
  return import('../db-watchdog.service');
}

/** Make BEGIN IMMEDIATE fail the way a held write lock does. */
function lockHeld() {
  executeMock.mockImplementation(async (sql: string) => {
    if (String(sql).includes('BEGIN IMMEDIATE')) throw new Error('SQLITE_BUSY: database is locked');
    return { rows: [] };
  });
}

describe('write-liveness probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({ rows: [] });
    statSyncMock.mockReturnValue({ size: 0 });
  });

  afterEach(() => vi.clearAllMocks());

  it('takes the write lock with BEGIN IMMEDIATE and releases it', async () => {
    const { runWriteLivenessProbeOnce, getWalWatchdogState } = await load();
    await runWriteLivenessProbeOnce();

    const sql = executeMock.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => s.includes('BEGIN IMMEDIATE'))).toBe(true);
    // Must not linger as a writer — releasing is what keeps the probe safe to
    // run every 60s against a single-writer database.
    expect(sql.some((s) => s.includes('ROLLBACK'))).toBe(true);
    expect(getWalWatchdogState().writeLockOk).toBe(true);
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it('uses a dedicated connection and always closes it', async () => {
    // Never the shared Prisma client: a saturated pool would make the probe
    // measure pool pressure instead of lock availability.
    const { runWriteLivenessProbeOnce } = await load();
    await runWriteLivenessProbeOnce();
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('closes the connection even when the probe fails', async () => {
    lockHeld();
    const { runWriteLivenessProbeOnce } = await load();
    await runWriteLivenessProbeOnce();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('does not page on a single failure', async () => {
    lockHeld();
    const { runWriteLivenessProbeOnce, getWalWatchdogState } = await load();
    await runWriteLivenessProbeOnce();
    expect(getWalWatchdogState().consecutiveWriteFailures).toBe(1);
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it('pages after 3 consecutive failures, with the diagnostics that identified the incident', async () => {
    lockHeld();
    statSyncMock.mockReturnValue({ size: 0 }); // the 0-byte WAL signature
    const { runWriteLivenessProbeOnce } = await load();

    await runWriteLivenessProbeOnce();
    await runWriteLivenessProbeOnce();
    expect(sentryCaptureMock).not.toHaveBeenCalled();
    await runWriteLivenessProbeOnce();

    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const [msg, opts] = sentryCaptureMock.mock.calls[0];
    expect(String(msg)).toMatch(/write lock/i);
    expect(opts.level).toBe('error');
    expect(opts.tags.component).toBe('write-liveness');
    // walBytes + uptime are exactly what let us reconstruct the 2026-07-25
    // outage after the fact; they must be on the event.
    expect(opts.extra.walBytes).toBe(0);
    expect(typeof opts.extra.processUptimeSec).toBe('number');
    expect(opts.extra.consecutiveFailures).toBe(3);
  });

  it('throttles repeat alerts during a sustained outage', async () => {
    lockHeld();
    const { runWriteLivenessProbeOnce } = await load();
    for (let i = 0; i < 8; i++) await runWriteLivenessProbeOnce();
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
  });

  it('resets the failure counter once writes recover', async () => {
    lockHeld();
    const { runWriteLivenessProbeOnce, getWalWatchdogState } = await load();
    await runWriteLivenessProbeOnce();
    await runWriteLivenessProbeOnce();
    expect(getWalWatchdogState().consecutiveWriteFailures).toBe(2);

    executeMock.mockResolvedValue({ rows: [] }); // lock released
    await runWriteLivenessProbeOnce();
    expect(getWalWatchdogState().consecutiveWriteFailures).toBe(0);
    expect(getWalWatchdogState().writeLockOk).toBe(true);
  });
});
