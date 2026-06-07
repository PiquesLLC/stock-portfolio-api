import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { Prisma } from '../generated/prisma/client';

// Dividend posting auto-credits real cash (UserSettings.cashBalance += amountGross) inside
// an atomic transaction guarded by a unique constraint. The money-safety properties: the
// amount is round(shares*perShare) to the cent, and a duplicate event is skipped (P2002) so
// a re-run NEVER double-credits. drip.service is mocked (cash-type events don't reinvest).

vi.mock('../services/drip.service', () => ({
  isDripEnabled: vi.fn().mockResolvedValue(false),
  reinvestDividend: vi.fn().mockResolvedValue(undefined),
}));

import { postDividendsForDate } from '../services/dividend-post.service';

const PAY_DATE = new Date('2026-06-07T12:00:00Z');

function cashEvent(over: Record<string, unknown> = {}) {
  return { id: 'evt1', ticker: 'AAPL', amountPerShare: 0.5, payDate: PAY_DATE, dividendType: 'cash', status: 'confirmed', ...over };
}

describe('postDividendsForDate — cash credit + idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const p = prismaMock as any;
    p.dividendEvent = { findMany: vi.fn().mockResolvedValue([]) };
    p.holding = { findMany: vi.fn().mockResolvedValue([]) };
    p.dividendCredit = { create: vi.fn().mockResolvedValue({ id: 'dc1' }), findFirst: vi.fn() };
    p.userSettings = { upsert: vi.fn().mockResolvedValue({}) };
    p.$transaction = vi.fn(async (fn: any) => fn(prismaMock));
  });

  it('credits cash by round(shares*perShare) and posts exactly once', async () => {
    (prismaMock as any).dividendEvent.findMany.mockResolvedValue([cashEvent()]);
    (prismaMock as any).holding.findMany.mockResolvedValue([{ userId: 'u1', ticker: 'AAPL', shares: 10 }]);

    const res = await postDividendsForDate(PAY_DATE);

    expect(res).toEqual({ posted: 1, skipped: 0 });
    const created = (prismaMock as any).dividendCredit.create.mock.calls[0][0].data;
    expect(created.amountGross).toBe(5);              // 10 * 0.50
    expect(created.dividendEventId).toBe('evt1');
    const upsert = (prismaMock as any).userSettings.upsert.mock.calls[0][0];
    expect(upsert.update.cashBalance.increment).toBe(5);
    expect(upsert.create.cashBalance).toBe(5);
  });

  it('rounds the credit to the nearest cent', async () => {
    (prismaMock as any).dividendEvent.findMany.mockResolvedValue([cashEvent({ amountPerShare: 0.125 })]);
    (prismaMock as any).holding.findMany.mockResolvedValue([{ userId: 'u1', ticker: 'AAPL', shares: 1 }]);

    await postDividendsForDate(PAY_DATE);

    const created = (prismaMock as any).dividendCredit.create.mock.calls[0][0].data;
    expect(created.amountGross).toBe(0.13);           // round(0.125 * 100) / 100
  });

  it('does NOT double-credit an already-posted dividend (P2002 → skipped, no cash increment)', async () => {
    (prismaMock as any).dividendEvent.findMany.mockResolvedValue([cashEvent()]);
    (prismaMock as any).holding.findMany.mockResolvedValue([{ userId: 'u1', ticker: 'AAPL', shares: 10 }]);
    (prismaMock as any).dividendCredit.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '7.4.2' }),
    );

    const res = await postDividendsForDate(PAY_DATE);

    expect(res).toEqual({ posted: 0, skipped: 1 });
    // The credit row threw inside the atomic tx, so the cash increment must NOT have run.
    expect((prismaMock as any).userSettings.upsert).not.toHaveBeenCalled();
  });
});
