import prisma from '../utils/prisma';
import { fetchPrices } from './market.service';



function round(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function calcYoY(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return round(((current - previous) / previous) * 100, 2);
}

function calcCagr(current: number, base: number, years: number): number | null {
  if (base <= 0 || years <= 0) return null;
  return round((Math.pow(current / base, 1 / years) - 1) * 100, 2);
}

export async function getDividendGrowthRates(
  userId: string,
  options: { excludeCurrentYear?: boolean; portfolioId?: string } = {}
) {
  const where: any = { userId, shares: { gt: 0 } };
  if (options.portfolioId) where.portfolioId = options.portfolioId;
  const holdings = await prisma.holding.findMany({
    where,
    select: { ticker: true, shares: true },
  });

  if (holdings.length === 0) {
    return { holdings: [], portfolio: { weightedAvgGrowthRate: null, totalAnnualIncome: 0, totalMonthlyIncome: 0 } };
  }

  const tickers = holdings.map(h => h.ticker.toUpperCase());

  const events = await prisma.dividendEvent.findMany({
    where: {
      ticker: { in: tickers },
      dividendType: 'regular',
      status: 'confirmed',
    },
    orderBy: { payDate: 'asc' },
  });

  const byTicker = new Map<string, Map<number, { total: number; lastPayDate: Date }>>();
  for (const event of events) {
    const year = event.payDate.getFullYear();
    const map = byTicker.get(event.ticker) ?? new Map<number, { total: number; lastPayDate: Date }>();
    const existing = map.get(year) ?? { total: 0, lastPayDate: event.payDate };
    existing.total += event.amountPerShare;
    if (event.payDate > existing.lastPayDate) existing.lastPayDate = event.payDate;
    map.set(year, existing);
    byTicker.set(event.ticker, map);
  }

  const quotesResult = await fetchPrices(tickers);

  const holdingsResults: any[] = [];
  const currentYear = new Date().getFullYear();
  const excludeCurrentYear = options.excludeCurrentYear ?? true;
  let totalAnnualIncome = 0;
  let weightedGrowthNumerator = 0;
  let weightedGrowthDenominator = 0;

  for (const holding of holdings) {
    const ticker = holding.ticker.toUpperCase();
    const yearMap = byTicker.get(ticker);
    if (!yearMap) continue;

    let years = Array.from(yearMap.keys()).sort((a, b) => a - b);
    if (excludeCurrentYear) {
      years = years.filter(y => y < currentYear);
    }
    if (years.length < 2) continue;

    const history = years.map(year => ({
      year,
      totalPerShare: round(yearMap.get(year)!.total, 2),
    }));

    const lastYear = years[years.length - 1];
    const prevYear = years[years.length - 2];
    const lastTotal = yearMap.get(lastYear)!.total;
    const prevTotal = yearMap.get(prevYear)!.total;

    const growth1yr = calcYoY(lastTotal, prevTotal);

    const year3 = lastYear - 3;
    const year5 = lastYear - 5;
    const total3 = yearMap.get(year3)?.total;
    const total5 = yearMap.get(year5)?.total;

    const growth3yr = total3 !== undefined ? calcCagr(lastTotal, total3, 3) : null;
    const growth5yr = total5 !== undefined ? calcCagr(lastTotal, total5, 5) : null;

    // Consecutive years of dividend growth
    let consecutiveYearsGrowth = 0;
    for (let i = years.length - 1; i > 0; i--) {
      const curr = yearMap.get(years[i])!.total;
      const prev = yearMap.get(years[i - 1])!.total;
      if (curr > prev) consecutiveYearsGrowth++;
      else break;
    }

    // Last increase date + pct
    let lastIncreaseDate: string | null = null;
    let lastIncreasePct: number | null = null;
    for (let i = years.length - 1; i > 0; i--) {
      const currYear = years[i];
      const prevYearLocal = years[i - 1];
      const currTotal = yearMap.get(currYear)!.total;
      const prevTotalLocal = yearMap.get(prevYearLocal)!.total;
      if (currTotal > prevTotalLocal) {
        lastIncreaseDate = yearMap.get(currYear)!.lastPayDate.toISOString().slice(0, 10);
        lastIncreasePct = calcYoY(currTotal, prevTotalLocal);
        break;
      }
    }

    const quote = quotesResult.quotes.get(ticker);
    const currentPrice = quote?.currentPrice ?? null;
    const currentAnnualDividend = round(lastTotal, 2);
    const dividendYield = currentPrice && currentPrice > 0
      ? round((currentAnnualDividend / currentPrice) * 100, 2)
      : null;

    const annualIncome = currentAnnualDividend * holding.shares;
    totalAnnualIncome += annualIncome;

    const primaryGrowthRate = growth5yr ?? growth3yr ?? growth1yr;
    if (primaryGrowthRate !== null) {
      weightedGrowthNumerator += primaryGrowthRate * annualIncome;
      weightedGrowthDenominator += annualIncome;
    }

    holdingsResults.push({
      ticker,
      currentAnnualDividend,
      dividendYield,
      growthRates: {
        '1yr': growth1yr,
        '3yr': growth3yr,
        '5yr': growth5yr,
      },
      consecutiveYearsGrowth,
      lastIncreaseDate,
      lastIncreasePct,
      history,
    });
  }

  const weightedAvgGrowthRate = weightedGrowthDenominator > 0
    ? round(weightedGrowthNumerator / weightedGrowthDenominator, 2)
    : null;

  return {
    holdings: holdingsResults,
    portfolio: {
      weightedAvgGrowthRate,
      totalAnnualIncome: round(totalAnnualIncome, 2),
      totalMonthlyIncome: round(totalAnnualIncome / 12, 2),
    },
  };
}
