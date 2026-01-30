import { getPortfolio } from './portfolio.service';
import { getRecentHoldingSnapshots } from './snapshot.service';
import { insightsCache } from '../utils/finnhub';
import {
  getMultipleCandlesGradual,
  HistoricalCandles,
} from '../utils/candle-cache';
import { HoldingWithQuote, HeroStats } from '../types';
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
  tickers: { ticker: string; valueDollar: number; valuePercent: number }[];
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
  heroStats: HeroStats | null;
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
  const sectorTickers = new Map<string, { ticker: string; value: number }[]>();
  for (const h of holdings) {
    const sector = getSector(h.ticker);
    sectorValues.set(sector, (sectorValues.get(sector) || 0) + h.currentValue);
    if (!sectorTickers.has(sector)) sectorTickers.set(sector, []);
    sectorTickers.get(sector)!.push({ ticker: h.ticker, value: h.currentValue });
  }

  const result: SectorExposureEntry[] = [];
  for (const [sector, value] of sectorValues) {
    const tickers = (sectorTickers.get(sector) || [])
      .sort((a, b) => b.value - a.value)
      .map(t => ({
        ticker: t.ticker,
        valueDollar: Math.round(t.value * 100) / 100,
        valuePercent: Math.round((t.value / totalValue) * 1000) / 10,
      }));
    result.push({
      sector,
      exposurePercent: Math.round((value / totalValue) * 1000) / 10,
      exposureDollar: Math.round(value * 100) / 100,
      tickers,
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
  const windowLabel = window === '1d' ? "today's" : window === '5d' ? "this week's" : "this month's";

  const formatDollar = (n: number): string => {
    return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  const gainers = contributions.filter(c => c.contributionDollar > 0).sort((a, b) => b.contributionDollar - a.contributionDollar);
  const losers = contributions.filter(c => c.contributionDollar < 0).sort((a, b) => a.contributionDollar - b.contributionDollar);

  const totalGains = gainers.reduce((sum, c) => sum + c.contributionDollar, 0);
  const totalLosses = losers.reduce((sum, c) => sum + Math.abs(c.contributionDollar), 0);

  const parts: string[] = [];

  // Gains sentence
  if (gainers.length > 0 && totalGains > 0) {
    const top = gainers.slice(0, 2);
    const topSum = top.reduce((sum, c) => sum + c.contributionDollar, 0);
    const pct = Math.round((topSum / totalGains) * 100);
    if (top.length === 2) {
      parts.push(`${pct}% of ${windowLabel} gains came from ${top[0].ticker} (+${formatDollar(top[0].contributionDollar)}) and ${top[1].ticker} (+${formatDollar(top[1].contributionDollar)})`);
    } else {
      parts.push(`${pct}% of ${windowLabel} gains came from ${top[0].ticker} (+${formatDollar(top[0].contributionDollar)})`);
    }
  }

  // Losses sentence
  if (losers.length > 0 && totalLosses > 0) {
    const top = losers.slice(0, 2);
    const topSum = top.reduce((sum, c) => sum + Math.abs(c.contributionDollar), 0);
    const pct = Math.round((topSum / totalLosses) * 100);
    if (top.length === 2) {
      parts.push(`${pct}% of ${windowLabel} losses came from ${top[0].ticker} (-${formatDollar(top[0].contributionDollar)}) and ${top[1].ticker} (-${formatDollar(top[1].contributionDollar)})`);
    } else {
      parts.push(`${pct}% of ${windowLabel} losses came from ${top[0].ticker} (-${formatDollar(top[0].contributionDollar)})`);
    }
  }

  if (parts.length === 0) return 'No significant portfolio movement in this period.';
  return parts.join('. ') + '.';
}

// ============================================================================
// HERO STATS
// ============================================================================

async function computeHeroStats(holdings: HoldingWithQuote[]): Promise<HeroStats> {
  // --- Stat 1: Sector Driver & Sector Drag (net day P/L per sector) ---
  // Sum net dayChange per sector, then pick best (most positive) and worst (most negative).
  const sectorNetPL = new Map<string, number>();
  for (const h of holdings) {
    const sector = getSector(h.ticker);
    sectorNetPL.set(sector, (sectorNetPL.get(sector) || 0) + h.dayChange);
  }

  let sectorDriver: HeroStats['sectorDriver'];
  let sectorDrag: HeroStats['sectorDrag'];

  if (sectorNetPL.size === 0) {
    sectorDriver = { sector: null, percent: 0, label: 'No intraday movement yet' };
    sectorDrag = { sector: null, percent: 0, label: 'No intraday movement yet' };
  } else {
    const totalNetPL = holdings.reduce((sum, h) => sum + h.dayChange, 0);

    // Best sector (highest net P/L)
    let bestSector = '';
    let bestPL = -Infinity;
    for (const [sector, pl] of sectorNetPL) {
      if (pl > bestPL) { bestSector = sector; bestPL = pl; }
    }
    const fmtBest = bestPL >= 0
      ? `+$${bestPL >= 100 ? Math.round(bestPL).toLocaleString('en-US') : bestPL.toFixed(2)}`
      : `-$${Math.abs(bestPL) >= 100 ? Math.round(Math.abs(bestPL)).toLocaleString('en-US') : Math.abs(bestPL).toFixed(2)}`;
    sectorDriver = {
      sector: bestPL > 0 ? bestSector : null,
      percent: totalNetPL !== 0 ? Math.round((bestPL / Math.abs(totalNetPL)) * 1000) / 10 : 0,
      label: bestPL > 0 ? `${fmtBest} net today` : 'No sector gains today',
    };

    // Worst sector (lowest net P/L)
    let worstSector = '';
    let worstPL = Infinity;
    for (const [sector, pl] of sectorNetPL) {
      if (pl < worstPL) { worstSector = sector; worstPL = pl; }
    }
    const fmtWorst = worstPL >= 0
      ? `+$${worstPL >= 100 ? Math.round(worstPL).toLocaleString('en-US') : worstPL.toFixed(2)}`
      : `-$${Math.abs(worstPL) >= 100 ? Math.round(Math.abs(worstPL)).toLocaleString('en-US') : Math.abs(worstPL).toFixed(2)}`;
    sectorDrag = {
      sector: worstPL < 0 ? worstSector : null,
      percent: totalNetPL !== 0 ? Math.round((worstPL / Math.abs(totalNetPL)) * 1000) / 10 : 0,
      label: worstPL < 0 ? `${fmtWorst} net today` : 'No sector losses today',
    };
  }

  // --- Stat 2: Largest Drag ---
  const losers = holdings.filter(h => h.dayChange < 0);
  let largestDrag: HeroStats['largestDrag'];
  if (losers.length === 0) {
    largestDrag = { ticker: null, lossDollar: 0, percent: 0, label: 'No losses today' };
  } else {
    const totalLosses = losers.reduce((sum, h) => sum + Math.abs(h.dayChange), 0);
    const worst = losers.reduce((w, h) => h.dayChange < w.dayChange ? h : w);
    const pct = Math.round((Math.abs(worst.dayChange) / totalLosses) * 1000) / 10;
    const fmtLoss = Math.abs(worst.dayChange) >= 100
      ? `$${Math.round(Math.abs(worst.dayChange)).toLocaleString('en-US')}`
      : `$${Math.abs(worst.dayChange).toFixed(2)}`;
    largestDrag = {
      ticker: worst.ticker,
      lossDollar: Math.round(worst.dayChange * 100) / 100,
      percent: pct,
      label: `-${fmtLoss} (${pct}% of today's losses)`,
    };
  }

  // --- Stat 2b: Largest Driver (biggest gainer) ---
  const winners = holdings.filter(h => h.dayChange > 0);
  let largestDriver: HeroStats['largestDriver'];
  if (winners.length === 0) {
    largestDriver = { ticker: null, gainDollar: 0, percent: 0, label: 'No gains today' };
  } else {
    const totalGains = winners.reduce((sum, h) => sum + h.dayChange, 0);
    const best = winners.reduce((b, h) => h.dayChange > b.dayChange ? h : b);
    const pct = Math.round((best.dayChange / totalGains) * 1000) / 10;
    const fmtGain = best.dayChange >= 100
      ? `$${Math.round(best.dayChange).toLocaleString('en-US')}`
      : `$${best.dayChange.toFixed(2)}`;
    largestDriver = {
      ticker: best.ticker,
      gainDollar: Math.round(best.dayChange * 100) / 100,
      percent: pct,
      label: `+${fmtGain} (${pct}% of today's gains)`,
    };
  }

  // --- Stat 3: Momentum & Deceleration (streak-based) ---
  // Use today's live dayChangePercent for each holding as the current day's direction,
  // plus historical holding snapshots for prior days. Streak = consecutive days in same direction.
  let momentum: HeroStats['momentum'] = null;
  let deceleration: HeroStats['deceleration'] = null;
  const heldTickers = new Set(holdings.map(h => h.ticker));

  try {
    const allSnaps = await getRecentHoldingSnapshots(10);
    const holdingSnaps = allSnaps.filter(s => heldTickers.has(s.ticker));

    // Group snapshots by date -> ticker -> dayPLPercent
    // Use dayPL direction and dayPLPercent for streak %
    const dateMap = new Map<string, Map<string, number>>();
    for (const s of holdingSnaps) {
      const dateStr = s.timestamp.toISOString().slice(0, 10);
      if (!dateMap.has(dateStr)) dateMap.set(dateStr, new Map());
      const tickerMap = dateMap.get(dateStr)!;
      // Use dayPLPercent for the direction signal
      tickerMap.set(s.ticker, s.dayPLPercent);
    }

    // Add today's live data (overwrite if snapshot exists for today)
    const todayStr = new Date().toISOString().slice(0, 10);
    if (!dateMap.has(todayStr)) dateMap.set(todayStr, new Map());
    const todayMap = dateMap.get(todayStr)!;
    for (const h of holdings) {
      if (!h.priceUnavailable && h.currentPrice > 0) {
        todayMap.set(h.ticker, h.dayChangePercent);
      }
    }

    const dates = Array.from(dateMap.keys()).sort().reverse(); // most recent first

    if (dates.length > 0) {
      const upStreaks = new Map<string, { days: number; cumPct: number }>();
      const downStreaks = new Map<string, { days: number; cumPct: number }>();

      for (const ticker of heldTickers) {
        // Winning streak: consecutive days with positive change
        let upDays = 0;
        let upPct = 0;
        for (const date of dates) {
          const pct = dateMap.get(date)?.get(ticker);
          if (pct === undefined) continue;
          if (pct > 0) { upDays++; upPct += pct; }
          else break;
        }
        if (upDays > 0) upStreaks.set(ticker, { days: upDays, cumPct: Math.round(upPct * 10) / 10 });

        // Losing streak: consecutive days with negative change
        let downDays = 0;
        let downPct = 0;
        for (const date of dates) {
          const pct = dateMap.get(date)?.get(ticker);
          if (pct === undefined) continue;
          if (pct < 0) { downDays++; downPct += pct; }
          else break;
        }
        if (downDays > 0) downStreaks.set(ticker, { days: downDays, cumPct: Math.round(downPct * 10) / 10 });
      }

      // Best winning streak
      let bestUp = '';
      let bestUpDays = 0;
      let bestUpPct = -Infinity;
      for (const [ticker, s] of upStreaks) {
        if (s.days > bestUpDays || (s.days === bestUpDays && s.cumPct > bestUpPct)) {
          bestUp = ticker;
          bestUpDays = s.days;
          bestUpPct = s.cumPct;
        }
      }

      if (bestUp && bestUpDays > 0) {
        momentum = {
          ticker: bestUp,
          streakDays: bestUpDays,
          streakPct: bestUpPct,
          label: `Up ${bestUpDays} day${bestUpDays !== 1 ? 's' : ''} (+${bestUpPct}%)`,
        };
      }

      // Worst losing streak
      let bestDown = '';
      let bestDownDays = 0;
      let bestDownPct = Infinity;
      for (const [ticker, s] of downStreaks) {
        if (s.days > bestDownDays || (s.days === bestDownDays && s.cumPct < bestDownPct)) {
          bestDown = ticker;
          bestDownDays = s.days;
          bestDownPct = s.cumPct;
        }
      }

      if (bestDown && bestDownDays > 0) {
        deceleration = {
          ticker: bestDown,
          streakDays: bestDownDays,
          streakPct: bestDownPct,
          label: `Down ${bestDownDays} day${bestDownDays !== 1 ? 's' : ''} (${bestDownPct}%)`,
        };
      }
    }
  } catch (err) {
    console.error('Error computing streaks:', err);
  }

  return { sectorDriver, sectorDrag, largestDrag, largestDriver, momentum, deceleration };
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

export async function getPortfolioIntelligence(
  window: IntelligenceWindow = '1d',
  userId?: string
): Promise<PortfolioIntelligenceResponse> {
  const cacheKey = userId ? `intelligence:${userId}:${window}` : `intelligence:${window}`;
  const cached = insightsCache.get<PortfolioIntelligenceResponse>(cacheKey);
  if (cached) return cached;

  let portfolio;
  if (userId) {
    const { getUserPortfolio } = await import('./user-portfolio.service');
    portfolio = await getUserPortfolio(userId);
    if (!portfolio) {
      return {
        window, contributors: [], detractors: [], sectorExposure: [],
        beta: null, explanation: 'User not found.', partial: true, heroStats: null,
      };
    }
  } else {
    portfolio = await getPortfolio();
  }
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
      heroStats: null,
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

  // Compute hero stats (only for 1d window — they're intraday stats)
  const heroStats = window === '1d' ? await computeHeroStats(holdings) : null;

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
    heroStats,
  };

  // Short TTL if data is incomplete (candles still caching), otherwise normal TTL
  const ttl = isIncomplete ? 60 : (window === '1d' ? 300 : 3600);
  insightsCache.set(cacheKey, result, ttl);

  return result;
}
