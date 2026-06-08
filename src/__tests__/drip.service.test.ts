import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// reinvestDividend converts a cash dividend credit into shares: buys amount/price shares,
// debits the SAME cash that was credited (so money isn't double-counted), recomputes the
// holding's weighted-average cost, and refuses to reinvest a credit twice. Price comes from
// a local fetchCurrentPrice -> yahooGet, so we mock yahooGet to control it.

const { yahooGetMock } = vi.hoisted(() => ({ yahooGetMock: vi.fn() }));
vi.mock('../utils/yahoo-http', () => ({ yahooGet: yahooGetMock }));

import { reinvestDividend } from '../services/drip.service';

const priceResp = (price: number) => ({ data: { chart: { result: [{ meta: { regularMarketPrice: price } }] } } });

describe('reinvestDividend — DRIP cash to shares', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const p = prismaMock as any;
    p.dividendCredit = { findFirst: vi.fn() };
    p.holding = { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) };
    p.dividendReinvestment = { create: vi.fn((arg: any) => Promise.resolve({ id: 'drip1', ...arg.data })) };
    p.lot = { create: vi.fn().mockResolvedValue({}) };
    p.userSettings = { update: vi.fn().mockResolvedValue({}) };
    p.$transaction = vi.fn(async (fn: any) => fn(prismaMock));
  });

  it('buys amount/price shares, debits the credited cash, and recomputes weighted-average cost', async () => {
    (prismaMock as any).dividendCredit.findFirst.mockResolvedValue({
      id: 'dc1', userId: 'u1', ticker: 'AAPL', amountGross: 10, reinvestment: null,
    });
    (prismaMock as any).holding.findFirst.mockResolvedValue({ id: 'h1', userId: 'u1', ticker: 'AAPL', shares: 10, averageCost: 4 });
    yahooGetMock.mockResolvedValue(priceResp(5));

    const res = await reinvestDividend('dc1', 'u1');

    expect(res.sharesPurchased).toBe(2);   // 10 / 5
    expect(res.pricePerShare).toBe(5);
    expect(res.totalAmount).toBe(10);

    const drip = (prismaMock as any).dividendReinvestment.create.mock.calls[0][0].data;
    expect(drip.sharesPurchased).toBe(2);
    expect(drip.totalAmount).toBe(10);

    const holdingUpd = (prismaMock as any).holding.update.mock.calls[0][0].data;
    expect(holdingUpd.shares).toEqual({ increment: 2 });   // atomic increment (race-safe): 10 -> 12
    expect(holdingUpd.averageCost).toBe(4.17);   // round((10*4 + 10) / 12 * 100) / 100

    const lot = (prismaMock as any).lot.create.mock.calls[0][0].data;
    expect(lot).toMatchObject({ shares: 2, costPerShare: 5, totalCost: 10, source: 'drip' });

    const cash = (prismaMock as any).userSettings.update.mock.calls[0][0].data;
    expect(cash.cashBalance.decrement).toBe(10); // the credited cash is debited back out
  });

  it('refuses to reinvest a credit that was already reinvested (no double-spend)', async () => {
    (prismaMock as any).dividendCredit.findFirst.mockResolvedValue({
      id: 'dc1', userId: 'u1', ticker: 'AAPL', amountGross: 10, reinvestment: { id: 'existing_drip' },
    });
    await expect(reinvestDividend('dc1', 'u1')).rejects.toThrow('already reinvested');
    expect((prismaMock as any).$transaction).not.toHaveBeenCalled(); // never touches balances
  });

  it('throws when the dividend credit is not found', async () => {
    (prismaMock as any).dividendCredit.findFirst.mockResolvedValue(null);
    await expect(reinvestDividend('missing', 'u1')).rejects.toThrow('not found');
  });
});
