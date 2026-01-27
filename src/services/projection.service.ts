import { Projection, ProjectionResponse, ProjectionMetrics } from '../types';
import { getRecentSnapshots } from './snapshot.service';
import { getPortfolio } from './portfolio.service';
import { config } from '../config';

const MINIMUM_SNAPSHOTS = 3;
const MINIMUM_VALUE_FOR_PROJECTION = 100; // Don't project on tiny/zero portfolios
const VOLATILITY_FACTOR = 1.5;

// Guardrails for projection values
const MAX_DAILY_RETURN = 0.10;     // 10% daily max (unrealistic beyond this)
const MIN_DAILY_RETURN = -0.10;    // -10% daily min
const MAX_ANNUALIZED_RETURN = 2.0; // 200% annual cap
const MIN_ANNUALIZED_RETURN = -0.95; // -95% annual floor
const MAX_VOLATILITY = 0.15;       // Cap daily volatility at 15%
const MAX_PROJECTION_MULTIPLIER = 100; // Don't show projections > 100x current value

function calculateReturns(values: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) {
      const ret = (values[i] - values[i - 1]) / values[i - 1];
      // Clamp extreme returns that would skew calculations
      returns.push(Math.max(MIN_DAILY_RETURN, Math.min(MAX_DAILY_RETURN, ret)));
    }
  }
  return returns;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const squaredDiffs = values.map((v) => Math.pow(v - avg, 2));
  return Math.sqrt(mean(squaredDiffs));
}

function diff(values: number[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] - values[i - 1]);
  }
  return result;
}

function calculateMetrics(values: number[]): ProjectionMetrics {
  const returns = calculateReturns(values);

  if (returns.length === 0) {
    return { velocity: 0, acceleration: 0, volatility: 0, drawdown: 0 };
  }

  const velocity = mean(returns);
  const acceleration = returns.length > 1 ? mean(diff(returns)) : 0;
  const volatility = Math.min(MAX_VOLATILITY, standardDeviation(returns));

  const maxValue = Math.max(...values);
  const currentValue = values[values.length - 1];
  const drawdown = maxValue > 0 ? (currentValue - maxValue) / maxValue : 0;

  return { velocity, acceleration, volatility, drawdown };
}

function calculateConfidence(snapshotCount: number, volatility: number): number {
  const sampleConfidence = Math.min(1, snapshotCount / 30);
  const volPenalty = Math.min(1, volatility * 20);
  return Math.max(0, (sampleConfidence * 0.6 + (1 - volPenalty) * 0.4)) * 100;
}

interface HorizonConfig {
  horizon: '6mo' | '1yr' | '5yr' | '10yr';
  periods: number;
}

const HORIZONS: HorizonConfig[] = [
  { horizon: '6mo', periods: 126 },
  { horizon: '1yr', periods: 252 },
  { horizon: '5yr', periods: 1260 },
  { horizon: '10yr', periods: 2520 },
];

function clampProjection(value: number, currentValue: number): number {
  // Prevent exponential overflow and unrealistic projections
  const maxValue = currentValue * MAX_PROJECTION_MULTIPLIER;
  const minValue = 0;

  if (!isFinite(value) || isNaN(value)) {
    return currentValue;
  }

  return Math.max(minValue, Math.min(maxValue, value));
}

export async function getProjections(): Promise<ProjectionResponse> {
  const [snapshots, portfolio] = await Promise.all([
    getRecentSnapshots(config.projectionWindow),
    getPortfolio(),
  ]);

  const currentValue = portfolio.totalValue;
  const snapshotCount = snapshots.length;

  // Check for insufficient data conditions
  if (snapshotCount < MINIMUM_SNAPSHOTS) {
    return {
      currentValue,
      projections: HORIZONS.map(({ horizon }) => ({
        horizon,
        base: currentValue,
        bull: currentValue,
        bear: currentValue,
        confidence: 0,
      })),
      snapshotCount,
      method: 'insufficient_data',
      metrics: null,
      message: `Need more history. Minimum ${MINIMUM_SNAPSHOTS} snapshots required, currently have ${snapshotCount}.`,
    };
  }

  // Check for near-zero or invalid portfolio value
  if (currentValue < MINIMUM_VALUE_FOR_PROJECTION) {
    return {
      currentValue,
      projections: HORIZONS.map(({ horizon }) => ({
        horizon,
        base: currentValue,
        bull: currentValue,
        bear: currentValue,
        confidence: 0,
      })),
      snapshotCount,
      method: 'insufficient_data',
      metrics: null,
      message: `Portfolio value too low for meaningful projections. Need at least $${MINIMUM_VALUE_FOR_PROJECTION}.`,
    };
  }

  // Check if any quotes are unavailable (could skew projections)
  if (portfolio.quotesUnavailableCount && portfolio.quotesUnavailableCount > 0) {
    const unavailablePercent = portfolio.quotesUnavailableCount / portfolio.holdings.length;
    if (unavailablePercent > 0.5) {
      return {
        currentValue,
        projections: HORIZONS.map(({ horizon }) => ({
          horizon,
          base: currentValue,
          bull: currentValue,
          bear: currentValue,
          confidence: 0,
        })),
        snapshotCount,
        method: 'insufficient_data',
        metrics: null,
        message: `Too many quotes unavailable (${portfolio.quotesUnavailableCount} of ${portfolio.holdings.length}). Waiting for price data.`,
      };
    }
  }

  const values = snapshots.map((s) => s.totalValue);

  // Additional check: make sure we don't have a bunch of zeros in snapshot history
  const validValues = values.filter(v => v > MINIMUM_VALUE_FOR_PROJECTION);
  if (validValues.length < MINIMUM_SNAPSHOTS) {
    return {
      currentValue,
      projections: HORIZONS.map(({ horizon }) => ({
        horizon,
        base: currentValue,
        bull: currentValue,
        bear: currentValue,
        confidence: 0,
      })),
      snapshotCount,
      method: 'insufficient_data',
      metrics: null,
      message: `Insufficient valid snapshot history. Some snapshots had near-zero values.`,
    };
  }

  const metrics = calculateMetrics(values);

  // Clamp velocity to reasonable bounds
  const clampedVelocity = Math.max(
    MIN_ANNUALIZED_RETURN / 252,
    Math.min(MAX_ANNUALIZED_RETURN / 252, metrics.velocity)
  );

  const confidence = calculateConfidence(snapshotCount, metrics.volatility);

  const projections: Projection[] = HORIZONS.map(({ horizon, periods }) => {
    // Use clamped velocity for projections
    const baseGrowth = Math.pow(1 + clampedVelocity, periods);
    const base = clampProjection(currentValue * baseGrowth, currentValue);

    const volSpread = metrics.volatility * VOLATILITY_FACTOR * Math.sqrt(periods);

    const bullVelocity = Math.min(MAX_ANNUALIZED_RETURN / 252, clampedVelocity + volSpread);
    const bullGrowth = Math.pow(1 + bullVelocity, periods);
    const bull = clampProjection(currentValue * bullGrowth, currentValue);

    const bearVelocity = Math.max(MIN_ANNUALIZED_RETURN / 252, clampedVelocity - volSpread);
    const bearGrowth = Math.pow(1 + bearVelocity, periods);
    const bear = clampProjection(Math.max(0, currentValue * bearGrowth), currentValue);

    return {
      horizon,
      base: Math.round(base * 100) / 100,
      bull: Math.round(bull * 100) / 100,
      bear: Math.round(bear * 100) / 100,
      confidence: Math.round(confidence * 10) / 10,
    };
  });

  return {
    currentValue,
    projections,
    snapshotCount,
    method: 'momentum',
    metrics: {
      velocity: Math.round(metrics.velocity * 1000000) / 1000000,
      acceleration: Math.round(metrics.acceleration * 1000000) / 1000000,
      volatility: Math.round(metrics.volatility * 1000000) / 1000000,
      drawdown: Math.round(metrics.drawdown * 1000000) / 1000000,
    },
  };
}
