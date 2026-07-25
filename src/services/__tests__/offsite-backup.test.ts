// Tests for the off-site R2 shipper. This file had ZERO coverage until
// 2026-07-24, when a forced prod run revealed v2 had been failing on EVERY run
// since the service deployed — first because the upload streamed a body of
// unknown length (R2 rejects `x-amz-decoded-content-length: undefined`), then
// because pg_dump 16.6 refuses to dump the 18.4 server.
//
// v2 no longer shells out to pg_dump at all: node-postgres speaks the wire
// protocol and is version-agnostic, so the export is a gzipped NDJSON logical
// dump. These cases target the failure mode that matters for backup code — an
// artifact that looks successful but is empty, truncated, or unrestorable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';

const sendMock = vi.hoisted(() => vi.fn());
const sentryCaptureMock = vi.hoisted(() => vi.fn());
const pgConnectMock = vi.hoisted(() => vi.fn());
const pgQueryMock = vi.hoisted(() => vi.fn());
const pgEndMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const statSyncMock = vi.hoisted(() => vi.fn());
const unlinkSyncMock = vi.hoisted(() => vi.fn());
const createWriteStreamMock = vi.hoisted(() => vi.fn());
const createReadStreamMock = vi.hoisted(() => vi.fn());
const openSyncMock = vi.hoisted(() => vi.fn());
const readSyncMock = vi.hoisted(() => vi.fn());
const closeSyncMock = vi.hoisted(() => vi.fn());

vi.mock('@sentry/node', () => ({ captureMessage: sentryCaptureMock }));
vi.mock('pg', () => ({
  Client: class { connect = pgConnectMock; query = pgQueryMock; end = pgEndMock; },
}));
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

async function loadModule() {
  vi.resetModules();
  return import('../offsite-backup.service');
}

function putCalls() {
  return sendMock.mock.calls.map((c) => c[0]).filter((cmd) => cmd?.input?.Body !== undefined);
}

/** pg returns the table list first, then one SELECT per table. */
function pgReturns(tables: string[], rowsPerTable: Record<string, any[]>) {
  pgQueryMock.mockImplementation(async (sql: string) => {
    if (String(sql).includes('pg_tables')) {
      return { rows: tables.map((t) => ({ tablename: t })) };
    }
    const match = String(sql).match(/FROM "(.+)"/);
    return { rows: rowsPerTable[match?.[1] ?? ''] ?? [] };
  });
}

describe('offsite backup — v2 logical export', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_ACCESS_KEY_ID = 'akid';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';
    process.env.R2_BUCKET = 'nala-backups';
    process.env.V2_DATABASE_URL = 'postgresql://u:p@host:5432/v2db';

    // No local v1 backup dir -> shipV1ToR2 no-ops and returns true, isolating v2.
    existsSyncMock.mockImplementation((p: string) => String(p).includes('.gz'));
    createWriteStreamMock.mockImplementation(() => new PassThrough());
    createReadStreamMock.mockReturnValue(new PassThrough());
    statSyncMock.mockReturnValue({ size: 5000 });
    openSyncMock.mockReturnValue(7);
    // Valid gzip magic by default.
    readSyncMock.mockImplementation((_fd: number, buf: Buffer) => { buf[0] = 0x1f; buf[1] = 0x8b; return 2; });
    sendMock.mockResolvedValue({ Contents: [] });
    pgConnectMock.mockResolvedValue(undefined);
    pgEndMock.mockResolvedValue(undefined);
    pgReturns(['Account', 'LedgerEntry'], {
      Account: [{ id: 'a1', balance: '10.00' }],
      LedgerEntry: [{ id: 'e1', amount: '5.00' }, { id: 'e2', amount: '-5.00' }],
    });
  });

  afterEach(() => {
    for (const k of ['V2_DATABASE_URL', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
      delete process.env[k];
    }
  });

  it('uploads with a numeric ContentLength matching the file size', async () => {
    const { runOffsiteBackupOnce } = await loadModule();
    await runOffsiteBackupOnce();

    const put = putCalls()[0];
    expect(put).toBeDefined();
    // Without this R2 sends `x-amz-decoded-content-length: undefined` and rejects.
    expect(typeof put.input.ContentLength).toBe('number');
    expect(put.input.ContentLength).toBe(5000);
    expect(String(put.input.Key)).toMatch(/\.ndjson\.gz$/);
  });

  it('enumerates tables from pg_tables rather than a hardcoded list', async () => {
    // A model added to prisma-v2 must not silently go unbacked-up.
    const { runOffsiteBackupOnce } = await loadModule();
    await runOffsiteBackupOnce();

    const sql = pgQueryMock.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => s.includes('pg_tables'))).toBe(true);
    expect(sql.some((s) => s.includes('FROM "Account"'))).toBe(true);
    expect(sql.some((s) => s.includes('FROM "LedgerEntry"'))).toBe(true);
  });

  it('records table and row counts on the uploaded object', async () => {
    const { runOffsiteBackupOnce } = await loadModule();
    await runOffsiteBackupOnce();
    const put = putCalls()[0];
    expect(put.input.Metadata.tables).toBe('2');
    expect(put.input.Metadata.rows).toBe('3');
  });

  it('refuses to upload when the export has zero rows', async () => {
    // Connecting to the wrong database yields a valid-looking empty export that
    // would overwrite the previous good object under the same date-stamped key.
    pgReturns(['Account'], { Account: [] });
    const { runOffsiteBackupOnce } = await loadModule();
    await runOffsiteBackupOnce();

    expect(putCalls()).toHaveLength(0);
    expect(sentryCaptureMock).toHaveBeenCalled();
  });

  it('refuses to upload when the file is not a valid gzip stream', async () => {
    readSyncMock.mockImplementation((_fd: number, buf: Buffer) => { buf[0] = 0x00; buf[1] = 0x00; return 2; });
    const { runOffsiteBackupOnce } = await loadModule();
    await runOffsiteBackupOnce();

    expect(putCalls()).toHaveLength(0);
    expect(sentryCaptureMock).toHaveBeenCalled();
  });

  it('refuses to upload an implausibly small file', async () => {
    statSyncMock.mockReturnValue({ size: 10 });
    const { runOffsiteBackupOnce } = await loadModule();
    await runOffsiteBackupOnce();

    expect(putCalls()).toHaveLength(0);
    expect(sentryCaptureMock).toHaveBeenCalled();
  });

  it('closes the Postgres connection even when the export fails', async () => {
    pgQueryMock.mockRejectedValue(new Error('connection refused'));
    const { runOffsiteBackupOnce } = await loadModule();
    await runOffsiteBackupOnce();

    expect(pgEndMock).toHaveBeenCalled();
    expect(putCalls()).toHaveLength(0);
    expect(sentryCaptureMock).toHaveBeenCalled();
  });

  it('skips v2 silently when V2_DATABASE_URL is not configured', async () => {
    delete process.env.V2_DATABASE_URL;
    const { runOffsiteBackupOnce } = await loadModule();
    await runOffsiteBackupOnce();

    expect(pgConnectMock).not.toHaveBeenCalled();
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });
});
