import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { deleteHolding } from '../services/portfolio.service';

/**
 * Regression tests for M-17: deleteHolding must not wipe a ticker's
 * Lot/PortfolioTrade/DividendCredit/DividendReinvestment history across the user's
 * OTHER portfolios. Single-portfolio ticker → unscoped delete (also cleans legacy
 * NULL-portfolioId rows); multi-portfolio ticker → delete scoped to THIS portfolio.
 */
describe('deleteHolding — cross-portfolio cascade guard (M-17 Step 0)', () => {
  let tx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    tx = {
      holding: { count: vi.fn(), delete: vi.fn().mockResolvedValue({}) },
      lot: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      portfolioTrade: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      dividendCredit: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      dividendReinvestment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const p = prismaMock as any;
    p.holding = {
      findFirst: vi.fn().mockResolvedValue({ id: 'h1', ticker: 'AAPL', userId: 'u1', portfolioId: 'pfA' }),
    };
    // deleteHolding runs its cascade via prisma.$transaction(cb) when db === prisma.
    p.$transaction = vi.fn(async (cb: any) => cb(tx));
  });

  it('deletes all history UNSCOPED when the ticker is in ONE portfolio', async () => {
    tx.holding.count.mockResolvedValue(1);
    await deleteHolding('AAPL', 'u1', 'pfA');
    const unscoped = { ticker: 'AAPL', userId: 'u1' };
    expect(tx.lot.deleteMany).toHaveBeenCalledWith({ where: unscoped });
    expect(tx.portfolioTrade.deleteMany).toHaveBeenCalledWith({ where: unscoped });
    expect(tx.dividendCredit.deleteMany).toHaveBeenCalledWith({ where: unscoped });
    expect(tx.dividendReinvestment.deleteMany).toHaveBeenCalledWith({ where: unscoped });
    expect(tx.holding.delete).toHaveBeenCalledTimes(1);
  });

  it('SCOPES the cascade to THIS portfolio when the ticker is in MULTIPLE portfolios', async () => {
    tx.holding.count.mockResolvedValue(2);
    await deleteHolding('AAPL', 'u1', 'pfA');
    const scoped = { ticker: 'AAPL', userId: 'u1', portfolioId: 'pfA' };
    expect(tx.lot.deleteMany).toHaveBeenCalledWith({ where: scoped });
    expect(tx.portfolioTrade.deleteMany).toHaveBeenCalledWith({ where: scoped });
    expect(tx.dividendCredit.deleteMany).toHaveBeenCalledWith({ where: scoped });
    expect(tx.dividendReinvestment.deleteMany).toHaveBeenCalledWith({ where: scoped });
    // The holding itself is still removed from its own portfolio.
    expect(tx.holding.delete).toHaveBeenCalledTimes(1);
  });
});
