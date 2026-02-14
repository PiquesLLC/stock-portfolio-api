/**
 * Nala Score Service
 *
 * Computes a per-stock composite score (0-100) across 5 dimensions:
 *   Value (25%), Quality (25%), Growth (20%), Dividends (15%), Momentum (15%)
 *
 * Each dimension has 4 sub-metrics scored 0-25, yielding 0-100 per dimension.
 * Academic basis: Fama-French factor research — Quality + Value weighted highest.
 *
 * Data sources (all cached, no new external API calls):
 *   - Alpha Vantage fundamentals (7-day Prisma cache)
 *   - Finnhub analyst snapshots (Prisma)
 *   - Dividend growth rates (computed from dividend events)
 *   - Polygon/Yahoo daily candles (1hr NodeCache)
 *   - Real-time quotes (15-30s cache)
 */

import { insightsCache } from '../utils/finnhub';
import { getCompanyFundamentals, FundamentalsResponse, ParsedOverview } from './fundamentals.service';
import { getAnalystSnapshot } from './analyst.service';
import { fetchFastQuote, fetchDailyCandles } from './market.service';
import prisma from '../utils/prisma';

// ── Types ──────────────────────────────────────────────────────

export interface NalaSubMetric {
  name: string;
  score: number;
  maxScore: number;
  rawValue: string;
  explanation: string;
}

export interface NalaDimension {
  name: string;
  score: number;
  weight: number;
  subMetrics: NalaSubMetric[];
  insight: string;
}

export type NalaGrade = 'Strong' | 'Good' | 'Fair' | 'Weak';

export interface NalaScoreResponse {
  ticker: string;
  composite: number;
  grade: NalaGrade;
  dimensions: {
    value: NalaDimension;
    quality: NalaDimension;
    growth: NalaDimension;
    dividends: NalaDimension;
    momentum: NalaDimension;
  };
  keyInsights: string[];
  dataAge: 'fresh' | 'cached' | 'stale';
  isETF: boolean;
  availableDimensions: string[];
  lastUpdated: string;
}

// ── Helpers ────────────────────────────────────────────────────

const NEUTRAL = 12.5;

function bracket(value: number | null | undefined, thresholds: [number, number][]): number {
  if (value == null) return NEUTRAL;
  for (const [threshold, score] of thresholds) {
    if (value >= threshold) return score;
  }
  return thresholds[thresholds.length - 1][1];
}

function pct(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

function fmt(v: number | null | undefined, suffix = ''): string {
  if (v == null) return 'N/A';
  return `${v >= 0 ? '' : ''}${Number(v.toFixed(2))}${suffix}`;
}

function gradeFromScore(score: number): NalaGrade {
  if (score >= 75) return 'Strong';
  if (score >= 50) return 'Good';
  if (score >= 25) return 'Fair';
  return 'Weak';
}

function buildDimension(name: string, weight: number, subMetrics: NalaSubMetric[]): NalaDimension {
  const score = subMetrics.reduce((sum, sm) => sum + sm.score, 0);
  // Pick the highest-scoring sub-metric as the insight
  const best = [...subMetrics].sort((a, b) => b.score - a.score)[0];
  const worst = [...subMetrics].sort((a, b) => a.score - b.score)[0];
  let insight = '';
  if (best && best.score >= 20) insight = `Strength: ${best.explanation}`;
  else if (worst && worst.score <= 8) insight = `Watch: ${worst.explanation}`;
  else insight = `${name} score is moderate across all sub-metrics.`;
  return { name, score: Math.round(score), weight, subMetrics, insight };
}

// ── VALUE Dimension ────────────────────────────────────────────

function scoreValue(overview: ParsedOverview | null, currentPrice: number): NalaDimension {
  const pe = overview?.peRatio;
  const peg = overview?.pegRatio;
  const fwdPe = overview?.forwardPE;
  const target = overview?.analystTargetPrice;

  // P/E Position (lower is cheaper)
  const peScore = pe != null && pe < 0
    ? 5  // negative earnings
    : bracket(pe != null ? -pe : null, [
        [-10, 25], [-15, 22], [-20, 18], [-25, 14], [-35, 10], [-50, 6], [-Infinity, 3],
      ].map(([t, s]) => [t, s] as [number, number]));
  const peActual = pe != null && pe < 0
    ? 5
    : pe == null ? NEUTRAL
    : pe <= 10 ? 25 : pe <= 15 ? 22 : pe <= 20 ? 18 : pe <= 25 ? 14 : pe <= 35 ? 10 : pe <= 50 ? 6 : 3;

  // PEG Ratio (1.0 = fair)
  const pegScore = peg == null || peg < 0 ? NEUTRAL
    : peg <= 0.5 ? 25 : peg <= 1.0 ? 22 : peg <= 1.5 ? 18 : peg <= 2.0 ? 14 : peg <= 3.0 ? 8 : 4;

  // Forward P/E Discount
  let fwdDiscount: number | null = null;
  if (pe != null && pe > 0 && fwdPe != null && fwdPe > 0) {
    fwdDiscount = ((pe - fwdPe) / pe) * 100;
  }
  const fwdScore = fwdDiscount == null ? NEUTRAL
    : fwdDiscount >= 30 ? 25 : fwdDiscount >= 20 ? 22 : fwdDiscount >= 10 ? 18
    : fwdDiscount >= 0 ? 14 : fwdDiscount >= -10 ? 10 : fwdDiscount >= -20 ? 6 : 3;

  // Price vs Analyst Target
  let upside: number | null = null;
  if (target != null && target > 0 && currentPrice > 0) {
    upside = ((target - currentPrice) / currentPrice) * 100;
  }
  const targetScore = upside == null ? NEUTRAL
    : upside >= 30 ? 25 : upside >= 20 ? 22 : upside >= 10 ? 18
    : upside >= 0 ? 14 : upside >= -10 ? 10 : upside >= -20 ? 6 : 3;

  return buildDimension('Value', 0.25, [
    { name: 'P/E Ratio', score: peActual, maxScore: 25, rawValue: fmt(pe, 'x'), explanation: pe != null ? (pe < 0 ? 'Negative earnings' : pe <= 20 ? 'Attractively valued' : pe <= 35 ? 'Growth premium priced in' : 'Expensive valuation') : 'P/E data unavailable' },
    { name: 'PEG Ratio', score: pegScore, maxScore: 25, rawValue: fmt(peg, 'x'), explanation: peg != null ? (peg <= 1.0 ? 'Undervalued relative to growth' : peg <= 2.0 ? 'Fairly priced for growth' : 'Overvalued for growth rate') : 'PEG data unavailable' },
    { name: 'Forward P/E Discount', score: fwdScore, maxScore: 25, rawValue: fwdDiscount != null ? fmt(fwdDiscount, '%') : 'N/A', explanation: fwdDiscount != null ? (fwdDiscount >= 10 ? 'Earnings expected to grow significantly' : fwdDiscount >= 0 ? 'Modest earnings growth expected' : 'Earnings may be declining') : 'Forward P/E unavailable' },
    { name: 'Analyst Target Upside', score: targetScore, maxScore: 25, rawValue: upside != null ? fmt(upside, '%') : 'N/A', explanation: upside != null ? (upside >= 20 ? 'Significant upside to analyst target' : upside >= 0 ? 'Modest upside to target' : 'Trading above analyst target') : 'No analyst target available' },
  ]);
}

// ── QUALITY Dimension ──────────────────────────────────────────

function scoreQuality(fundamentals: FundamentalsResponse): NalaDimension {
  const overview = fundamentals.overview;
  const bs = fundamentals.balanceSheets.annual[0];
  const cf = fundamentals.cashFlows.annual[0];
  const is_ = fundamentals.incomeStatements.annual[0];

  // ROE
  const roe = overview?.returnOnEquity != null ? overview.returnOnEquity * 100 : null;
  const roeScore = roe == null ? NEUTRAL
    : roe >= 25 ? 25 : roe >= 20 ? 22 : roe >= 15 ? 18 : roe >= 10 ? 14 : roe >= 5 ? 10 : roe >= 0 ? 6 : 3;

  // Profit Margin
  const margin = overview?.profitMargin != null ? overview.profitMargin * 100 : null;
  const marginScore = margin == null ? NEUTRAL
    : margin >= 25 ? 25 : margin >= 20 ? 22 : margin >= 15 ? 18 : margin >= 10 ? 14 : margin >= 5 ? 10 : margin >= 0 ? 6 : 3;

  // Debt-to-Equity
  const totalDebt = (bs?.longTermDebt ?? 0) + (bs?.currentDebt ?? 0);
  const equity = bs?.totalShareholderEquity;
  const deRatio = equity != null && equity > 0 ? totalDebt / equity : null;
  // Lower is better — invert for scoring
  const deScore = deRatio == null ? NEUTRAL
    : deRatio <= 0.3 ? 25 : deRatio <= 0.5 ? 22 : deRatio <= 1.0 ? 18 : deRatio <= 1.5 ? 14 : deRatio <= 2.0 ? 10 : deRatio <= 3.0 ? 6 : 3;

  // FCF Margin
  const fcf = cf?.freeCashFlow;
  const revenue = is_?.totalRevenue;
  const fcfMargin = fcf != null && revenue != null && revenue > 0 ? (fcf / revenue) * 100 : null;
  const fcfScore = fcfMargin == null ? NEUTRAL
    : fcfMargin >= 20 ? 25 : fcfMargin >= 15 ? 22 : fcfMargin >= 10 ? 18 : fcfMargin >= 5 ? 14 : fcfMargin >= 0 ? 10 : 4;

  return buildDimension('Quality', 0.25, [
    { name: 'Return on Equity', score: roeScore, maxScore: 25, rawValue: fmt(roe, '%'), explanation: roe != null ? (roe >= 20 ? 'Excellent capital efficiency' : roe >= 10 ? 'Solid returns on equity' : roe >= 0 ? 'Low return on equity' : 'Destroying shareholder value') : 'ROE data unavailable' },
    { name: 'Profit Margin', score: marginScore, maxScore: 25, rawValue: fmt(margin, '%'), explanation: margin != null ? (margin >= 20 ? 'High-margin business' : margin >= 10 ? 'Healthy margins' : margin >= 0 ? 'Thin margins' : 'Operating at a loss') : 'Margin data unavailable' },
    { name: 'Debt-to-Equity', score: deScore, maxScore: 25, rawValue: deRatio != null ? fmt(deRatio, 'x') : 'N/A', explanation: deRatio != null ? (deRatio <= 0.5 ? 'Conservative balance sheet' : deRatio <= 1.5 ? 'Moderate leverage' : 'Heavily leveraged') : 'Balance sheet data unavailable' },
    { name: 'FCF Margin', score: fcfScore, maxScore: 25, rawValue: fmt(fcfMargin, '%'), explanation: fcfMargin != null ? (fcfMargin >= 15 ? 'Strong cash generation' : fcfMargin >= 5 ? 'Adequate cash flow' : fcfMargin >= 0 ? 'Minimal free cash flow' : 'Negative free cash flow') : 'Cash flow data unavailable' },
  ]);
}

// ── GROWTH Dimension ───────────────────────────────────────────

function scoreGrowth(fundamentals: FundamentalsResponse): NalaDimension {
  const annual = fundamentals.incomeStatements.annual;
  const cfAnnual = fundamentals.cashFlows.annual;

  const latest = annual[0];
  const prior = annual[1];

  // Revenue Growth YoY
  const revGrowth = pct(latest?.totalRevenue, prior?.totalRevenue);
  const revScore = revGrowth == null ? NEUTRAL
    : revGrowth >= 25 ? 25 : revGrowth >= 15 ? 22 : revGrowth >= 10 ? 18 : revGrowth >= 5 ? 14 : revGrowth >= 0 ? 10 : revGrowth >= -10 ? 6 : 3;

  // Earnings Growth YoY
  const earnGrowth = pct(latest?.netIncome, prior?.netIncome);
  const earnScore = earnGrowth == null ? NEUTRAL
    : earnGrowth >= 25 ? 25 : earnGrowth >= 15 ? 22 : earnGrowth >= 10 ? 18 : earnGrowth >= 5 ? 14 : earnGrowth >= 0 ? 10 : earnGrowth >= -10 ? 6 : 3;

  // FCF Growth YoY
  const latestCF = cfAnnual[0];
  const priorCF = cfAnnual[1];
  const fcfGrowth = pct(latestCF?.freeCashFlow, priorCF?.freeCashFlow);
  const fcfScore = fcfGrowth == null ? NEUTRAL
    : fcfGrowth >= 25 ? 25 : fcfGrowth >= 15 ? 22 : fcfGrowth >= 10 ? 18 : fcfGrowth >= 5 ? 14 : fcfGrowth >= 0 ? 10 : fcfGrowth >= -10 ? 6 : 3;

  // Revenue Consistency (consecutive years of growth)
  const revenues = annual.map(is => is.totalRevenue).filter(r => r != null) as number[];
  let consecutiveGrowth = 0;
  for (let i = 0; i < revenues.length - 1; i++) {
    if (revenues[i] > revenues[i + 1]) consecutiveGrowth++;
    else break;
  }
  const consistencyScore = revenues.length < 2 ? NEUTRAL
    : consecutiveGrowth >= 4 ? 25 : consecutiveGrowth >= 3 ? 20 : consecutiveGrowth >= 2 ? 15 : consecutiveGrowth >= 1 ? 10 : 5;

  return buildDimension('Growth', 0.20, [
    { name: 'Revenue Growth YoY', score: revScore, maxScore: 25, rawValue: fmt(revGrowth, '%'), explanation: revGrowth != null ? (revGrowth >= 15 ? 'Strong top-line growth' : revGrowth >= 5 ? 'Steady revenue growth' : revGrowth >= 0 ? 'Flat revenue' : 'Revenue declining') : 'Revenue data unavailable' },
    { name: 'Earnings Growth YoY', score: earnScore, maxScore: 25, rawValue: fmt(earnGrowth, '%'), explanation: earnGrowth != null ? (earnGrowth >= 15 ? 'Accelerating earnings' : earnGrowth >= 5 ? 'Earnings growing' : earnGrowth >= 0 ? 'Flat earnings' : 'Earnings declining') : 'Earnings data unavailable' },
    { name: 'FCF Growth YoY', score: fcfScore, maxScore: 25, rawValue: fmt(fcfGrowth, '%'), explanation: fcfGrowth != null ? (fcfGrowth >= 15 ? 'Cash flow expanding rapidly' : fcfGrowth >= 0 ? 'Cash flow growing' : 'Cash flow contracting') : 'Cash flow data unavailable' },
    { name: 'Revenue Consistency', score: consistencyScore, maxScore: 25, rawValue: `${consecutiveGrowth} yr${consecutiveGrowth !== 1 ? 's' : ''}`, explanation: consecutiveGrowth >= 3 ? 'Multi-year growth streak' : consecutiveGrowth >= 1 ? 'Recent growth but not sustained' : 'No consecutive growth years' },
  ]);
}

// ── DIVIDENDS Dimension ────────────────────────────────────────

async function scoreDividends(ticker: string, overview: ParsedOverview | null): Promise<NalaDimension> {
  const divYield = overview?.dividendYield != null ? overview.dividendYield * 100 : null;

  // Check if this stock pays dividends
  const hasDiv = divYield != null && divYield > 0;
  if (!hasDiv) {
    // Non-payer: neutral 50/100
    return buildDimension('Dividends', 0.15, [
      { name: 'Dividend Yield', score: NEUTRAL, maxScore: 25, rawValue: '0%', explanation: 'Does not currently pay a dividend' },
      { name: 'Payout Ratio', score: NEUTRAL, maxScore: 25, rawValue: 'N/A', explanation: 'No dividend payout' },
      { name: 'Consecutive Growth Years', score: NEUTRAL, maxScore: 25, rawValue: 'N/A', explanation: 'No dividend history' },
      { name: 'Dividend Growth Rate', score: NEUTRAL, maxScore: 25, rawValue: 'N/A', explanation: 'No dividend growth data' },
    ]);
  }

  // Yield scoring
  const yieldScore = divYield >= 4.0 ? 25 : divYield >= 3.0 ? 22 : divYield >= 2.0 ? 18
    : divYield >= 1.0 ? 14 : divYield >= 0.5 ? 10 : 6;

  // Look up dividend growth data from events
  const events = await prisma.dividendEvent.findMany({
    where: { ticker: ticker.toUpperCase() },
    orderBy: { payDate: 'asc' },
  });

  // Compute consecutive years and growth from events
  const byYear = new Map<number, number>();
  for (const e of events) {
    const yr = e.payDate.getFullYear();
    byYear.set(yr, (byYear.get(yr) ?? 0) + e.amountPerShare);
  }
  const years = Array.from(byYear.keys()).sort((a, b) => a - b);
  const currentYear = new Date().getFullYear();
  const filteredYears = years.filter(y => y < currentYear);

  let consecutiveYears = 0;
  if (filteredYears.length >= 2) {
    for (let i = filteredYears.length - 1; i > 0; i--) {
      const curr = byYear.get(filteredYears[i])!;
      const prev = byYear.get(filteredYears[i - 1])!;
      if (curr > prev) consecutiveYears++;
      else break;
    }
  }

  // CAGR 3yr
  let cagr3yr: number | null = null;
  if (filteredYears.length >= 4) {
    const latest = byYear.get(filteredYears[filteredYears.length - 1])!;
    const base = byYear.get(filteredYears[filteredYears.length - 4])!;
    if (base > 0) cagr3yr = (Math.pow(latest / base, 1 / 3) - 1) * 100;
  }

  // Payout ratio (from dividend events total vs EPS)
  const eps = overview?.eps;
  const latestYearDiv = filteredYears.length > 0 ? byYear.get(filteredYears[filteredYears.length - 1]) : null;
  let payoutRatio: number | null = null;
  if (latestYearDiv != null && eps != null && eps > 0) {
    payoutRatio = (latestYearDiv / eps) * 100;
  }

  const payoutScore = payoutRatio == null ? NEUTRAL
    : (payoutRatio >= 20 && payoutRatio <= 50) ? 25
    : (payoutRatio > 50 && payoutRatio <= 60) ? 22
    : (payoutRatio >= 10 && payoutRatio < 20) ? 18
    : (payoutRatio > 60 && payoutRatio <= 75) ? 14
    : (payoutRatio > 75 && payoutRatio <= 90) ? 8 : 4;

  const consScore = consecutiveYears >= 25 ? 25 : consecutiveYears >= 10 ? 22
    : consecutiveYears >= 5 ? 18 : consecutiveYears >= 3 ? 14 : consecutiveYears >= 1 ? 10 : 5;

  const cagrScore = cagr3yr == null ? NEUTRAL
    : cagr3yr >= 15 ? 25 : cagr3yr >= 10 ? 22 : cagr3yr >= 7 ? 18
    : cagr3yr >= 3 ? 14 : cagr3yr >= 0 ? 10 : 4;

  return buildDimension('Dividends', 0.15, [
    { name: 'Dividend Yield', score: yieldScore, maxScore: 25, rawValue: fmt(divYield, '%'), explanation: divYield >= 3.0 ? 'Above-average yield' : divYield >= 1.5 ? 'Moderate yield' : 'Below-average yield' },
    { name: 'Payout Ratio', score: payoutScore, maxScore: 25, rawValue: payoutRatio != null ? fmt(payoutRatio, '%') : 'N/A', explanation: payoutRatio != null ? (payoutRatio <= 60 ? 'Sustainable payout' : payoutRatio <= 80 ? 'Payout ratio is elevated' : 'High payout ratio — may not be sustainable') : 'Payout data unavailable' },
    { name: 'Consecutive Growth Years', score: consScore, maxScore: 25, rawValue: `${consecutiveYears} yr${consecutiveYears !== 1 ? 's' : ''}`, explanation: consecutiveYears >= 10 ? 'Long track record of dividend increases' : consecutiveYears >= 3 ? 'Growing dividend streak' : 'Limited dividend growth history' },
    { name: 'Dividend Growth Rate', score: cagrScore, maxScore: 25, rawValue: cagr3yr != null ? fmt(cagr3yr, '%') : 'N/A', explanation: cagr3yr != null ? (cagr3yr >= 10 ? 'Strong dividend growth' : cagr3yr >= 3 ? 'Moderate dividend growth' : cagr3yr >= 0 ? 'Slow dividend growth' : 'Dividend is shrinking') : 'Insufficient history for growth rate' },
  ]);
}

// ── MOMENTUM Dimension ─────────────────────────────────────────

async function scoreMomentum(ticker: string, overview: ParsedOverview | null, currentPrice: number): Promise<NalaDimension> {
  // 52-week range position
  const high52 = overview?.fiftyTwoWeekHigh;
  const low52 = overview?.fiftyTwoWeekLow;
  let position52: number | null = null;
  if (high52 != null && low52 != null && high52 > low52 && currentPrice > 0) {
    position52 = ((currentPrice - low52) / (high52 - low52)) * 100;
  }
  const posScore = position52 == null ? NEUTRAL
    : position52 >= 90 ? 25 : position52 >= 75 ? 22 : position52 >= 50 ? 18
    : position52 >= 30 ? 12 : position52 >= 15 ? 8 : 4;

  // 6-month price performance from daily candles
  let sixMonthReturn: number | null = null;
  try {
    const candles = await fetchDailyCandles(ticker, 180);
    if (candles.length >= 2) {
      const oldPrice = candles[0].close;
      const newPrice = candles[candles.length - 1].close;
      if (oldPrice > 0) sixMonthReturn = ((newPrice - oldPrice) / oldPrice) * 100;
    }
  } catch { /* candles unavailable */ }

  const returnScore = sixMonthReturn == null ? NEUTRAL
    : sixMonthReturn >= 30 ? 25 : sixMonthReturn >= 20 ? 22 : sixMonthReturn >= 10 ? 18
    : sixMonthReturn >= 0 ? 14 : sixMonthReturn >= -10 ? 10 : sixMonthReturn >= -20 ? 6 : 3;

  // Beta stability (prefer beta near 1.0)
  const beta = overview?.beta;
  const betaScore = beta == null ? NEUTRAL
    : (beta >= 0.8 && beta <= 1.2) ? 25
    : (beta >= 0.5 && beta < 0.8) ? 22
    : (beta > 1.2 && beta <= 1.5) ? 20
    : beta < 0.5 ? 18
    : (beta > 1.5 && beta <= 2.0) ? 12
    : 6;

  // Analyst consensus
  let bullishRatio: number | null = null;
  try {
    const snapshot = await getAnalystSnapshot(ticker);
    if (snapshot) {
      const total = (snapshot.strongBuy ?? 0) + (snapshot.buy ?? 0) + (snapshot.hold ?? 0)
        + (snapshot.sell ?? 0) + (snapshot.strongSell ?? 0);
      if (total > 0) {
        bullishRatio = ((snapshot.strongBuy ?? 0) + (snapshot.buy ?? 0)) / total * 100;
      }
    }
  } catch { /* analyst data unavailable */ }

  const analystScore = bullishRatio == null ? NEUTRAL
    : bullishRatio >= 80 ? 25 : bullishRatio >= 65 ? 22 : bullishRatio >= 50 ? 18
    : bullishRatio >= 35 ? 14 : bullishRatio >= 20 ? 8 : 4;

  return buildDimension('Momentum', 0.15, [
    { name: '52-Week Position', score: posScore, maxScore: 25, rawValue: position52 != null ? fmt(position52, '%') : 'N/A', explanation: position52 != null ? (position52 >= 75 ? 'Trading near 52-week high' : position52 >= 40 ? 'Mid-range of 52-week' : 'Near 52-week low') : '52-week data unavailable' },
    { name: '6-Month Return', score: returnScore, maxScore: 25, rawValue: fmt(sixMonthReturn, '%'), explanation: sixMonthReturn != null ? (sixMonthReturn >= 20 ? 'Strong recent momentum' : sixMonthReturn >= 0 ? 'Positive trend' : 'Negative momentum') : 'Price history unavailable' },
    { name: 'Beta Stability', score: betaScore, maxScore: 25, rawValue: beta != null ? fmt(beta) : 'N/A', explanation: beta != null ? (beta >= 0.8 && beta <= 1.2 ? 'Moves in line with market' : beta > 1.5 ? 'Significantly more volatile than market' : beta < 0.5 ? 'Very low volatility' : 'Moderate volatility difference') : 'Beta unavailable' },
    { name: 'Analyst Consensus', score: analystScore, maxScore: 25, rawValue: bullishRatio != null ? fmt(bullishRatio, '% buy') : 'N/A', explanation: bullishRatio != null ? (bullishRatio >= 70 ? 'Strong analyst consensus to buy' : bullishRatio >= 50 ? 'Majority of analysts are bullish' : 'Mixed or bearish analyst sentiment') : 'No analyst coverage' },
  ]);
}

// ── Main Score Function ────────────────────────────────────────

export async function getNalaScore(ticker: string): Promise<NalaScoreResponse> {
  const upper = ticker.toUpperCase();
  const cacheKey = `nala-score:${upper}`;

  const cached = insightsCache.get<NalaScoreResponse>(cacheKey);
  if (cached) return cached;

  // Fetch all data in parallel
  const [fundamentals, quote] = await Promise.all([
    getCompanyFundamentals(upper),
    fetchFastQuote(upper),
  ]);

  const overview = fundamentals.overview;
  const currentPrice = quote?.currentPrice ?? 0;

  // Detect real ETFs by name patterns (not by missing data)
  const name = (overview?.name ?? '').toUpperCase();
  const isETF = overview != null && (
    name.includes(' ETF') || name.includes(' FUND') || name.includes(' TRUST') ||
    name.includes('ISHARES') || name.includes('VANGUARD') || name.includes('SPDR') ||
    (overview.sector === 'N/A' && overview.industry === 'N/A' && name.length > 0)
  );

  // Always score all 5 dimensions — missing data gets neutral 12.5/25 per sub-metric
  const [value, quality, growth, dividends, momentum] = await Promise.all([
    scoreValue(overview, currentPrice),
    scoreQuality(fundamentals),
    scoreGrowth(fundamentals),
    scoreDividends(upper, overview),
    scoreMomentum(upper, overview, currentPrice),
  ]);

  const dimensions = { value, quality, growth, dividends, momentum };
  const composite = Math.round(
    value.score * value.weight +
    quality.score * quality.weight +
    growth.score * growth.weight +
    dividends.score * dividends.weight +
    momentum.score * momentum.weight
  );

  // Generate key insights
  const allSubs = Object.values(dimensions).flatMap(d =>
    d.subMetrics.map(sm => ({ ...sm, dim: d.name }))
  );
  const strengths = allSubs.filter(s => s.score >= 20).sort((a, b) => b.score - a.score).slice(0, 2);
  const weaknesses = allSubs.filter(s => s.score <= 8).sort((a, b) => a.score - b.score).slice(0, 2);

  const topDim = Object.values(dimensions).sort((a, b) => b.score - a.score)[0];
  const keyInsights: string[] = [];
  if (isETF) keyInsights.push(`${upper} is an ETF — some dimensions use neutral defaults where individual fundamentals are unavailable.`);
  keyInsights.push(`${upper} scores ${composite}/100 (${gradeFromScore(composite)}) — strongest in ${topDim.name}.`);
  for (const s of strengths) keyInsights.push(`${s.explanation}`);
  for (const w of weaknesses) keyInsights.push(`Watch: ${w.explanation}`);

  const result: NalaScoreResponse = {
    ticker: upper,
    composite,
    grade: gradeFromScore(composite),
    dimensions,
    keyInsights,
    dataAge: fundamentals.dataAge,
    isETF,
    availableDimensions: ['Value', 'Quality', 'Growth', 'Dividends', 'Momentum'],
    lastUpdated: new Date().toISOString(),
  };

  insightsCache.set(cacheKey, result, 86400);
  return result;
}
