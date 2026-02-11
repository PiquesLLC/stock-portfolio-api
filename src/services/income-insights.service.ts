/**
 * Income Insights Service
 * Provides dividend-focused analytics for the Income tab.
 */

import prisma from '../utils/prisma';
import { getPortfolio } from './portfolio.service';
import { getDividendSummary, getDividendCredits } from './dividend-post.service';
import { insightsCache } from '../utils/finnhub';



// ============================================================================
// TYPES
// ============================================================================

export type IncomeWindow = 'today' | '5d' | '1m';

export interface IncomeHealthBreakdown {
  stability: number;      // 0-25
  growth: number;         // 0-25
  coverage: number;       // 0-25
  diversification: number; // 0-25
}

export interface IncomeCategoryDetail {
  score: number;
  maxScore: number;
  calcBullets: string[];
  evidenceBullets: string[];
  drivers: { label: string; value: string; impact: string }[];
  quickFixes: string[];
}

export interface IncomeHealthDetails {
  stability: IncomeCategoryDetail;
  growth: IncomeCategoryDetail;
  coverage: IncomeCategoryDetail;
  diversification: IncomeCategoryDetail;
}

export interface IncomeHealthScore {
  overall: number;        // 0-100
  breakdown: IncomeHealthBreakdown;
  grade: 'Excellent' | 'Good' | 'Fair' | 'Poor';
  details: IncomeHealthDetails;
}

export interface IncomeCashFlow {
  annualIncome: number;
  monthlyIncome: number;
  dailyIncome: number;
  projectedNextMonth: number;
}

export interface IncomeMomentum {
  yoyChangePct: number | null;
  holdingsRaisedPayout: string[];
  trend: 'growing' | 'stable' | 'declining' | 'unknown';
}

export interface IncomeReliability {
  classification: 'stable' | 'moderate' | 'volatile';
  monthlyStdDev: number | null;
  consecutiveMonths: number;
}

export interface IncomeContributor {
  ticker: string;
  dividendDollar: number;
  yieldPct: number | null;
  percentOfTotal: number;
  paymentCount: number;
}

export interface IncomeConcentration {
  top1Percent: number;
  top3Percent: number;
  top1Ticker: string | null;
  top3Tickers: string[];
  isConcentrated: boolean;
}

export interface IncomeTimelineEvent {
  ticker: string;
  eventType: 'paid' | 'declared';
  date: string;
  amountReceived: number;
  dateEstimated: boolean;
}

export interface IncomeLiveIntelligence {
  window: IncomeWindow;
  statement: string;
  amountInWindow: number;
}

export interface IncomeInsightsResponse {
  healthScore: IncomeHealthScore;
  keyDrivers: string[];
  liveIntelligence: IncomeLiveIntelligence;
  signals: {
    cashFlow: IncomeCashFlow;
    momentum: IncomeMomentum;
    reliability: IncomeReliability;
  };
  contributors: IncomeContributor[];
  concentration: IncomeConcentration;
  timeline: IncomeTimelineEvent[];
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getWindowDays(window: IncomeWindow): number {
  switch (window) {
    case 'today': return 1;
    case '5d': return 5;
    case '1m': return 30;
  }
}

function calculateStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function formatCurrency(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ============================================================================
// MAIN SERVICE FUNCTION
// ============================================================================

export async function getIncomeInsights(window: IncomeWindow = 'today'): Promise<IncomeInsightsResponse> {
  const cacheKey = `income-insights:${window}`;
  const cached = insightsCache.get<IncomeInsightsResponse>(cacheKey);
  if (cached) return cached;

  // Get all dividend credits
  const credits = await getDividendCredits();
  const portfolio = await getPortfolio();
  const holdings = portfolio.holdings;

  // Get dividend summary
  const summary = await getDividendSummary();

  // Calculate date ranges
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const windowStart = new Date(today);
  windowStart.setDate(windowStart.getDate() - getWindowDays(window));

  const yearAgo = new Date(today);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);

  const twoYearsAgo = new Date(today);
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  const ytdStart = new Date(now.getFullYear(), 0, 1);

  // ============================================================================
  // CALCULATE SIGNALS
  // ============================================================================

  // Group credits by month for analysis
  const creditsByMonth = new Map<string, number>();
  const creditsThisYear: typeof credits = [];
  const creditsLastYear: typeof credits = [];

  for (const credit of credits) {
    const creditDate = new Date(credit.creditedAt);
    const monthKey = `${creditDate.getFullYear()}-${String(creditDate.getMonth() + 1).padStart(2, '0')}`;
    creditsByMonth.set(monthKey, (creditsByMonth.get(monthKey) || 0) + credit.amountGross);

    if (creditDate >= yearAgo) {
      creditsThisYear.push(credit);
    }
    if (creditDate >= twoYearsAgo && creditDate < yearAgo) {
      creditsLastYear.push(credit);
    }
  }

  // Cash Flow calculations
  const totalAllTime = summary.totalAllTime;
  const totalYTD = summary.totalYTD;
  const totalThisYear = creditsThisYear.reduce((sum, c) => sum + c.amountGross, 0);
  const totalLastYear = creditsLastYear.reduce((sum, c) => sum + c.amountGross, 0);

  // Calculate averages based on YTD
  const monthsInYear = now.getMonth() + 1;
  const daysInYear = Math.floor((now.getTime() - ytdStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  const annualIncome = monthsInYear > 0 ? Math.round((totalYTD / monthsInYear) * 12 * 100) / 100 : 0;
  const monthlyIncome = Math.round(totalYTD / monthsInYear * 100) / 100;
  const dailyIncome = daysInYear > 0 ? Math.round(totalYTD / daysInYear * 100) / 100 : 0;

  // Project next month based on same month last year or average
  const nextMonth = (now.getMonth() + 1) % 12 + 1;
  const lastYearSameMonth = `${now.getFullYear() - 1}-${String(nextMonth).padStart(2, '0')}`;
  const projectedNextMonth = creditsByMonth.get(lastYearSameMonth) ?? monthlyIncome;

  const cashFlow: IncomeCashFlow = {
    annualIncome,
    monthlyIncome,
    dailyIncome,
    projectedNextMonth: Math.round(projectedNextMonth * 100) / 100,
  };

  // Momentum calculations
  const yoyChangePct = totalLastYear > 0
    ? Math.round(((totalThisYear - totalLastYear) / totalLastYear) * 10000) / 100
    : null;

  // Find holdings that raised payouts (compare this year vs last year by ticker)
  const tickerThisYear = new Map<string, number>();
  const tickerLastYear = new Map<string, number>();
  for (const c of creditsThisYear) {
    tickerThisYear.set(c.ticker, (tickerThisYear.get(c.ticker) || 0) + c.amountGross);
  }
  for (const c of creditsLastYear) {
    tickerLastYear.set(c.ticker, (tickerLastYear.get(c.ticker) || 0) + c.amountGross);
  }

  const holdingsRaisedPayout: string[] = [];
  for (const [ticker, thisYearAmount] of tickerThisYear) {
    const lastYearAmount = tickerLastYear.get(ticker) || 0;
    if (lastYearAmount > 0 && thisYearAmount > lastYearAmount * 1.05) {
      holdingsRaisedPayout.push(ticker);
    }
  }

  let trend: IncomeMomentum['trend'] = 'unknown';
  if (yoyChangePct !== null) {
    if (yoyChangePct >= 5) trend = 'growing';
    else if (yoyChangePct <= -5) trend = 'declining';
    else trend = 'stable';
  }

  const momentum: IncomeMomentum = {
    yoyChangePct,
    holdingsRaisedPayout,
    trend,
  };

  // Reliability calculations
  const monthlyAmounts = Array.from(creditsByMonth.values());
  const monthlyStdDev = calculateStdDev(monthlyAmounts);
  const avgMonthly = monthlyAmounts.length > 0
    ? monthlyAmounts.reduce((a, b) => a + b, 0) / monthlyAmounts.length
    : 0;

  // Calculate coefficient of variation for classification
  let classification: IncomeReliability['classification'] = 'stable';
  if (monthlyStdDev !== null && avgMonthly > 0) {
    const cv = monthlyStdDev / avgMonthly;
    if (cv > 0.5) classification = 'volatile';
    else if (cv > 0.25) classification = 'moderate';
    else classification = 'stable';
  }

  // Count consecutive months with income
  const sortedMonths = Array.from(creditsByMonth.keys()).sort().reverse();
  let consecutiveMonths = 0;
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let checkMonth = currentMonthKey;

  for (let i = 0; i < 24; i++) {
    if (creditsByMonth.has(checkMonth)) {
      consecutiveMonths++;
      // Move to previous month
      const [year, month] = checkMonth.split('-').map(Number);
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear = month === 1 ? year - 1 : year;
      checkMonth = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
    } else {
      break;
    }
  }

  const reliability: IncomeReliability = {
    classification,
    monthlyStdDev: monthlyStdDev !== null ? Math.round(monthlyStdDev * 100) / 100 : null,
    consecutiveMonths,
  };

  // ============================================================================
  // CONTRIBUTORS
  // ============================================================================

  const contributors: IncomeContributor[] = [];
  const totalDividends = summary.totalAllTime;

  for (const tickerData of summary.byTicker) {
    // Find holding to get current value for yield calculation
    const holding = holdings.find(h => h.ticker === tickerData.ticker);
    let yieldPct: number | null = null;

    if (holding && holding.currentValue > 0) {
      // Annual yield = (annual dividends / current value) * 100
      // Estimate annual from total / years of data
      const yearsOfData = Math.max(1, creditsByMonth.size / 12);
      const annualDividend = tickerData.total / yearsOfData;
      yieldPct = Math.round((annualDividend / holding.currentValue) * 10000) / 100;
    }

    contributors.push({
      ticker: tickerData.ticker,
      dividendDollar: Math.round(tickerData.total * 100) / 100,
      yieldPct,
      percentOfTotal: totalDividends > 0
        ? Math.round((tickerData.total / totalDividends) * 10000) / 100
        : 0,
      paymentCount: tickerData.count,
    });
  }

  // Sort by dividend amount descending
  contributors.sort((a, b) => b.dividendDollar - a.dividendDollar);

  // ============================================================================
  // CONCENTRATION
  // ============================================================================

  const top1Ticker = contributors.length > 0 ? contributors[0].ticker : null;
  const top3Tickers = contributors.slice(0, 3).map(c => c.ticker);
  const top1Percent = contributors.length > 0 ? contributors[0].percentOfTotal : 0;
  const top3Percent = contributors.slice(0, 3).reduce((sum, c) => sum + c.percentOfTotal, 0);

  const concentration: IncomeConcentration = {
    top1Percent,
    top3Percent,
    top1Ticker,
    top3Tickers,
    isConcentrated: top1Percent > 40 || top3Percent > 70,
  };

  // ============================================================================
  // TIMELINE
  // ============================================================================

  const timeline: IncomeTimelineEvent[] = credits.slice(0, 20).map(c => ({
    ticker: c.ticker,
    eventType: 'paid' as const,
    date: new Date(c.creditedAt).toISOString().slice(0, 10),
    amountReceived: Math.round(c.amountGross * 100) / 100,
    dateEstimated: c.dividendEvent?.status === 'preliminary',
  }));

  // ============================================================================
  // HEALTH SCORE
  // ============================================================================

  // Stability (0-25): Based on monthly std dev coefficient of variation
  let stabilityScore = 25;
  const stabilityCalc: string[] = [
    'Score starts at 25/25.',
    'Measures consistency of monthly dividend income using coefficient of variation (CV = std dev / mean).',
    'CV > 50% â†’ 5/25, CV > 40% â†’ 10/25, CV > 30% â†’ 15/25, CV > 20% â†’ 20/25, CV â‰¤ 20% â†’ 25/25.',
  ];
  const stabilityEvidence: string[] = [];
  const stabilityDrivers: { label: string; value: string; impact: string }[] = [];
  const stabilityFixes: string[] = [];

  if (monthlyStdDev !== null && avgMonthly > 0) {
    const cv = monthlyStdDev / avgMonthly;
    stabilityEvidence.push(`Monthly income data: ${creditsByMonth.size} months analyzed.`);
    stabilityEvidence.push(`Average monthly income: ${formatCurrency(avgMonthly)}.`);
    stabilityEvidence.push(`Std deviation: ${formatCurrency(monthlyStdDev)}.`);
    stabilityEvidence.push(`Coefficient of variation: ${(cv * 100).toFixed(1)}%.`);

    if (cv > 0.5) {
      stabilityScore = 5;
      stabilityDrivers.push({ label: 'CV', value: `${(cv * 100).toFixed(1)}%`, impact: 'Score 5/25 (>50% threshold)' });
      stabilityFixes.push('Add holdings with more consistent payout schedules (monthly or quarterly payers).');
    } else if (cv > 0.4) {
      stabilityScore = 10;
      stabilityDrivers.push({ label: 'CV', value: `${(cv * 100).toFixed(1)}%`, impact: 'Score 10/25 (>40% threshold)' });
      stabilityFixes.push('Consider adding monthly dividend payers to smooth income.');
    } else if (cv > 0.3) {
      stabilityScore = 15;
      stabilityDrivers.push({ label: 'CV', value: `${(cv * 100).toFixed(1)}%`, impact: 'Score 15/25 (>30% threshold)' });
    } else if (cv > 0.2) {
      stabilityScore = 20;
      stabilityDrivers.push({ label: 'CV', value: `${(cv * 100).toFixed(1)}%`, impact: 'Score 20/25 (>20% threshold)' });
    } else {
      stabilityScore = 25;
      stabilityDrivers.push({ label: 'CV', value: `${(cv * 100).toFixed(1)}%`, impact: 'Full score â€” very stable income' });
    }
  } else if (creditsByMonth.size < 3) {
    stabilityScore = 10;
    stabilityEvidence.push(`Only ${creditsByMonth.size} month(s) of data available.`);
    stabilityDrivers.push({ label: 'Data', value: `${creditsByMonth.size} months`, impact: 'Insufficient data â€” default score 10/25' });
    stabilityFixes.push('Continue tracking to build more dividend history.');
  }

  // Growth (0-25): Based on YoY change
  let growthScore = 15;
  const growthCalc: string[] = [
    'Score starts at 15/25 (default when no YoY data).',
    'Compares dividend income this year vs last year.',
    'YoY â‰¥ 20% â†’ 25/25, â‰¥ 10% â†’ 22/25, â‰¥ 5% â†’ 20/25, â‰¥ 0% â†’ 15/25, â‰¥ -10% â†’ 10/25, < -10% â†’ 5/25.',
  ];
  const growthEvidence: string[] = [];
  const growthDrivers: { label: string; value: string; impact: string }[] = [];
  const growthFixes: string[] = [];

  if (yoyChangePct !== null) {
    growthEvidence.push(`This year dividend income: ${formatCurrency(totalThisYear)}.`);
    growthEvidence.push(`Last year dividend income: ${formatCurrency(totalLastYear)}.`);
    growthEvidence.push(`Year-over-year change: ${yoyChangePct >= 0 ? '+' : ''}${yoyChangePct.toFixed(1)}%.`);

    if (yoyChangePct >= 20) {
      growthScore = 25;
      growthDrivers.push({ label: 'YoY Change', value: `+${yoyChangePct.toFixed(1)}%`, impact: 'Full score â€” excellent growth' });
    } else if (yoyChangePct >= 10) {
      growthScore = 22;
      growthDrivers.push({ label: 'YoY Change', value: `+${yoyChangePct.toFixed(1)}%`, impact: 'Score 22/25 (â‰¥10% growth)' });
    } else if (yoyChangePct >= 5) {
      growthScore = 20;
      growthDrivers.push({ label: 'YoY Change', value: `+${yoyChangePct.toFixed(1)}%`, impact: 'Score 20/25 (â‰¥5% growth)' });
    } else if (yoyChangePct >= 0) {
      growthScore = 15;
      growthDrivers.push({ label: 'YoY Change', value: `${yoyChangePct.toFixed(1)}%`, impact: 'Score 15/25 (flat/slight growth)' });
      growthFixes.push('Look for dividend growth stocks to increase income over time.');
    } else if (yoyChangePct >= -10) {
      growthScore = 10;
      growthDrivers.push({ label: 'YoY Change', value: `${yoyChangePct.toFixed(1)}%`, impact: 'Score 10/25 (slight decline)' });
      growthFixes.push('Review holdings that cut dividends and consider replacing with growers.');
    } else {
      growthScore = 5;
      growthDrivers.push({ label: 'YoY Change', value: `${yoyChangePct.toFixed(1)}%`, impact: 'Score 5/25 (significant decline)' });
      growthFixes.push('Significant income decline. Review portfolio for dividend cuts.');
    }

    if (holdingsRaisedPayout.length > 0) {
      growthEvidence.push(`Holdings that raised payouts: ${holdingsRaisedPayout.join(', ')}.`);
    }
  } else {
    growthEvidence.push('Not enough historical data for YoY comparison.');
    growthDrivers.push({ label: 'Data', value: 'N/A', impact: 'Default score 15/25 â€” no YoY comparison available' });
  }

  // Coverage (0-25): % of holdings that pay dividends
  const dividendPayingHoldings = new Set(summary.byTicker.map(t => t.ticker));
  const holdingsPayingDividends = holdings.filter(h => dividendPayingHoldings.has(h.ticker)).length;
  const coverageRatio = holdings.length > 0 ? holdingsPayingDividends / holdings.length : 0;

  let coverageScore = 5;
  const coverageCalc: string[] = [
    'Measures what percentage of your holdings pay dividends.',
    'â‰¥ 80% â†’ 25/25, â‰¥ 60% â†’ 20/25, â‰¥ 40% â†’ 15/25, â‰¥ 20% â†’ 10/25, < 20% â†’ 5/25.',
  ];
  const coverageEvidence: string[] = [];
  const coverageDrivers: { label: string; value: string; impact: string }[] = [];
  const coverageFixes: string[] = [];

  coverageEvidence.push(`Total holdings: ${holdings.length}.`);
  coverageEvidence.push(`Holdings paying dividends: ${holdingsPayingDividends}.`);
  coverageEvidence.push(`Coverage ratio: ${(coverageRatio * 100).toFixed(1)}%.`);

  if (coverageRatio >= 0.8) {
    coverageScore = 25;
    coverageDrivers.push({ label: 'Coverage', value: `${(coverageRatio * 100).toFixed(0)}%`, impact: 'Full score â€” most holdings pay dividends' });
  } else if (coverageRatio >= 0.6) {
    coverageScore = 20;
    coverageDrivers.push({ label: 'Coverage', value: `${(coverageRatio * 100).toFixed(0)}%`, impact: 'Score 20/25 (â‰¥60% coverage)' });
  } else if (coverageRatio >= 0.4) {
    coverageScore = 15;
    coverageDrivers.push({ label: 'Coverage', value: `${(coverageRatio * 100).toFixed(0)}%`, impact: 'Score 15/25 (â‰¥40% coverage)' });
    coverageFixes.push('Consider adding dividend-paying stocks to increase income coverage.');
  } else if (coverageRatio >= 0.2) {
    coverageScore = 10;
    coverageDrivers.push({ label: 'Coverage', value: `${(coverageRatio * 100).toFixed(0)}%`, impact: 'Score 10/25 (â‰¥20% coverage)' });
    coverageFixes.push('Most holdings don\'t pay dividends. Add income-generating assets.');
  } else {
    coverageScore = 5;
    coverageDrivers.push({ label: 'Coverage', value: `${(coverageRatio * 100).toFixed(0)}%`, impact: 'Score 5/25 (low coverage)' });
    coverageFixes.push('Very few holdings pay dividends. Consider dividend ETFs for diversified income.');
  }

  // Diversification (0-25): Inverse of concentration
  let diversificationScore = 25;
  const divCalc: string[] = [
    'Measures how spread out your dividend income is across sources.',
    'Top 1 source > 60% â†’ 5/25, > 50% â†’ 10/25, > 40% â†’ 15/25, > 30% â†’ 20/25, â‰¤ 30% â†’ 25/25.',
    'Also penalized if fewer than 5 dividend sources.',
  ];
  const divEvidence: string[] = [];
  const divDrivers: { label: string; value: string; impact: string }[] = [];
  const divFixes: string[] = [];
  const numSources = summary.byTicker.length;

  divEvidence.push(`Number of dividend sources: ${numSources}.`);
  if (top1Ticker) {
    divEvidence.push(`Largest source: ${top1Ticker} at ${top1Percent.toFixed(1)}% of total income.`);
  }
  if (top3Tickers.length > 0) {
    divEvidence.push(`Top 3 sources (${top3Tickers.join(', ')}): ${top3Percent.toFixed(1)}% of total income.`);
  }

  if (top1Percent > 60) {
    diversificationScore = 5;
    divDrivers.push({ label: 'Top 1 concentration', value: `${top1Percent.toFixed(1)}%`, impact: 'Score 5/25 (>60% threshold)' });
    divFixes.push('Income is heavily concentrated. Add more dividend sources to reduce risk.');
  } else if (top1Percent > 50) {
    diversificationScore = 10;
    divDrivers.push({ label: 'Top 1 concentration', value: `${top1Percent.toFixed(1)}%`, impact: 'Score 10/25 (>50% threshold)' });
    divFixes.push('Consider adding dividend stocks to reduce concentration.');
  } else if (top1Percent > 40) {
    diversificationScore = 15;
    divDrivers.push({ label: 'Top 1 concentration', value: `${top1Percent.toFixed(1)}%`, impact: 'Score 15/25 (>40% threshold)' });
  } else if (top1Percent > 30) {
    diversificationScore = 20;
    divDrivers.push({ label: 'Top 1 concentration', value: `${top1Percent.toFixed(1)}%`, impact: 'Score 20/25 (>30% threshold)' });
  } else {
    diversificationScore = 25;
    divDrivers.push({ label: 'Top 1 concentration', value: `${top1Percent.toFixed(1)}%`, impact: 'Full score â€” well diversified' });
  }

  // Adjust for number of dividend sources
  if (numSources < 3) {
    diversificationScore = Math.min(diversificationScore, 10);
    divDrivers.push({ label: 'Source count', value: `${numSources}`, impact: 'Capped at 10/25 (<3 sources)' });
    divFixes.push('Add more dividend-paying holdings to increase diversification.');
  } else if (numSources < 5) {
    diversificationScore = Math.min(diversificationScore, 15);
    divDrivers.push({ label: 'Source count', value: `${numSources}`, impact: 'Capped at 15/25 (<5 sources)' });
  }

  const overall = stabilityScore + growthScore + coverageScore + diversificationScore;

  let grade: IncomeHealthScore['grade'] = 'Poor';
  if (overall >= 75) grade = 'Excellent';
  else if (overall >= 50) grade = 'Good';
  else if (overall >= 25) grade = 'Fair';

  const healthScore: IncomeHealthScore = {
    overall,
    breakdown: {
      stability: stabilityScore,
      growth: growthScore,
      coverage: coverageScore,
      diversification: diversificationScore,
    },
    grade,
    details: {
      stability: {
        score: stabilityScore,
        maxScore: 25,
        calcBullets: stabilityCalc,
        evidenceBullets: stabilityEvidence,
        drivers: stabilityDrivers,
        quickFixes: stabilityFixes,
      },
      growth: {
        score: growthScore,
        maxScore: 25,
        calcBullets: growthCalc,
        evidenceBullets: growthEvidence,
        drivers: growthDrivers,
        quickFixes: growthFixes,
      },
      coverage: {
        score: coverageScore,
        maxScore: 25,
        calcBullets: coverageCalc,
        evidenceBullets: coverageEvidence,
        drivers: coverageDrivers,
        quickFixes: coverageFixes,
      },
      diversification: {
        score: diversificationScore,
        maxScore: 25,
        calcBullets: divCalc,
        evidenceBullets: divEvidence,
        drivers: divDrivers,
        quickFixes: divFixes,
      },
    },
  };

  // ============================================================================
  // KEY DRIVERS
  // ============================================================================

  const keyDrivers: string[] = [];

  // Factual statements about the portfolio's income
  if (totalYTD > 0) {
    keyDrivers.push(`You've received ${formatCurrency(totalYTD)} in dividends YTD.`);
  }

  if (top1Ticker && top1Percent > 0) {
    keyDrivers.push(`${top1Ticker} is your largest income source at ${top1Percent.toFixed(1)}% of total dividends.`);
  }

  if (holdingsRaisedPayout.length > 0) {
    keyDrivers.push(`${holdingsRaisedPayout.length} holding(s) increased their payout vs last year: ${holdingsRaisedPayout.slice(0, 3).join(', ')}.`);
  }

  if (consecutiveMonths > 0) {
    keyDrivers.push(`You've received income for ${consecutiveMonths} consecutive month(s).`);
  }

  if (coverageRatio < 0.5 && holdings.length > 0) {
    keyDrivers.push(`${Math.round((1 - coverageRatio) * 100)}% of your holdings don't pay dividends.`);
  }

  if (concentration.isConcentrated) {
    keyDrivers.push(`Income is concentrated: top 3 sources account for ${top3Percent.toFixed(0)}%.`);
  }

  // ============================================================================
  // LIVE INTELLIGENCE
  // ============================================================================

  const windowCredits = credits.filter(c => new Date(c.creditedAt) >= windowStart);
  const amountInWindow = windowCredits.reduce((sum, c) => sum + c.amountGross, 0);

  let statement: string;
  if (amountInWindow > 0) {
    const tickersInWindow = [...new Set(windowCredits.map(c => c.ticker))];
    if (window === 'today') {
      statement = `You received ${formatCurrency(amountInWindow)} in dividends today from ${tickersInWindow.join(', ')}.`;
    } else if (window === '5d') {
      statement = `${formatCurrency(amountInWindow)} received this week from ${tickersInWindow.length} source(s).`;
    } else {
      statement = `${formatCurrency(amountInWindow)} received this month from ${tickersInWindow.length} source(s).`;
    }
  } else {
    if (window === 'today') {
      statement = 'No dividend payments today.';
    } else if (window === '5d') {
      statement = 'No dividends received this week.';
    } else {
      statement = 'No dividends received this month.';
    }
  }

  const liveIntelligence: IncomeLiveIntelligence = {
    window,
    statement,
    amountInWindow: Math.round(amountInWindow * 100) / 100,
  };

  // ============================================================================
  // RESULT
  // ============================================================================

  const result: IncomeInsightsResponse = {
    healthScore,
    keyDrivers: keyDrivers.slice(0, 5),
    liveIntelligence,
    signals: {
      cashFlow,
      momentum,
      reliability,
    },
    contributors: contributors.slice(0, 10),
    concentration,
    timeline,
  };

  // Cache for 5 minutes
  insightsCache.set(cacheKey, result, 300);
  return result;
}

