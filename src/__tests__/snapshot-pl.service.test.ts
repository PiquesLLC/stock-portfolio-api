import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// createSnapshotIfNeeded persists getPortfolio's totalPL verbatim (covered elsewhere),
// but owns two pieces of snapshot-specific logic worth locking in: the dailyPL delta vs
// the PREVIOUS snapshot, and the >25% sudden-drop circuit-breaker that refuses to record
// an anomalous (bad-data) snapshot. getPortfolio is mocked; each test uses a fresh userId
// so the module-level in-memory fast-path/in-flight guards don't interfere.

const { getPortfolioMock } = vi.hoisted(() => ({ getPortfolioMock: vi.fn() }));

vi.mock('../services/portfolio.service', async (importOriginal) => ({
  ...(await importOriginal() as object),
  getPortfolio: getPortfolioMock,
}));

import { createSnapshotIfNeeded } from '../services/snapshot.service';

let uidCounter = 0;
const freshUser = () => `snap_user_${uidCounter++}`;

function portfolioStub(over: Record<string, unknown> = {}) {
  return {
    holdings: [{ ticker: 'AAPL', shares: 10, currentPrice: 110, currentValue: 1100, dayChange: 0, dayChangePercent: 0 }],
    options: [],
    cashBalance: 0,
    marginDebt: 0,
    holdingsValue: 1100,
    totalAssets: 1100,
    netEquity: 1100,
    totalValue: 1100,
    totalCost: 1000,
    totalPL: 100,
    totalPLPercent: 10,
    dayChange: 0,
    quotesUnavailableCount: 0,
    ...over,
  };
}

describe('createSnapshotIfNeeded — snapshot-specific math + guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const p = prismaMock as any;
    p.portfolioSnapshot = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'snap_1' }),
    };
    p.holdingSnapshot = { createMany: vi.fn().mockResolvedValue({ count: 1 }) };
  });

  it('computes dailyPL as the delta vs the previous snapshot totalValue', async () => {
    const userId = freshUser();
    (prismaMock as any).portfolioSnapshot.findFirst.mockResolvedValue({
      id: 'prev', userId, timestamp: new Date('2020-01-01'), totalValue: 1000, netEquity: 1000,
    });
    getPortfolioMock.mockResolvedValue(portfolioStub({ totalAssets: 1100, totalPL: 100, totalPLPercent: 10 }));

    const snap = await createSnapshotIfNeeded(userId);

    expect(snap).not.toBeNull();
    const data = (prismaMock as any).portfolioSnapshot.create.mock.calls[0][0].data;
    expect(data.totalValue).toBe(1100);
    expect(data.dailyPL).toBeCloseTo(100, 6);        // 1100 - 1000
    expect(data.dailyPLPercent).toBeCloseTo(10, 6);  // 100 / 1000 * 100
    expect(data.totalPL).toBe(100);                  // copied straight from getPortfolio
  });

  it('sets dailyPL = 0 when there is no previous snapshot', async () => {
    const userId = freshUser();
    (prismaMock as any).portfolioSnapshot.findFirst.mockResolvedValue(null);
    getPortfolioMock.mockResolvedValue(portfolioStub({ totalAssets: 1100 }));

    const snap = await createSnapshotIfNeeded(userId);

    expect(snap).not.toBeNull();
    const data = (prismaMock as any).portfolioSnapshot.create.mock.calls[0][0].data;
    expect(data.dailyPL).toBe(0);
    expect(data.dailyPLPercent).toBe(0);
  });

  it('skips the snapshot on a >25% sudden drop vs the previous value (bad-data circuit-breaker)', async () => {
    const userId = freshUser();
    (prismaMock as any).portfolioSnapshot.findFirst.mockResolvedValue({
      id: 'prev', userId, timestamp: new Date('2020-01-01'), totalValue: 1000, netEquity: 1000,
    });
    getPortfolioMock.mockResolvedValue(portfolioStub({ totalAssets: 700 })); // 30% drop vs 1000

    const snap = await createSnapshotIfNeeded(userId);

    expect(snap).toBeNull();
    expect((prismaMock as any).portfolioSnapshot.create).not.toHaveBeenCalled();
  });
});
