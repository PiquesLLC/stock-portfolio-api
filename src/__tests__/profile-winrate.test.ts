import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';
import { computeWinRate } from '../services/profile-stats.service';

/**
 * Regression tests for F-H-4: realized win rate / profit factor must match SOLD
 * shares to their average buy cost, not compare FULL buy cost (including still-held
 * shares) against only-sold proceeds — which booked every profitable trim as a loss.
 */
describe('computeWinRate — quantity-matched realized win rate (F-H-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prismaMock as any).portfolioTrade = { findMany: vi.fn() };
  });

  function mockTrades(buys: unknown[], sells: unknown[]) {
    (prismaMock as any).portfolioTrade.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(where.type === 'sell' ? sells : buys),
    );
  }

  it('counts a profitable partial trim as a WIN, not a loss', async () => {
    // Buy 100 AAPL @ $100 ($10,000 total). Sell 10 @ $150 ($1,500). Still up big.
    mockTrades(
      [{ ticker: 'AAPL', type: 'buy', shares: 100, price: 100, date: new Date('2025-01-01') }],
      [{ ticker: 'AAPL', type: 'sell', shares: 10, price: 150, date: new Date('2025-06-01') }],
    );
    const r = await computeWinRate('u1');
    // Old (buggy): proceeds $1,500 vs FULL buy cost $10,000 → "loss" → winRate 0%.
    // Correct: the 10 sold shares cost $1,000, returned $1,500 → a WIN → 100%.
    expect(r.winRate).toBe(100);
    expect(r.tickerMatchedCost.get('AAPL')).toBeCloseTo(1000, 6);
  });

  it('counts a genuine losing sale as a loss', async () => {
    mockTrades(
      [{ ticker: 'MSFT', type: 'buy', shares: 10, price: 300, date: new Date('2025-01-01') }],
      [{ ticker: 'MSFT', type: 'sell', shares: 10, price: 250, date: new Date('2025-06-01') }],
    );
    const r = await computeWinRate('u1');
    expect(r.winRate).toBe(0);
    expect(r.tickerMatchedCost.get('MSFT')).toBeCloseTo(3000, 6);
  });

  it('returns null win rate when there are no sells', async () => {
    mockTrades([{ ticker: 'AAPL', type: 'buy', shares: 5, price: 100, date: new Date() }], []);
    const r = await computeWinRate('u1');
    expect(r.winRate).toBeNull();
    expect(r.totalTrades).toBe(0);
  });
});
