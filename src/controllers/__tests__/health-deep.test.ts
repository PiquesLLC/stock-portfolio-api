// Tests for GET /health/deep — the DB write probe added after 2026-07-14,
// when a 4¾-hour write outage stayed invisible because the shallow /health
// (no DB touch) kept returning 200 to BetterStack.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const queryRawUnsafeMock = vi.hoisted(() => vi.fn());
const executeRawUnsafeMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/prisma', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock, $executeRawUnsafe: executeRawUnsafeMock },
}));
vi.mock('../../services/db-watchdog.service', () => ({
  getWalWatchdogState: () => ({ enabled: true, walBytes: 1024, lastCheckAt: null, lastCheckpoint: null, consecutiveLargeWal: 0 }),
}));

import { healthDeep } from '../health.controller';

function makeRes() {
  const res: Partial<Response> & { statusCode: number; body?: unknown } = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this as Response; },
    json(payload: unknown) { this.body = payload; return this as Response; },
  };
  return res as Response & { statusCode: number; body?: { status?: string; db?: { readOk: boolean; writeOk: boolean } } };
}

describe('GET /health/deep', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 ok when read and write probes succeed', async () => {
    queryRawUnsafeMock.mockResolvedValue([{ 1: 1 }]);
    executeRawUnsafeMock.mockResolvedValue(1);
    const res = makeRes();

    await healthDeep({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body?.status).toBe('ok');
    expect(res.body?.db?.readOk).toBe(true);
    expect(res.body?.db?.writeOk).toBe(true);
  });

  it('REGRESSION: returns 503 degraded when the DB write times out (2026-07-14 state)', async () => {
    queryRawUnsafeMock.mockResolvedValue([{ 1: 1 }]); // reads fine
    executeRawUnsafeMock.mockRejectedValue(
      Object.assign(new Error('Operation has timed out'), { code: 'P1008' }),
    );
    const res = makeRes();

    await healthDeep({} as Request, res);

    expect(res.statusCode).toBe(503);
    expect(res.body?.status).toBe('degraded');
    expect(res.body?.db?.readOk).toBe(true);
    expect(res.body?.db?.writeOk).toBe(false);
  });

  it('returns 503 promptly when the write probe HANGS (deadline, not a hung health check)', async () => {
    queryRawUnsafeMock.mockResolvedValue([{ 1: 1 }]);
    executeRawUnsafeMock.mockImplementation(() => new Promise(() => { /* never resolves */ }));
    const res = makeRes();

    const started = Date.now();
    await healthDeep({} as Request, res);
    const elapsed = Date.now() - started;

    expect(res.statusCode).toBe(503);
    expect(elapsed).toBeLessThan(10_000); // 3s probe deadline + slack, not a hang
  }, 15_000);

  it('returns 503 when even reads fail', async () => {
    queryRawUnsafeMock.mockRejectedValue(new Error('SQLITE_BUSY'));
    const res = makeRes();

    await healthDeep({} as Request, res);

    expect(res.statusCode).toBe(503);
    expect(res.body?.db?.readOk).toBe(false);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled(); // no write attempt on a dead read path
  });
});
