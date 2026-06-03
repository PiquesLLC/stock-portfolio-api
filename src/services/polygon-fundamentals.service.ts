/**
 * Polygon.io Fundamentals Service
 *
 * Replaces Alpha Vantage for financial statements. Uses Polygon's
 * /vX/reference/financials endpoint (unlimited on Developer plan).
 * Caches results in Prisma FundamentalsCache (7-day TTL).
 *
 * Returns the same FundamentalsResponse interface as the old AV service
 * so the controller + UI don't need changes.
 */

import axios from 'axios';
import prisma from '../utils/prisma';
import { config } from '../config';

const POLYGON_BASE = 'https://api.polygon.io';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Parsed types (match existing UI contract) ─────────────────────────

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

// ── Polygon data helpers ──────────────────────────────────────────────

function pVal(obj: Record<string, any> | undefined, key: string): number | null {
  if (!obj) return null;
  const v = obj[key]?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

interface PolygonFiling {
  fiscal_period: string;          // "FY", "Q1", "Q2", "Q3", "Q4"
  fiscal_year: string;
  start_date: string;
  end_date: string;
  filing_date: string;
  financials: {
    income_statement?: Record<string, { value?: number; unit?: string; label?: string }>;
    balance_sheet?: Record<string, { value?: number; unit?: string; label?: string }>;
    cash_flow_statement?: Record<string, { value?: number; unit?: string; label?: string }>;
    comprehensive_income?: Record<string, { value?: number; unit?: string; label?: string }>;
  };
  company_name?: string;
}

async function fetchPolygonFinancials(
  ticker: string,
  timeframe: 'annual' | 'quarterly',
  limit = 20,
): Promise<PolygonFiling[]> {
  if (!config.polygonApiKey) return [];

  try {
    const resp = await axios.get(`${POLYGON_BASE}/vX/reference/financials`, {
      params: {
        ticker: ticker.toUpperCase(),
        timeframe,
        limit,
        sort: 'period_of_report_date',
        order: 'desc',
        apiKey: config.polygonApiKey,
      },
      timeout: 15000,
    });
    return resp.data?.results ?? [];
  } catch (err) {
    console.error(`[Polygon Fundamentals] Fetch failed for ${ticker} (${timeframe}):`, (err as Error).message);
    return [];
  }
}

async function fetchPolygonTickerDetails(ticker: string): Promise<Record<string, any> | null> {
  if (!config.polygonApiKey) return null;

  try {
    const resp = await axios.get(`${POLYGON_BASE}/v3/reference/tickers/${ticker.toUpperCase()}`, {
      params: { apiKey: config.polygonApiKey },
      timeout: 10000,
    });
    return resp.data?.results ?? null;
  } catch {
    return null;
  }
}

// ── Parsers ───────────────────────────────────────────────────────────

function parseIncomeStatement(filing: PolygonFiling, period: 'annual' | 'quarterly'): ParsedIncomeStatement {
  const is = filing.financials?.income_statement;
  const revenue = pVal(is, 'revenues');
  const costOfRevenue = pVal(is, 'cost_of_revenue');
  const grossProfit = pVal(is, 'gross_profit') ??
    (revenue != null && costOfRevenue != null ? revenue - costOfRevenue : null);
  const operatingIncome = pVal(is, 'operating_income_loss');
  const netIncome = pVal(is, 'net_income_loss');

  // EBITDA: Polygon rarely provides it directly. Derive from operating income + D&A estimate.
  // D&A ~ operating cash flow - net income (rough proxy when D&A field absent)
  let ebitda = pVal(is, 'ebitda');
  if (ebitda == null && operatingIncome != null) {
    const cf = filing.financials?.cash_flow_statement;
    const opCF = pVal(cf, 'net_cash_flow_from_operating_activities');
    const ni = netIncome;
    if (opCF != null && ni != null) {
      // D&A is typically the largest non-cash add-back: OCF - NI ≈ D&A + other adjustments
      const impliedDA = opCF - ni;
      if (impliedDA > 0) ebitda = operatingIncome + impliedDA;
    }
  }

  return {
    fiscalDateEnding: filing.end_date,
    period,
    totalRevenue: revenue,
    grossProfit,
    operatingIncome,
    netIncome,
    ebitda,
    researchAndDevelopment: pVal(is, 'research_and_development'),
  };
}

function parseBalanceSheet(filing: PolygonFiling, period: 'annual' | 'quarterly'): ParsedBalanceSheet {
  const bs = filing.financials?.balance_sheet;
  return {
    fiscalDateEnding: filing.end_date,
    period,
    totalAssets: pVal(bs, 'assets'),
    totalLiabilities: pVal(bs, 'liabilities'),
    totalShareholderEquity: pVal(bs, 'equity') ?? pVal(bs, 'stockholders_equity'),
    cashAndEquivalents: pVal(bs, 'cash_and_cash_equivalents') ??
      pVal(bs, 'cash_and_short_term_investments') ??
      pVal(bs, 'cash') ??
      pVal(bs, 'cash_cash_equivalents_and_short_term_investments'),
    longTermDebt: pVal(bs, 'long_term_debt'),
    currentDebt: pVal(bs, 'current_debt'),
  };
}

function parseCashFlow(filing: PolygonFiling, period: 'annual' | 'quarterly'): ParsedCashFlow {
  const cf = filing.financials?.cash_flow_statement;
  const is = filing.financials?.income_statement;

  const opCF = pVal(cf, 'net_cash_flow_from_operating_activities') ??
    pVal(cf, 'net_cash_flow_from_operating_activities_continuing');

  // Prefer explicit CapEx fields; fall back to total investing activities as proxy
  const explicitCapex = pVal(cf, 'capital_expenditure') ??
    pVal(cf, 'payments_to_acquire_property_plant_and_equipment');
  const investingCF = pVal(cf, 'net_cash_flow_from_investing_activities') ??
    pVal(cf, 'net_cash_flow_from_investing_activities_continuing');
  const capex = explicitCapex ?? investingCF;

  // Free cash flow: OCF + CapEx (CapEx is typically negative)
  const fcf = opCF != null && capex != null ? opCF + capex : null;

  // Financing activities includes dividends + buybacks (not broken out separately)
  const financingCF = pVal(cf, 'net_cash_flow_from_financing_activities') ??
    pVal(cf, 'net_cash_flow_from_financing_activities_continuing');

  return {
    fiscalDateEnding: filing.end_date,
    period,
    operatingCashflow: opCF,
    capitalExpenditures: capex != null ? (capex < 0 ? capex : -capex) : null,
    freeCashFlow: fcf,
    dividendPayout: financingCF, // Financing activities as proxy (includes dividends + buybacks)
    netIncome: pVal(is, 'net_income_loss'),
  };
}

function buildOverviewFromFilings(
  annualFilings: PolygonFiling[],
  quarterlyFilings: PolygonFiling[],
  tickerDetails: Record<string, any> | null,
): ParsedOverview | null {
  if (annualFilings.length === 0 && quarterlyFilings.length === 0) return null;

  const latestAnnual = annualFilings[0];
  const latestQuarter = quarterlyFilings[0];
  const latest = latestQuarter || latestAnnual;

  const is = latest?.financials?.income_statement;
  const bs = latest?.financials?.balance_sheet;

  // Compute TTM revenue from last 4 quarters
  let revenueTTM: number | null = null;
  if (quarterlyFilings.length >= 4) {
    const q4 = quarterlyFilings.slice(0, 4);
    const revenues = q4.map(f => pVal(f.financials?.income_statement, 'revenues')).filter((v): v is number => v != null);
    if (revenues.length === 4) revenueTTM = revenues.reduce((a, b) => a + b, 0);
  }
  if (revenueTTM == null && latestAnnual) {
    revenueTTM = pVal(latestAnnual.financials?.income_statement, 'revenues');
  }

  // TTM EPS
  let eps: number | null = null;
  if (quarterlyFilings.length >= 4) {
    const q4 = quarterlyFilings.slice(0, 4);
    const epsValues = q4.map(f =>
      pVal(f.financials?.income_statement, 'diluted_earnings_per_share') ??
      pVal(f.financials?.income_statement, 'basic_earnings_per_share')
    ).filter((v): v is number => v != null);
    if (epsValues.length >= 2) {
      eps = epsValues.length === 4 ? epsValues.reduce((a, b) => a + b, 0) : (epsValues.reduce((a, b) => a + b, 0) / epsValues.length) * 4;
    }
  }

  // TTM net income for profit margin
  let netIncomeTTM: number | null = null;
  if (quarterlyFilings.length >= 4) {
    const q4 = quarterlyFilings.slice(0, 4);
    const ni = q4.map(f => pVal(f.financials?.income_statement, 'net_income_loss')).filter((v): v is number => v != null);
    if (ni.length === 4) netIncomeTTM = ni.reduce((a, b) => a + b, 0);
  }

  const profitMargin = revenueTTM != null && netIncomeTTM != null && revenueTTM !== 0
    ? netIncomeTTM / revenueTTM
    : null;

  // ROE from latest quarter
  const equity = pVal(bs, 'equity') ?? pVal(bs, 'stockholders_equity');
  const returnOnEquity = netIncomeTTM != null && equity != null && equity !== 0
    ? netIncomeTTM / equity
    : null;

  // Prefer ticker details (authoritative) over quarterly filing data which can have
  // bogus diluted_average_shares (e.g. AMZN Q4 reports 12M instead of 10.8B)
  const tickerShares = tickerDetails?.weighted_shares_outstanding ?? tickerDetails?.share_class_shares_outstanding ?? null;
  // Prefer annual filing shares over quarterly (quarterly Q4 filings often have bad data)
  const annualIS = latestAnnual?.financials?.income_statement;
  const filingShares = pVal(annualIS, 'weighted_average_shares') ?? pVal(annualIS, 'diluted_average_shares')
    ?? pVal(is, 'weighted_average_shares') ?? pVal(is, 'diluted_average_shares');
  const sharesOutstanding = tickerShares
    ?? filingShares
    ?? null;

  const marketCap = tickerDetails?.market_cap ?? null;

  return {
    name: latest?.company_name ?? tickerDetails?.name ?? '',
    description: tickerDetails?.description ?? '',
    sector: tickerDetails?.sic_description ?? '',
    industry: tickerDetails?.sic_description ?? '',
    marketCap,
    peRatio: eps != null && eps !== 0 && marketCap != null && sharesOutstanding != null && sharesOutstanding > 0
      ? (marketCap / sharesOutstanding) / eps
      : null,
    pegRatio: null, // Not available from Polygon
    eps: eps != null ? Math.round(eps * 100) / 100 : null,
    forwardPE: null, // Not available from Polygon
    profitMargin: profitMargin != null ? Math.round(profitMargin * 10000) / 10000 : null,
    returnOnEquity: returnOnEquity != null ? Math.round(returnOnEquity * 10000) / 10000 : null,
    revenueTTM,
    dividendYield: null, // Computed from dividends endpoint separately
    beta: null, // Computed from screener cache
    analystTargetPrice: null,
    fiftyTwoWeekHigh: null, // From screener cache
    fiftyTwoWeekLow: null,
    bookValue: equity != null && sharesOutstanding != null && sharesOutstanding > 0
      ? Math.round((equity / sharesOutstanding) * 100) / 100
      : null,
    sharesOutstanding,
  };
}

// ── Finnhub SEC Filing Enrichment ─────────────────────────────────────

interface XBRLEntry { concept: string; value: number; unit: string; label: string; }

function findXBRL(entries: XBRLEntry[] | undefined, patterns: string[]): number | null {
  if (!entries) return null;
  for (const pat of patterns) {
    const lower = pat.toLowerCase();
    // Use endsWith to avoid substring ambiguity (e.g. 'LongTermDebt' matching 'LongTermDebtCurrent')
    const found = entries.find(e => e.concept.toLowerCase().endsWith(lower));
    if (found && typeof found.value === 'number' && Number.isFinite(found.value)) return found.value;
  }
  return null;
}

/**
 * Fetch Finnhub financials-reported (SEC XBRL) and backfill missing data on
 * Polygon-parsed balance sheets and cash flow statements.
 * Fixes: cash (missing for AMZN/AAPL/TSLA/META), capex/FCF (investingCF proxy),
 * and debt (currentDebt often missing from Polygon).
 */
async function enrichFromFinnhubReported(
  ticker: string,
  balanceParsed: { annual: ParsedBalanceSheet[]; quarterly: ParsedBalanceSheet[] },
  cashFlowParsed: { annual: ParsedCashFlow[]; quarterly: ParsedCashFlow[] },
): Promise<void> {
  const { finnhubQueue } = await import('../utils/finnhub-queue');

  const data = await finnhubQueue.request<{
    data?: Array<{ year: number; quarter: number; report: { bs?: XBRLEntry[]; cf?: XBRLEntry[]; ic?: XBRLEntry[] } }>;
  }>('/stock/financials-reported', { symbol: ticker, freq: 'annual' });

  if (!data?.data?.length) return;

  let enriched = 0;

  // Build a map of fiscal year end → XBRL data for matching
  for (const filing of data.data) {
    const bs = filing.report?.bs;
    const cf = filing.report?.cf;
    if (!bs && !cf) continue;

    // Match to our parsed annual data by fiscal year.
    // Most companies: end_date year === fiscal year (e.g. "2024-12-31" for FY2024).
    // Non-calendar FY (e.g. Walmart Jan end): FY2024 → end_date "2025-01-31".
    // So also check year+1 as fallback for off-calendar fiscal years.
    const yearStr = String(filing.year);
    const yearPlusOne = String(filing.year + 1);

    // Enrich balance sheet
    const matchedBS = balanceParsed.annual.find(b => b.fiscalDateEnding.startsWith(yearStr))
      ?? balanceParsed.annual.find(b => b.fiscalDateEnding.startsWith(yearPlusOne));
    if (matchedBS) {
      // Cash
      if (matchedBS.cashAndEquivalents == null) {
        const cashVal = findXBRL(bs, [
          'CashAndCashEquivalentsAtCarryingValue',
          'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
          'CashAndCashEquivalents',
        ]);
        // Also try to include short-term investments (closer to "cash & equivalents" used in DCF)
        const stInv = findXBRL(bs, [
          'MarketableSecuritiesCurrent',
          'ShortTermInvestments',
          'AvailableForSaleSecuritiesCurrent',
        ]);
        if (cashVal != null) {
          matchedBS.cashAndEquivalents = cashVal + (stInv ?? 0);
          enriched++;
        }
      }
      // Long-term debt
      if (matchedBS.longTermDebt == null) {
        const ltd = findXBRL(bs, [
          'LongTermDebtNoncurrent', 'LongTermDebt',
          'LongTermDebtAndCapitalLeaseObligations',
        ]);
        if (ltd != null) { matchedBS.longTermDebt = ltd; enriched++; }
      }
      // Current debt
      if (matchedBS.currentDebt == null) {
        const cd = findXBRL(bs, [
          'LongTermDebtCurrent', 'DebtCurrent', 'ShortTermBorrowings',
          'CommercialPaper', 'CurrentPortionOfLongTermDebt',
        ]);
        if (cd != null) { matchedBS.currentDebt = cd; enriched++; }
      }
    }

    // Enrich cash flow statement
    const matchedCF = cashFlowParsed.annual.find(c => c.fiscalDateEnding.startsWith(yearStr))
      ?? cashFlowParsed.annual.find(c => c.fiscalDateEnding.startsWith(yearPlusOne));
    if (matchedCF && cf) {
      const realCapex = findXBRL(cf, [
        'PaymentsToAcquirePropertyPlantAndEquipment',
        'PaymentsToAcquireProductiveAssets',
      ]);
      const realOpCF = findXBRL(cf, [
        'NetCashProvidedByUsedInOperatingActivities',
        'NetCashProvidedByOperatingActivities',
      ]);
      if (realCapex != null) {
        // XBRL reports capex as positive (cash outflow); our format expects negative
        matchedCF.capitalExpenditures = -Math.abs(realCapex);
        if (realOpCF != null) {
          // Keep operatingCashflow consistent with the OCF used for FCF
          matchedCF.operatingCashflow = realOpCF;
          matchedCF.freeCashFlow = realOpCF - Math.abs(realCapex);
          enriched++;
        } else if (matchedCF.operatingCashflow != null) {
          matchedCF.freeCashFlow = matchedCF.operatingCashflow - Math.abs(realCapex);
          enriched++;
        }
      }
    }
  }

  if (enriched > 0) {
    console.log(`[Polygon Fundamentals] Enriched ${ticker} with ${enriched} fields from Finnhub SEC data`);
  }
}

// ── Cache + Public API ────────────────────────────────────────────────

function deserializeCache(
  ticker: string,
  cached: { overviewJson: string | null; incomeJson: string | null; balanceJson: string | null; cashFlowJson: string | null; lastFetchedAt: Date },
  dataAge: 'fresh' | 'cached' | 'stale',
): FundamentalsResponse {
  const empty = { annual: [], quarterly: [] };
  let overview = null;
  let income = empty;
  let balance = empty;
  let cashFlow = empty;
  try {
    overview = cached.overviewJson ? JSON.parse(cached.overviewJson) : null;
    income = cached.incomeJson ? JSON.parse(cached.incomeJson) : empty;
    balance = cached.balanceJson ? JSON.parse(cached.balanceJson) : empty;
    cashFlow = cached.cashFlowJson ? JSON.parse(cached.cashFlowJson) : empty;
  } catch (err) {
    console.error(`[Fundamentals] Corrupted cache for ${ticker}, returning empty:`, (err as Error).message);
  }

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

async function refreshFundamentals(ticker: string): Promise<void> {
  const upper = ticker.toUpperCase();
  console.log(`[Polygon Fundamentals] Refreshing ${upper}...`);

  // Fetch annual + quarterly + ticker details concurrently
  const [annualFilings, quarterlyFilings, tickerDetails] = await Promise.all([
    fetchPolygonFinancials(upper, 'annual', 10),
    fetchPolygonFinancials(upper, 'quarterly', 20),
    fetchPolygonTickerDetails(upper),
  ]);

  if (annualFilings.length === 0 && quarterlyFilings.length === 0) {
    // fetchPolygonFinancials() returns [] on BOTH "Polygon genuinely has no filings"
    // and "the fetch failed" (timeout/5xx/network all hit its catch). We must not cache
    // an empty sentinel for a transient failure — that would blank out a real ticker's
    // fundamentals for up to 7 days. tickerDetails is the corroborating signal: it's
    // non-null only when Polygon actually responded for this ticker. If it's null too,
    // treat this as a fetch failure and DON'T cache — let the next cycle retry (old behavior).
    if (!tickerDetails) {
      console.warn(`[Polygon Fundamentals] No filings and no ticker details for ${upper} — treating as fetch failure, not caching`);
      return;
    }

    // Real ticker that genuinely has no Polygon financials (recent IPOs, foreign listings).
    // Mark overviewJson so pickNextTicker() (which re-selects any ticker with a falsy
    // overviewJson) stops re-fetching it every 15s. We deliberately:
    //   • touch ONLY overviewJson + lastFetchedAt — never the statement columns — so we
    //     can't clobber real income/balance/cashflow data written by another code path
    //     (e.g. the legacy Alpha Vantage writer can store overviewJson="null" with real
    //     statements);
    //   • use an atomic updateMany guarded to rows whose overviewJson is null/empty, with a
    //     create-if-absent fallback — so a concurrent refresh that found real data is never
    //     overwritten (no read-then-write race; refreshFundamentalsForTicker bypasses the
    //     inflightRefresh dedupe, so concurrent same-ticker refreshes are possible).
    // lastFetchedAt drives a natural retry once the row goes stale (>7d), in case the issuer
    // later files. (Mirrors the earnings sentinel in fundamentals-prefetch.service.ts.)
    console.warn(`[Polygon Fundamentals] No filings found for ${upper} — marking empty (sentinel)`);
    const nullOverview = JSON.stringify(null); // the string "null" — truthy, so the picker skips it
    const marked = await prisma.fundamentalsCache.updateMany({
      where: { ticker: upper, OR: [{ overviewJson: null }, { overviewJson: nullOverview }] },
      data: { overviewJson: nullOverview, lastFetchedAt: new Date() },
    });
    if (marked.count === 0) {
      // No row matched: either none exists (create one) or one already holds a real overview
      // (leave it — the unique constraint makes create throw, which we swallow to preserve it).
      try {
        await prisma.fundamentalsCache.create({
          data: { ticker: upper, overviewJson: nullOverview, lastFetchedAt: new Date() },
        });
      } catch { /* row appeared concurrently with real data — preserve it */ }
    }
    return;
  }

  const overview = buildOverviewFromFilings(annualFilings, quarterlyFilings, tickerDetails);

  // Enrich overview with screener cache data (beta, 52W, dividend yield)
  if (overview) {
    try {
      const screener = await prisma.screenerCache.findUnique({ where: { ticker: upper } });
      if (screener) {
        if (screener.beta != null) overview.beta = screener.beta;
        if (screener.week52High != null) overview.fiftyTwoWeekHigh = screener.week52High;
        if (screener.week52Low != null) overview.fiftyTwoWeekLow = screener.week52Low;
        if (screener.annualDividend != null && overview.marketCap != null && overview.sharesOutstanding != null && overview.sharesOutstanding > 0) {
          const price = overview.marketCap / overview.sharesOutstanding;
          if (price > 0) overview.dividendYield = screener.annualDividend / price;
        }
      }
    } catch { /* screener enrichment is best-effort */ }
  }

  const incomeParsed = {
    annual: annualFilings.map(f => parseIncomeStatement(f, 'annual')),
    quarterly: quarterlyFilings.map(f => parseIncomeStatement(f, 'quarterly')),
  };
  const balanceParsed = {
    annual: annualFilings.map(f => parseBalanceSheet(f, 'annual')),
    quarterly: quarterlyFilings.map(f => parseBalanceSheet(f, 'quarterly')),
  };
  const cashFlowParsed = {
    annual: annualFilings.map(f => parseCashFlow(f, 'annual')),
    quarterly: quarterlyFilings.map(f => parseCashFlow(f, 'quarterly')),
  };

  // Enrich from Finnhub financials-reported (SEC XBRL data) for accurate cash, capex, debt
  try {
    await enrichFromFinnhubReported(upper, balanceParsed, cashFlowParsed);
  } catch { /* Finnhub enrichment is best-effort */ }

  await prisma.fundamentalsCache.upsert({
    where: { ticker: upper },
    update: {
      overviewJson: JSON.stringify(overview),
      incomeJson: JSON.stringify(incomeParsed),
      balanceJson: JSON.stringify(balanceParsed),
      cashFlowJson: JSON.stringify(cashFlowParsed),
      lastFetchedAt: new Date(),
    },
    create: {
      ticker: upper,
      overviewJson: JSON.stringify(overview),
      incomeJson: JSON.stringify(incomeParsed),
      balanceJson: JSON.stringify(balanceParsed),
      cashFlowJson: JSON.stringify(cashFlowParsed),
      lastFetchedAt: new Date(),
    },
  });

  // Invalidate Nala Score cache since underlying data changed
  try {
    const { invalidateNalaScoreCache } = await import('./nala-score.service');
    invalidateNalaScoreCache(upper);
  } catch { /* nala-score service may not be loaded yet at startup */ }

  console.log(`[Polygon Fundamentals] Cached ${upper} (${annualFilings.length} annual, ${quarterlyFilings.length} quarterly)`);
}

// In-flight dedupe: prevents thundering herd on concurrent requests for the same ticker
const inflightRefresh = new Map<string, Promise<void>>();

/** Get fundamentals — serve from cache, refresh from Polygon if stale. */
export async function getCompanyFundamentals(ticker: string): Promise<FundamentalsResponse> {
  const upper = ticker.toUpperCase();

  const empty: FundamentalsResponse = {
    ticker: upper,
    overview: null,
    incomeStatements: { annual: [], quarterly: [] },
    balanceSheets: { annual: [], quarterly: [] },
    cashFlows: { annual: [], quarterly: [] },
    lastUpdated: '',
    dataAge: 'stale',
  };

  const cached = await prisma.fundamentalsCache.findUnique({ where: { ticker: upper } });

  if (cached) {
    const ageMs = Date.now() - new Date(cached.lastFetchedAt).getTime();
    const dataAge: 'fresh' | 'cached' | 'stale' =
      ageMs < 24 * 60 * 60 * 1000 ? 'fresh' :
      ageMs < CACHE_MAX_AGE_MS ? 'cached' : 'stale';

    const result = deserializeCache(upper, cached, dataAge);

    if (dataAge === 'stale' && !inflightRefresh.has(upper)) {
      // Refresh in background, return stale data now. Dedupe concurrent requests.
      const p = refreshFundamentals(upper)
        .catch(err => console.error(`[Polygon Fundamentals] Background refresh failed for ${upper}:`, err.message))
        .finally(() => inflightRefresh.delete(upper));
      inflightRefresh.set(upper, p);
    }

    return result;
  }

  // No cache — fetch immediately (Polygon has no daily limit)
  try {
    await refreshFundamentals(upper);
    const fresh = await prisma.fundamentalsCache.findUnique({ where: { ticker: upper } });
    if (fresh) return deserializeCache(upper, fresh, 'fresh');
  } catch (err) {
    console.error(`[Polygon Fundamentals] On-demand fetch failed for ${upper}:`, (err as Error).message);
  }

  return empty;
}

/** Force-refresh fundamentals for a ticker. */
export async function refreshFundamentalsForTicker(ticker: string): Promise<void> {
  await refreshFundamentals(ticker.toUpperCase());
}
