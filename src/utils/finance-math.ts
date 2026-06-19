/**
 * Finance Math Utilities
 * TWR, XIRR, Beta, Correlation, and related calculations.
 */

// ============================================================================
// SHARED RISK CONSTANTS — the single source for risk-adjusted metrics so a
// portfolio's Sharpe / annualized volatility are identical on every screen.
// ============================================================================

/** Risk-free rate for ALL Sharpe ratios. The app standardizes on 0 (Sharpe =
 *  return / volatility); change here and every Sharpe across the app moves together. */
export const RISK_FREE_RATE = 0;

/** Trading days per year — the one annualization factor for volatility and return. */
export const TRADING_DAYS = 252;

// ============================================================================
// TIME-WEIGHTED RETURN (TWR)
// ============================================================================

export interface SnapshotPoint {
  date: Date;
  value: number;
}

export interface CashflowEvent {
  date: Date;
  amount: number; // positive = deposit, negative = withdrawal
}

/**
 * Calculate Time-Weighted Return (TWR) using the chain-linking method.
 * Splits the period at each cashflow event and compounds sub-period returns.
 *
 * For each sub-period between cashflows:
 *   R_i = V_end / (V_start + CF) - 1
 * TWR = product(1 + R_i) - 1
 *
 * If no cashflows, this simplifies to simple return: (V_end / V_start) - 1.
 */
export function calculateTWR(
  snapshots: SnapshotPoint[],
  cashflows: CashflowEvent[] = []
): number | null {
  if (snapshots.length < 2) return null;

  const sorted = [...snapshots].sort((a, b) => a.date.getTime() - b.date.getTime());
  const sortedCF = [...cashflows].sort((a, b) => a.date.getTime() - b.date.getTime());

  if (sorted[0].value <= 0) return null;

  // If no cashflows, simple return
  if (sortedCF.length === 0) {
    return (sorted[sorted.length - 1].value / sorted[0].value) - 1;
  }

  // Build sub-periods around cashflow dates
  let twrProduct = 1;
  let periodStartValue = sorted[0].value;
  let snapshotIdx = 1;

  for (const cf of sortedCF) {
    // Find the snapshot closest to (but not after) the cashflow date
    let valueBeforeCF = periodStartValue;
    while (snapshotIdx < sorted.length && sorted[snapshotIdx].date.getTime() <= cf.date.getTime()) {
      valueBeforeCF = sorted[snapshotIdx].value;
      snapshotIdx++;
    }

    // Sub-period return: growth from start to just before cashflow
    if (periodStartValue > 0) {
      const subReturn = valueBeforeCF / periodStartValue;
      twrProduct *= subReturn;
    }

    // New period starts with value + cashflow
    periodStartValue = valueBeforeCF + cf.amount;
    if (periodStartValue <= 0) {
      // Portfolio was fully withdrawn — break the TWR chain and restart
      // from the next valid snapshot. The $0.01 floor creates astronomical
      // returns (e.g., recovery to $1K from $0.01 = 100,000x).
      twrProduct *= valueBeforeCF / (periodStartValue - cf.amount || 1);
      // Find next snapshot with positive value
      while (snapshotIdx < sorted.length && sorted[snapshotIdx].value <= 0) snapshotIdx++;
      if (snapshotIdx < sorted.length) {
        periodStartValue = sorted[snapshotIdx].value;
        snapshotIdx++;
      } else {
        break;
      }
      continue;
    }
  }

  // Final sub-period: from last cashflow to end
  const finalValue = sorted[sorted.length - 1].value;
  if (periodStartValue > 0) {
    // Advance to find any remaining snapshots
    const subReturn = finalValue / periodStartValue;
    twrProduct *= subReturn;
  }

  return twrProduct - 1;
}

// ============================================================================
// MONEY-WEIGHTED RETURN (XIRR)
// ============================================================================

/**
 * Calculate XIRR (Extended Internal Rate of Return) using Newton-Raphson.
 * cashflows: array of {date, amount} where negative = investment, positive = return.
 * The last cashflow should be the current portfolio value (positive).
 *
 * Returns annualized rate, or null if convergence fails.
 */
export function calculateXIRR(
  cashflows: CashflowEvent[],
  guess: number = 0.1
): number | null {
  if (cashflows.length < 2) return null;

  const sorted = [...cashflows].sort((a, b) => a.date.getTime() - b.date.getTime());
  const d0 = sorted[0].date.getTime();

  // NPV function: sum of CF_i / (1+r)^(t_i/365)
  function npv(rate: number): number {
    let sum = 0;
    for (const cf of sorted) {
      const years = (cf.date.getTime() - d0) / (365.25 * 24 * 60 * 60 * 1000);
      const denom = Math.pow(1 + rate, years);
      if (denom === 0 || !isFinite(denom)) return Infinity;
      sum += cf.amount / denom;
    }
    return sum;
  }

  // Derivative of NPV
  function dnpv(rate: number): number {
    let sum = 0;
    for (const cf of sorted) {
      const years = (cf.date.getTime() - d0) / (365.25 * 24 * 60 * 60 * 1000);
      const denom = Math.pow(1 + rate, years + 1);
      if (denom === 0 || !isFinite(denom)) return Infinity;
      sum -= years * cf.amount / denom;
    }
    return sum;
  }

  let rate = guess;
  const MAX_ITER = 100;
  const TOLERANCE = 1e-7;

  for (let i = 0; i < MAX_ITER; i++) {
    const f = npv(rate);
    const df = dnpv(rate);

    if (Math.abs(f) < TOLERANCE) return rate;
    if (df === 0 || !isFinite(df)) break;

    const newRate = rate - f / df;

    // Guard against divergence
    if (!isFinite(newRate) || newRate < -0.99) break;

    rate = newRate;
  }

  // Fallback: try bisection if Newton fails — wide range for extreme performance
  let lo = -0.99;
  let hi = 10.0;
  const fLo = npv(lo);
  const fHi = npv(hi);

  if (fLo * fHi > 0) return null; // same sign, no root in range

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < TOLERANCE) return mid;
    if (fMid * npv(lo) < 0) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return (lo + hi) / 2;
}

// ============================================================================
// BETA & CORRELATION
// ============================================================================

/**
 * Calculate Pearson correlation coefficient between two return arrays.
 * Returns null if insufficient data (< 20 points).
 */
export function calculateCorrelation(
  returns1: number[],
  returns2: number[]
): number | null {
  const len = Math.min(returns1.length, returns2.length);
  if (len < 20) return null; // Need >=20 points for statistically meaningful correlation

  // Use the last `len` values from each array
  const r1 = returns1.slice(-len);
  const r2 = returns2.slice(-len);

  const mean1 = r1.reduce((a, b) => a + b, 0) / len;
  const mean2 = r2.reduce((a, b) => a + b, 0) / len;

  let numerator = 0;
  let denom1 = 0;
  let denom2 = 0;

  for (let i = 0; i < len; i++) {
    const d1 = r1[i] - mean1;
    const d2 = r2[i] - mean2;
    numerator += d1 * d2;
    denom1 += d1 * d1;
    denom2 += d2 * d2;
  }

  const denom = Math.sqrt(denom1 * denom2);
  if (denom === 0) return null;

  return numerator / denom;
}

/**
 * Calculate beta of portfolio returns vs benchmark returns.
 * Beta = Cov(Rp, Rb) / Var(Rb)
 * Returns null if insufficient data.
 */
export function calculateBeta(
  portfolioReturns: number[],
  benchmarkReturns: number[]
): number | null {
  const len = Math.min(portfolioReturns.length, benchmarkReturns.length);
  if (len < 10) return null;

  const rp = portfolioReturns.slice(-len);
  const rb = benchmarkReturns.slice(-len);

  const meanP = rp.reduce((a, b) => a + b, 0) / len;
  const meanB = rb.reduce((a, b) => a + b, 0) / len;

  let covariance = 0;
  let varianceB = 0;

  for (let i = 0; i < len; i++) {
    const dp = rp[i] - meanP;
    const db = rb[i] - meanB;
    covariance += dp * db;
    varianceB += db * db;
  }

  if (varianceB === 0) return null;

  return covariance / varianceB;
}

// ============================================================================
// ANNUALIZATION HELPERS
// ============================================================================

/**
 * Annualize a total return over a given number of calendar days.
 * Uses: (1 + totalReturn)^(365/days) - 1
 */
export function annualizeReturn(totalReturn: number, days: number): number {
  if (days <= 0) return 0;
  return Math.pow(1 + totalReturn, 365 / days) - 1;
}

/**
 * Calculate annualized volatility from daily returns.
 * Uses sqrt(252) annualization factor (trading days).
 */
export function annualizedVolatility(dailyReturns: number[]): number | null {
  if (dailyReturns.length < 10) return null;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const squaredDiffs = dailyReturns.map(r => Math.pow(r - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (dailyReturns.length - 1);

  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
}

/**
 * Sharpe ratio = (annualized return − RISK_FREE_RATE) / annualized volatility.
 * One definition shared by realized metrics, the risk forecast, and every other
 * caller, so the figure can't disagree between screens. Returns null when
 * volatility is null or <= 0 (Sharpe undefined).
 */
export function sharpeRatio(
  annualizedReturn: number | null,
  annualizedVol: number | null,
): number | null {
  if (annualizedReturn === null || annualizedVol === null) return null;
  // Reject NaN/Infinity defensively (shared math used app-wide) and undefined vol.
  if (!Number.isFinite(annualizedReturn) || !Number.isFinite(annualizedVol) || annualizedVol <= 0) return null;
  return (annualizedReturn - RISK_FREE_RATE) / annualizedVol;
}

/**
 * Calculate maximum drawdown from a value series.
 * Returns as a positive fraction (e.g., 0.15 = 15% drawdown).
 */
export function maxDrawdown(values: number[]): number {
  if (values.length < 2) return 0;

  let peak = values[0];
  if (peak <= 0) return 0; // Cannot compute drawdown from zero/negative base
  let maxDD = 0;

  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }

  return maxDD;
}

/**
 * Find best and worst single-day returns from snapshots.
 */
export function bestWorstDays(
  snapshots: SnapshotPoint[]
): { bestDay: { date: Date; returnPct: number } | null; worstDay: { date: Date; returnPct: number } | null } {
  if (snapshots.length < 2) return { bestDay: null, worstDay: null };

  const sorted = [...snapshots].sort((a, b) => a.date.getTime() - b.date.getTime());

  let bestDay: { date: Date; returnPct: number } | null = null;
  let worstDay: { date: Date; returnPct: number } | null = null;

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].value <= 0) continue;
    const ret = ((sorted[i].value - sorted[i - 1].value) / sorted[i - 1].value) * 100;

    if (!bestDay || ret > bestDay.returnPct) {
      bestDay = { date: sorted[i].date, returnPct: Math.round(ret * 100) / 100 };
    }
    if (!worstDay || ret < worstDay.returnPct) {
      worstDay = { date: sorted[i].date, returnPct: Math.round(ret * 100) / 100 };
    }
  }

  return { bestDay, worstDay };
}

/**
 * Calculate daily returns from a value series.
 */
export function dailyReturnsFromValues(values: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) {
      returns.push((values[i] - values[i - 1]) / values[i - 1]);
    }
  }
  return returns;
}

/**
 * Validate if a return is plausible (anti-cheat).
 * Returns true if the return seems suspicious.
 */
export function isSuspiciousReturn(returnPct: number, days: number): boolean {
  // Single day > 300% is impossible without corporate action
  if (days <= 1 && Math.abs(returnPct) > 300) return true;
  // Multi-period cumulative return checks
  if (days <= 30 && Math.abs(returnPct) > 500) return true;
  if (days <= 365 && Math.abs(returnPct) > 2000) return true;
  return false;
}

/**
 * Check if annualized Sharpe ratio is suspiciously high.
 */
export function isSuspiciousSharpe(
  annualReturn: number,
  annualVol: number
): boolean {
  if (annualVol <= 0) return false;
  const sharpe = annualReturn / annualVol;
  return sharpe > 5;
}
