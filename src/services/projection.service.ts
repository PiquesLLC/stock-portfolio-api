import {
  SP500ProjectionResponse,
  RealizedProjectionResponse,
  RealizedMetrics,
  MetricsResponse,
  LookbackPeriod,
  ProjectionHorizons,
  PortfolioSnapshot,
} from '../types';
import { getPortfolio } from './portfolio.service';
import { getSnapshotsAfter, getAllSnapshots } from './snapshot.service';
import { getTotalDividendsBetween } from './dividend.service';
import { config } from '../config';

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
 * Project portfolio value using S&P 500 long-run total return
 */
export async function getSP500Projections(): Promise<SP500ProjectionResponse> {
  const portfolio = await getPortfolio();
  const currentValue = portfolio.totalValue;
  const annualReturn = config.sp500CagrTotalReturn;

  // Monthly compounding: (1 + r)^(years*12) where r = monthly rate
  const monthlyRate = Math.pow(1 + annualReturn, 1 / 12) - 1;

  const horizons: ProjectionHorizons = {
    '6m': { base: 0 },
    '1y': { base: 0 },
    '5y': { base: 0 },
    '10y': { base: 0 },
  };

  for (const { key, years } of HORIZONS) {
    const months = years * 12;
    const futureValue = currentValue * Math.pow(1 + monthlyRate, months);
    horizons[key] = { base: Math.round(futureValue * 100) / 100 };
  }

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
function calculateRealizedMetrics(
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

  const values = snapshots.map((s) => s.totalValue);
  const startValue = values[0];
  const endValue = values[values.length - 1];

  // Calculate time span in years
  const startDate = new Date(snapshots[0].timestamp);
  const endDate = new Date(snapshots[snapshots.length - 1].timestamp);
  const daysDiff = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
  const yearsDiff = daysDiff / 365;

  // CAGR calculation: (endValue / startValue)^(1/years) - 1
  // Include dividends in the total return
  let cagr: number | null = null;
  if (startValue > 0 && yearsDiff > 0) {
    const totalReturn = (endValue + totalDividends) / startValue;
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

  // Volatility: stddev of returns * sqrt(periods per year)
  // Assume snapshots are roughly daily (or at interval seconds)
  let volatility: number | null = null;
  if (periodReturns.length >= 2) {
    const meanReturn = periodReturns.reduce((a, b) => a + b, 0) / periodReturns.length;
    const squaredDiffs = periodReturns.map((r) => Math.pow(r - meanReturn, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (periodReturns.length - 1);
    const stddev = Math.sqrt(variance);

    // Annualize: assume periods per year based on actual data frequency
    const periodsPerYear = periodReturns.length / yearsDiff;
    volatility = stddev * Math.sqrt(periodsPerYear);

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
  if (values.length >= 2) {
    let peak = values[0];
    let maxDD = 0;

    for (const value of values) {
      if (value > peak) {
        peak = value;
      }
      const drawdown = (peak - value) / peak;
      if (drawdown > maxDD) {
        maxDD = drawdown;
      }
    }

    maxDrawdown = -Math.round(maxDD * 10000) / 10000; // Negative to show as loss
  }

  // Sharpe Ratio: (CAGR - riskFreeRate) / volatility
  let sharpe: number | null = null;
  if (cagr !== null && volatility !== null && volatility > 0) {
    sharpe = (cagr - config.riskFreeRate) / volatility;
    sharpe = Math.round(sharpe * 100) / 100;
  }

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
  lookback: LookbackPeriod = '1y'
): Promise<RealizedProjectionResponse> {
  const portfolio = await getPortfolio();
  const currentValue = portfolio.totalValue;
  const allSnapshots = await getAllSnapshots();

  // Determine what lookback to actually use
  const lookbackUsed = getBestAvailableLookback(allSnapshots, lookback);
  const startDate = getLookbackStartDate(lookbackUsed);

  // Filter snapshots to lookback period
  const snapshots = startDate
    ? allSnapshots.filter((s) => new Date(s.timestamp) >= startDate)
    : allSnapshots;

  // Get dividends in the period
  const dividendStartDate = startDate || (allSnapshots.length > 0 ? new Date(allSnapshots[0].timestamp) : new Date());
  const totalDividends = await getTotalDividendsBetween(dividendStartDate, new Date());

  // Calculate metrics
  const { metrics: realized, notes } = calculateRealizedMetrics(snapshots, totalDividends);

  // Build projections using realized CAGR (or 0 if unavailable)
  const projectionRate = realized.cagr ?? 0;
  const monthlyRate = Math.pow(1 + projectionRate, 1 / 12) - 1;

  const horizons: ProjectionHorizons = {
    '6m': { base: 0 },
    '1y': { base: 0 },
    '5y': { base: 0 },
    '10y': { base: 0 },
  };

  for (const { key, years } of HORIZONS) {
    const months = years * 12;
    let futureValue = currentValue * Math.pow(1 + monthlyRate, months);

    // Prevent insane values
    if (!isFinite(futureValue) || isNaN(futureValue)) {
      futureValue = currentValue;
      if (!notes.includes('Some projections reset to current value due to calculation issues')) {
        notes.push('Some projections reset to current value due to calculation issues');
      }
    }

    // Cap at reasonable multipliers
    const maxMultiplier = 1000;
    if (futureValue > currentValue * maxMultiplier) {
      futureValue = currentValue * maxMultiplier;
    }
    if (futureValue < 0) {
      futureValue = 0;
    }

    horizons[key] = { base: Math.round(futureValue * 100) / 100 };
  }

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
export async function getMetrics(lookback: LookbackPeriod = '1y'): Promise<MetricsResponse> {
  const portfolio = await getPortfolio();
  const currentValue = portfolio.totalValue;
  const allSnapshots = await getAllSnapshots();

  const lookbackUsed = getBestAvailableLookback(allSnapshots, lookback);
  const startDate = getLookbackStartDate(lookbackUsed);

  const snapshots = startDate
    ? allSnapshots.filter((s) => new Date(s.timestamp) >= startDate)
    : allSnapshots;

  const dividendStartDate = startDate || (allSnapshots.length > 0 ? new Date(allSnapshots[0].timestamp) : new Date());
  const totalDividends = await getTotalDividendsBetween(dividendStartDate, new Date());

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
export async function getProjections(): Promise<RealizedProjectionResponse> {
  return getRealizedProjections('1y');
}
