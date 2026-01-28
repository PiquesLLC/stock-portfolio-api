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
  HoldingWithQuote,
} from '../types';
import { config } from '../config';

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
  // Simple sector grouping by ticker patterns
  // This is a heuristic - real implementation would use sector data
  const sectorGroups: Record<string, string[]> = {
    'Tech': ['AAPL', 'MSFT', 'GOOGL', 'GOOG', 'META', 'AMZN', 'NVDA', 'AMD', 'INTC', 'TSLA', 'CRM', 'ORCL', 'ADBE', 'NFLX'],
    'Finance': ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'V', 'MA', 'AXP', 'BRK.A', 'BRK.B', 'SCHW', 'BLK'],
    'Healthcare': ['JNJ', 'UNH', 'PFE', 'ABBV', 'MRK', 'LLY', 'TMO', 'ABT', 'DHR', 'BMY', 'AMGN', 'CVS'],
    'Energy': ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'OXY', 'KMI'],
    'Consumer': ['WMT', 'PG', 'KO', 'PEP', 'COST', 'HD', 'NKE', 'MCD', 'SBUX', 'TGT', 'LOW'],
    'Industrial': ['CAT', 'DE', 'BA', 'HON', 'UPS', 'LMT', 'GE', 'RTX', 'MMM', 'UNP'],
    'ETF/Index': ['SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO', 'VEA', 'VWO', 'BND', 'AGG', 'VNQ', 'XLF', 'XLK', 'XLE'],
  };

  const totalValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
  if (totalValue === 0) return { apparentDiversification: 0, effectiveDiversification: 0, sectorConcentration: [] };

  const sectorValues = new Map<string, number>();

  for (const holding of holdings) {
    let sector = 'Other';
    for (const [s, tickers] of Object.entries(sectorGroups)) {
      if (tickers.includes(holding.ticker.toUpperCase())) {
        sector = s;
        break;
      }
    }
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
// RISK FORECAST (MONTE CARLO) - WITH GRACEFUL DEGRADATION
// ============================================================================

// S&P 500 historical stats (fallback values)
const SPY_ANNUAL_VOL = 0.16; // ~16% annualized volatility
const SPY_ANNUAL_RETURN = config.sp500CagrTotalReturn || 0.10;

export async function getRiskForecast(): Promise<RiskForecast> {
  const cacheKey = 'risk-forecast';
  const cached = insightsCache.get<RiskForecast>(cacheKey);
  if (cached) return cached;

  const portfolio = await getPortfolio();
  const holdings = portfolio.holdings;
  const currentValue = portfolio.totalAssets;

  if (holdings.length === 0 || currentValue <= 0) {
    return {
      expectedAnnualVol: null,
      maxDrawdown1y: null,
      monteCarloBands: null,
      partial: true,
    };
  }

  // Use gradual candle fetching
  const tickers = holdings.map(h => h.ticker);
  const fetchResult = await getMultipleCandlesGradual(tickers, CORRELATION_TRADING_DAYS);
  const candleData = fetchResult.data;

  // Calculate portfolio returns from available data
  let portfolioReturns = calculatePortfolioReturns(holdings, candleData, MIN_MONTE_CARLO_DAYS);

  // Check if we have enough data
  const hasEnoughData = portfolioReturns.length >= MIN_MONTE_CARLO_DAYS;

  let expectedAnnualVol: number | null = null;
  let maxDrawdown1y: number | null = null;
  let monteCarloBands: { p10: number; p50: number; p90: number } | null = null;
  let partial = !fetchResult.allCached;

  if (hasEnoughData) {
    // Full analysis with actual portfolio data
    expectedAnnualVol = calculateAnnualizedVolatility(portfolioReturns);

    // Calculate historical max drawdown
    const equityCurve: number[] = [100];
    for (const ret of portfolioReturns) {
      equityCurve.push(equityCurve[equityCurve.length - 1] * (1 + ret));
    }
    maxDrawdown1y = calculateMaxDrawdown(equityCurve);

    // Monte Carlo simulation
    const numSimulations = 500;
    const tradingDaysPerYear = 252;

    const dailyMean = portfolioReturns.reduce((a, b) => a + b, 0) / portfolioReturns.length;
    const dailyVol = expectedAnnualVol ? expectedAnnualVol / Math.sqrt(252) : 0.01;

    const finalValues: number[] = [];

    for (let sim = 0; sim < numSimulations; sim++) {
      let value = currentValue;
      for (let day = 0; day < tradingDaysPerYear; day++) {
        const u1 = Math.random();
        const u2 = Math.random();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const dailyReturn = dailyMean + dailyVol * z;
        value *= (1 + dailyReturn);
      }
      finalValues.push(value);
    }

    finalValues.sort((a, b) => a - b);

    const percentile = (arr: number[], p: number) => {
      const idx = Math.floor(arr.length * p);
      return Math.round(arr[idx]);
    };

    monteCarloBands = {
      p10: percentile(finalValues, 0.1),
      p50: percentile(finalValues, 0.5),
      p90: percentile(finalValues, 0.9),
    };
  } else {
    // Fallback: use SPY volatility for basic scenario bands
    expectedAnnualVol = SPY_ANNUAL_VOL;

    // Simple scenario-based projection (no simulation)
    const dailyVol = expectedAnnualVol / Math.sqrt(252);
    const dailyMean = SPY_ANNUAL_RETURN / 252;

    // Estimate bands based on normal distribution
    // p10 = mean - 1.28 * std, p90 = mean + 1.28 * std
    const annualMean = dailyMean * 252;
    const annualStd = dailyVol * Math.sqrt(252);

    monteCarloBands = {
      p10: Math.round(currentValue * (1 + annualMean - 1.28 * annualStd)),
      p50: Math.round(currentValue * (1 + annualMean)),
      p90: Math.round(currentValue * (1 + annualMean + 1.28 * annualStd)),
    };

    partial = true;
  }

  const result: RiskForecast = {
    expectedAnnualVol: expectedAnnualVol ? Math.round(expectedAnnualVol * 10000) / 10000 : null,
    maxDrawdown1y: maxDrawdown1y ? Math.round(maxDrawdown1y * 10000) / 10000 : null,
    monteCarloBands,
    partial,
  };

  // Longer cache if plan limitation (24h), otherwise short (5min) for still caching
  const isPlanLimit = fetchResult.message.includes('paid plan');
  const cacheTtl = hasEnoughData && fetchResult.allCached ? 86400 : (isPlanLimit ? 86400 : 300);
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
