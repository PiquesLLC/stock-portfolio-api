import { getPortfolio } from './portfolio.service';
import { getRecentHoldingSnapshots } from './snapshot.service';
import { insightsCache } from '../utils/finnhub';
import {
  getMultipleCandlesGradual,
  HistoricalCandles,
} from '../utils/candle-cache';
import { periodStartCloseFromDateStrings } from '../utils/candle-window';
import { HoldingWithQuote, HeroStats } from '../types';
import { getSector } from '../utils/sectors';
import { yahooGet } from '../utils/yahoo-http';
import { calculateBeta } from '../utils/finance-math';
import NodeCache from 'node-cache';

// Yahoo Finance candle cache for fallback
const yahooCache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

async function fetchYahooCandlesFallback(ticker: string): Promise<{ closes: number[]; dates: string[] } | null> {
  const cacheKey = `yahoo-intel:${ticker}`;
  // `undefined` = never fetched; `null` = fetched and FAILED/empty (negative-cached). Returning the
  // cached null is the whole point: without it a slow/rate-limited ticker was re-fetched on every
  // phase (contributions, streaks) and every compute — and the '1m' streak loop does those serially,
  // so N tickers x the 5s Yahoo timeout stalled the whole "Gathering Intelligence" step for minutes.
  const cached = yahooCache.get<{ closes: number[]; dates: string[] } | null>(cacheKey);
  if (cached !== undefined) return cached;

  const NEGATIVE_TTL = 300; // 5 min — retry a failing/throttled ticker soon, but not every compute
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 60 * 24 * 60 * 60; // 60 days back
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${from}&period2=${now}&interval=1d`;
    const resp = await yahooGet(url);

    const result = resp.data?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]) {
      yahooCache.set(cacheKey, null, NEGATIVE_TTL);
      return null;
    }

    const timestamps: number[] = result.timestamp;
    const q = result.indicators.quote[0];
    const closes: number[] = [];
    const dates: string[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      if (q.close[i] != null) {
        closes.push(q.close[i]);
        dates.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
      }
    }

    if (closes.length === 0) {
      yahooCache.set(cacheKey, null, NEGATIVE_TTL);
      return null;
    }

    const data = { closes, dates };
    yahooCache.set(cacheKey, data);
    return data;
  } catch {
    yahooCache.set(cacheKey, null, NEGATIVE_TTL); // negative-cache the failure so we don't re-hit it
    return null;
  }
}

// Types
export type IntelligenceWindow = '1d' | '5d' | '1m';

export interface ContributorEntry {
  ticker: string;
  percentReturn: number | null;
  contributionDollar: number;
  shares?: number;
  avgCost?: number;
  currentPrice?: number;
  currentValue?: number;
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
  winnersCount: number;
  losersCount: number;
  streakSource?: 'candles' | 'snapshots';
  totalGains: number;
  totalLosses: number;
  totalAbsMovement: number;
  netPnL: number;
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
  shares: number;
  avgCost: number;
  currentPrice: number;
  currentValue: number;
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
        shares: h.shares,
        avgCost: h.averageCost,
        currentPrice: h.currentPrice,
        currentValue: h.currentValue,
      };
    });
    return { contributions, candleData: null };
  }

  const tickers = holdings.map(h => h.ticker);
  const fetchResult = await getMultipleCandlesGradual(tickers, CORRELATION_TRADING_DAYS);
  const candleData = fetchResult.data;
  const daysBack = window === '5d' ? 5 : 22;

  // Check if Finnhub data is mostly empty (paid plan limitation)
  const _finnhubHasData = Array.from(candleData.values()).some(c => c && !c.partial && c.closes.length >= daysBack + 1);

  // Build contributions - use Yahoo as fallback when Finnhub is unavailable
  const contributionPromises = holdings.map(async h => {
    const candles = candleData.get(h.ticker);
    let closes: number[] | null = null;
    let dates: (string | Date)[] | null = null;

    // Try Finnhub first
    if (candles && !candles.partial && candles.closes.length >= daysBack + 1) {
      closes = candles.closes;
      dates = candles.dates;
    }
    // Fallback to Yahoo for this ticker if Finnhub doesn't have enough data
    else {
      const yahooData = await fetchYahooCandlesFallback(h.ticker);
      if (yahooData && yahooData.closes.length >= daysBack + 1) {
        closes = yahooData.closes;
        dates = yahooData.dates;
      }
    }

    const holdingMeta = { shares: h.shares, avgCost: h.averageCost, currentPrice: h.currentPrice, currentValue: h.currentValue };

    if (!closes || closes.length < daysBack + 1) {
      return { ticker: h.ticker, contributionDollar: 0, percentReturn: null, ...holdingMeta };
    }

    const currentPrice = closes[closes.length - 1];
    // '1m' = calendar-month date-anchor (was 22 fixed bars → holiday drift); '5d' = 5
    // trading days, which is exact on a daily series, so keep the bar offset there.
    const referenceClose = window === '1m'
      ? (periodStartCloseFromDateStrings(closes, dates, 30) ?? closes[closes.length - 1 - daysBack])
      : closes[closes.length - 1 - daysBack];
    if (referenceClose <= 0) return { ticker: h.ticker, contributionDollar: 0, percentReturn: null, ...holdingMeta };
    const priceChange = currentPrice - referenceClose;
    const percentReturn = Math.round(((currentPrice - referenceClose) / referenceClose) * 1000) / 10;
    return {
      ticker: h.ticker,
      contributionDollar: Math.round(h.shares * priceChange * 100) / 100,
      percentReturn,
      ...holdingMeta,
    };
  });

  const contributions = await Promise.all(contributionPromises);
  return { contributions, candleData };
}

function splitContributors(contributions: HoldingContribution[]): {
  contributors: ContributorEntry[];
  detractors: ContributorEntry[];
  winnersCount: number;
  losersCount: number;
} {
  const sorted = [...contributions].sort((a, b) => b.contributionDollar - a.contributionDollar);

  const toEntry = (c: HoldingContribution): ContributorEntry => ({
    ticker: c.ticker,
    contributionDollar: c.contributionDollar,
    percentReturn: c.percentReturn,
    shares: c.shares,
    avgCost: Math.round(c.avgCost * 100) / 100,
    currentPrice: Math.round(c.currentPrice * 100) / 100,
    currentValue: Math.round(c.currentValue * 100) / 100,
  });

  const allWinners = sorted.filter(c => c.contributionDollar > 0);
  const allLosers = sorted.filter(c => c.contributionDollar < 0);
  const contributors = allWinners.slice(0, 5).map(toEntry);
  const detractors = allLosers.slice(-5).reverse().map(toEntry);

  return { contributors, detractors, winnersCount: allWinners.length, losersCount: allLosers.length };
}

// ============================================================================
// SECTOR EXPOSURE
// ============================================================================

export function computeSectorExposure(holdings: HoldingWithQuote[]): SectorExposureEntry[] {
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

  // Beta via the canonical library: Cov(port, spy) / Var(spy). minLen is >=
  // MIN_BETA_DAYS (60) by the guard above, so calculateBeta's <10 gate can never
  // change behavior, and the arrays are already equal-length (slice(-len) is a
  // no-op) — this is a zero-delta consolidation of the former inline formula.
  const n = minLen;
  const meanPort = portfolioReturns.reduce((a, b) => a + b, 0) / n;
  const meanSpy = alignedSpyReturns.reduce((a, b) => a + b, 0) / n;

  const beta = calculateBeta(portfolioReturns, alignedSpyReturns);
  if (beta === null) return null;

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

async function computeHeroStats(
  holdings: HoldingWithQuote[],
  contributions: HoldingContribution[],
  window: IntelligenceWindow,
  userId: string,
  candleData?: Map<string, HistoricalCandles> | null
): Promise<HeroStats> {
  const periodLabel = window === '1d' ? 'today' : window === '5d' ? 'this week' : 'this month';
  const periodPossessive = window === '1d' ? "today's" : window === '5d' ? "this week's" : "this month's";

  // --- Stat 1: Sector Driver & Sector Drag (net P/L per sector) ---
  const sectorNetPL = new Map<string, number>();
  for (const c of contributions) {
    const sector = getSector(c.ticker);
    sectorNetPL.set(sector, (sectorNetPL.get(sector) || 0) + c.contributionDollar);
  }

  let sectorDriver: HeroStats['sectorDriver'];
  let sectorDrag: HeroStats['sectorDrag'];

  if (sectorNetPL.size === 0) {
    sectorDriver = { sector: null, percent: 0, label: 'No movement yet' };
    sectorDrag = { sector: null, percent: 0, label: 'No movement yet' };
  } else {
    const totalNetPL = contributions.reduce((sum, c) => sum + c.contributionDollar, 0);

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
      label: bestPL > 0 ? `${fmtBest} net ${periodLabel}` : `No sector gains ${periodLabel}`,
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
      label: worstPL < 0 ? `${fmtWorst} net ${periodLabel}` : `No sector losses ${periodLabel}`,
    };
  }

  // --- Stat 2: Largest Drag ---
  const losers = contributions.filter(c => c.contributionDollar < 0);
  let largestDrag: HeroStats['largestDrag'];
  if (losers.length === 0) {
    largestDrag = { ticker: null, lossDollar: 0, percent: 0, label: `No losses ${periodLabel}` };
  } else {
    const totalLosses = losers.reduce((sum, c) => sum + Math.abs(c.contributionDollar), 0);
    const worst = losers.reduce((w, c) => c.contributionDollar < w.contributionDollar ? c : w);
    const pct = Math.round((Math.abs(worst.contributionDollar) / totalLosses) * 1000) / 10;
    const fmtLoss = Math.abs(worst.contributionDollar) >= 100
      ? `$${Math.round(Math.abs(worst.contributionDollar)).toLocaleString('en-US')}`
      : `$${Math.abs(worst.contributionDollar).toFixed(2)}`;
    largestDrag = {
      ticker: worst.ticker,
      lossDollar: Math.round(worst.contributionDollar * 100) / 100,
      percent: pct,
      label: `-${fmtLoss} (${pct}% of ${periodPossessive} losses)`,
    };
  }

  // --- Stat 2b: Largest Driver (biggest gainer) ---
  const winners = contributions.filter(c => c.contributionDollar > 0);
  let largestDriver: HeroStats['largestDriver'];
  if (winners.length === 0) {
    largestDriver = { ticker: null, gainDollar: 0, percent: 0, label: `No gains ${periodLabel}` };
  } else {
    const totalGains = winners.reduce((sum, c) => sum + c.contributionDollar, 0);
    const best = winners.reduce((b, c) => c.contributionDollar > b.contributionDollar ? c : b);
    const pct = Math.round((best.contributionDollar / totalGains) * 1000) / 10;
    const fmtGain = best.contributionDollar >= 100
      ? `$${Math.round(best.contributionDollar).toLocaleString('en-US')}`
      : `$${best.contributionDollar.toFixed(2)}`;
    largestDriver = {
      ticker: best.ticker,
      gainDollar: Math.round(best.contributionDollar * 100) / 100,
      percent: pct,
      label: `+${fmtGain} (${pct}% of ${periodPossessive} gains)`,
    };
  }

  // --- Stat 3: Momentum & Deceleration (streak-based) ---
  // Use today's live dayChangePercent for each holding as the current day's direction,
  // plus historical holding snapshots for prior days. Streak = consecutive days in same direction.
  let momentum: HeroStats['momentum'] = null;
  let deceleration: HeroStats['deceleration'] = null;
  const heldTickers = new Set(holdings.map(h => h.ticker));

  try {
    if (window === '1m' && candleData) {
      const maxDays = 22; // Approx. 1 month of trading days
      const upStreaks = new Map<string, { days: number; cumPct: number }>();
      const downStreaks = new Map<string, { days: number; cumPct: number }>();

      for (const h of holdings) {
        const candles = candleData.get(h.ticker);
        let returns: number[] | null = null;

        if (candles && !candles.partial && candles.returns.length > 0) {
          returns = candles.returns;
        } else {
          const yahooData = await fetchYahooCandlesFallback(h.ticker);
          if (yahooData && yahooData.closes.length > 1) {
            returns = [];
            for (let i = 1; i < yahooData.closes.length; i++) {
              const prev = yahooData.closes[i - 1];
              if (prev > 0) {
                returns.push((yahooData.closes[i] - prev) / prev);
              }
            }
          }
        }

        if (!returns || returns.length === 0) continue;

        const recentReturns = returns.slice(-maxDays);

        // Winning streak: consecutive positive returns
        let upDays = 0;
        let upPct = 0;
        for (let i = recentReturns.length - 1; i >= 0; i--) {
          const r = recentReturns[i];
          if (r > 0) { upDays++; upPct += r * 100; }
          else break;
        }
        if (upDays > 0) upStreaks.set(h.ticker, { days: upDays, cumPct: Math.round(upPct * 10) / 10 });

        // Losing streak: consecutive negative returns
        let downDays = 0;
        let downPct = 0;
        for (let i = recentReturns.length - 1; i >= 0; i--) {
          const r = recentReturns[i];
          if (r < 0) { downDays++; downPct += r * 100; }
          else break;
        }
        if (downDays > 0) downStreaks.set(h.ticker, { days: downDays, cumPct: Math.round(downPct * 10) / 10 });
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

      return { sectorDriver, sectorDrag, largestDrag, largestDriver, momentum, deceleration };
    }

    const lookbackDays = window === '1m' ? 30 : 10;
    const allSnaps = await getRecentHoldingSnapshots(userId, lookbackDays);
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

// ============================================================================
// STALE-WHILE-REVALIDATE CACHE
// ============================================================================

interface CachedIntelligence {
  data: PortfolioIntelligenceResponse;
  freshUntil: number;  // timestamp (ms) — serve without refresh
  staleUntil: number;  // timestamp (ms) — serve immediately + background refresh
}

const intelligenceCache = new Map<string, CachedIntelligence>();
const refreshInFlight = new Map<string, Promise<PortfolioIntelligenceResponse>>();
// Dedupes SYNCHRONOUS cold-miss computes (distinct from refreshInFlight, which is for
// background SWR refreshes): concurrent requests + client polls for the same cold key
// share ONE computation instead of each kicking off a duplicate heavy (~10-15s) job.
const computeInFlight = new Map<string, Promise<PortfolioIntelligenceResponse>>();

function getFreshTtlMs(window: IntelligenceWindow, isIncomplete: boolean): number {
  if (isIncomplete) return 60_000;
  return window === '1d' ? 300_000 : 3_600_000;
}

function getStaleTtlMs(window: IntelligenceWindow, isIncomplete: boolean): number {
  if (isIncomplete) return 120_000;
  return window === '1d' ? 600_000 : 7_200_000;
}

async function computeIntelligence(
  userId: string,
  window: IntelligenceWindow,
  portfolioId?: string
): Promise<PortfolioIntelligenceResponse> {
  const portfolio = await getPortfolio(userId, { portfolioId });
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
      winnersCount: 0,
      losersCount: 0,
      totalGains: 0,
      totalLosses: 0,
      totalAbsMovement: 0,
      netPnL: 0,
    };
  }

  // Compute attribution
  const { contributions, candleData } = await computeContributions(holdings, window);
  const { contributors, detractors, winnersCount, losersCount } = splitContributors(contributions);
  const totalGains = contributions
    .filter(c => c.contributionDollar > 0)
    .reduce((sum, c) => sum + c.contributionDollar, 0);
  const totalLosses = contributions
    .filter(c => c.contributionDollar < 0)
    .reduce((sum, c) => sum + Math.abs(c.contributionDollar), 0);
  const totalAbsMovement = totalGains + totalLosses;
  const netPnL = contributions.reduce((sum, c) => sum + c.contributionDollar, 0);

  // Compute sector exposure
  const sectorExposure = computeSectorExposure(holdings);

  // Compute beta (reuse candle data if available)
  const beta = await computeBeta(holdings, candleData);

  // Generate explanation
  const explanation = generateExplanation(contributions, window);

  // Compute hero stats for all windows
  const heroStats = await computeHeroStats(holdings, contributions, window, userId, candleData);

  const hasContributions = contributors.length > 0 || detractors.length > 0;
  const isIncomplete = window !== '1d' && !hasContributions;

  const streakSource: 'candles' | 'snapshots' =
    window === '1m' && candleData ? 'candles' : 'snapshots';

  const result: PortfolioIntelligenceResponse = {
    window,
    contributors,
    detractors,
    sectorExposure,
    beta,
    explanation,
    partial: isIncomplete,
    heroStats,
    winnersCount,
    losersCount,
    streakSource,
    totalGains: Math.round(totalGains * 100) / 100,
    totalLosses: Math.round(totalLosses * 100) / 100,
    totalAbsMovement: Math.round(totalAbsMovement * 100) / 100,
    netPnL: Math.round(netPnL * 100) / 100,
  };

  return result;
}

function cacheResult(cacheKey: string, result: PortfolioIntelligenceResponse, window: IntelligenceWindow): void {
  const isIncomplete = result.partial && window !== '1d';
  const now = Date.now();
  intelligenceCache.set(cacheKey, {
    data: result,
    freshUntil: now + getFreshTtlMs(window, isIncomplete),
    staleUntil: now + getStaleTtlMs(window, isIncomplete),
  });
  // Also store in insightsCache for backward compat (other code may read it)
  const ttl = isIncomplete ? 60 : (window === '1d' ? 300 : 3600);
  insightsCache.set(cacheKey, result, ttl);
}

function refreshInBackground(userId: string, window: IntelligenceWindow, cacheKey: string, portfolioId?: string): void {
  // Deduplicate: if a refresh is already in flight for this key, skip
  if (refreshInFlight.has(cacheKey)) return;

  const promise = computeIntelligence(userId, window, portfolioId)
    .then(result => {
      cacheResult(cacheKey, result, window);
      return result;
    })
    .catch(err => {
      console.error(`[Intelligence] Background refresh failed for ${cacheKey}:`, err.message);
      return null as any;
    })
    .finally(() => {
      refreshInFlight.delete(cacheKey);
    });

  refreshInFlight.set(cacheKey, promise);
}

/**
 * Drop a user's cached intelligence (all windows/portfolios) so the next
 * request recomputes from current holdings. Called from portfolio mutation
 * handlers. In-flight computes are also forgotten; a compute that started
 * pre-mutation can still finish and briefly re-cache pre-trade data (~0.6s
 * window) — accepted, the SWR refresh corrects it on the next request.
 */
export function invalidateUserIntelligence(userId: string): void {
  const prefix = `intelligence:${userId}:`;
  for (const key of intelligenceCache.keys()) {
    if (key.startsWith(prefix)) intelligenceCache.delete(key);
  }
  for (const key of computeInFlight.keys()) {
    if (key.startsWith(prefix)) computeInFlight.delete(key);
  }
  for (const key of refreshInFlight.keys()) {
    if (key.startsWith(prefix)) refreshInFlight.delete(key);
  }
}

export async function getPortfolioIntelligence(
  userId: string,
  window: IntelligenceWindow = '1d',
  portfolioId?: string
): Promise<PortfolioIntelligenceResponse> {
  const cacheKey = `intelligence:${userId}:${window}${portfolioId ? `:${portfolioId}` : ''}`;
  const now = Date.now();

  // Check our SWR cache first
  const cached = intelligenceCache.get(cacheKey);
  if (cached) {
    if (now < cached.freshUntil) {
      // Still fresh — serve as-is
      return cached.data;
    }
    if (now < cached.staleUntil) {
      // Stale but within grace period — serve immediately, refresh in background
      refreshInBackground(userId, window, cacheKey, portfolioId);
      return cached.data;
    }
    // Expired past stale window — fall through to full compute
  }

  // Also check the legacy insightsCache (may have been populated by other code)
  const legacyCached = insightsCache.get<PortfolioIntelligenceResponse>(cacheKey);
  if (legacyCached) return legacyCached;

  // Cold miss — compute, but DEDUPE concurrent cold computes for the same key so a client
  // poll (or a second viewer) JOINS the one in-flight computation instead of starting a
  // duplicate heavy job. Without this, every retry/poll re-ran the full ~10-15s compute,
  // which thrashed the server and made cold loads slow and flaky ("refresh… refresh… loads").
  let pending = computeInFlight.get(cacheKey);
  if (!pending) {
    pending = computeIntelligence(userId, window, portfolioId)
      .then((result) => {
        cacheResult(cacheKey, result, window);
        return result;
      })
      .finally(() => {
        computeInFlight.delete(cacheKey);
      });
    computeInFlight.set(cacheKey, pending);
  }
  return pending;
}
