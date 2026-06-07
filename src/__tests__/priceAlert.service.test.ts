import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { PlanLimitError } from '../utils/plan-limit.error';
import { createPriceAlert } from '../services/priceAlert.service';

// createPriceAlert is pure validation + a free-tier paywall (no market data): above/below
// require targetPrice, pct_up/pct_down require percentChange, free users are capped at 1
// alert, paid users are not, and the ticker is upper-cased on write.

describe('createPriceAlert — validation + free-tier limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const p = prismaMock as any;
    p.user = { findUnique: vi.fn().mockResolvedValue({ plan: 'free' }) };
    p.priceAlert = { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue({ id: 'pa1' }) };
  });

  it('requires targetPrice for above/below conditions', async () => {
    await expect(createPriceAlert({ ticker: 'AAPL', condition: 'above', userId: 'u1' } as any))
      .rejects.toThrow('targetPrice is required');
    expect((prismaMock as any).priceAlert.create).not.toHaveBeenCalled();
  });

  it('requires percentChange for pct_up/pct_down conditions', async () => {
    await expect(createPriceAlert({ ticker: 'AAPL', condition: 'pct_up', userId: 'u1' } as any))
      .rejects.toThrow('percentChange is required');
    expect((prismaMock as any).priceAlert.create).not.toHaveBeenCalled();
  });

  it('enforces the free-tier limit of 1 alert', async () => {
    (prismaMock as any).user.findUnique.mockResolvedValue({ plan: 'free' });
    (prismaMock as any).priceAlert.count.mockResolvedValue(1);
    await expect(createPriceAlert({ ticker: 'AAPL', condition: 'above', targetPrice: 200, userId: 'u1' } as any))
      .rejects.toBeInstanceOf(PlanLimitError);
    expect((prismaMock as any).priceAlert.create).not.toHaveBeenCalled();
  });

  it('lets a paid user exceed the free limit and upper-cases the ticker on write', async () => {
    (prismaMock as any).user.findUnique.mockResolvedValue({ plan: 'pro' });
    (prismaMock as any).priceAlert.count.mockResolvedValue(5);
    await createPriceAlert({ ticker: 'aapl', condition: 'above', targetPrice: 200, userId: 'u1' } as any);
    const data = (prismaMock as any).priceAlert.create.mock.calls[0][0].data;
    expect(data.ticker).toBe('AAPL');
    expect(data.condition).toBe('above');
    expect(data.enabled).toBe(true);
    expect(data.triggered).toBe(false);
  });
});
