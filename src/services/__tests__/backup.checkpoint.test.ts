// Unit tests for the WAL-checkpoint branch logic in backup.service.ts.
//
// The full backup path does heavy filesystem + libsql I/O that's hard to
// mock cleanly. These tests cover the new busy=0/busy=1/null-row/throw
// paths specifically — those are the operationally load-bearing ones
// flagged by the previous reviewer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryRawUnsafeMock = vi.hoisted(() => vi.fn());
const sentryCaptureMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/prisma', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));
vi.mock('@sentry/node', () => ({ captureMessage: sentryCaptureMock }));

import { checkpointWal } from '../backup.service';

describe('checkpointWal', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    sentryCaptureMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok=true when busy=0 (fully drained)', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ busy: 0, log: 42, checkpointed: 42 }]);
    const result = await checkpointWal();
    expect(result).toEqual({ ok: true, busy: 0, log: 42, checkpointed: 42 });
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it('returns ok=false and Sentry-captures when busy=1 (partial drain)', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ busy: 1, log: 100, checkpointed: 50 }]);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await checkpointWal();
    expect(result?.ok).toBe(false);
    expect(result?.busy).toBe(1);
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    expect(sentryCaptureMock.mock.calls[0][0]).toMatch(/WAL checkpoint INCOMPLETE/);
    expect(sentryCaptureMock.mock.calls[0][1]).toMatchObject({
      level: 'error',
      tags: { component: 'backup' },
      extra: { busy: 1, log: 100, checkpointed: 50 },
    });
    consoleSpy.mockRestore();
  });

  it('returns null when PRAGMA returns no rows', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await checkpointWal();
    expect(result).toBeNull();
    consoleSpy.mockRestore();
  });

  it('returns null when underlying query throws', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('database is locked'));
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await checkpointWal();
    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('WAL checkpoint warning: database is locked'),
    );
    consoleSpy.mockRestore();
  });
});
