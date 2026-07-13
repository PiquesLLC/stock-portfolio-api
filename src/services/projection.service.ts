import {
  SP500ProjectionResponse,
  RealizedProjectionResponse,
  RealizedMetrics,
  MetricsResponse,
  LookbackPeriod,
  ProjectionHorizons,
  PortfolioSnapshot,
  PaceProjection,
  PaceWindow,
  CurrentPaceResponse,
  Portfolio,
} from '../types';
import { getPortfolio, getHoldings } from './portfolio.service';
import { getSnapshotsAfter, getAllSnapshots, reconstructPortfolioHistory } from './snapshot.service';
import { getTotalDividendsBetween } from './dividend.service';

import { config } from '../config';
import { sharpeRatio, TRADING_DAYS } from '../utils/finance-math';

// Horizon periods in years
const HORIZONS: { key: keyof ProjectionHorizons; years: number }[] = [
  { key: '6m', years: 0.5 },
  { key: '1y', years: 1 },
  { key: '5y', years: 5 },
  { key: '10y', years: 10 },
];

// Lookback periods in days
const LOOKBACK_DAYS: Record<LookbackPeriod, number | null> = {
  '1d': 1,
  '1w': 7,
  '1m': 30,
  '6m': 180,
  '1y': 365,
  'max': null, // Use all available data
};

/**
 * Calculate the start date for a given lookback period
 */
function getLookbackStartDate(lookback: LookbackPeriod): Date | null {
  const days = LOOKBACK_DAYS[lookback];
  if (days === null) return null; // 'max' means no start date filter

  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

/**
 * Project a current value forward across the standard HORIZONS using
 * monthly-compounded growth at a flat annual rate.
 *
 * With `clamp` enabled it reproduces the realized path's safety treatment:
 * non-finite results reset to currentValue (reported via `onReset`), values
 * are capped at 1000x currentValue and floored at 0. Left disabled (the
 * default) the raw compounded value is returned, matching the previous
 * unguarded SP500 / sub-portfolio behaviour exactly.
 */
function projectMonthlyCompound(
  currentValue: number,
  annualRate: number,
  opts: { clamp?: boolean; onReset?: () => void } = {},
): ProjectionHorizons {
  const monthlyRate = Math.pow(1 + annualRate, 1 / 12) - 1;
  const horizons: ProjectionHorizons = {
    '6m': { base: 0 },
    '1y': { base: 0 },
    '5y': { base: 0 },
    '10y': { base: 0 },
  };

  for (const { key, years } of HORIZONS) {
    const months = years * 12;
    let futureValue = currentValue * Math.pow(1 + monthlyRate, months);

    if (opts.clamp) {
      if (!isFinite(futureValue) || isNaN(futureValue)) {
        futureValue = currentValue;
        opts.onReset?.();
      }
      const maxMultiplier = 1000;
      if (futureValue > currentValue * maxMultiplier) {
        futureValue = currentValue * maxMultiplier;
      }
      if (futureValue < 0) {
        futureValue = 0;
      }
    }

    horizons[key] = { base: Math.round(futureValue * 100) / 100 };
  }

  return horizons;
}

/**
 * Project portfolio value using S&P 500 long-run total return
 */
export async function getSP500Projections(userId: string, portfolioId?: string): Promise<SP500ProjectionResponse> {
  const portfolio = await getPortfolio(userId, { portfolioId });
  const currentValue = portfolio.netEquity;
  const annualReturn = config.sp500CagrTotalReturn;

  // Monthly-compounded growth at the long-run S&P 500 rate (shared helper).
  const horizons = projectMonthlyCompound(currentValue, annualReturn);

  return {
    mode: 'sp500',
    asOf: new Date().toISOString(),
    currentValue,
    assumptions: {
      annualReturn,
      compounding: 'monthly',
    },
    horizons,
  };
}

/**
 * Calculate realized metrics from snapshot history
 */
export function calculateRealizedMetrics(
  snapshots: PortfolioSnapshot[],
  totalDividends: number
): { metrics: RealizedMetrics; notes: string[] } {
  const notes: string[] = [];

  if (snapshots.length < 2) {
    notes.push('Need at least 2 snapshots to calculate metrics');
    return {
      metrics: { cagr: null, volatility: null, maxDrawdown: null, sharpe: null },
      notes,
    };
  }

  // Dedupe to one value per calendar day (last snapshot of each day) so volatility and
  // drawdown are computed on DAILY returns. The snapshots are intraday; annualizing
  // intraday returns by data frequency made this screen's vol/Sharpe inconsistent with
  // every other screen. Matches the benchmark service's daily dedup + canonical √252. F-M-16.
  const dailyValueMap = new Map<string, number>();
  for (const s of snapshots) {
    dailyValueMap.set(new Date(s.timestamp).toISOString().slice(0, 10), s.netEquity ?? s.totalValue);
  }
  const values = Array.from(dailyValueMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => v);
  const startValue = values[0];
  const endValue = values[values.length - 1];

  // Calculate time span in years
  const startDate = new Date(snapshots[0].timestamp);
  const endDate = new Date(snapshots[snapshots.length - 1].timestamp);
  const daysDiff = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
  const yearsDiff = daysDiff / 365;

  // CAGR calculation: (endValue / startValue)^(1/years) - 1
  let cagr: number | null = null;
  if (startValue > 0 && yearsDiff > 0) {
    // Dividends are ALREADY reflected in endValue: dividend posting credits cash
    // (dividend-post.service) which folds into snapshot totalValue/netEquity, and
    // DRIP adds shares. Adding totalDividends again double-counted them and
    // inflated CAGR (and every projection derived from it). See F-CRIT-2.
    if (totalDividends > 0) {
      notes.push('Dividends are included in portfolio value (not added separately to CAGR)');
    }
    const totalReturn = endValue / startValue;
    if (totalReturn > 0) {
      cagr = Math.pow(totalReturn, 1 / yearsDiff) - 1;

      // Sanity check - cap at reasonable bounds
      if (cagr > 10) {
        notes.push('CAGR capped at 1000% due to extreme value');
        cagr = 10;
      } else if (cagr < -0.99) {
        notes.push('CAGR floored at -99% due to extreme value');
        cagr = -0.99;
      }

      cagr = Math.round(cagr * 10000) / 10000;
    }
  }

  // Calculate period returns for volatility
  const periodReturns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) {
      const ret = (values[i] - values[i - 1]) / values[i - 1];
      // Clamp extreme single-period returns
      periodReturns.push(Math.max(-0.5, Math.min(0.5, ret)));
    }
  }

  // Volatility: stddev of DAILY returns annualized by √252 (canonical) — consistent with
  // the benchmark service and finance-math.annualizedVolatility. F-M-16.
  let volatility: number | null = null;
  if (periodReturns.length >= 2) {
    const meanReturn = periodReturns.reduce((a, b) => a + b, 0) / periodReturns.length;
    const squaredDiffs = periodReturns.map((r) => Math.pow(r - meanReturn, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (periodReturns.length - 1);
    const stddev = Math.sqrt(variance);

    volatility = stddev * Math.sqrt(TRADING_DAYS);

    // Cap volatility at reasonable max
    if (volatility > 5) {
      notes.push('Volatility capped at 500%');
      volatility = 5;
    }

    volatility = Math.round(volatility * 10000) / 10000;
  } else {
    notes.push('Need more data points for volatility calculation');
  }

  // Max Drawdown: largest peak-to-trough decline
  let maxDrawdown: number | null = null;
  if (values.length >= 2 && values[0] > 0) {
    let peak = values[0];
    let maxDD = 0;

    for (const value of values) {
      if (value > peak) {
        peak = value;
      }
      // Guard peak > 0: netEquity can go non-positive under margin, and dividing by a
      // non-positive peak produced out-of-range drawdowns (e.g. −150%). F-M-16.
      if (peak > 0) {
        const drawdown = (peak - value) / peak;
        if (drawdown > maxDD) {
          maxDD = drawdown;
        }
      }
    }

    maxDrawdown = -Math.round(maxDD * 10000) / 10000; // Negative to show as loss
  }

  // Sharpe Ratio — canonical rf=0 definition shared with the risk forecast.
  // (Previously subtracted config.riskFreeRate=0.02, which disagreed with the
  // risk-forecast Sharpe's rf=0 and produced a different number for the same data.)
  let sharpe = sharpeRatio(cagr, volatility);
  if (sharpe !== null) sharpe = Math.round(sharpe * 100) / 100;

  return { metrics: { cagr, volatility, maxDrawdown, sharpe }, notes };
}

/**
 * Determine the best available lookback period given the data
 */
function getBestAvailableLookback(
  snapshots: PortfolioSnapshot[],
  requested: LookbackPeriod
): LookbackPeriod {
  if (snapshots.length === 0) return requested;

  const oldestDate = new Date(snapshots[0].timestamp);
  const now = new Date();
  const availableDays = (now.getTime() - oldestDate.getTime()) / (1000 * 60 * 60 * 24);

  const requestedDays = LOOKBACK_DAYS[requested];

  // If 'max' or we have enough data, use requested
  if (requestedDays === null || availableDays >= requestedDays) {
    return requested;
  }

  // Otherwise find the best available
  const periods: LookbackPeriod[] = ['1y', '6m', '1m', '1w', '1d'];
  for (const period of periods) {
    const days = LOOKBACK_DAYS[period];
    if (days !== null && availableDays >= days) {
      return period;
    }
  }

  return '1d'; // Fallback to shortest period
}

/**
 * Get realized projections based on portfolio history
 */
export async function getRealizedProjections(
  userId: string,
  lookback: LookbackPeriod = '1y',
  portfolioId?: string,
): Promise<RealizedProjectionResponse> {
  const portfolio = await getPortfolio(userId, { portfolioId });
  const currentValue = portfolio.netEquity;

  // When portfolioId is provided, snapshots are user-wide and can't be scoped.
  // Fall back to SP500-based projections using current portfolio value only,
  // to avoid mixing scoped current data with unscoped historical data.
  if (portfolioId) {
    const annualReturn = config.sp500CagrTotalReturn;
    const notes: string[] = ['Sub-portfolio: using SP500 projections (historical snapshots are user-wide)'];
    const horizons = projectMonthlyCompound(currentValue, annualReturn);

    return {
      mode: 'realized',
      lookback,
      lookbackUsed: lookback,
      asOf: new Date().toISOString(),
      currentValue,
      realized: { cagr: null, volatility: null, maxDrawdown: null, sharpe: null },
      horizons,
      notes,
      snapshotCount: 0,
      dataStartDate: null,
      dataEndDate: null,
    };
  }

  const allSnapshots = await getAllSnapshots(userId);

  // Determine what lookback to actually use
  const lookbackUsed = getBestAvailableLookback(allSnapshots, lookback);
  const startDate = getLookbackStartDate(lookbackUsed);

  // Filter snapshots to lookback period
  const snapshots = startDate
    ? allSnapshots.filter((s) => new Date(s.timestamp) >= startDate)
    : allSnapshots;

  // Get dividends in the period
  const dividendStartDate = startDate || (allSnapshots.length > 0 ? new Date(allSnapshots[0].timestamp) : new Date());
  const totalDividends = await getTotalDividendsBetween(userId, dividendStartDate, new Date());

  // Calculate metrics
  const { metrics: realized, notes } = calculateRealizedMetrics(snapshots, totalDividends);

  // Build projections using realized CAGR (or 0 if unavailable), with the same
  // safety clamps as before (non-finite resets to current, cap 1000x, floor 0).
  const projectionRate = realized.cagr ?? 0;
  const horizons = projectMonthlyCompound(currentValue, projectionRate, {
    clamp: true,
    onReset: () => {
      if (!notes.includes('Some projections reset to current value due to calculation issues')) {
        notes.push('Some projections reset to current value due to calculation issues');
      }
    },
  });

  if (lookbackUsed !== lookback) {
    notes.push(`Requested ${lookback} lookback not available, used ${lookbackUsed} instead`);
  }

  return {
    mode: 'realized',
    lookback,
    lookbackUsed,
    asOf: new Date().toISOString(),
    currentValue,
    realized,
    horizons,
    notes,
    snapshotCount: snapshots.length,
    dataStartDate: snapshots.length > 0 ? snapshots[0].timestamp.toISOString() : null,
    dataEndDate: snapshots.length > 0 ? snapshots[snapshots.length - 1].timestamp.toISOString() : null,
  };
}

/**
 * Get metrics only (without projections)
 */
export async function getMetrics(userId: string, lookback: LookbackPeriod = '1y', portfolioId?: string): Promise<MetricsResponse> {
  const portfolio = await getPortfolio(userId, { portfolioId });
  const currentValue = portfolio.netEquity;

  // When portfolioId is provided, snapshots are user-wide and can't be scoped.
  // Return empty metrics to avoid mixing scoped current data with unscoped history.
  if (portfolioId) {
    return {
      lookback,
      lookbackUsed: lookback,
      asOf: new Date().toISOString(),
      currentValue,
      metrics: { cagr: null, volatility: null, maxDrawdown: null, sharpe: null },
      notes: ['Sub-portfolio: historical metrics unavailable (snapshots are user-wide)'],
      snapshotCount: 0,
      dataStartDate: null,
      dataEndDate: null,
    };
  }

  const allSnapshots = await getAllSnapshots(userId);

  const lookbackUsed = getBestAvailableLookback(allSnapshots, lookback);
  const startDate = getLookbackStartDate(lookbackUsed);

  const snapshots = startDate
    ? allSnapshots.filter((s) => new Date(s.timestamp) >= startDate)
    : allSnapshots;

  const dividendStartDate = startDate || (allSnapshots.length > 0 ? new Date(allSnapshots[0].timestamp) : new Date());
  const totalDividends = await getTotalDividendsBetween(userId, dividendStartDate, new Date());

  const { metrics, notes } = calculateRealizedMetrics(snapshots, totalDividends);

  return {
    lookback,
    lookbackUsed,
    asOf: new Date().toISOString(),
    currentValue,
    metrics,
    notes,
    snapshotCount: snapshots.length,
    dataStartDate: snapshots.length > 0 ? snapshots[0].timestamp.toISOString() : null,
    dataEndDate: snapshots.length > 0 ? snapshots[snapshots.length - 1].timestamp.toISOString() : null,
  };
}

// Legacy export for backwards compatibility during transition
export async function getProjections(userId: string, portfolioId?: string): Promise<RealizedProjectionResponse> {
  return getRealizedProjections(userId, '1y', portfolioId);
}

/**
 * Calculate pace-based projections using month-to-date (MTD) performance.
 * This is a simple linear projection based on current month's pacing.
 *
 * Uses ASSETS ONLY (holdings + cash) - margin debt is NOT included.
 */
export async function getPaceProjection(userId: string, currentAssets: number, portfolioId?: string): Promise<PaceProjection> {
  const now = new Date();
  const daysIntoMonth = now.getDate(); // 1-31

  // When portfolioId is provided, snapshots are user-wide and can't be scoped.
  // Return a data-less projection to avoid mixing scoped current data with unscoped history.
  if (portfolioId) {
    return {
      hasData: false,
      mtdReturnPct: null,
      paceMonthlyPct: null,
      paceAnnualPct: null,
      horizonPct: { '1y': null, '2y': null, '5y': null, '10y': null },
      horizonValue: { '1y': null, '2y': null, '5y': null, '10y': null },
      baselineMonthDate: null,
      baselineMonthAssets: null,
      currentAssets,
      daysIntoMonth,
      note: 'Sub-portfolio: pace projections unavailable (snapshots are user-wide)',
    };
  }

  // Get first day of current month
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  firstOfMonth.setHours(0, 0, 0, 0);

  // Get all snapshots from start of month
  const monthSnapshots = await getSnapshotsAfter(userId, firstOfMonth);

  // Find baseline: first snapshot on or after first of month
  let baselineSnapshot: PortfolioSnapshot | null = null;
  if (monthSnapshots.length > 0) {
    baselineSnapshot = monthSnapshots[0];
  }

  // If no baseline found, return empty projection
  if (!baselineSnapshot || (baselineSnapshot.netEquity ?? baselineSnapshot.totalValue) <= 0) {
    return {
      hasData: false,
      mtdReturnPct: null,
      paceMonthlyPct: null,
      paceAnnualPct: null,
      horizonPct: { '1y': null, '2y': null, '5y': null, '10y': null },
      horizonValue: { '1y': null, '2y': null, '5y': null, '10y': null },
      baselineMonthDate: null,
      baselineMonthAssets: null,
      currentAssets,
      daysIntoMonth,
      note: 'Not enough data yet - no baseline snapshot for this month',
    };
  }

  const baselineMonthAssets = (baselineSnapshot.netEquity ?? baselineSnapshot.totalValue);

  // Calculate MTD return
  const mtdReturn = (currentAssets - baselineMonthAssets) / baselineMonthAssets;

  // Safety check for NaN/Infinity
  if (!isFinite(mtdReturn) || isNaN(mtdReturn)) {
    return {
      hasData: false,
      mtdReturnPct: null,
      paceMonthlyPct: null,
      paceAnnualPct: null,
      horizonPct: { '1y': null, '2y': null, '5y': null, '10y': null },
      horizonValue: { '1y': null, '2y': null, '5y': null, '10y': null },
      baselineMonthDate: baselineSnapshot.timestamp.toISOString(),
      baselineMonthAssets,
      currentAssets,
      daysIntoMonth,
      note: 'Calculation error - invalid return value',
    };
  }

  // MTD return as percentage
  const mtdReturnPct = mtdReturn * 100;

  // Pace projections:
  // paceMonthlyPct = mtdReturn (already the month's current performance to date)
  // paceAnnualPct = paceMonthlyPct * 12 (simple linear annualization)
  const paceMonthlyPct = mtdReturnPct;
  const paceAnnualPct = paceMonthlyPct * 12;

  // Compute horizon percentages (simple linear scaling)
  const pace1yPct = paceAnnualPct;
  const pace2yPct = paceAnnualPct * 2;
  const pace5yPct = paceAnnualPct * 5;
  const pace10yPct = paceAnnualPct * 10;

  // Compute horizon values
  const pace1yValue = currentAssets * (1 + pace1yPct / 100);
  const pace2yValue = currentAssets * (1 + pace2yPct / 100);
  const pace5yValue = currentAssets * (1 + pace5yPct / 100);
  const pace10yValue = currentAssets * (1 + pace10yPct / 100);

  // Safety: ensure no negative values
  const safeValue = (v: number) => (isFinite(v) && !isNaN(v) && v >= 0) ? Math.round(v * 100) / 100 : null;
  const safePct = (v: number) => (isFinite(v) && !isNaN(v)) ? Math.round(v * 100) / 100 : null;

  return {
    hasData: true,
    mtdReturnPct: safePct(mtdReturnPct),
    paceMonthlyPct: safePct(paceMonthlyPct),
    paceAnnualPct: safePct(paceAnnualPct),
    horizonPct: {
      '1y': safePct(pace1yPct),
      '2y': safePct(pace2yPct),
      '5y': safePct(pace5yPct),
      '10y': safePct(pace10yPct),
    },
    horizonValue: {
      '1y': safeValue(pace1yValue),
      '2y': safeValue(pace2yValue),
      '5y': safeValue(pace5yValue),
      '10y': safeValue(pace10yValue),
    },
    baselineMonthDate: baselineSnapshot.timestamp.toISOString(),
    baselineMonthAssets: Math.round(baselineMonthAssets * 100) / 100,
    currentAssets: Math.round(currentAssets * 100) / 100,
    daysIntoMonth,
    note: null,
  };
}

// ============================================================================
// CURRENT PACE (Linear annualization model)
// ============================================================================

const WINDOW_LABELS: Record<PaceWindow, string> = {
  '1D': 'Today',
  '1M': '1 Month',
  '6M': '6 Months',
  '1Y': '1 Year',
  'YTD': 'Year-to-Date',
};

// Linear annualization multipliers
const LINEAR_MULTIPLIERS: Record<string, number> = {
  '1D': 252,   // trading days per year
  '1W': 52,    // weeks per year
  '1M': 12,    // months per year
  '6M': 2,     // half-years per year
  '1Y': 1,     // already annual
};

// Hard clamp bounds for annualized pace
const PACE_CLAMP_MIN = -0.90; // -90%
const PACE_CLAMP_MAX = 0.50;  // +50%

function clampLinearPace(pace: number): { pace: number; capped: boolean } {
  if (!isFinite(pace) || isNaN(pace)) return { pace: 0, capped: true };
  let capped = false;
  if (pace > PACE_CLAMP_MAX) { pace = PACE_CLAMP_MAX; capped = true; }
  if (pace < PACE_CLAMP_MIN) { pace = PACE_CLAMP_MIN; capped = true; }
  return { pace, capped };
}

function makeProjections(
  currentAssets: number,
  annualizedPace: number
): CurrentPaceResponse['projections'] {
  // Compound growth across future years: currentAssets * (1 + pace)^years
  const make = (years: number) => {
    let value = currentAssets * Math.pow(1 + annualizedPace, years);
    if (!isFinite(value) || isNaN(value)) value = currentAssets;
    if (value < 0) value = 0;
    value = Math.round(value * 100) / 100;
    const gainPct = currentAssets > 0
      ? Math.round(((value - currentAssets) / currentAssets) * 10000) / 100
      : 0;
    return { value, gainPct };
  };
  return { '1y': make(1), '2y': make(2), '5y': make(5), '10y': make(10) };
}

function getCurrentMonthNumber(): number {
  return new Date().getMonth() + 1; // 1-12
}

async function computeYtd(userId: string, portfolio: Portfolio, portfolioId?: string): Promise<CurrentPaceResponse> {
  const currentAssets = portfolio.netEquity;

  // Use reconstructed Yahoo data to get Jan 1 baseline (matches chart)
  const ytdDays = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000);
  const holdings = await getHoldings(userId, portfolioId);
  const reconstructed = await reconstructPortfolioHistory(
    holdings, portfolio.cashBalance, ytdDays, portfolio.marginDebt
  );

  if (reconstructed.length === 0) {
    return {
      window: 'YTD', windowLabel: WINDOW_LABELS['YTD'], dataStatus: 'no_data',
      snapshotCount: 0, dataStartDate: null, dataEndDate: null, daysCovered: 0,
      currentAssets, referenceAssets: null,
      windowReturnPct: null, annualizedPacePct: null, capped: false,
      projections: { '1y': null, '2y': null, '5y': null, '10y': null },
      note: 'No historical data available for YTD.',
      estimated: false, estimatedReason: null,
      trueYtdAvailable: false,
    };
  }

  const startEquity = reconstructed[0].value;

  if (startEquity <= 0) {
    return {
      window: 'YTD', windowLabel: WINDOW_LABELS['YTD'], dataStatus: 'insufficient',
      snapshotCount: 0, dataStartDate: null, dataEndDate: null, daysCovered: 0,
      currentAssets, referenceAssets: startEquity,
      windowReturnPct: null, annualizedPacePct: null, capped: false,
      projections: { '1y': null, '2y': null, '5y': null, '10y': null },
      note: 'Start equity must be positive.',
      estimated: false, estimatedReason: null,
      trueYtdAvailable: true,
    };
  }

  // Simple return from reconstructed baseline
  const windowReturn = (currentAssets - startEquity) / startEquity;
  const windowReturnPct = Math.round(windowReturn * 10000) / 100;

  // Linear annualization: windowReturn × (12 / currentMonthNumber)
  const monthNum = getCurrentMonthNumber();
  let annualizedPace = windowReturn * (12 / monthNum);
  const { pace: clampedPace, capped } = clampLinearPace(annualizedPace);
  annualizedPace = clampedPace;
  const annualizedPacePct = Math.round(annualizedPace * 10000) / 100;

  const year = new Date().getFullYear();
  const jan1 = new Date(year, 0, 1);
  const now = new Date();
  const daysCovered = (now.getTime() - jan1.getTime()) / (1000 * 60 * 60 * 24);

  return {
    window: 'YTD',
    windowLabel: WINDOW_LABELS['YTD'],
    dataStatus: 'ok',
    snapshotCount: 0,
    dataStartDate: jan1.toISOString(),
    dataEndDate: now.toISOString(),
    daysCovered: Math.round(daysCovered * 10) / 10,
    currentAssets: Math.round(currentAssets * 100) / 100,
    referenceAssets: Math.round(startEquity * 100) / 100,
    windowReturnPct,
    annualizedPacePct,
    capped,
    projections: makeProjections(currentAssets, annualizedPace),
    note: capped ? 'Capped for realism.' : null,
    estimated: false, estimatedReason: null,
    trueYtdAvailable: true,
    ytdDetail: { startEquity, netContributions: 0 },
  };
}

export async function getCurrentPaceProjection(
  userId: string,
  window: PaceWindow = '1M',
  portfolioId?: string,
): Promise<CurrentPaceResponse> {
  const portfolio = await getPortfolio(userId, { portfolioId });
  const currentAssets = portfolio.netEquity;

  // ---- YTD: simple return with linear annualization ----
  if (window === 'YTD') {
    return computeYtd(userId, portfolio, portfolioId);
  }

  const emptyResponse = (
    status: 'no_data' | 'insufficient',
    note: string,
    snaps: PortfolioSnapshot[] = []
  ): CurrentPaceResponse => ({
    window,
    windowLabel: WINDOW_LABELS[window],
    dataStatus: status,
    snapshotCount: snaps.length,
    dataStartDate: snaps.length > 0 ? snaps[0].timestamp.toISOString() : null,
    dataEndDate: snaps.length > 0 ? snaps[snaps.length - 1].timestamp.toISOString() : null,
    daysCovered: 0,
    currentAssets,
    referenceAssets: null,
    windowReturnPct: null,
    annualizedPacePct: null,
    capped: false,
    projections: { '1y': null, '2y': null, '5y': null, '10y': null },
    note,
    estimated: false,
    estimatedReason: null,
  });

  // ---- 1D: use LIVE portfolio dayChangePercent ----
  if (window === '1D') {
    const windowReturn = portfolio.dayChangePercent / 100;
    const windowReturnPct = Math.round(windowReturn * 10000) / 100;

    const referenceAssets = portfolio.dayChange !== 0
      ? currentAssets - portfolio.dayChange
      : currentAssets;

    // Linear annualization: windowReturn × 252
    let annualizedPace = windowReturn * LINEAR_MULTIPLIERS['1D'];
    const { pace: clampedPace, capped } = clampLinearPace(annualizedPace);
    annualizedPace = clampedPace;
    const annualizedPacePct = Math.round(annualizedPace * 10000) / 100;

    return {
      window,
      windowLabel: WINDOW_LABELS[window],
      dataStatus: 'ok',
      snapshotCount: 0,
      dataStartDate: new Date().toISOString(),
      dataEndDate: new Date().toISOString(),
      daysCovered: 1,
      currentAssets: Math.round(currentAssets * 100) / 100,
      referenceAssets: Math.round(referenceAssets * 100) / 100,
      windowReturnPct,
      annualizedPacePct,
      capped,
      projections: makeProjections(currentAssets, annualizedPace),
      note: capped ? 'Capped for realism.' : null,
      estimated: false,
      estimatedReason: null,
    };
  }

  // ---- Non-1D windows: Use reconstructed Yahoo candle data (matches chart) ----
  const WINDOW_DAYS: Record<string, number> = { '1M': 30, '6M': 182, '1Y': 365 };
  const targetDays = WINDOW_DAYS[window] ?? 30;

  const holdings = await getHoldings(userId, portfolioId);
  const reconstructed = await reconstructPortfolioHistory(
    holdings, portfolio.cashBalance, targetDays, portfolio.marginDebt
  );

  if (reconstructed.length === 0) {
    return emptyResponse('no_data', `No historical data available for ${WINDOW_LABELS[window]} window.`);
  }

  const nowMs = Date.now();
  const baselineAssets = reconstructed[0].value;
  const baselineTimestamp = new Date(reconstructed[0].time);
  const snapshotCount = reconstructed.length;

  if (baselineAssets <= 0) {
    return emptyResponse('insufficient', 'Baseline value is zero.');
  }

  const actualSpanDays = Math.max(1, (nowMs - baselineTimestamp.getTime()) / (1000 * 60 * 60 * 24));

  // Compute window return from reconstructed data (same source as chart)
  let windowReturn: number;
  windowReturn = (currentAssets - baselineAssets) / baselineAssets;

  if (!isFinite(windowReturn) || isNaN(windowReturn)) {
    windowReturn = 0;
  }

  const windowReturnPct = Math.round(windowReturn * 10000) / 100;

  // Linear annualization: windowReturn × multiplier
  const multiplier = LINEAR_MULTIPLIERS[window] ?? 1;
  let annualizedPace = windowReturn * multiplier;
  const { pace: clampedPace, capped } = clampLinearPace(annualizedPace);
  annualizedPace = clampedPace;
  const annualizedPacePct = Math.round(annualizedPace * 10000) / 100;

  const projections = makeProjections(currentAssets, annualizedPace);

  return {
    window,
    windowLabel: WINDOW_LABELS[window],
    dataStatus: 'ok',
    snapshotCount,
    dataStartDate: baselineTimestamp.toISOString(),
    dataEndDate: new Date().toISOString(),
    daysCovered: Math.round(actualSpanDays * 10) / 10,
    currentAssets: Math.round(currentAssets * 100) / 100,
    referenceAssets: Math.round(baselineAssets * 100) / 100,
    windowReturnPct,
    annualizedPacePct,
    capped,
    projections,
    note: capped ? 'Capped for realism.' : null,
    estimated: false,
    estimatedReason: null,
  };
}
