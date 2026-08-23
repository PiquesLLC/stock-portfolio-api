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
// flush() as well as captureMessage: the self-heal restart path awaits a flush
// before exiting, and a mock missing that export throws on access rather than
// failing an assertion.
vi.mock('@sentry/node', () => ({ captureMessage: sentryCaptureMock, flush: vi.fn(async () => true) }));
vi.mock('../backup.service', () => ({
  DB_PATH: '/data/nala.db',
  getLastBackupStatus: () => null,
}));
// $disconnect/$connect/initSqlitePragmas are used only by the self-heal pool
// reset, which NODE_ENV=test keeps switched off — so nothing here exercises
// them. They are mocked anyway: a missing export on a vi.mock factory throws on
// first access, so without these the first test that ever reaches that path
// would die on the mock instead of reporting what the code did.
vi.mock('../../utils/prisma', async () => ({
  default: { $queryRawUnsafe: vi.fn(), $disconnect: vi.fn(), $connect: vi.fn() },
  RESOLVED_DB_FILE: '/data/nala.db',
  initSqlitePragmas: vi.fn(),
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
    // clearAllMocks resets call history but NOT implementations, so a
    // mockReturnValue set by one test leaks into the next. Re-assert defaults.
    existsSyncMock.mockReturnValue(true);
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

  it('sets busy_timeout BEFORE taking the lock', async () => {
    // Load-bearing and easy to delete by accident: libsql's own connection
    // default is 0.0, so without this PRAGMA the probe becomes a hair-trigger
    // that fails on microseconds of ordinary contention. Ordering matters too —
    // set after BEGIN IMMEDIATE it would not apply to the acquisition.
    const { runWriteLivenessProbeOnce } = await load();
    await runWriteLivenessProbeOnce();

    const sql = executeMock.mock.calls.map((c) => String(c[0]));
    const pragmaAt = sql.findIndex((s) => /busy_timeout\s*=\s*\d+/i.test(s));
    const beginAt = sql.findIndex((s) => s.includes('BEGIN IMMEDIATE'));
    expect(pragmaAt).toBeGreaterThanOrEqual(0);
    expect(beginAt).toBeGreaterThanOrEqual(0);
    expect(pragmaAt).toBeLessThan(beginAt);
  });

  it('probes the same database file Prisma opens', async () => {
    // backup.service's DB_PATH and Prisma's resolved path diverge in dev
    // (<root>/dev.db vs <root>/prisma/dev.db). Probing the wrong file would make
    // the monitor structurally meaningless — healthy against a DB nobody uses.
    const { runWriteLivenessProbeOnce } = await load();
    await runWriteLivenessProbeOnce();
    expect(createClientMock).toHaveBeenCalledWith({ url: 'file:/data/nala.db' });
  });

  it('reports FAILURE when the database file is missing, never success', async () => {
    // createClient would CREATE an empty DB and trivially win the lock on it —
    // reporting healthy forever if the volume failed to mount.
    existsSyncMock.mockReturnValue(false);
    const { runWriteLivenessProbeOnce, getWalWatchdogState } = await load();
    await runWriteLivenessProbeOnce();

    expect(getWalWatchdogState().writeLockOk).toBe(false);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('releases the in-flight guard so the probe keeps running', async () => {
    // The dangerous failure of a re-entrancy guard is LATCHING: one slow run
    // would silently disable the probe forever. Overlap itself is currently
    // impossible (the libsql file driver is synchronous), so this asserts the
    // release rather than trying to force a race that cannot happen.
    const { runWriteLivenessProbeOnce } = await load();
    await runWriteLivenessProbeOnce();
    await runWriteLivenessProbeOnce();
    await runWriteLivenessProbeOnce();
    expect(createClientMock).toHaveBeenCalledTimes(3);
  });
});
