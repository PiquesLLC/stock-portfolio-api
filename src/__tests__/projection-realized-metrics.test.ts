import { describe, it, expect } from 'vitest';
import { calculateRealizedMetrics } from '../services/projection.service';

/**
 * Regression test for F-CRIT-2: realized CAGR must NOT add dividends on top of the
 * ending snapshot value. Dividends are already reflected in the portfolio value
 * (dividend posting credits cash → folds into snapshot totalValue/netEquity; DRIP
 * adds shares). Adding totalDividends again double-counted them and inflated CAGR.
 */
describe('calculateRealizedMetrics — CAGR does not double-count dividends', () => {
  const snapshots = [
    { timestamp: new Date('2025-01-01T00:00:00.000Z'), totalValue: 10000, netEquity: 10000 },
    { timestamp: new Date('2026-01-01T00:00:00.000Z'), totalValue: 11000, netEquity: 11000 },
  ] as unknown as Parameters<typeof calculateRealizedMetrics>[0];

  it('returns the true 10% CAGR (11000/10000), not the inflated 15% (with +500 divs)', () => {
    // End value 11,000 already includes the $500 of dividends credited during the year.
    const { metrics } = calculateRealizedMetrics(snapshots, 500);
    // Old (buggy) behavior: (11000 + 500) / 10000 = 1.15 → 15% CAGR over 1 year.
    expect(metrics.cagr).toBeCloseTo(0.10, 6);
  });

  it('is identical whether or not dividends are passed (they are already in the value)', () => {
    const withDivs = calculateRealizedMetrics(snapshots, 500).metrics.cagr;
    const withoutDivs = calculateRealizedMetrics(snapshots, 0).metrics.cagr;
    expect(withDivs).toBe(withoutDivs);
  });
});

describe('calculateRealizedMetrics — drawdown guards non-positive equity (F-M-16)', () => {
  const mk = (rows: Array<[string, number]>) =>
    rows.map(([d, v]) => ({ timestamp: new Date(d), totalValue: v, netEquity: v })) as unknown as Parameters<
      typeof calculateRealizedMetrics
    >[0];

  it('computes a correct drawdown from a positive-start series', () => {
    const dd = calculateRealizedMetrics(mk([['2025-01-01', 12000], ['2025-06-01', 9000]]), 0).metrics.maxDrawdown;
    expect(dd).toBeCloseTo(-0.25, 4); // (12000 − 9000) / 12000
  });

  it('does not emit a garbage drawdown when equity starts non-positive (margin)', () => {
    const dd = calculateRealizedMetrics(mk([['2025-01-01', -500], ['2025-06-01', 8000]]), 0).metrics.maxDrawdown;
    expect(dd === null || dd === 0).toBe(true);
  });
});
