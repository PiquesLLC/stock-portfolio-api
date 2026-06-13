import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// BUG-002: getUserPortfolio is the public-profile / owner-profile twin of
// getPortfolio and independently re-derives day P&L. It must apply the SAME
// opened-today cost-basis anchor, or a profile page would contradict the
// dashboard (and poison the persisted snapshot dailyPL).

const { fetchPricesMock } = vi.hoisted(() => ({ fetchPricesMock: vi.fn() }));

vi.mock('../services/market.service', async (importOriginal) => ({
  ...(await importOriginal() as object),
  fetchPrices: fetchPricesMock,
}));

import { getUserPortfolio } from '../services/user-portfolio.service';

function equityQuote(currentPrice: number, previousClose: number) {
  return { currentPrice, previousClose, isStale: false, isRepricing: false };
}
function pricesResult(quotes: Map<string, unknown>) {
  return { quotes, staleCount: 0, repricingCount: 0, failedTickers: [], provider: 'polygon' };
}

describe('getUserPortfolio day-P&L anchor (BUG-002 profile twin)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const p = prismaMock as any;
    p.user = { findUnique: vi.fn().mockResolvedValue({ id: 'u1', settings: { cashBalance: 0, marginDebt: 0 } }) };
    p.holding = { findMany: vi.fn() };
  });

  it('anchors at cost basis for a position opened today (matches getPortfolio)', async () => {
    (prismaMock as any).holding.findMany.mockResolvedValue([
      { id: 'h1', userId: 'u1', portfolioId: 'pf_1', ticker: 'AAPL', shares: 2, averageCost: 290, holdingType: 'equity', createdAt: new Date() },
    ]);
    fetchPricesMock.mockResolvedValue(pricesResult(new Map([['AAPL', equityQuote(291.30, 295.63)]])));

    const pf = await getUserPortfolio('u1');
    const h = pf!.holdings.find((x: any) => x.ticker === 'AAPL') as any;

    expect(h.dayChange).toBeCloseTo(2.6, 6);   // 2*(291.30-290), NOT 2*(291.30-295.63)
    expect(h.dayChange).toBeGreaterThan(0);
    expect(pf!.dayChange).toBeCloseTo(2.6, 6);
  });

  it('still anchors at previousClose for a position opened before today', async () => {
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    (prismaMock as any).holding.findMany.mockResolvedValue([
      { id: 'h1', userId: 'u1', portfolioId: 'pf_1', ticker: 'AAPL', shares: 2, averageCost: 290, holdingType: 'equity', createdAt: lastMonth },
    ]);
    fetchPricesMock.mockResolvedValue(pricesResult(new Map([['AAPL', equityQuote(291.30, 295.63)]])));

    const pf = await getUserPortfolio('u1');
    const h = pf!.holdings.find((x: any) => x.ticker === 'AAPL') as any;

    expect(h.dayChange).toBeCloseTo(2 * (291.30 - 295.63), 5);
    expect(h.dayChange).toBeLessThan(0);
  });
});
