/**
 * Company Fundamentals Service
 *
 * Fetches company overview, income statements, balance sheets, and cash flows
 * from Alpha Vantage. Uses Prisma/SQLite for persistent caching (7-day TTL).
 * Background rotation job refreshes ~4 tickers per run.
 */

import prisma from '../utils/prisma';
import {
  fetchCompanyOverview,
  fetchIncomeStatement,
  fetchBalanceSheet,
  fetchCashFlow,
  parseAVNumber,
  getDailyCallsRemaining,
  AVCompanyOverview,
  AVFinancialReport,
} from '../utils/alpha-vantage';



const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// â”€â”€ Parsed types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ParsedOverview {
  name: string;
  description: string;
  sector: string;
  industry: string;
  marketCap: number | null;
  peRatio: number | null;
  pegRatio: number | null;
  eps: number | null;
  forwardPE: number | null;
  profitMargin: number | null;
  returnOnEquity: number | null;
  revenueTTM: number | null;
  dividendYield: number | null;
  beta: number | null;
  analystTargetPrice: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  bookValue: number | null;
  sharesOutstanding: number | null;
}

export interface ParsedIncomeStatement {
  fiscalDateEnding: string;
  period: 'annual' | 'quarterly';
  totalRevenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  ebitda: number | null;
  researchAndDevelopment: number | null;
}

export interface ParsedBalanceSheet {
  fiscalDateEnding: string;
  period: 'annual' | 'quarterly';
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalShareholderEquity: number | null;
  cashAndEquivalents: number | null;
  longTermDebt: number | null;
  currentDebt: number | null;
}

export interface ParsedCashFlow {
  fiscalDateEnding: string;
  period: 'annual' | 'quarterly';
  operatingCashflow: number | null;
  capitalExpenditures: number | null;
  freeCashFlow: number | null;
  dividendPayout: number | null;
  netIncome: number | null;
}

export interface FundamentalsResponse {
  ticker: string;
  overview: ParsedOverview | null;
  incomeStatements: { annual: ParsedIncomeStatement[]; quarterly: ParsedIncomeStatement[] };
  balanceSheets: { annual: ParsedBalanceSheet[]; quarterly: ParsedBalanceSheet[] };
  cashFlows: { annual: ParsedCashFlow[]; quarterly: ParsedCashFlow[] };
  lastUpdated: string;
  dataAge: 'fresh' | 'cached' | 'stale';
}

function safeParseCachedJson<T>(ticker: string, label: string, raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`[AV Fundamentals] Ignoring malformed cached ${label} for ${ticker}`);
    return fallback;
  }
}

// â”€â”€ Parsers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseOverview(raw: AVCompanyOverview): ParsedOverview {
  return {
    name: raw.Name || '',
    description: raw.Description || '',
    sector: raw.Sector || '',
    industry: raw.Industry || '',
    marketCap: parseAVNumber(raw.MarketCapitalization),
    peRatio: parseAVNumber(raw.PERatio),
    pegRatio: parseAVNumber(raw.PEGRatio),
    eps: parseAVNumber(raw.EPS),
    forwardPE: parseAVNumber(raw.ForwardPE),
    profitMargin: parseAVNumber(raw.ProfitMargin),
    returnOnEquity: parseAVNumber(raw.ReturnOnEquityTTM),
    revenueTTM: parseAVNumber(raw.RevenueTTM),
    dividendYield: parseAVNumber(raw.DividendYield),
    beta: parseAVNumber(raw.Beta),
    analystTargetPrice: parseAVNumber(raw.AnalystTargetPrice),
    fiftyTwoWeekHigh: parseAVNumber(raw['52WeekHigh']),
    fiftyTwoWeekLow: parseAVNumber(raw['52WeekLow']),
    bookValue: parseAVNumber(raw.BookValue),
    sharesOutstanding: parseAVNumber(raw.SharesOutstanding),
  };
}

function parseIncomeStatements(reports: AVFinancialReport[], period: 'annual' | 'quarterly'): ParsedIncomeStatement[] {
  return reports.slice(0, 5).map(r => ({
    fiscalDateEnding: r.fiscalDateEnding,
    period,
    totalRevenue: parseAVNumber(r.totalRevenue),
    grossProfit: parseAVNumber(r.grossProfit),
    operatingIncome: parseAVNumber(r.operatingIncome),
    netIncome: parseAVNumber(r.netIncome),
    ebitda: parseAVNumber(r.ebitda),
    researchAndDevelopment: parseAVNumber(r.researchAndDevelopment),
  }));
}

function parseBalanceSheets(reports: AVFinancialReport[], period: 'annual' | 'quarterly'): ParsedBalanceSheet[] {
  return reports.slice(0, 5).map(r => ({
    fiscalDateEnding: r.fiscalDateEnding,
    period,
    totalAssets: parseAVNumber(r.totalAssets),
    totalLiabilities: parseAVNumber(r.totalCurrentLiabilities != null ? undefined : r.totalLiabilities),
    totalShareholderEquity: parseAVNumber(r.totalShareholderEquity),
    cashAndEquivalents: parseAVNumber(r.cashAndCashEquivalentsAtCarryingValue),
    longTermDebt: parseAVNumber(r.longTermDebt),
    currentDebt: parseAVNumber(r.currentDebt ?? r.shortTermDebt),
  }));
}

function parseCashFlows(reports: AVFinancialReport[], period: 'annual' | 'quarterly'): ParsedCashFlow[] {
  return reports.slice(0, 5).map(r => {
    const opCF = parseAVNumber(r.operatingCashflow);
    const capEx = parseAVNumber(r.capitalExpenditures);
    const fcf = opCF != null && capEx != null ? opCF - Math.abs(capEx) : null;
    return {
      fiscalDateEnding: r.fiscalDateEnding,
      period,
      operatingCashflow: opCF,
      capitalExpenditures: capEx,
      freeCashFlow: fcf,
      dividendPayout: parseAVNumber(r.dividendPayout),
      netIncome: parseAVNumber(r.netIncome),
    };
  });
}

// â”€â”€ Cache logic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Get fundamentals from cache, fetching from AV if stale and budget allows. */
export async function getCompanyFundamentals(ticker: string): Promise<FundamentalsResponse> {
  const upper = ticker.toUpperCase();
  const cached = await prisma.fundamentalsCache.findUnique({ where: { ticker: upper } });

  const empty: FundamentalsResponse = {
    ticker: upper,
    overview: null,
    incomeStatements: { annual: [], quarterly: [] },
    balanceSheets: { annual: [], quarterly: [] },
    cashFlows: { annual: [], quarterly: [] },
    lastUpdated: '',
    dataAge: 'stale',
  };

  if (cached) {
    const ageMs = Date.now() - new Date(cached.lastFetchedAt).getTime();
    const dataAge: 'fresh' | 'cached' | 'stale' =
      ageMs < 24 * 60 * 60 * 1000 ? 'fresh' :
      ageMs < CACHE_MAX_AGE_MS ? 'cached' : 'stale';

    const result = deserializeCache(upper, cached, dataAge);

    // If cache is still valid, return it
    if (dataAge !== 'stale') return result;

    // Cache is stale â€” try to refresh in background if budget allows
    const remaining = await getDailyCallsRemaining();
    if (remaining >= 4) {
      // Refresh async â€” return stale data now, next request gets fresh
      refreshFundamentals(upper).catch(err =>
        console.error(`[AV Fundamentals] Background refresh failed for ${upper}:`, err.message)
      );
    }

    return result;
  }

  // No cache at all â€” try to fetch if budget allows
  const remaining = await getDailyCallsRemaining();
  if (remaining >= 4) {
    try {
      await refreshFundamentals(upper);
      const fresh = await prisma.fundamentalsCache.findUnique({ where: { ticker: upper } });
      if (fresh) return deserializeCache(upper, fresh, 'fresh');
    } catch (err) {
      console.error(`[AV Fundamentals] On-demand fetch failed for ${upper}:`, (err as Error).message);
    }
  }

  return empty;
}

function deserializeCache(
  ticker: string,
  cached: { overviewJson: string | null; incomeJson: string | null; balanceJson: string | null; cashFlowJson: string | null; lastFetchedAt: Date },
  dataAge: 'fresh' | 'cached' | 'stale',
): FundamentalsResponse {
  const overview = safeParseCachedJson<ParsedOverview | null>(ticker, 'overview', cached.overviewJson, null);
  const income = safeParseCachedJson<{ annual: ParsedIncomeStatement[]; quarterly: ParsedIncomeStatement[] }>(
    ticker,
    'income statements',
    cached.incomeJson,
    { annual: [], quarterly: [] },
  );
  const balance = safeParseCachedJson<{ annual: ParsedBalanceSheet[]; quarterly: ParsedBalanceSheet[] }>(
    ticker,
    'balance sheets',
    cached.balanceJson,
    { annual: [], quarterly: [] },
  );
  const cashFlow = safeParseCachedJson<{ annual: ParsedCashFlow[]; quarterly: ParsedCashFlow[] }>(
    ticker,
    'cash flows',
    cached.cashFlowJson,
    { annual: [], quarterly: [] },
  );

  return {
    ticker,
    overview,
    incomeStatements: income,
    balanceSheets: balance,
    cashFlows: cashFlow,
    lastUpdated: new Date(cached.lastFetchedAt).toISOString(),
    dataAge,
  };
}

/** Fetch all fundamentals for a ticker from AV and save to Prisma. Uses 4 API calls. */
async function refreshFundamentals(ticker: string): Promise<void> {
  console.log(`[AV Fundamentals] Refreshing ${ticker}...`);

  const [overview, income, balance, cashFlow] = await Promise.all([
    fetchCompanyOverview(ticker),
    fetchIncomeStatement(ticker),
    fetchBalanceSheet(ticker),
    fetchCashFlow(ticker),
  ]);

  const overviewParsed = overview ? parseOverview(overview) : null;
  const incomeParsed = income ? {
    annual: parseIncomeStatements(income.annualReports || [], 'annual'),
    quarterly: parseIncomeStatements(income.quarterlyReports || [], 'quarterly'),
  } : { annual: [], quarterly: [] };
  const balanceParsed = balance ? {
    annual: parseBalanceSheets(balance.annualReports || [], 'annual'),
    quarterly: parseBalanceSheets(balance.quarterlyReports || [], 'quarterly'),
  } : { annual: [], quarterly: [] };
  const cashFlowParsed = cashFlow ? {
    annual: parseCashFlows(cashFlow.annualReports || [], 'annual'),
    quarterly: parseCashFlows(cashFlow.quarterlyReports || [], 'quarterly'),
  } : { annual: [], quarterly: [] };

  await prisma.fundamentalsCache.upsert({
    where: { ticker },
    update: {
      overviewJson: JSON.stringify(overviewParsed),
      incomeJson: JSON.stringify(incomeParsed),
      balanceJson: JSON.stringify(balanceParsed),
      cashFlowJson: JSON.stringify(cashFlowParsed),
      lastFetchedAt: new Date(),
    },
    create: {
      ticker,
      overviewJson: JSON.stringify(overviewParsed),
      incomeJson: JSON.stringify(incomeParsed),
      balanceJson: JSON.stringify(balanceParsed),
      cashFlowJson: JSON.stringify(cashFlowParsed),
      lastFetchedAt: new Date(),
    },
  });

  console.log(`[AV Fundamentals] Cached ${ticker}`);
}

/** Public wrapper to force-refresh fundamentals for a ticker. */
export async function refreshFundamentalsForTicker(ticker: string): Promise<void> {
  const upper = ticker.toUpperCase();
  await refreshFundamentals(upper);
}

/** Background rotation: refresh the N oldest/never-fetched tickers. */
export async function rotateTickerFundamentals(allTickers: string[]): Promise<void> {
  const remaining = await getDailyCallsRemaining();
  const callsPerTicker = 4;
  const maxTickers = Math.floor(Math.min(remaining, 16) / callsPerTicker);

  if (maxTickers === 0) {
    console.log('[AV Fundamentals] No daily budget remaining, skipping rotation');
    return;
  }

  const cached = await prisma.fundamentalsCache.findMany({
    select: { ticker: true, lastFetchedAt: true },
  });
  const cachedMap = new Map(cached.map(c => [c.ticker, c.lastFetchedAt]));

  const upperTickers = allTickers.map(t => t.toUpperCase());
  const neverFetched = upperTickers.filter(t => !cachedMap.has(t));
  const previouslyFetched = upperTickers
    .filter(t => cachedMap.has(t))
    .sort((a, b) => cachedMap.get(a)!.getTime() - cachedMap.get(b)!.getTime());

  const tickersToRefresh = [...neverFetched, ...previouslyFetched].slice(0, maxTickers);

  if (tickersToRefresh.length === 0) {
    console.log('[AV Fundamentals] All tickers recently cached, nothing to rotate');
    return;
  }

  console.log(`[AV Fundamentals] Rotating ${tickersToRefresh.length} tickers: ${tickersToRefresh.join(', ')}`);

  for (const t of tickersToRefresh) {
    try {
      await refreshFundamentals(t);
    } catch (err) {
      console.error(`[AV Fundamentals] Rotation failed for ${t}:`, (err as Error).message);
    }
  }
}

