// Regression tests for the DB write-timeout brownout breaker added after the
// 2026-07-14 outage. The load-bearing invariants:
//
//   1. A failing run-record write must NOT prevent the job body from running
//      (in the outage, backgroundJobRun.create's 5s timeout consumed every
//      attempt and no job ever executed).
//   2. Once a DB timeout is observed, telemetry writes (run records,
//      dead-letter entries, idempotency bookkeeping) stand down instead of
//      each burning another 5s timeout slot on the serialized connection.
//   3. Timeout classification recognizes the Prisma P1008 / libsql
//      SocketTimeout shapes actually seen in prod logs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backgroundJobRunCreate = vi.hoisted(() => vi.fn());
const backgroundJobRunUpdate = vi.hoisted(() => vi.fn());
const deadLetterCreate = vi.hoisted(() => vi.fn());
const idempotencyCreate = vi.hoisted(() => vi.fn());
const idempotencyUpdate = vi.hoisted(() => vi.fn());

vi.mock('../../utils/prisma', () => ({
  default: {
    backgroundJobRun: { create: backgroundJobRunCreate, update: backgroundJobRunUpdate },
    deadLetterEntry: { create: deadLetterCreate },
    jobIdempotencyKey: { create: idempotencyCreate, update: idempotencyUpdate },
  },
}));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn() }));

import {
  runJob,
  isDbTimeoutError,
  isDbBrownout,
  noteDbTimeout,
  __resetDbBrownoutForTests,
} from '../job-runner.service';

function p1008(): Error & { code: string } {
  const err = new Error(
    'Invalid `prisma.backgroundJobRun.create()` invocation:\n\nOperation has timed out',
  ) as Error & { code: string };
  err.code = 'P1008';
  return err;
}

describe('isDbTimeoutError', () => {
  it('matches the prod P1008 / SocketTimeout / busy shapes', () => {
    expect(isDbTimeoutError(p1008())).toBe(true);
    expect(isDbTimeoutError(new Error('Operation has timed out'))).toBe(true);
    expect(isDbTimeoutError(new Error('DriverAdapterError: SocketTimeout'))).toBe(true);
    expect(isDbTimeoutError(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isDbTimeoutError(new Error('No data found for ticker: CYBR'))).toBe(false);
    expect(isDbTimeoutError(new Error('rate limit exceeded'))).toBe(false);
    expect(isDbTimeoutError(null)).toBe(false);
  });
});

describe('runJob under DB brownout', () => {
  beforeEach(() => {
    __resetDbBrownoutForTests();
    backgroundJobRunCreate.mockReset();
    backgroundJobRunUpdate.mockReset();
    deadLetterCreate.mockReset();
    idempotencyCreate.mockReset();
    idempotencyUpdate.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    __resetDbBrownoutForTests();
    vi.restoreAllMocks();
  });

  it('REGRESSION: job body still runs when the run-record create times out', async () => {
    backgroundJobRunCreate.mockRejectedValue(p1008());
    const fn = vi.fn().mockResolvedValue(undefined);

    await runJob({ name: 'outage_regression', fn, maxAttempts: 1 });

    expect(fn).toHaveBeenCalledTimes(1); // the 2026-07-14 failure mode: this was 0
    expect(isDbBrownout()).toBe(true); // and the timeout tripped the breaker
  });

  it('skips all telemetry writes while browned out, but still runs the job', async () => {
    noteDbTimeout('test', 'Operation has timed out');
    expect(isDbBrownout()).toBe(true);

    const fn = vi.fn().mockResolvedValue(undefined);
    await runJob({ name: 'quiet_job', fn, maxAttempts: 1, idempotencyKey: 'k1' });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(backgroundJobRunCreate).not.toHaveBeenCalled();
    expect(backgroundJobRunUpdate).not.toHaveBeenCalled();
    expect(idempotencyCreate).not.toHaveBeenCalled();
    expect(idempotencyUpdate).not.toHaveBeenCalled();
  });

  it('skips the dead-letter write while browned out (was a doomed 5s timeout per job per tick)', async () => {
    const fn = vi.fn().mockRejectedValue(p1008()); // job body hits the timeout
    await runJob({ name: 'failing_job', fn, maxAttempts: 1 });

    expect(isDbBrownout()).toBe(true);
    expect(deadLetterCreate).not.toHaveBeenCalled();
  });

  it('writes telemetry normally when healthy', async () => {
    backgroundJobRunCreate.mockResolvedValue({ id: 'run-1' });
    backgroundJobRunUpdate.mockResolvedValue({});
    const fn = vi.fn().mockResolvedValue(undefined);

    await runJob({ name: 'healthy_job', fn, maxAttempts: 1 });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(backgroundJobRunCreate).toHaveBeenCalledTimes(1);
    expect(backgroundJobRunUpdate).toHaveBeenCalledTimes(1);
    expect(isDbBrownout()).toBe(false);
  });

  it('dead-letters normally when healthy and the job fails permanently', async () => {
    backgroundJobRunCreate.mockResolvedValue({ id: 'run-2' });
    backgroundJobRunUpdate.mockResolvedValue({});
    deadLetterCreate.mockResolvedValue({});
    const fn = vi.fn().mockRejectedValue(new Error('unauthorized'));

    await runJob({ name: 'perm_fail_job', fn, maxAttempts: 1 });

    expect(deadLetterCreate).toHaveBeenCalledTimes(1);
    expect(isDbBrownout()).toBe(false); // non-timeout failures never trip the breaker
  });
});
