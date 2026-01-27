/**
 * Calculate Exponential Moving Average
 */
export function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];

  const multiplier = 2 / (period + 1);
  let emaValue = values[0];

  for (let i = 1; i < values.length; i++) {
    emaValue = (values[i] - emaValue) * multiplier + emaValue;
  }

  return emaValue;
}

/**
 * Calculate standard deviation
 */
export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;

  return Math.sqrt(variance);
}

/**
 * Calculate linear regression slope
 */
export function linearRegressionSlope(values: number[]): number {
  if (values.length < 2) return 0;

  const n = values.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}

/**
 * Calculate daily returns from portfolio values
 */
export function calculateDailyReturns(values: number[]): number[] {
  if (values.length < 2) return [];

  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] !== 0) {
      returns.push((values[i] - values[i - 1]) / values[i - 1]);
    }
  }

  return returns;
}

/**
 * Calculate weekly returns (using 5-day periods)
 */
export function calculateWeeklyReturns(values: number[]): number[] {
  if (values.length < 6) return [];

  const returns: number[] = [];
  for (let i = 5; i < values.length; i++) {
    if (values[i - 5] !== 0) {
      returns.push((values[i] - values[i - 5]) / values[i - 5]);
    }
  }

  return returns;
}

/**
 * Annualize a daily return rate
 */
export function annualizeDailyReturn(dailyReturn: number): number {
  return Math.pow(1 + dailyReturn, 252) - 1;
}

/**
 * Calculate maximum drawdown
 */
export function calculateDrawdown(values: number[]): number {
  if (values.length < 2) return 0;

  let maxValue = values[0];
  let maxDrawdown = 0;

  for (const value of values) {
    if (value > maxValue) {
      maxValue = value;
    }
    const drawdown = (value - maxValue) / maxValue;
    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown;
}

/**
 * Calculate current drawdown from peak
 */
export function calculateCurrentDrawdown(values: number[]): number {
  if (values.length < 2) return 0;

  const maxValue = Math.max(...values);
  const currentValue = values[values.length - 1];

  return (currentValue - maxValue) / maxValue;
}
