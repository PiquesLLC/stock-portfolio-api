// Tests for the off-site R2 shipper. This file had ZERO coverage until
// 2026-07-24, when a forced prod run surfaced that v2 had been failing on every
// single run: `shipV2ToR2` piped pg_dump's stdout straight into PutObject, and
// R2 rejects the resulting `x-amz-decoded-content-length: undefined`.
//
// Its failure modes are invisible until someone attempts a restore, so the
// cases here are chosen for exactly that: a backup that LOOKS successful but
// isn't, and a shipper that silently stops running altogether.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const sendMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const sentryCaptureMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const statSyncMock = vi.hoisted(() => vi.fn());
const unlinkSyncMock = vi.hoisted(() => vi.fn());
const createWriteStreamMock = vi.hoisted(() => vi.fn());
const createReadStreamMock = vi.hoisted(() => vi.fn());
const openSyncMock = vi.hoisted(() => vi.fn());
const readSyncMock = vi.hoisted(() => vi.fn());
const closeSyncMock = vi.hoisted(() => vi.fn());

vi.mock('@sentry/node', () => ({ captureMessage: sentryCaptureMock }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = sendMock; },
  PutObjectCommand: class { constructor(public input: any) {} },
  ListObjectsV2Command: class { constructor(public input: any) {} },
  DeleteObjectCommand: class { constructor(public input: any) {} },
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: existsSyncMock,
    statSync: statSyncMock,
    unlinkSync: unlinkSyncMock,
    createWriteStream: createWriteStreamMock,
    createReadStream: createReadStreamMock,
    openSync: openSyncMock,
    readSync: readSyncMock,
    closeSync: closeSyncMock,
  };
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
}

/** Fresh module instance so the module-scope `running` latch can't leak between tests. */
async function loadModule() {
  vi.resetModules();
  return import('../offsite-backup.service');
}

function putCalls() {
  return sendMock.mock.calls
    .map((c) => c[0])
    .filter((cmd) => cmd?.input?.Body !== undefined);
}

/**
 * runOffsiteBackupOnce awaits shipV1ToR2 before it ever reaches shipV2ToR2, so
 * emitting child events immediately after calling it fires them before spawn()
 * has run and before any listener is attached. Wait for the spawn first.
 */
async function waitForSpawn(): Promise<void> {
  for (let i = 0; i < 200 && spawnMock.mock.calls.length === 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

/** Drive the fake pg_dump to completion the way the real one would. */
async function finishDump(child: FakeChild, code: number | null, signal: string | null = null) {
  await waitForSpawn();
  child.stdout.end();
  await new Promise((r) => setImmediate(r));
  child.emit('exit', code, signal);
}

describe('offsite backup — v2 pg_dump ship', () => {
  let child: FakeChild;
  let sink: PassThrough;

  beforeEach(() => {
    vi.clearAllMocks();

    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_ACCESS_KEY_ID = 'akid';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';
    process.env.R2_BUCKET = 'nala-backups';
    process.env.V2_DATABASE_URL = 'postgresql://u:p@host:5432/v2db';

    // No local v1 backup dir -> shipV1ToR2 no-ops and returns true, isolating v2.
    existsSyncMock.mockImplementation((p: string) => String(p).includes('.dump'));

    child = new FakeChild();
    spawnMock.mockReturnValue(child);

    sink = new PassThrough();
    createWriteStreamMock.mockReturnValue(sink);
    createReadStreamMock.mockReturnValue(new PassThrough());

    statSyncMock.mockReturnValue({ size: 2 * 1024 * 1024 });
    // Valid pg_dump custom-format magic.
    readSyncMock.mockImplementation((_fd: number, buf: Buffer) => {
      Buffer.from('PGDMP').copy(buf);
      return 5;
    });
    openSyncMock.mockReturnValue(7);
    sendMock.mockResolvedValue({ Contents: [] });
  });

  afterEach(() => {
    delete process.env.V2_DATABASE_URL;
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_BUCKET;
  });

  it('uploads with a numeric ContentLength matching the temp file size', async () => {
    const { runOffsiteBackupOnce } = await loadModule();
    const run = runOffsiteBackupOnce();

    await finishDump(child, 0); // pg_dump produced its output and exited cleanly
    await run;

    const put = putCalls()[0];
    expect(put).toBeDefined();
    // The whole point: without this R2 sends `x-amz-decoded-content-length: undefined`.
    expect(typeof put.input.ContentLength).toBe('number');
    expect(put.input.ContentLength).toBe(2 * 1024 * 1024);
  });

  it('resolves (does not hang) when pg_dump is killed by a signal', async () => {
    // REGRESSION GUARD. A signal-killed child reports `code === null`. An earlier
    // revision also used `null` as the "hasn't exited yet" sentinel, so this
    // promise never settled -> the module-scope `running` flag latched true ->
    // BOTH v1 and v2 backups stopped permanently, behind a console.warn.
    const { runOffsiteBackupOnce } = await loadModule();
    const run = runOffsiteBackupOnce();

    await finishDump(child, null, 'SIGKILL');

    await expect(
      Promise.race([
        run.then(() => 'settled'),
        new Promise((r) => setTimeout(() => r('HUNG'), 2000)),
      ]),
    ).resolves.toBe('settled');

    expect(putCalls()).toHaveLength(0);
  });

  it('refuses to upload an implausibly small dump and reports it', async () => {
    // pg_dump exits 0 and emits a well-formed ~1KB archive when pointed at an
    // empty or wrong database. Size alone is the only cheap tell.
    statSyncMock.mockReturnValue({ size: 900 });
    const { runOffsiteBackupOnce } = await loadModule();
    const run = runOffsiteBackupOnce();

    await finishDump(child, 0);
    await run;

    expect(putCalls()).toHaveLength(0);
    expect(sentryCaptureMock).toHaveBeenCalled();
  });

  it('refuses to upload when the archive lacks the PGDMP magic', async () => {
    readSyncMock.mockImplementation((_fd: number, buf: Buffer) => {
      Buffer.from('junk!').copy(buf);
      return 5;
    });
    const { runOffsiteBackupOnce } = await loadModule();
    const run = runOffsiteBackupOnce();

    await finishDump(child, 0);
    await run;

    expect(putCalls()).toHaveLength(0);
    expect(sentryCaptureMock).toHaveBeenCalled();
  });

  it('does not upload when pg_dump exits non-zero', async () => {
    const { runOffsiteBackupOnce } = await loadModule();
    const run = runOffsiteBackupOnce();

    await waitForSpawn();
    child.stderr.end('permission denied');
    await finishDump(child, 1);
    await run;

    expect(putCalls()).toHaveLength(0);
  });

  it('rejects a V2_DATABASE_URL with no database name instead of dumping the wrong db', async () => {
    // libpq defaults an empty PGDATABASE to the USERNAME, which yields a
    // successful-looking dump of a different (or empty) database.
    process.env.V2_DATABASE_URL = 'postgresql://u:p@host:5432';
    const { runOffsiteBackupOnce } = await loadModule();
    await runOffsiteBackupOnce();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(putCalls()).toHaveLength(0);
    expect(sentryCaptureMock).toHaveBeenCalled();
  });
});
