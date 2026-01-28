import { PrismaClient } from '@prisma/client';
import { getPortfolio } from './portfolio.service';
import { getAllSnapshots } from './snapshot.service';
import { insightsCache } from '../utils/finnhub';
import {
  getMultipleCandlesGradual,
  HistoricalCandles,
  getCacheStats,
  hasCachedCandles,
} from '../utils/candle-cache';
import {
  HealthScore,
  Attribution,
  LeakDetectorResult,
  RiskForecast,
  RiskForecastBasis,
  RiskForecastMetrics,
  RiskForecastScenarios,
  HoldingWithQuote,
} from '../types';
import { config } from '../config';
import { getSector } from '../utils/sectors';

const prisma = new PrismaClient();

// Reduced trading days for correlation (9 months instead of 1 year)
const CORRELATION_TRADING_DAYS = 180;
// Minimum days needed for analysis
const MIN_CORRELATION_DAYS = 60;
// Minimum days for Monte Carlo
const MIN_MONTE_CARLO_DAYS = 100;
// Fallback days if full data unavailable
const FALLBACK_TRADING_DAYS = 120;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Calculate Pearson correlation coefficient between two return arrays
 */
function calculateCorrelation(returns1: number[], returns2: number[]): number | null {
  const len = Math.min(returns1.length, returns2.length);
  if (len < 20) return null;

  const r1 = returns1.slice(-len);
  const r2 = returns2.slice(-len);

  const mean1 = r1.reduce((a, b) => a + b, 0) / len;
  const mean2 = r2.reduce((a, b) => a + b, 0) / len;

  let numerator = 0;
  let denom1 = 0;
  let denom2 = 0;

  for (let i = 0; i < len; i++) {
    const diff1 = r1[i] - mean1;
    const diff2 = r2[i] - mean2;
    numerator += diff1 * diff2;
    denom1 += diff1 * diff1;
    denom2 += diff2 * diff2;
  }

  const denom = Math.sqrt(denom1 * denom2);
  if (denom === 0) return null;

  return numerator / denom;
}

/**
 * Calculate annualized volatility from daily returns
 */
function calculateAnnualizedVolatility(returns: number[]): number | null {
  if (returns.length < 20) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const squaredDiffs = returns.map(r => Math.pow(r - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (returns.length - 1);
  const dailyVol = Math.sqrt(variance);

  return dailyVol * Math.sqrt(252);
}

/**
 * Calculate maximum drawdown from a price/value series
 */
function calculateMaxDrawdown(values: number[]): number | null {
  if (values.length < 2) return null;

  let peak = values[0];
  let maxDrawdown = 0;

  for (const value of values) {
    if (value > peak) {
      peak = value;
    }
    const drawdown = (peak - value) / peak;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown;
}

/**
 * Get portfolio returns from historical candle data
 */
function calculatePortfolioReturns(
  holdings: HoldingWithQuote[],
  candleData: Map<string, HistoricalCandles>,
  minDays: number = 20
): number[] {
  let minLength = Infinity;
  const holdingReturns: { weight: number; returns: number[] }[] = [];

  const totalValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
  if (totalValue === 0) return [];

  for (const holding of holdings) {
    const candles = candleData.get(holding.ticker);
    if (!candles || candles.partial || candles.returns.length < minDays) continue;

    const weight = holding.currentValue / totalValue;
    holdingReturns.push({ weight, returns: candles.returns });
    minLength = Math.min(minLength, candles.returns.length);
  }

  if (holdingReturns.length === 0 || minLength === 0 || minLength === Infinity) {
    return [];
  }

  const portfolioReturns: number[] = [];
  for (let i = 0; i < minLength; i++) {
    let dayReturn = 0;
    for (const hr of holdingReturns) {
      dayReturn += hr.weight * hr.returns[hr.returns.length - minLength + i];
    }
    portfolioReturns.push(dayReturn);
  }

  return portfolioReturns;
}

/**
 * Simple sector-based pseudo-diversification estimate
 * (Used as fallback when correlation data unavailable)
 */
function estimateSectorDiversification(holdings: HoldingWithQuote[]): {
  apparentDiversification: number;
  effectiveDiversification: number;
  sectorConcentration: { sector: string; percent: number }[];
} {
  const totalValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
  if (totalValue === 0) return { apparentDiversification: 0, effectiveDiversification: 0, sectorConcentration: [] };

  const sectorValues = new Map<string, number>();

  for (const holding of holdings) {
    const sector = getSector(holding.ticker);
    sectorValues.set(sector, (sectorValues.get(sector) || 0) + holding.currentValue);
  }

  const sectorConcentration: { sector: string; percent: number }[] = [];
  for (const [sector, value] of sectorValues) {
    sectorConcentration.push({
      sector,
      percent: Math.round((value / totalValue) * 1000) / 10,
    });
  }
  sectorConcentration.sort((a, b) => b.percent - a.percent);

  // Apparent diversification = number of holdings
  const apparentDiversification = holdings.length;

  // Effective diversification = approximate 1/HHI
  // HHI = sum of squared weights
  const hhi = holdings.reduce((sum, h) => {
    const weight = h.currentValue / totalValue;
    return sum + weight * weight;
  }, 0);

  const effectiveDiversification = hhi > 0 ? Math.round(1 / hhi) : holdings.length;

  return { apparentDiversification, effectiveDiversification, sectorConcentration };
}

// ============================================================================
// HEALTH SCORE
// ============================================================================

export async function getHealthScore(): Promise<HealthScore> {
  const cacheKey = 'health-score';
  const cached = insightsCache.get<HealthScore>(cacheKey);
  if (cached) return cached;

  const portfolio = await getPortfolio();
  const snapshots = await getAllSnapshots();
  const holdings = portfolio.holdings;

  const reasons: string[] = [];
  const quickFixes: string[] = [];

  let concentrationScore = 25;
  let volatilityScore = 25;
  let drawdownScore = 25;
  let diversificationScore = 25;
  let marginPenalty = 0;

  // ---- CONCENTRATION ANALYSIS ----
  if (holdings.length > 0 && portfolio.holdingsValue > 0) {
    const sortedByValue = [...holdings].sort((a, b) => b.currentValue - a.currentValue);
    const top1Pct = (sortedByValue[0]?.currentValue || 0) / portfolio.holdingsValue * 100;
    const top3Value = sortedByValue.slice(0, 3).reduce((sum, h) => sum + h.currentValue, 0);
    const top3Pct = (top3Value / portfolio.holdingsValue) * 100;

    if (top1Pct > 25) {
      const penalty = Math.min(15, (top1Pct - 25) * 0.5);
      concentrationScore -= penalty;
      reasons.push(`${sortedByValue[0].ticker} is ${top1Pct.toFixed(0)}% of portfolio (>25% threshold)`);
      quickFixes.push(`Consider trimming ${sortedByValue[0].ticker} to reduce single-stock risk`);
    }

    if (top3Pct > 55) {
      const penalty = Math.min(10, (top3Pct - 55) * 0.3);
      concentrationScore -= penalty;
      if (reasons.length === 0) {
        reasons.push(`Top 3 holdings are ${top3Pct.toFixed(0)}% of portfolio (>55% threshold)`);
      }
    }
  } else if (holdings.length === 0) {
    concentrationScore = 0;
    reasons.push('No holdings in portfolio');
    quickFixes.push('Add holdings to build a diversified portfolio');
  }

  // ---- VOLATILITY ANALYSIS ----
  if (snapshots.length >= 30) {
    const values = snapshots.map(s => s.totalValue);
    const returns: number[] = [];
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] > 0) {
        returns.push((values[i] - values[i - 1]) / values[i - 1]);
      }
    }

    const vol = calculateAnnualizedVolatility(returns);
    if (vol !== null) {
      if (vol > 0.4) {
        volatilityScore = 5;
        reasons.push(`Very high volatility (${(vol * 100).toFixed(0)}% annualized)`);
        quickFixes.push('Add lower-volatility assets like bonds or dividend stocks');
      } else if (vol > 0.25) {
        volatilityScore = 15;
        reasons.push(`Elevated volatility (${(vol * 100).toFixed(0)}% annualized)`);
      } else if (vol > 0.15) {
        volatilityScore = 20;
      }
    }
  }

  // ---- DRAWDOWN ANALYSIS ----
  if (snapshots.length >= 30) {
    const values = snapshots.map(s => s.totalValue);
    const maxDD = calculateMaxDrawdown(values);

    if (maxDD !== null) {
      if (maxDD > 0.2) {
        drawdownScore = 5;
        if (!reasons.some(r => r.includes('drawdown'))) {
          reasons.push(`Historical max drawdown of ${(maxDD * 100).toFixed(0)}%`);
        }
      } else if (maxDD > 0.1) {
        drawdownScore = 15;
      } else if (maxDD > 0.05) {
        drawdownScore = 20;
      }
    }
  }

  // ---- DIVERSIFICATION ANALYSIS ----
  if (holdings.length >= 15) {
    diversificationScore = 25;
  } else if (holdings.length >= 10) {
    diversificationScore = 22;
  } else if (holdings.length >= 7) {
    diversificationScore = 18;
  } else if (holdings.length >= 5) {
    diversificationScore = 15;
  } else if (holdings.length >= 3) {
    diversificationScore = 10;
    if (!reasons.some(r => r.includes('diversif'))) {
      reasons.push('Limited diversification with only ' + holdings.length + ' holdings');
      quickFixes.push('Consider adding more uncorrelated assets');
    }
  } else {
    diversificationScore = 5;
    reasons.push('Very limited diversification');
  }

  // ---- MARGIN PENALTY ----
  if (portfolio.marginDebt > 0 && portfolio.totalAssets > 0) {
    const marginRatio = portfolio.marginDebt / portfolio.totalAssets;
    marginPenalty = Math.min(15, marginRatio * 30);

    if (marginRatio > 0.1) {
      reasons.push(`Using ${(marginRatio * 100).toFixed(0)}% margin (increases risk)`);
      quickFixes.push('Consider reducing margin debt to lower risk');
    }
  }

  const rawScore = concentrationScore + volatilityScore + drawdownScore + diversificationScore;
  const overall = Math.max(0, Math.min(100, Math.round(rawScore - marginPenalty)));

  const result: HealthScore = {
    overall,
    breakdown: {
      concentration: Math.max(0, Math.round(concentrationScore)),
      volatility: Math.max(0, Math.round(volatilityScore)),
      drawdown: Math.max(0, Math.round(drawdownScore)),
      diversification: Math.max(0, Math.round(diversificationScore)),
      margin: Math.round(marginPenalty),
    },
    reasons: reasons.slice(0, 3),
    quickFixes: quickFixes.slice(0, 2),
    partial: holdings.length === 0,
  };

  // Short cache (5 minutes) since health score depends on current prices
  insightsCache.set(cacheKey, result, 300);
  return result;
}

// ============================================================================
// ATTRIBUTION
// ============================================================================

type AttributionWindow = '1d' | '5d' | '1m';

export async function getAttribution(window: AttributionWindow = '1d'): Promise<Attribution> {
  const cacheKey = `attribution:${window}`;
  const cached = insightsCache.get<Attribution>(cacheKey);
  if (cached) return cached;

  const portfolio = await getPortfolio();
  const holdings = portfolio.holdings;

  if (holdings.length === 0) {
    return {
      window,
      topContributors: [],
      topDetractors: [],
      partial: true,
    };
  }

  let contributions: { ticker: string; contributionDollar: number; contributionPct: number }[] = [];

  if (window === '1d') {
    const totalDayChange = holdings.reduce((sum, h) => sum + h.dayChange, 0);

    contributions = holdings.map(h => ({
      ticker: h.ticker,
      contributionDollar: Math.round(h.dayChange * 100) / 100,
      contributionPct: totalDayChange !== 0
        ? Math.round((h.dayChange / Math.abs(totalDayChange)) * 10000) / 100
        : 0,
    }));
  } else {
    // Use gradual candle fetching for 5d/1m
    const tickers = holdings.map(h => h.ticker);
    const fetchResult = await getMultipleCandlesGradual(tickers, CORRELATION_TRADING_DAYS);
    const candleData = fetchResult.data;

    const daysBack = window === '5d' ? 5 : 22;

    contributions = holdings.map(h => {
      const candles = candleData.get(h.ticker);
      if (!candles || candles.partial || candles.closes.length < daysBack + 1) {
        return { ticker: h.ticker, contributionDollar: 0, contributionPct: 0 };
      }

      const currentPrice = candles.closes[candles.closes.length - 1];
      const pastPrice = candles.closes[candles.closes.length - 1 - daysBack];

      if (pastPrice <= 0) {
        return { ticker: h.ticker, contributionDollar: 0, contributionPct: 0 };
      }

      const priceChange = currentPrice - pastPrice;
      const contributionDollar = h.shares * priceChange;

      return {
        ticker: h.ticker,
        contributionDollar: Math.round(contributionDollar * 100) / 100,
        contributionPct: 0,
      };
    });

    const totalContribution = contributions.reduce((sum, c) => sum + Math.abs(c.contributionDollar), 0);
    if (totalContribution > 0) {
      contributions = contributions.map(c => ({
        ...c,
        contributionPct: Math.round((c.contributionDollar / totalContribution) * 10000) / 100,
      }));
    }
  }

  const sorted = [...contributions].sort((a, b) => b.contributionDollar - a.contributionDollar);

  const topContributors = sorted
    .filter(c => c.contributionDollar > 0)
    .slice(0, 5);

  const topDetractors = sorted
    .filter(c => c.contributionDollar < 0)
    .slice(-5)
    .reverse();

  const result: Attribution = {
    window,
    topContributors,
    topDetractors,
    partial: false,
  };

  insightsCache.set(cacheKey, result, window === '1d' ? 300 : 86400);
  return result;
}

// ============================================================================
// LEAK DETECTOR (CORRELATION CLUSTERS) - WITH GRACEFUL DEGRADATION
// ============================================================================

export async function getLeakDetector(): Promise<LeakDetectorResult> {
  const cacheKey = 'leak-detector';
  const cached = insightsCache.get<LeakDetectorResult>(cacheKey);
  if (cached) return cached;

  const portfolio = await getPortfolio();
  const holdings = portfolio.holdings;

  if (holdings.length < 2) {
    return {
      correlationClusters: [],
      summaries: ['Need at least 2 holdings to analyze correlations'],
      heatmapData: null,
      partial: true,
    };
  }

  // Get top 12 holdings by weight
  const sortedHoldings = [...holdings]
    .sort((a, b) => b.currentValue - a.currentValue)
    .slice(0, 12);

  const tickers = sortedHoldings.map(h => h.ticker);

  // Use gradual candle fetching
  const fetchResult = await getMultipleCandlesGradual(tickers, CORRELATION_TRADING_DAYS);
  const candleData = fetchResult.data;

  // Count how many tickers have enough data
  const tickersWithData = Array.from(candleData.values()).filter(
    c => !c.partial && c.returns.length >= MIN_CORRELATION_DAYS
  );

  // If not enough data, return fallback analysis
  if (tickersWithData.length < 2) {
    // Use sector-based fallback
    const sectorAnalysis = estimateSectorDiversification(holdings);

    const summaries: string[] = [];

    // Add context about the data limitation
    if (fetchResult.message.includes('paid plan')) {
      summaries.push('Correlation analysis requires Finnhub paid plan for historical data.');
      summaries.push('Showing sector-based diversification estimate instead.');
    } else {
      summaries.push(fetchResult.message);
    }

    if (sectorAnalysis.effectiveDiversification < sectorAnalysis.apparentDiversification * 0.5) {
      summaries.push(`Apparent diversification: ${sectorAnalysis.apparentDiversification} holdings`);
      summaries.push(`Effective diversification: ~${sectorAnalysis.effectiveDiversification} (sector overlap detected)`);
    }

    if (sectorAnalysis.sectorConcentration.length > 0 && sectorAnalysis.sectorConcentration[0].percent > 40) {
      summaries.push(`${sectorAnalysis.sectorConcentration[0].sector} sector: ${sectorAnalysis.sectorConcentration[0].percent}% of portfolio`);
    }

    const result: LeakDetectorResult = {
      correlationClusters: [],
      summaries,
      heatmapData: null,
      partial: true,
    };

    // Longer cache for plan limitation (24h), short for still caching (5 min)
    const cacheTtl = fetchResult.message.includes('paid plan') ? 86400 : 300;
    insightsCache.set(cacheKey, result, cacheTtl);
    return result;
  }

  // Build correlation matrix from available data
  const correlationMatrix: { t1: string; t2: string; corr: number }[] = [];
  const validTickers = tickersWithData.map(c => c.ticker);

  for (let i = 0; i < validTickers.length; i++) {
    for (let j = i + 1; j < validTickers.length; j++) {
      const candles1 = candleData.get(validTickers[i]);
      const candles2 = candleData.get(validTickers[j]);

      if (candles1 && candles2) {
        const corr = calculateCorrelation(candles1.returns, candles2.returns);
        if (corr !== null) {
          correlationMatrix.push({ t1: validTickers[i], t2: validTickers[j], corr });
        }
      }
    }
  }

  // Find clusters where correlation > 0.8
  const highCorrelations = correlationMatrix.filter(c => c.corr > 0.8);

  // Union-Find for clustering
  const parent = new Map<string, string>();
  validTickers.forEach(t => parent.set(t, t));

  function find(x: string): string {
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!));
    }
    return parent.get(x)!;
  }

  function union(x: string, y: string): void {
    const px = find(x);
    const py = find(y);
    if (px !== py) {
      parent.set(px, py);
    }
  }

  highCorrelations.forEach(({ t1, t2 }) => union(t1, t2));

  // Group tickers by cluster
  const clusters = new Map<string, string[]>();
  validTickers.forEach(t => {
    const root = find(t);
    if (!clusters.has(root)) {
      clusters.set(root, []);
    }
    clusters.get(root)!.push(t);
  });

  // Build result
  const correlationClusters: { tickers: string[]; avgCorrelation: number }[] = [];
  const summaries: string[] = [];

  clusters.forEach((members, _root) => {
    if (members.length >= 2) {
      let totalCorr = 0;
      let count = 0;
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const pair = correlationMatrix.find(
            c => (c.t1 === members[i] && c.t2 === members[j]) ||
                 (c.t1 === members[j] && c.t2 === members[i])
          );
          if (pair) {
            totalCorr += pair.corr;
            count++;
          }
        }
      }
      const avgCorr = count > 0 ? totalCorr / count : 0.8;

      correlationClusters.push({
        tickers: members,
        avgCorrelation: Math.round(avgCorr * 100) / 100,
      });

      summaries.push(
        `These stocks move together: ${members.join(', ')} (${(avgCorr * 100).toFixed(0)}% correlated)`
      );
    }
  });

  // Add status message about data coverage
  if (fetchResult.tickersPending.length > 0) {
    summaries.push(fetchResult.message);
  } else if (correlationClusters.length > 0) {
    summaries.push('Your diversification may be lower than it looks');
  } else if (holdings.length >= 3) {
    summaries.push('No highly correlated clusters detected - good diversification!');
  }

  // Build heatmap
  const heatmapTickers = validTickers.slice(0, 8);
  const heatmapData: number[][] = [];

  for (let i = 0; i < heatmapTickers.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < heatmapTickers.length; j++) {
      if (i === j) {
        row.push(1);
      } else {
        const pair = correlationMatrix.find(
          c => (c.t1 === heatmapTickers[i] && c.t2 === heatmapTickers[j]) ||
               (c.t1 === heatmapTickers[j] && c.t2 === heatmapTickers[i])
        );
        row.push(pair ? Math.round(pair.corr * 100) / 100 : 0);
      }
    }
    heatmapData.push(row);
  }

  const result: LeakDetectorResult = {
    correlationClusters,
    summaries,
    heatmapData: heatmapTickers.length >= 2 ? {
      tickers: heatmapTickers,
      matrix: heatmapData,
    } : null,
    partial: fetchResult.tickersPending.length > 0,
  };

  // Full cache (24h) only if all data is complete
  insightsCache.set(cacheKey, result, fetchResult.allCached ? 86400 : 300);

  return result;
}

// ============================================================================
// RISK FORECAST (MONTE CARLO) - PORTFOLIO-SPECIFIC STATISTICS
// ============================================================================

// Configuration for Monte Carlo
const MONTE_CARLO_SIMULATIONS = 5000;  // Number of simulation paths
const TRADING_DAYS_PER_YEAR = 252;
const RISK_FREE_RATE = 0.0;  // Assume 0 for Sharpe ratio (simplicity)

// Target lookback periods (in trading days)
const TARGET_LOOKBACK_1Y = 252;
const TARGET_LOOKBACK_6M = 126;
const TARGET_LOOKBACK_90D = 63;
const MIN_LOOKBACK_DAYS = 60;  // Minimum days needed for any analysis

/**
 * Calculate portfolio daily returns with forward-fill for missing data.
 * Returns { returns, lookbackDays, tickersCovered }
 */
function calculatePortfolioReturnsWithForwardFill(
  holdings: HoldingWithQuote[],
  candleData: Map<string, HistoricalCandles>,
  targetDays: number
): { returns: number[]; lookbackDays: number; tickersCovered: number } {
  const totalValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
  if (totalValue === 0) {
    return { returns: [], lookbackDays: 0, tickersCovered: 0 };
  }

  // Collect all available returns with their weights
  const holdingData: { weight: number; returns: number[]; ticker: string }[] = [];
  let maxLength = 0;

  for (const holding of holdings) {
    const candles = candleData.get(holding.ticker);
    if (!candles || candles.partial || candles.returns.length < MIN_LOOKBACK_DAYS) continue;

    const weight = holding.currentValue / totalValue;
    holdingData.push({
      weight,
      returns: candles.returns,
      ticker: holding.ticker,
    });
    maxLength = Math.max(maxLength, candles.returns.length);
  }

  if (holdingData.length === 0) {
    return { returns: [], lookbackDays: 0, tickersCovered: 0 };
  }

  // Use the shorter of maxLength or targetDays
  const lookbackDays = Math.min(maxLength, targetDays);

  // Build portfolio returns using forward-fill for missing data
  const portfolioReturns: number[] = [];

  for (let i = 0; i < lookbackDays; i++) {
    let dayReturn = 0;
    let totalWeightUsed = 0;

    for (const hd of holdingData) {
      // Calculate index from the end of each return series
      const idx = hd.returns.length - lookbackDays + i;

      if (idx >= 0 && idx < hd.returns.length) {
        // We have data for this day
        dayReturn += hd.weight * hd.returns[idx];
        totalWeightUsed += hd.weight;
      } else {
        // Forward-fill: use 0 return (hold position flat)
        totalWeightUsed += hd.weight;
      }
    }

    // Normalize if not all weight was used
    if (totalWeightUsed > 0 && totalWeightUsed < 0.99) {
      dayReturn = dayReturn / totalWeightUsed;
    }

    portfolioReturns.push(dayReturn);
  }

  return {
    returns: portfolioReturns,
    lookbackDays,
    tickersCovered: holdingData.length,
  };
}

/**
 * Calculate annualized return (CAGR) from daily returns
 */
function calculateAnnualizedReturn(returns: number[]): number | null {
  if (returns.length < MIN_LOOKBACK_DAYS) return null;

  // Calculate cumulative return
  let cumulative = 1;
  for (const r of returns) {
    cumulative *= (1 + r);
  }

  // Annualize: (1 + total_return)^(252/days) - 1
  const totalReturn = cumulative - 1;
  const years = returns.length / TRADING_DAYS_PER_YEAR;
  const annualized = Math.pow(1 + totalReturn, 1 / years) - 1;

  return annualized;
}

/**
 * Calculate Sharpe ratio (assuming rf=0)
 */
function calculateSharpeRatio(returns: number[], annualVol: number | null): number | null {
  if (returns.length < MIN_LOOKBACK_DAYS || annualVol === null || annualVol === 0) return null;

  const annualReturn = calculateAnnualizedReturn(returns);
  if (annualReturn === null) return null;

  // Sharpe = (return - rf) / volatility
  return (annualReturn - RISK_FREE_RATE) / annualVol;
}

/**
 * Run Monte Carlo simulation using Geometric Brownian Motion (GBM)
 * Uses portfolio-specific mu (mean return) and sigma (volatility)
 */
function runMonteCarloGBM(
  currentValue: number,
  dailyMean: number,
  dailyVol: number,
  numPaths: number,
  horizonDays: number
): { optimistic: number; baseCase: number; pessimistic: number } {
  const finalValues: number[] = [];

  // GBM: S(t+dt) = S(t) * exp((mu - 0.5*sigma^2)*dt + sigma*sqrt(dt)*Z)
  // For daily steps, dt = 1/252, but we use daily parameters directly
  const drift = dailyMean - 0.5 * dailyVol * dailyVol;

  for (let sim = 0; sim < numPaths; sim++) {
    let value = currentValue;

    for (let day = 0; day < horizonDays; day++) {
      // Box-Muller transform for normal random
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

      // GBM step
      const logReturn = drift + dailyVol * z;
      value *= Math.exp(logReturn);
    }

    finalValues.push(value);
  }

  // Sort for percentile calculation
  finalValues.sort((a, b) => a - b);

  const percentile = (arr: number[], p: number): number => {
    const idx = Math.floor(arr.length * p);
    return Math.round(arr[Math.min(idx, arr.length - 1)]);
  };

  return {
    pessimistic: percentile(finalValues, 0.1),   // 10th percentile
    baseCase: percentile(finalValues, 0.5),      // 50th percentile (median)
    optimistic: percentile(finalValues, 0.9),    // 90th percentile
  };
}

export async function getRiskForecast(): Promise<RiskForecast> {
  const cacheKey = 'risk-forecast';
  const cached = insightsCache.get<RiskForecast>(cacheKey);
  if (cached) return cached;

  const portfolio = await getPortfolio();
  const holdings = portfolio.holdings;
  const currentValue = portfolio.totalAssets;

  // Empty portfolio case
  if (holdings.length === 0 || currentValue <= 0) {
    const result: RiskForecast = {
      status: 'insufficient',
      basis: {
        lookbackDays: 0,
        dataQuality: 'fallback',
        tickersCovered: 0,
        tickersTotal: 0,
        note: 'No holdings in portfolio',
      },
      metrics: {
        annualReturn: null,
        annualVolatility: null,
        maxDrawdown: null,
        sharpeRatio: null,
      },
      scenarios: null,
      currentValue: 0,
    };
    return result;
  }

  // Fetch candle data for all holdings
  const tickers = holdings.map(h => h.ticker);
  const fetchResult = await getMultipleCandlesGradual(tickers, TARGET_LOOKBACK_1Y);
  const candleData = fetchResult.data;

  // Calculate portfolio returns with forward-fill
  // Try 1Y first, then fall back to 6M, then 90D
  let portfolioData = calculatePortfolioReturnsWithForwardFill(holdings, candleData, TARGET_LOOKBACK_1Y);

  if (portfolioData.returns.length < MIN_LOOKBACK_DAYS) {
    portfolioData = calculatePortfolioReturnsWithForwardFill(holdings, candleData, TARGET_LOOKBACK_6M);
  }

  if (portfolioData.returns.length < MIN_LOOKBACK_DAYS) {
    portfolioData = calculatePortfolioReturnsWithForwardFill(holdings, candleData, TARGET_LOOKBACK_90D);
  }

  const { returns: portfolioReturns, lookbackDays, tickersCovered } = portfolioData;
  const hasEnoughData = portfolioReturns.length >= MIN_LOOKBACK_DAYS;

  // Determine data quality
  let dataQuality: 'full' | 'partial' | 'fallback';
  let note: string | null = null;

  if (!hasEnoughData) {
    dataQuality = 'fallback';
    if (fetchResult.message.includes('paid plan')) {
      note = 'Historical data requires Finnhub paid plan. Showing placeholder.';
    } else if (fetchResult.tickersPending.length > 0) {
      note = `Caching price history (${fetchResult.tickersPending.length} tickers pending)`;
    } else {
      note = 'Insufficient historical data for analysis';
    }
  } else if (tickersCovered < holdings.length) {
    dataQuality = 'partial';
    note = `Based on ${tickersCovered} of ${holdings.length} holdings (${lookbackDays} trading days)`;
  } else if (lookbackDays < TARGET_LOOKBACK_1Y) {
    dataQuality = 'partial';
    note = `Based on ${lookbackDays} trading days (~${Math.round(lookbackDays / 21)} months)`;
  } else {
    dataQuality = 'full';
    note = `Based on ${lookbackDays} trading days of portfolio-weighted returns`;
  }

  // Calculate metrics
  let annualReturn: number | null = null;
  let annualVolatility: number | null = null;
  let maxDrawdown: number | null = null;
  let sharpeRatio: number | null = null;
  let scenarios: RiskForecastScenarios | null = null;

  if (hasEnoughData) {
    // Calculate annualized metrics from portfolio returns
    annualVolatility = calculateAnnualizedVolatility(portfolioReturns);
    annualReturn = calculateAnnualizedReturn(portfolioReturns);
    sharpeRatio = calculateSharpeRatio(portfolioReturns, annualVolatility);

    // Calculate historical max drawdown
    const equityCurve: number[] = [100];
    for (const ret of portfolioReturns) {
      equityCurve.push(equityCurve[equityCurve.length - 1] * (1 + ret));
    }
    maxDrawdown = calculateMaxDrawdown(equityCurve);

    // Run Monte Carlo simulation with portfolio-specific parameters
    const dailyMean = portfolioReturns.reduce((a, b) => a + b, 0) / portfolioReturns.length;
    const dailyVol = annualVolatility ? annualVolatility / Math.sqrt(TRADING_DAYS_PER_YEAR) : 0.01;

    scenarios = runMonteCarloGBM(
      currentValue,
      dailyMean,
      dailyVol,
      MONTE_CARLO_SIMULATIONS,
      TRADING_DAYS_PER_YEAR  // 1-year horizon
    );
  }

  // Determine status
  let status: 'ready' | 'caching' | 'insufficient';
  if (hasEnoughData) {
    status = fetchResult.tickersPending.length > 0 ? 'caching' : 'ready';
  } else if (fetchResult.tickersPending.length > 0) {
    status = 'caching';
  } else {
    status = 'insufficient';
  }

  const result: RiskForecast = {
    status,
    basis: {
      lookbackDays,
      dataQuality,
      tickersCovered,
      tickersTotal: holdings.length,
      note,
    },
    metrics: {
      annualReturn: annualReturn !== null ? Math.round(annualReturn * 10000) / 10000 : null,
      annualVolatility: annualVolatility !== null ? Math.round(annualVolatility * 10000) / 10000 : null,
      maxDrawdown: maxDrawdown !== null ? Math.round(maxDrawdown * 10000) / 10000 : null,
      sharpeRatio: sharpeRatio !== null ? Math.round(sharpeRatio * 100) / 100 : null,
    },
    scenarios,
    currentValue: Math.round(currentValue * 100) / 100,
  };

  // Cache: 24h if full data, 5min if still caching
  const cacheTtl = status === 'ready' && dataQuality === 'full' ? 86400 : 300;
  insightsCache.set(cacheKey, result, cacheTtl);

  return result;
}

// ============================================================================
// CACHE STATUS (for debugging/monitoring)
// ============================================================================

export function getInsightsCacheStatus(): {
  candleStats: ReturnType<typeof getCacheStats>;
  insightsCacheKeys: string[];
} {
  const keys = insightsCache.keys();
  return {
    candleStats: getCacheStats(),
    insightsCacheKeys: keys,
  };
}

/**
 * Clear all insights caches (for debugging/admin)
 */
export function clearAllInsightsCaches(): void {
  insightsCache.flushAll();
}
