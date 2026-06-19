import { describe, it, expect } from 'vitest';
import { sharpeRatio, RISK_FREE_RATE, TRADING_DAYS } from '../utils/finance-math';

// Locks the single risk-adjusted-return convention. The whole app (realized
// metrics in projection.service AND the risk forecast in insights.service) shares
// these, so a portfolio's Sharpe is identical on every screen. A regression that
// reintroduced a non-zero rf (the old projection.service used 0.02) fails here.
describe('finance-math shared risk constants & sharpeRatio', () => {
  it('standardizes the risk-free rate at 0 and trading days at 252', () => {
    expect(RISK_FREE_RATE).toBe(0);
    expect(TRADING_DAYS).toBe(252);
  });

  it('computes Sharpe as return / volatility (rf=0)', () => {
    expect(sharpeRatio(0.10, 0.20)).toBeCloseTo(0.5, 10);
    expect(sharpeRatio(0.30, 0.15)).toBeCloseTo(2.0, 10);
    // A negative return stays negative (no rf cushion).
    expect(sharpeRatio(-0.05, 0.10)).toBeCloseTo(-0.5, 10);
  });

  it('returns null when return or volatility is missing or non-positive', () => {
    expect(sharpeRatio(0.10, 0)).toBeNull();
    expect(sharpeRatio(0.10, null)).toBeNull();
    expect(sharpeRatio(null, 0.20)).toBeNull();
    expect(sharpeRatio(0.10, -0.01)).toBeNull();
  });
});
