import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { deleteHolding } from '../services/portfolio.service';

/**
 * Regression tests for M-17 (Step 0 mitigation): deleteHolding must NOT cascade the
 * ticker's Lot/PortfolioTrade/DividendCredit/DividendReinvestment deletes when the
 * user holds the same ticker in more than one portfolio — those tables have no
 * portfolioId, so a (ticker,userId) delete wiped the OTHER portfolio's history too.
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

  it('cascades all history deletes when the ticker is in ONE portfolio', async () => {
    tx.holding.count.mockResolvedValue(1);
    await deleteHolding('AAPL', 'u1', 'pfA');
    expect(tx.lot.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.portfolioTrade.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.dividendCredit.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.dividendReinvestment.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.holding.delete).toHaveBeenCalledTimes(1);
  });

  it('SKIPS the cascade when the ticker is in MULTIPLE portfolios (no cross-portfolio wipe)', async () => {
    tx.holding.count.mockResolvedValue(2);
    await deleteHolding('AAPL', 'u1', 'pfA');
    expect(tx.lot.deleteMany).not.toHaveBeenCalled();
    expect(tx.portfolioTrade.deleteMany).not.toHaveBeenCalled();
    expect(tx.dividendCredit.deleteMany).not.toHaveBeenCalled();
    expect(tx.dividendReinvestment.deleteMany).not.toHaveBeenCalled();
    // The holding itself is still removed from its own portfolio.
    expect(tx.holding.delete).toHaveBeenCalledTimes(1);
  });
});
