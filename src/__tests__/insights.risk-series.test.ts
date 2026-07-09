import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// getDailyRiskSeries is the deposit-neutral daily series feeding the health
// score's volatility/drawdown (two of the risk radar's six dims). Lock in:
// (1) deposits/withdrawals adjust the return base (a flow is not a market move),
// (2) market moves on flow days still register,
// (3) netEquity preferred over totalValue when the account has real values,
// (4) fewer than 2 daily points -> null (callers flag the dim insufficient).

const { getDailyPortfolioValuesMock } = vi.hoisted(() => ({ getDailyPortfolioValuesMock: vi.fn() }));

vi.mock('../services/snapshot.service', async (importOriginal) => ({
  ...(await importOriginal() as object),
  getDailyPortfolioValues: getDailyPortfolioValuesMock,
}));

import { getDailyRiskSeries } from '../services/insights.service';

describe('getDailyRiskSeries — deposit-neutral daily risk series', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prismaMock as any).transaction = { findMany: vi.fn().mockResolvedValue([]) };
  });

  it('a deposit does not register as a market gain', async () => {
    // Day 1: $1000. Day 2: user deposits $500, market flat -> value $1500.
    getDailyPortfolioValuesMock.mockResolvedValue([
      { date: '2026-07-01', totalValue: 1000, netEquity: null },
      { date: '2026-07-02', totalValue: 1500, netEquity: null },
    ]);
    (prismaMock as any).transaction.findMany.mockResolvedValue([
      { type: 'deposit', amount: 500, date: new Date('2026-07-02T14:00:00Z') },
    ]);

    const series = await getDailyRiskSeries('u1');
    expect(series).not.toBeNull();
    // r = 1500 / (1000 + 500) - 1 = 0 — flat, NOT +50%
    expect(series!.returns).toHaveLength(1);
    expect(series!.returns[0]).toBeCloseTo(0, 10);
    expect(series!.equityIndex[1]).toBeCloseTo(100, 10);
  });

  it('a withdrawal does not register as a crash (drawdown stays clean)', async () => {
    getDailyPortfolioValuesMock.mockResolvedValue([
      { date: '2026-07-01', totalValue: 2000, netEquity: null },
      { date: '2026-07-02', totalValue: 1000, netEquity: null },
    ]);
    (prismaMock as any).transaction.findMany.mockResolvedValue([
      { type: 'withdrawal', amount: 1000, date: new Date('2026-07-02T10:00:00Z') },
    ]);

    const series = await getDailyRiskSeries('u1');
    expect(series!.returns[0]).toBeCloseTo(0, 10);
    // Equity index never dipped -> no fabricated drawdown
    expect(Math.min(...series!.equityIndex)).toBeCloseTo(100, 10);
  });

  it('market moves on a deposit day still register', async () => {
    // Deposit $500 onto $1000, then the $1500 base gains 10% -> $1650
    getDailyPortfolioValuesMock.mockResolvedValue([
      { date: '2026-07-01', totalValue: 1000, netEquity: null },
      { date: '2026-07-02', totalValue: 1650, netEquity: null },
    ]);
    (prismaMock as any).transaction.findMany.mockResolvedValue([
      { type: 'deposit', amount: 500, date: new Date('2026-07-02T14:00:00Z') },
    ]);

    const series = await getDailyRiskSeries('u1');
    expect(series!.returns[0]).toBeCloseTo(0.1, 10);
  });

  it('prefers netEquity over totalValue when the account has real netEquity', async () => {
    getDailyPortfolioValuesMock.mockResolvedValue([
      { date: '2026-07-01', totalValue: 5000, netEquity: 1000 },
      { date: '2026-07-02', totalValue: 5000, netEquity: 1100 },
    ]);

    const series = await getDailyRiskSeries('u1');
    expect(series!.returns[0]).toBeCloseTo(0.1, 10);
  });

  it('returns null with fewer than 2 daily points', async () => {
    getDailyPortfolioValuesMock.mockResolvedValue([
      { date: '2026-07-01', totalValue: 1000, netEquity: null },
    ]);
    expect(await getDailyRiskSeries('u1')).toBeNull();
  });

  it('drops legacy null-netEquity days instead of mixing totalValue in (no fabricated margin drop)', async () => {
    // Margin user: totalValue = netEquity + $1000 marginDebt. Day 1 is a legacy
    // snapshot without netEquity. Substituting its totalValue would fabricate a
    // ~$1000 "drop" into day 2; the day must be dropped instead.
    getDailyPortfolioValuesMock.mockResolvedValue([
      { date: '2026-07-01', totalValue: 3000, netEquity: null },
      { date: '2026-07-02', totalValue: 3000, netEquity: 2000 },
      { date: '2026-07-03', totalValue: 3000, netEquity: 2000 },
    ]);

    const series = await getDailyRiskSeries('u1');
    expect(series).not.toBeNull();
    // Only the two netEquity days chain: one flat return, no fake -33% drop
    expect(series!.returns).toHaveLength(1);
    expect(series!.returns[0]).toBeCloseTo(0, 10);
    expect(series!.dates).toEqual(['2026-07-02', '2026-07-03']);
    expect(Math.min(...series!.equityIndex)).toBeCloseTo(100, 10);
  });
});
