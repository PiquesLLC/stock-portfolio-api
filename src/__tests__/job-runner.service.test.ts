import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { JobExecutionError, detectStuckJobs, healStuckJobs, runJob } from '../services/job-runner.service';

describe('job-runner throwOnFailure behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prismaMock as any).backgroundJobRun = {
      create: vi.fn().mockResolvedValue({ id: 'run-1' }),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    (prismaMock as any).deadLetterEntry = {
      create: vi.fn().mockResolvedValue({ id: 'dl-1' }),
    };
    (prismaMock as any).jobIdempotencyKey = {
      create: vi.fn().mockResolvedValue({ id: 'ik-1' }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _sum: { duplicateHits: 0 } }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
  });

  it('throws terminal failure when throwOnFailure=true', async () => {
    await expect(
      runJob({
        name: 'apple_iap_webhook_test',
        maxAttempts: 3,
        throwOnFailure: true,
        fn: async () => {
          throw new JobExecutionError('invalid signed payload', 'PERMANENT');
        },
      }),
    ).rejects.toMatchObject({
      name: 'JobExecutionError',
      category: 'PERMANENT',
      message: 'invalid signed payload',
    });

    expect((prismaMock as any).backgroundJobRun.create).toHaveBeenCalledTimes(1);
    expect((prismaMock as any).deadLetterEntry.create).toHaveBeenCalledTimes(1);
  });

  it('swallows terminal failure when throwOnFailure=false', async () => {
    await expect(
      runJob({
        name: 'heatmap_refresh_test',
        maxAttempts: 1,
        fn: async () => {
          throw new Error('provider timeout');
        },
      }),
    ).resolves.toBeUndefined();

    expect((prismaMock as any).backgroundJobRun.create).toHaveBeenCalledTimes(1);
    expect((prismaMock as any).deadLetterEntry.create).toHaveBeenCalledTimes(1);
  });

  it('skips duplicate execution when idempotency key already exists', async () => {
    (prismaMock as any).jobIdempotencyKey.create = vi.fn().mockRejectedValue({ code: 'P2002' });
    (prismaMock as any).jobIdempotencyKey.updateMany = vi.fn().mockResolvedValue({ count: 0 });

    await runJob({
      name: 'dividend_post',
      idempotencyKey: 'dividend_post:123',
      fn: async () => undefined,
    });

    expect((prismaMock as any).backgroundJobRun.create).not.toHaveBeenCalled();
    expect((prismaMock as any).jobIdempotencyKey.update).toHaveBeenCalled();
  });

  it('caps retry backoff at maxDelayMs', async () => {
    const timeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    let attempts = 0;
    await runJob({
      name: 'retry_cap_test',
      maxAttempts: 2,
      baseDelayMs: 5000,
      maxDelayMs: 2000,
      fn: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary failure');
      },
    });

    const delays = timeoutSpy.mock.calls.map(call => Number(call[1]));
    expect(delays).toContain(2000);
    timeoutSpy.mockRestore();
  });

  it('detects stuck jobs older than the requested threshold', async () => {
    const stuck = [{ id: 'run-1', jobName: 'snapshot_scheduler', status: 'running', attempt: 1, maxAttempts: 3, startedAt: new Date('2026-03-14T10:00:00.000Z') }];
    (prismaMock as any).backgroundJobRun.findMany = vi.fn().mockResolvedValue(stuck);

    const result = await detectStuckJobs(45);

    expect(result).toEqual(stuck);
    expect((prismaMock as any).backgroundJobRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'running',
        startedAt: expect.objectContaining({ lt: expect.any(Date) }),
      }),
    }));
  });

  it('heals only the detected stuck jobs', async () => {
    (prismaMock as any).backgroundJobRun.findMany = vi.fn().mockResolvedValue([
      { id: 'run-1', jobName: 'snapshot_scheduler', attempt: 1, maxAttempts: 3, startedAt: new Date('2026-03-14T10:00:00.000Z'), durationMs: null },
      { id: 'run-2', jobName: 'dividend_sync', attempt: 2, maxAttempts: 3, startedAt: new Date('2026-03-14T09:00:00.000Z'), durationMs: null },
    ]);
    (prismaMock as any).backgroundJobRun.updateMany = vi.fn().mockResolvedValue({ count: 2 });

    const healed = await healStuckJobs(30);

    expect((prismaMock as any).backgroundJobRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['run-1', 'run-2'] },
        status: 'running',
      },
      data: {
        status: 'failed',
        error: 'Stuck job healed by admin after exceeding 30 minute threshold',
        completedAt: expect.any(Date),
      },
    });
    expect(healed).toEqual([
      { id: 'run-1', jobName: 'snapshot_scheduler', action: 'marked_failed' },
      { id: 'run-2', jobName: 'dividend_sync', action: 'marked_failed' },
    ]);
  });
});
