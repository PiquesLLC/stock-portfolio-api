import { getPortfolio } from './portfolio.service';
import { getAllSnapshots } from './snapshot.service';
import { insightsCache } from '../utils/finnhub';
import {
  getMultipleCandlesGradual,
  HistoricalCandles,
  getCacheStats,
  getBenchmarkReturns,
} from '../utils/candle-cache';
import {
  HealthScore,
  HealthScoreDetails,
  Attribution,
  LeakDetectorResult,
  RiskForecast,
  RiskForecastScenarios,
  HoldingWithQuote,
} from '../types';
import { getSector } from '../utils/sectors';



// Reduced trading days for correlation (9 months instead of 1 year)
const CORRELATION_TRADING_DAYS = 180;
// Minimum days needed for analysis
const MIN_CORRELATION_DAYS = 60;
// Minimum days for Monte Carlo

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

/**
 * Calculate max drawdown returning both the percentage and the peak/trough dates.
 */
function calculateMaxDrawdownWithDates(values: number[], _timestamps?: Date[]): {
  maxDD: number | null;
  peakIdx: number;
  troughIdx: number;
} {
  if (values.length < 2) return { maxDD: null, peakIdx: 0, troughIdx: 0 };

  let peak = values[0];
  let peakIdx = 0;
  let maxDD = 0;
  let ddPeakIdx = 0;
  let ddTroughIdx = 0;

  for (let i = 0; i < values.length; i++) {
    if (values[i] > peak) {
      peak = values[i];
      peakIdx = i;
    }
    const dd = (peak - values[i]) / peak;
    if (dd > maxDD) {
      maxDD = dd;
      ddPeakIdx = peakIdx;
      ddTroughIdx = i;
    }
  }

  return { maxDD, peakIdx: ddPeakIdx, troughIdx: ddTroughIdx };
}

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

  // ============================================================
  // CONCENTRATION DETAIL
  // ============================================================
  const concCalc: string[] = [
    'Score starts at 25/25.',
    'Penalise if largest holding > 25% of portfolio (up to -15 pts).',
    'Penalise if top 3 holdings > 55% of portfolio (up to -10 pts).',
  ];
  const concEvidence: string[] = [];
  const concDrivers: { label: string; value: string; impact: string }[] = [];
  const concFixes: string[] = [];

  if (holdings.length > 0 && portfolio.holdingsValue > 0) {
    const sortedByValue = [...holdings].sort((a, b) => b.currentValue - a.currentValue);
    const top1Pct = (sortedByValue[0]?.currentValue || 0) / portfolio.holdingsValue * 100;
    const top3Value = sortedByValue.slice(0, 3).reduce((sum, h) => sum + h.currentValue, 0);
    const top3Pct = (top3Value / portfolio.holdingsValue) * 100;
    const top5Value = sortedByValue.slice(0, 5).reduce((sum, h) => sum + h.currentValue, 0);
    const top5Pct = (top5Value / portfolio.holdingsValue) * 100;

    concEvidence.push(
      `Largest holding: ${sortedByValue[0].ticker} at ${top1Pct.toFixed(1)}% ($${Math.round(sortedByValue[0].currentValue).toLocaleString()}).`,
      `Top 3 holdings: ${sortedByValue.slice(0, 3).map(h => h.ticker).join(', ')} = ${top3Pct.toFixed(1)}%.`,
      `Top 5 holdings: ${top5Pct.toFixed(1)}% of portfolio.`,
      `Holdings value: $${Math.round(portfolio.holdingsValue).toLocaleString()}.`,
    );

    if (top1Pct > 25) {
      const penalty = Math.min(15, (top1Pct - 25) * 0.5);
      concentrationScore -= penalty;
      reasons.push(`${sortedByValue[0].ticker} is ${top1Pct.toFixed(0)}% of portfolio (>25% threshold)`);
      concDrivers.push({
        label: `${sortedByValue[0].ticker} weight`,
        value: `${top1Pct.toFixed(1)}%`,
        impact: `-${penalty.toFixed(1)} pts (threshold 25%)`,
      });
      concFixes.push(`Consider trimming ${sortedByValue[0].ticker} to below 25% of portfolio.`);
      quickFixes.push(`Consider trimming ${sortedByValue[0].ticker} to reduce single-stock risk`);
    } else {
      concDrivers.push({
        label: `${sortedByValue[0].ticker} weight`,
        value: `${top1Pct.toFixed(1)}%`,
        impact: 'Within 25% threshold - no penalty.',
      });
    }

    if (top3Pct > 55) {
      const penalty = Math.min(10, (top3Pct - 55) * 0.3);
      concentrationScore -= penalty;
      concDrivers.push({
        label: 'Top 3 weight',
        value: `${top3Pct.toFixed(1)}%`,
        impact: `-${penalty.toFixed(1)} pts (threshold 55%)`,
      });
      if (reasons.length === 0) {
        reasons.push(`Top 3 holdings are ${top3Pct.toFixed(0)}% of portfolio (>55% threshold)`);
      }
      concFixes.push('Reduce top-3 concentration below 55% by adding new positions.');
    } else {
      concDrivers.push({
        label: 'Top 3 weight',
        value: `${top3Pct.toFixed(1)}%`,
        impact: 'Within 55% threshold - no penalty.',
      });
    }
  } else if (holdings.length === 0) {
    concentrationScore = 0;
    concEvidence.push('No holdings in portfolio.');
    reasons.push('No holdings in portfolio');
    quickFixes.push('Add holdings to build a diversified portfolio');
  }

  // ============================================================
  // VOLATILITY DETAIL
  // ============================================================
  const volCalc: string[] = [
    'Score starts at 25/25.',
    'Computed from annualized standard deviation of daily portfolio snapshot returns.',
    '>40% annualized -> 5/25, >25% -> 15/25, >15% -> 20/25, <=15% -> 25/25.',
  ];
  const volEvidence: string[] = [];
  const volDrivers: { label: string; value: string; impact: string }[] = [];
  const volFixes: string[] = [];

  let computedVol: number | null = null;
  if (snapshots.length >= 30) {
    const values = snapshots.map(s => s.totalValue);
    const returns: number[] = [];
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] > 0) {
        returns.push((values[i] - values[i - 1]) / values[i - 1]);
      }
    }

    computedVol = calculateAnnualizedVolatility(returns);
    volEvidence.push(`Snapshots used: ${snapshots.length} (${returns.length} daily returns).`);
    if (snapshots.length > 0) {
      const oldest = snapshots[0].timestamp;
      const newest = snapshots[snapshots.length - 1].timestamp;
      volEvidence.push(`Date range: ${oldest.toISOString().slice(0, 10)} to ${newest.toISOString().slice(0, 10)}.`);
    }

    if (computedVol !== null) {
      const volPct = (computedVol * 100).toFixed(1);
      volEvidence.push(`Portfolio annualized volatility: ${volPct}%.`);

      if (computedVol > 0.4) {
        volatilityScore = 5;
        reasons.push(`Very high volatility (${(computedVol * 100).toFixed(0)}% annualized)`);
        volDrivers.push({ label: 'Annualized vol', value: `${volPct}%`, impact: 'Score set to 5/25 (>40% threshold).' });
        volFixes.push('Add lower-volatility assets (bonds, dividend stocks, or broad-market ETFs).');
        quickFixes.push('Add lower-volatility assets like bonds or dividend stocks');
      } else if (computedVol > 0.25) {
        volatilityScore = 15;
        reasons.push(`Elevated volatility (${(computedVol * 100).toFixed(0)}% annualized)`);
        volDrivers.push({ label: 'Annualized vol', value: `${volPct}%`, impact: 'Score set to 15/25 (>25% threshold).' });
        volFixes.push('Consider adding lower-vol assets to bring portfolio vol below 25%.');
      } else if (computedVol > 0.15) {
        volatilityScore = 20;
        volDrivers.push({ label: 'Annualized vol', value: `${volPct}%`, impact: 'Score set to 20/25 (>15% threshold).' });
      } else {
        volDrivers.push({ label: 'Annualized vol', value: `${volPct}%`, impact: 'Full score - below 15% threshold.' });
      }
    }
  } else {
    volEvidence.push(`Only ${snapshots.length} snapshots available (need 30+ for volatility analysis).`);
    volDrivers.push({ label: 'Data', value: `${snapshots.length} snapshots`, impact: 'Insufficient data - default score 25/25.' });
  }

  // ============================================================
  // DRAWDOWN DETAIL
  // ============================================================
  const ddCalc: string[] = [
    'Score starts at 25/25.',
    'Max drawdown = largest peak-to-trough decline in portfolio snapshot history.',
    '>20% -> 5/25, >10% -> 15/25, >5% -> 20/25, <=5% -> 25/25.',
  ];
  const ddEvidence: string[] = [];
  const ddDrivers: { label: string; value: string; impact: string }[] = [];
  const ddFixes: string[] = [];

  if (snapshots.length >= 30) {
    const values = snapshots.map(s => s.totalValue);
    const { maxDD, peakIdx, troughIdx } = calculateMaxDrawdownWithDates(values);

    ddEvidence.push(`Snapshots analysed: ${snapshots.length}.`);
    if (snapshots.length > 0) {
      ddEvidence.push(`Period: ${snapshots[0].timestamp.toISOString().slice(0, 10)} to ${snapshots[snapshots.length - 1].timestamp.toISOString().slice(0, 10)}.`);
    }

    if (maxDD !== null) {
      const ddPct = (maxDD * 100).toFixed(1);
      const peakDate = snapshots[peakIdx]?.timestamp?.toISOString().slice(0, 10) || '?';
      const troughDate = snapshots[troughIdx]?.timestamp?.toISOString().slice(0, 10) || '?';
      ddEvidence.push(`Max drawdown: -${ddPct}% (peak ${peakDate} -> trough ${troughDate}).`);
      ddEvidence.push(`Peak value: $${Math.round(values[peakIdx]).toLocaleString()}, trough value: $${Math.round(values[troughIdx]).toLocaleString()}.`);

      if (maxDD > 0.2) {
        drawdownScore = 5;
        ddDrivers.push({ label: 'Max drawdown', value: `-${ddPct}%`, impact: 'Score set to 5/25 (>20% threshold).' });
        if (!reasons.some(r => r.includes('drawdown'))) {
          reasons.push(`Historical max drawdown of ${(maxDD * 100).toFixed(0)}%`);
        }
        ddFixes.push('Consider adding defensive positions to limit future drawdowns.');
      } else if (maxDD > 0.1) {
        drawdownScore = 15;
        ddDrivers.push({ label: 'Max drawdown', value: `-${ddPct}%`, impact: 'Score set to 15/25 (>10% threshold).' });
      } else if (maxDD > 0.05) {
        drawdownScore = 20;
        ddDrivers.push({ label: 'Max drawdown', value: `-${ddPct}%`, impact: 'Score set to 20/25 (>5% threshold).' });
      } else {
        ddDrivers.push({ label: 'Max drawdown', value: `-${ddPct}%`, impact: 'Full score - below 5% threshold.' });
      }
    }
  } else {
    ddEvidence.push(`Only ${snapshots.length} snapshots available (need 30+ for drawdown analysis).`);
    ddDrivers.push({ label: 'Data', value: `${snapshots.length} snapshots`, impact: 'Insufficient data - default score 25/25.' });
  }

  // ============================================================
  // DIVERSIFICATION DETAIL
  // ============================================================
  const divCalc: string[] = [
    '15+ holdings -> 25/25, 10-14 -> 22, 7-9 -> 18, 5-6 -> 15, 3-4 -> 10, <3 -> 5.',
    'Also penalised if sector concentration is extreme (HHI of weights).',
  ];
  const divEvidence: string[] = [];
  const divDrivers: { label: string; value: string; impact: string }[] = [];
  const divFixes: string[] = [];

  // Compute HHI and sector stats
  const totalValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
  const hhi = totalValue > 0
    ? holdings.reduce((sum, h) => sum + Math.pow(h.currentValue / totalValue, 2), 0)
    : 0;
  const sectorValues = new Map<string, number>();
  for (const h of holdings) {
    const sector = getSector(h.ticker);
    sectorValues.set(sector, (sectorValues.get(sector) || 0) + h.currentValue);
  }
  const sectorsSorted = Array.from(sectorValues.entries())
    .map(([sector, val]) => ({ sector, pct: totalValue > 0 ? (val / totalValue) * 100 : 0 }))
    .sort((a, b) => b.pct - a.pct);

  divEvidence.push(`Number of holdings: ${holdings.length}.`);
  divEvidence.push(`Number of sectors: ${sectorValues.size}.`);
  divEvidence.push(`HHI (Herfindahl index): ${hhi.toFixed(4)} (lower is better; 1/${holdings.length || 1} = ${holdings.length > 0 ? (1 / holdings.length).toFixed(4) : 'N/A'} is ideal).`);
  if (sectorsSorted.length > 0) {
    divEvidence.push(`Largest sector: ${sectorsSorted[0].sector} at ${sectorsSorted[0].pct.toFixed(1)}%.`);
    divEvidence.push(`Sectors: ${sectorsSorted.map(s => `${s.sector} ${s.pct.toFixed(1)}%`).join(', ')}.`);
  }

  if (holdings.length >= 15) {
    diversificationScore = 25;
    divDrivers.push({ label: 'Holdings count', value: `${holdings.length}`, impact: 'Full score (>=15 holdings).' });
  } else if (holdings.length >= 10) {
    diversificationScore = 22;
    divDrivers.push({ label: 'Holdings count', value: `${holdings.length}`, impact: '22/25 (10-14 holdings).' });
  } else if (holdings.length >= 7) {
    diversificationScore = 18;
    divDrivers.push({ label: 'Holdings count', value: `${holdings.length}`, impact: '18/25 (7-9 holdings).' });
  } else if (holdings.length >= 5) {
    diversificationScore = 15;
    divDrivers.push({ label: 'Holdings count', value: `${holdings.length}`, impact: '15/25 (5-6 holdings).' });
    divFixes.push('Adding 2-3 more positions from underrepresented sectors would improve this score.');
  } else if (holdings.length >= 3) {
    diversificationScore = 10;
    divDrivers.push({ label: 'Holdings count', value: `${holdings.length}`, impact: '10/25 (3-4 holdings).' });
    if (!reasons.some(r => r.includes('diversif'))) {
      reasons.push('Limited diversification with only ' + holdings.length + ' holdings');
      quickFixes.push('Consider adding more uncorrelated assets');
    }
    divFixes.push('Consider adding more uncorrelated assets from different sectors.');
  } else {
    diversificationScore = 5;
    divDrivers.push({ label: 'Holdings count', value: `${holdings.length}`, impact: '5/25 (<3 holdings).' });
    reasons.push('Very limited diversification');
    divFixes.push('Build a diversified portfolio with at least 7-10 holdings across multiple sectors.');
  }

  if (sectorsSorted.length > 0 && sectorsSorted[0].pct > 50) {
    divDrivers.push({ label: `${sectorsSorted[0].sector} sector`, value: `${sectorsSorted[0].pct.toFixed(1)}%`, impact: 'Over 50% in one sector - consider rebalancing.' });
  }

  // ============================================================
  // MARGIN PENALTY DETAIL
  // ============================================================
  const marginCalc: string[] = [
    'Penalty = min(15, marginRatio * 30).',
    'marginRatio = marginDebt / totalAssets.',
  ];
  const marginEvidence: string[] = [];
  const marginDrivers: { label: string; value: string; impact: string }[] = [];
  const marginFixes: string[] = [];

  if (portfolio.marginDebt > 0 && portfolio.totalAssets > 0) {
    const marginRatio = portfolio.marginDebt / portfolio.totalAssets;
    marginPenalty = Math.min(15, marginRatio * 30);

    marginEvidence.push(`Margin debt: $${Math.round(portfolio.marginDebt).toLocaleString()}.`);
    marginEvidence.push(`Total assets: $${Math.round(portfolio.totalAssets).toLocaleString()}.`);
    marginEvidence.push(`Margin ratio: ${(marginRatio * 100).toFixed(1)}%.`);
    marginEvidence.push(`Penalty: -${marginPenalty.toFixed(1)} points.`);

    marginDrivers.push({
      label: 'Margin ratio',
      value: `${(marginRatio * 100).toFixed(1)}%`,
      impact: `-${marginPenalty.toFixed(1)} pts`,
    });

    if (marginRatio > 0.1) {
      reasons.push(`Using ${(marginRatio * 100).toFixed(0)}% margin (increases risk)`);
      quickFixes.push('Consider reducing margin debt to lower risk');
      marginFixes.push('Reducing margin debt would directly improve your health score.');
    }
  } else {
    marginEvidence.push('No margin debt - no penalty applied.');
  }

  // ============================================================
  // ASSEMBLE RESULT
  // ============================================================
  const rawScore = concentrationScore + volatilityScore + drawdownScore + diversificationScore;
  const overall = Math.max(0, Math.min(100, Math.round(rawScore - marginPenalty)));

  const details: HealthScoreDetails = {
    concentration: {
      score: Math.max(0, Math.round(concentrationScore)),
      maxScore: 25,
      calcBullets: concCalc,
      evidenceBullets: concEvidence,
      drivers: concDrivers,
      quickFixes: concFixes,
    },
    volatility: {
      score: Math.max(0, Math.round(volatilityScore)),
      maxScore: 25,
      calcBullets: volCalc,
      evidenceBullets: volEvidence,
      drivers: volDrivers,
      quickFixes: volFixes,
    },
    drawdown: {
      score: Math.max(0, Math.round(drawdownScore)),
      maxScore: 25,
      calcBullets: ddCalc,
      evidenceBullets: ddEvidence,
      drivers: ddDrivers,
      quickFixes: ddFixes,
    },
    diversification: {
      score: Math.max(0, Math.round(diversificationScore)),
      maxScore: 25,
      calcBullets: divCalc,
      evidenceBullets: divEvidence,
      drivers: divDrivers,
      quickFixes: divFixes,
    },
    margin: {
      penalty: Math.round(marginPenalty),
      calcBullets: marginCalc,
      evidenceBullets: marginEvidence,
      drivers: marginDrivers,
      quickFixes: marginFixes,
    },
  };

  const result: HealthScore = {
    overall,
    breakdown: {
      concentration: details.concentration.score,
      volatility: details.volatility.score,
      drawdown: details.drawdown.score,
      diversification: details.diversification.score,
      margin: details.margin.penalty,
    },
    reasons: reasons.slice(0, 3),
    quickFixes: quickFixes.slice(0, 2),
    partial: holdings.length === 0,
    details,
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
      winnersCount: 0,
      losersCount: 0,
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
      if (!candles || candles.closes.length < 2) {
        return { ticker: h.ticker, contributionDollar: 0, contributionPct: 0 };
      }

      // Use available data: go back daysBack if possible, otherwise use earliest available
      const availableBack = Math.min(daysBack, candles.closes.length - 1);
      const currentPrice = candles.closes[candles.closes.length - 1];
      const pastPrice = candles.closes[candles.closes.length - 1 - availableBack];

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

  const winnersCount = contributions.filter(c => c.contributionDollar > 0).length;
  const losersCount = contributions.filter(c => c.contributionDollar < 0).length;

  const result: Attribution = {
    window,
    topContributors,
    topDetractors,
    winnersCount,
    losersCount,
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
      spyCorrelation: null,
      suggestedActions: [],
      hiddenConcentration: false,
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
      spyCorrelation: null,
      suggestedActions: [],
      hiddenConcentration: false,
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

  // Compute portfolio vs SPY correlation using weighted portfolio returns
  let spyCorrelation: number | null = null;
  const spyReturns = getBenchmarkReturns('SPY', CORRELATION_TRADING_DAYS);
  if (spyReturns && spyReturns.length >= MIN_CORRELATION_DAYS && tickersWithData.length > 0) {
    // Build weighted portfolio daily returns
    const totalValue = sortedHoldings.reduce((s, h) => s + h.currentValue, 0);
    const minLen = Math.min(spyReturns.length, ...tickersWithData.map(c => c.returns.length));
    if (minLen >= MIN_CORRELATION_DAYS) {
      const portfolioReturns: number[] = [];
      for (let d = 0; d < minLen; d++) {
        let dayReturn = 0;
        for (const c of tickersWithData) {
          const holding = sortedHoldings.find(h => h.ticker === c.ticker);
          const weight = holding ? holding.currentValue / totalValue : 0;
          if (d < c.returns.length) {
            dayReturn += weight * c.returns[d];
          }
        }
        portfolioReturns.push(dayReturn);
      }
      const trimmedSpy = spyReturns.slice(spyReturns.length - minLen);
      const corr = calculateCorrelation(portfolioReturns, trimmedSpy);
      if (corr !== null) {
        spyCorrelation = Math.round(corr * 100) / 100;
      }
    }
  }

  // Compute hidden concentration: effective diversification < 50% of holding count
  // "Effective" holdings = those not highly correlated with each other
  let hiddenConcentration = false;
  if (holdings.length >= 4 && correlationClusters.length > 0) {
    const clusteredTickers = new Set(correlationClusters.flatMap(c => c.tickers));
    const effectiveCount = holdings.length - clusteredTickers.size + correlationClusters.length;
    hiddenConcentration = effectiveCount < holdings.length * 0.5;
  }

  // Generate suggested actions (factual observations, not advice)
  const suggestedActions: string[] = [];
  if (correlationClusters.length > 0) {
    suggestedActions.push(`${correlationClusters.length} group(s) of correlated holdings reduce effective diversification.`);
  }
  if (hiddenConcentration) {
    suggestedActions.push(`Effective diversification is less than half the number of holdings due to correlation overlap.`);
  }
  if (spyCorrelation !== null && Math.abs(spyCorrelation) > 0.85) {
    suggestedActions.push(`Portfolio closely tracks the S&P 500 (${(spyCorrelation * 100).toFixed(0)}% correlation). Adding uncorrelated assets would increase diversification.`);
  }
  if (holdings.length < 5 && holdings.length > 0) {
    suggestedActions.push(`Portfolio has only ${holdings.length} holding(s). Broader exposure could reduce single-stock risk.`);
  }

  const result: LeakDetectorResult = {
    correlationClusters,
    summaries,
    heatmapData: heatmapTickers.length >= 2 ? {
      tickers: heatmapTickers,
      matrix: heatmapData,
    } : null,
    partial: fetchResult.tickersPending.length > 0,
    spyCorrelation,
    suggestedActions,
    hiddenConcentration,
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
  // If paid plan is required, don't show as "caching" since it won't complete
  const paidPlanRequired = fetchResult.message.includes('paid plan');
  let status: 'ready' | 'caching' | 'insufficient';
  if (hasEnoughData) {
    status = (fetchResult.tickersPending.length > 0 && !paidPlanRequired) ? 'caching' : 'ready';
  } else if (fetchResult.tickersPending.length > 0 && !paidPlanRequired) {
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

