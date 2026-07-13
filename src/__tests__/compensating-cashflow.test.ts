import { describe, it, expect } from 'vitest';
import { computeCompensatingCashflow } from '../utils/compensating-cashflow';

/**
 * Regression tests for F-CRIT-1: the compensating TWR cash-flow recorded when a
 * holding is added/removed/edited must equal the change in MARKET value of the
 * position (what the snapshot value series actually moves by), NOT its cost basis.
 * The old cost-basis implementation leaked unrealized P/L into TWR.
 */
describe('computeCompensatingCashflow', () => {
  it('removing an APPRECIATED position withdraws MARKET value, not cost basis', () => {
    // 10 AAPL, cost $100/sh ($1,000 basis), now $200/sh ($2,000 market). Remove it.
    const cf = computeCompensatingCashflow({
      oldShares: 10,
      newShares: 0,
      currentPrice: 200,
      oldCostBasis: 1000,
      newCostBasis: 0,
    });
    // Old (buggy) behavior recorded a $1,000 withdrawal → fabricated a -50% TWR leg.
    expect(cf).toEqual({ type: 'withdrawal', amount: 2000 });
  });

  it('adding an already-appreciated position deposits MARKET value, not cost basis', () => {
    const cf = computeCompensatingCashflow({
      oldShares: 0,
      newShares: 10,
      currentPrice: 200,
      oldCostBasis: 0,
      newCostBasis: 1000, // entered at historical cost $100/sh
    });
    expect(cf).toEqual({ type: 'deposit', amount: 2000 });
  });

  it('a pure averageCost correction (shares unchanged) records NO phantom flow', () => {
    // Old behavior recorded a $500 deposit for a cost-basis-only edit (F-CRIT-1 sibling).
    const cf = computeCompensatingCashflow({
      oldShares: 10,
      newShares: 10,
      currentPrice: 200,
      oldCostBasis: 1000,
      newCostBasis: 1500,
    });
    expect(cf).toBeNull();
  });

  it('partial reduce withdraws the MARKET value of the shares removed', () => {
    const cf = computeCompensatingCashflow({
      oldShares: 10,
      newShares: 4,
      currentPrice: 200,
      oldCostBasis: 1000,
      newCostBasis: 400,
    });
    expect(cf).toEqual({ type: 'withdrawal', amount: 1200 }); // 6 shares * $200
  });

  it('falls back to cost-basis delta when no live price is available', () => {
    const cf = computeCompensatingCashflow({
      oldShares: 10,
      newShares: 0,
      currentPrice: null,
      oldCostBasis: 1000,
      newCostBasis: 0,
    });
    expect(cf).toEqual({ type: 'withdrawal', amount: 1000 });
  });

  it('returns null for sub-cent / zero deltas', () => {
    expect(
      computeCompensatingCashflow({ oldShares: 10, newShares: 10, currentPrice: 200, oldCostBasis: 1000, newCostBasis: 1000 }),
    ).toBeNull();
    expect(
      computeCompensatingCashflow({ oldShares: 5, newShares: 5, currentPrice: 0, oldCostBasis: 500, newCostBasis: 500 }),
    ).toBeNull();
  });
});
