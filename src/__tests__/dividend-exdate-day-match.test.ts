import { describe, it, expect, beforeEach, vi } from 'vitest';

// Regression guard for the prod duplicate-dividend bug (measured 2026-07-24:
// 2,631 excess rows across 96 tickers, over half the table).
//
// `@@unique([ticker, exDate, amountPerShare])` compares exDate EXACTLY, but the
// Yahoo and Polygon feeds stamp different times for the same dividend — 13:30Z
// vs 14:30Z. An exact-match upsert therefore never matched the sibling row and
// silently took the `create` branch, duplicating every dual-sourced dividend.
// Matching must key on the ex-date CALENDAR DAY instead.

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../utils/prisma', () => ({
  default: { dividendEvent: { findMany: h.findMany, update: h.update, create: h.create } },
}));

import { createDividendEvent } from '../services/dividend.service';

describe('dividend upsert matches on ex-date calendar day, not exact timestamp', () => {
  beforeEach(() => {
    h.findMany.mockReset();
    h.update.mockReset().mockResolvedValue({ id: 'existing' });
    h.create.mockReset().mockResolvedValue({ id: 'new' });
  });

  const yahooRow = {
    id: 'existing',
    exDate: new Date('2024-05-10T13:30:00.000Z'), // Yahoo's stamp
    amountPerShare: 0.25,
  };

  it('updates the existing row when the same dividend arrives with a different time-of-day', async () => {
    h.findMany.mockResolvedValue([yahooRow]);

    await createDividendEvent({
      ticker: 'aapl',
      exDate: '2024-05-10T14:30:00.000Z', // Polygon's stamp — same dividend
      payDate: '2024-05-16T14:30:00.000Z',
      amountPerShare: 0.25,
    });

    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0].where).toEqual({ id: 'existing' });
  });

  it('still creates when the ex-date falls on a different calendar day', async () => {
    h.findMany.mockResolvedValue([yahooRow]);

    await createDividendEvent({
      ticker: 'AAPL',
      exDate: '2024-08-12T13:30:00.000Z',
      payDate: '2024-08-15T13:30:00.000Z',
      amountPerShare: 0.25,
    });

    expect(h.update).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('still creates when the amount differs on the same day (a genuinely distinct event)', async () => {
    h.findMany.mockResolvedValue([yahooRow]);

    await createDividendEvent({
      ticker: 'AAPL',
      exDate: '2024-05-10T14:30:00.000Z',
      payDate: '2024-05-16T14:30:00.000Z',
      amountPerShare: 1.05,
    });

    expect(h.update).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('matches a legacy INTEGER-stored row once Prisma has decoded it to a Date', async () => {
    // Pre-driver-adapter rows are epoch-ms. Prisma decodes them to a Date, so
    // day-matching in JS works on them — which is exactly why the match is done
    // after decode rather than as a SQL range predicate (SQLite orders every
    // INTEGER below every TEXT, so a SQL bound of either form skips the other).
    h.findMany.mockResolvedValue([
      { id: 'legacy', exDate: new Date(1715347800000), amountPerShare: 0.25 }, // 2024-05-10T13:30Z
    ]);

    await createDividendEvent({
      ticker: 'AAPL',
      exDate: '2024-05-10T14:30:00.000Z',
      payDate: '2024-05-16T14:30:00.000Z',
      amountPerShare: 0.25,
    });

    expect(h.create).not.toHaveBeenCalled();
    expect(h.update.mock.calls[0][0].where).toEqual({ id: 'legacy' });
  });

  it('uppercases the ticker before looking for a match', async () => {
    h.findMany.mockResolvedValue([]);

    await createDividendEvent({
      ticker: 'aapl',
      exDate: '2024-05-10T14:30:00.000Z',
      payDate: '2024-05-16T14:30:00.000Z',
      amountPerShare: 0.25,
    });

    expect(h.findMany.mock.calls[0][0].where).toEqual({ ticker: 'AAPL' });
  });
});
