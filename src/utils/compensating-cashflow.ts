/**
 * Compensating cash-flow for portfolio composition changes (add / remove / edit
 * a holding). Adding or removing a position makes the portfolio VALUE series
 * (snapshots) jump; that jump is a transfer of capital, not investment
 * performance, so a matching deposit/withdrawal Transaction is recorded to
 * neutralize it in the time-weighted return.
 *
 * CRITICAL: the snapshot value series moves at MARKET value
 * (getPortfolio: currentValue = shares * currentPrice), so the compensating
 * cash-flow MUST equal the change in MARKET value of the position. The prior
 * implementation used COST BASIS (shares * averageCost), which leaked the
 * position's unrealized gain/loss straight into TWR — removing an appreciated
 * position fabricated a loss equal to its unrealized gain, and onboarding an
 * already-up position fabricated a matching gain. Using market value also
 * fixes a sibling bug: a pure averageCost correction (shares unchanged) no
 * longer records a phantom deposit/withdrawal, because market value is
 * unchanged when share count is unchanged.
 *
 * Falls back to the cost-basis delta ONLY when no live price is available, so
 * the behavior is never worse than before on the missing-quote path.
 */
export interface CompensatingCashflow {
  type: 'deposit' | 'withdrawal';
  amount: number;
}

export function computeCompensatingCashflow(params: {
  oldShares: number;
  newShares: number;
  currentPrice: number | null | undefined;
  oldCostBasis: number;
  newCostBasis: number;
}): CompensatingCashflow | null {
  const { oldShares, newShares, currentPrice, oldCostBasis, newCostBasis } = params;

  const hasPrice =
    typeof currentPrice === 'number' && Number.isFinite(currentPrice) && currentPrice > 0;

  // Market-value delta is the correct offset; cost-basis delta is the fallback.
  const delta = hasPrice
    ? newShares * currentPrice - oldShares * currentPrice
    : newCostBasis - oldCostBasis;

  if (!Number.isFinite(delta) || Math.abs(delta) < 0.01) return null;

  return {
    type: delta > 0 ? 'deposit' : 'withdrawal',
    amount: Math.abs(delta),
  };
}
