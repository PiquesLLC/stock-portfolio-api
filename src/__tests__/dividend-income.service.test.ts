import { describe, it, expect } from 'vitest';
import { computeForwardAnnualIncome } from '../services/dividend-income.service';

describe('computeForwardAnnualIncome (canonical forward dividend income)', () => {
  it('sums shares * forward per-share from the screener map', () => {
    const screener = new Map([
      ['AAPL', 1.0],
      ['MSFT', 3.0],
    ]);
    const r = computeForwardAnnualIncome(
      [
        { ticker: 'AAPL', shares: 10, currentPrice: 200, currentValue: 2000 },
        { ticker: 'MSFT', shares: 5, currentPrice: 400, currentValue: 2000 },
      ],
      screener,
    );
    expect(r.totalAnnualIncome).toBe(25); // 10*1 + 5*3
    expect(r.totalMonthlyIncome).toBeCloseTo(2.08, 2); // 25/12
    expect(r.byTicker.get('AAPL')?.annualIncome).toBe(10);
    expect(r.byTicker.get('AAPL')?.yieldPct).toBeCloseTo(0.5, 2); // 1/200
    expect(r.portfolioYieldPct).toBe(0.63); // 25/4000 = 0.625% -> rounded to 2dp
  });

  it('omits non-payers (no screener value, no ETF reference)', () => {
    const r = computeForwardAnnualIncome(
      [{ ticker: 'TSLA', shares: 100, currentPrice: 250, currentValue: 25000 }],
      new Map(),
    );
    expect(r.totalAnnualIncome).toBe(0);
    expect(r.byTicker.has('TSLA')).toBe(false);
    expect(r.portfolioYieldPct).toBe(0); // 0 / 25000
  });

  it('is case-insensitive on ticker and yields null without a price', () => {
    const r = computeForwardAnnualIncome(
      [{ ticker: 'aapl', shares: 10, currentPrice: 0, currentValue: 0 }],
      new Map([['AAPL', 1.0]]),
    );
    expect(r.totalAnnualIncome).toBe(10); // screener per-share applies even with no price
    expect(r.byTicker.get('AAPL')?.yieldPct).toBeNull(); // price 0
    expect(r.portfolioYieldPct).toBeNull(); // total value 0 -> null, not 0
  });

  it('yields a forward portfolio yield off market value, not a simple average of holding yields', () => {
    // A tiny-value high-yield position must NOT dominate the portfolio yield.
    const r = computeForwardAnnualIncome(
      [
        { ticker: 'HI', shares: 1, currentPrice: 1, currentValue: 1 }, // 100% yield, $1 value
        { ticker: 'LO', shares: 100, currentPrice: 100, currentValue: 10000 }, // 1% yield, $10k value
      ],
      new Map([
        ['HI', 1.0], // $1/share on a $1 stock = 100%
        ['LO', 1.0], // $1/share on a $100 stock = 1%
      ]),
    );
    // income = 1*1 + 100*1 = 101 ; value = 10001 ; yield ≈ 1.0098%  (value-weighted)
    expect(r.totalAnnualIncome).toBe(101);
    expect(r.portfolioYieldPct).toBeCloseTo(1.01, 2);
    // A simple average of the two holding yields would be ~50.5% — confirm we are NOT doing that.
    expect(r.portfolioYieldPct!).toBeLessThan(2);
  });
});
