import { getPortfolio } from './portfolio.service';
import { insightsCache } from '../utils/finnhub';
import {
  getMultipleCandlesGradual,
  HistoricalCandles,
} from '../utils/candle-cache';
import { HoldingWithQuote } from '../types';
import { getSector } from '../utils/sectors';

// Types
export type IntelligenceWindow = '1d' | '5d' | '1m';

export interface ContributorEntry {
  ticker: string;
  percentReturn: number | null;
  contributionDollar: number;
}

export interface SectorExposureEntry {
  sector: string;
  exposurePercent: number;
  exposureDollar: number;
}

export interface BetaResult {
  portfolioBeta: number;
  betaContributionPercent: number | null;
  spyReturnPercent: number;
  alphaPercent: number;
  dataNote: string;
}

export interface PortfolioIntelligenceResponse {
  window: IntelligenceWindow;
  contributors: ContributorEntry[];
  detractors: ContributorEntry[];
  sectorExposure: SectorExposureEntry[];
  beta: BetaResult | null;
  explanation: string;
  partial: boolean;
}

const CORRELATION_TRADING_DAYS = 180;
const MIN_BETA_DAYS = 60;

// ============================================================================
// STOCK-LEVEL ATTRIBUTION
// ============================================================================

interface HoldingContribution {
  ticker: string;
  contributionDollar: number;
  percentReturn: number | null;
}

async function computeContributions(
  holdings: HoldingWithQuote[],
  window: IntelligenceWindow
): Promise<{ contributions: HoldingContribution[]; candleData: Map<string, HistoricalCandles> | null }> {
  if (window === '1d') {
    const contributions = holdings.map(h => {
      // percentReturn = (currentPrice - previousClose) / previousClose * 100
      // dayChangePercent is already this value from the quote
      const percentReturn = (!h.priceUnavailable && h.currentPrice > 0)
        ? Math.round(h.dayChangePercent * 10) / 10
        : null;
      return {
        ticker: h.ticker,
        contributionDollar: Math.round(h.dayChange * 100) / 100,
        percentReturn,
      };
    });
    return { contributions, candleData: null };
  }

  const tickers = holdings.map(h => h.ticker);
  const fetchResult = await getMultipleCandlesGradual(tickers, CORRELATION_TRADING_DAYS);
  const candleData = fetchResult.data;
  const daysBack = window === '5d' ? 5 : 22;

  const contributions = holdings.map(h => {
    const candles = candleData.get(h.ticker);
    if (!candles || candles.partial || candles.closes.length < daysBack + 1) {
      return { ticker: h.ticker, contributionDollar: 0, percentReturn: null };
    }
    const currentPrice = candles.closes[candles.closes.length - 1];
    const referenceClose = candles.closes[candles.closes.length - 1 - daysBack];
    if (referenceClose <= 0) return { ticker: h.ticker, contributionDollar: 0, percentReturn: null };
    const priceChange = currentPrice - referenceClose;
    const percentReturn = Math.round(((currentPrice - referenceClose) / referenceClose) * 1000) / 10;
    return {
      ticker: h.ticker,
      contributionDollar: Math.round(h.shares * priceChange * 100) / 100,
      percentReturn,
    };
  });

  return { contributions, candleData };
}

function splitContributors(contributions: HoldingContribution[]): {
  contributors: ContributorEntry[];
  detractors: ContributorEntry[];
} {
  const sorted = [...contributions].sort((a, b) => b.contributionDollar - a.contributionDollar);

  const toEntry = (c: HoldingContribution): ContributorEntry => ({
    ticker: c.ticker,
    contributionDollar: c.contributionDollar,
    percentReturn: c.percentReturn,
  });

  const contributors = sorted.filter(c => c.contributionDollar > 0).slice(0, 5).map(toEntry);
  const detractors = sorted.filter(c => c.contributionDollar < 0).slice(-5).reverse().map(toEntry);

  return { contributors, detractors };
}

// ============================================================================
// SECTOR EXPOSURE
// ============================================================================

function computeSectorExposure(holdings: HoldingWithQuote[]): SectorExposureEntry[] {
  const totalValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
  if (totalValue === 0) return [];

  const sectorValues = new Map<string, number>();
  for (const h of holdings) {
    const sector = getSector(h.ticker);
    sectorValues.set(sector, (sectorValues.get(sector) || 0) + h.currentValue);
  }

  const result: SectorExposureEntry[] = [];
  for (const [sector, value] of sectorValues) {
    result.push({
      sector,
      exposurePercent: Math.round((value / totalValue) * 1000) / 10,
      exposureDollar: Math.round(value * 100) / 100,
    });
  }
  result.sort((a, b) => b.exposurePercent - a.exposurePercent);
  return result;
}

// ============================================================================
// BETA VS SPY
// ============================================================================

async function computeBeta(
  holdings: HoldingWithQuote[],
  existingCandleData: Map<string, HistoricalCandles> | null
): Promise<BetaResult | null> {
  // Fetch candle data if we don't have it yet
  const allTickers = holdings.map(h => h.ticker);
  const needSpy = !allTickers.includes('SPY');
  const tickersToFetch = needSpy ? [...allTickers, 'SPY'] : allTickers;

  let candleData: Map<string, HistoricalCandles>;
  if (existingCandleData && existingCandleData.has('SPY')) {
    candleData = existingCandleData;
  } else {
    const fetchResult = await getMultipleCandlesGradual(tickersToFetch, CORRELATION_TRADING_DAYS);
    candleData = fetchResult.data;
  }

  const spyCandles = candleData.get('SPY');
  if (!spyCandles || spyCandles.partial || spyCandles.returns.length < MIN_BETA_DAYS) {
    return null;
  }

  const spyReturns = spyCandles.returns;

  // Compute portfolio daily returns (weight × holding return)
  const totalValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
  if (totalValue === 0) return null;

  let minLen = spyReturns.length;
  const holdingData: { weight: number; returns: number[] }[] = [];

  for (const h of holdings) {
    const candles = candleData.get(h.ticker);
    if (!candles || candles.partial || candles.returns.length < MIN_BETA_DAYS) continue;
    const weight = h.currentValue / totalValue;
    holdingData.push({ weight, returns: candles.returns });
    minLen = Math.min(minLen, candles.returns.length);
  }

  if (holdingData.length === 0 || minLen < MIN_BETA_DAYS) return null;

  // Build aligned portfolio returns
  const portfolioReturns: number[] = [];
  const alignedSpyReturns: number[] = [];

  for (let i = 0; i < minLen; i++) {
    let dayReturn = 0;
    for (const hd of holdingData) {
      dayReturn += hd.weight * hd.returns[hd.returns.length - minLen + i];
    }
    portfolioReturns.push(dayReturn);
    alignedSpyReturns.push(spyReturns[spyReturns.length - minLen + i]);
  }

  // Linear regression: beta = Cov(port, spy) / Var(spy)
  const n = minLen;
  const meanPort = portfolioReturns.reduce((a, b) => a + b, 0) / n;
  const meanSpy = alignedSpyReturns.reduce((a, b) => a + b, 0) / n;

  let cov = 0;
  let varSpy = 0;
  for (let i = 0; i < n; i++) {
    const dp = portfolioReturns[i] - meanPort;
    const ds = alignedSpyReturns[i] - meanSpy;
    cov += dp * ds;
    varSpy += ds * ds;
  }

  if (varSpy === 0) return null;

  const beta = cov / varSpy;
  const alpha = meanPort - beta * meanSpy;

  // Annualize alpha
  const alphaAnnual = alpha * 252;

  // SPY cumulative return over the period
  let spyCum = 1;
  for (const r of alignedSpyReturns) spyCum *= (1 + r);
  const spyReturnPct = (spyCum - 1) * 100;

  // Portfolio cumulative return
  let portCum = 1;
  for (const r of portfolioReturns) portCum *= (1 + r);
  const portReturnPct = (portCum - 1) * 100;

  // Beta contribution percent: how much of portfolio return is explained by market
  const betaContributionPct = portReturnPct !== 0
    ? Math.round((beta * spyReturnPct / portReturnPct) * 1000) / 10
    : null;

  return {
    portfolioBeta: Math.round(beta * 100) / 100,
    betaContributionPercent: betaContributionPct,
    spyReturnPercent: Math.round(spyReturnPct * 100) / 100,
    alphaPercent: Math.round(alphaAnnual * 10000) / 100,
    dataNote: `Based on ${n} trading days`,
  };
}

// ============================================================================
// EXPLANATION GENERATOR
// ============================================================================

function generateExplanation(
  contributions: HoldingContribution[],
  window: IntelligenceWindow
): string {
  const totalPL = contributions.reduce((sum, c) => sum + c.contributionDollar, 0);
  if (totalPL === 0) return 'No significant portfolio movement in this period.';

  const sorted = [...contributions].sort((a, b) => Math.abs(b.contributionDollar) - Math.abs(a.contributionDollar));
  const top2 = sorted.slice(0, 2);
  const top2Sum = top2.reduce((sum, c) => sum + c.contributionDollar, 0);
  const top2Pct = Math.round(Math.abs(top2Sum / totalPL) * 100);

  const direction = totalPL > 0 ? 'gains' : 'losses';
  const windowLabel = window === '1d' ? "today's" : window === '5d' ? "this week's" : "this month's";

  const formatDollar = (n: number): string => {
    const sign = n >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  if (top2.length === 2) {
    return `${top2Pct}% of ${windowLabel} ${direction} came from ${top2[0].ticker} (${formatDollar(top2[0].contributionDollar)}) and ${top2[1].ticker} (${formatDollar(top2[1].contributionDollar)}).`;
  } else if (top2.length === 1) {
    return `${top2Pct}% of ${windowLabel} ${direction} came from ${top2[0].ticker} (${formatDollar(top2[0].contributionDollar)}).`;
  }
  return 'No significant portfolio movement in this period.';
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

export async function getPortfolioIntelligence(
  window: IntelligenceWindow = '1d'
): Promise<PortfolioIntelligenceResponse> {
  const cacheKey = `intelligence:${window}`;
  const cached = insightsCache.get<PortfolioIntelligenceResponse>(cacheKey);
  if (cached) return cached;

  const portfolio = await getPortfolio();
  const holdings = portfolio.holdings;

  if (holdings.length === 0) {
    return {
      window,
      contributors: [],
      detractors: [],
      sectorExposure: [],
      beta: null,
      explanation: 'Add holdings to see portfolio intelligence.',
      partial: true,
    };
  }

  // Compute attribution
  const { contributions, candleData } = await computeContributions(holdings, window);
  const { contributors, detractors } = splitContributors(contributions);

  // Compute sector exposure
  const sectorExposure = computeSectorExposure(holdings);

  // Compute beta (reuse candle data if available)
  const beta = await computeBeta(holdings, candleData);

  // Generate explanation
  const explanation = generateExplanation(contributions, window);

  const hasContributions = contributors.length > 0 || detractors.length > 0;
  const isIncomplete = window !== '1d' && !hasContributions;

  const result: PortfolioIntelligenceResponse = {
    window,
    contributors,
    detractors,
    sectorExposure,
    beta,
    explanation,
    partial: isIncomplete,
  };

  // Short TTL if data is incomplete (candles still caching), otherwise normal TTL
  const ttl = isIncomplete ? 60 : (window === '1d' ? 300 : 3600);
  insightsCache.set(cacheKey, result, ttl);

  return result;
}
