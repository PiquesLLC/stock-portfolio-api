/**
 * SEC EDGAR XBRL ingest — normalized fundamentals straight from the filer.
 *
 * WHY THIS EXISTS. Polygon's cash-flow tagging is inconsistent across filers, and
 * capex in particular is missing often enough that free cash flow used to be derived
 * from total investing cash flow. That is not capex — it carries securities
 * purchases, maturities and acquisitions — and measured against real filings it
 * produced MSFT FCF of $43B against an actual ~$70B, phantom negative years for
 * AMZN, and JPM at -$413B (a negative share price). Dropping the fallback fixed the
 * wrongness but left holes: NVDA came back with 3 usable years out of 10, JPM with 0.
 * EDGAR fills those holes with the company's own US-GAAP XBRL, free, for every US
 * filer, every year.
 *
 * TERMS OF USE. The SEC requires a User-Agent that identifies the caller and caps
 * traffic at 10 requests/second. Both are honoured here; without the header SEC
 * returns 403. Set SEC_EDGAR_USER_AGENT to a real contact — see the constant below.
 */

const EDGAR_HOST = 'https://data.sec.gov';
const TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';

/**
 * SEC blocks anonymous traffic. This must name the operator and a working contact.
 * The default is a placeholder so development works, but it should be overridden in
 * production — the SEC does block non-compliant callers.
 */
const USER_AGENT = process.env.SEC_EDGAR_USER_AGENT
  ?? 'Nala (support@nalaai.com)';

/** SEC's published ceiling is 10/s. Stay under it. */
const MIN_REQUEST_INTERVAL_MS = 125; // 8 req/s
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function edgarFetch(url: string): Promise<unknown | null> {
  await throttle();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip, deflate' },
    });
    // 404 is the normal answer for "this filer never tagged this concept" — not an
    // error worth logging on every ticker.
    if (res.status === 404) return null;
    if (res.status === 403) {
      console.warn('[EDGAR] 403 — SEC is rejecting our User-Agent. Set SEC_EDGAR_USER_AGENT to a real contact.');
      return null;
    }
    if (!res.ok) {
      console.warn(`[EDGAR] ${res.status} for ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[EDGAR] fetch failed for ${url}: ${(err as Error).message}`);
    return null;
  }
}

/* ─── ticker → CIK ─────────────────────────────────────────────────── */

let cikCache: Map<string, string> | null = null;
let cikCacheAt = 0;
const CIK_CACHE_MS = 24 * 60 * 60 * 1000;

/** Ten-digit zero-padded CIK for a ticker, or null if EDGAR doesn't list it. */
export async function getCik(ticker: string): Promise<string | null> {
  if (!cikCache || Date.now() - cikCacheAt > CIK_CACHE_MS) {
    const raw = await edgarFetch(TICKER_MAP_URL) as
      Record<string, { cik_str: number; ticker: string }> | null;
    if (!raw) return null;
    const map = new Map<string, string>();
    for (const entry of Object.values(raw)) {
      if (entry?.ticker && entry.cik_str != null) {
        map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, '0'));
      }
    }
    // Only adopt a non-empty map — a truncated response shouldn't blank the cache.
    if (map.size > 0) { cikCache = map; cikCacheAt = Date.now(); }
  }
  return cikCache?.get(ticker.toUpperCase()) ?? null;
}

/* ─── fact extraction (pure — unit tested without network) ─────────── */

export interface EdgarFact {
  start?: string;
  end: string;
  val: number;
  form?: string;
  filed?: string;
  fy?: number;
  fp?: string;
}

const DAY_MS = 86400000;
const days = (a: string, b: string) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY_MS);

/**
 * Annual values keyed by period-end date.
 *
 * Three things make this less trivial than it looks: EDGAR returns quarterly and
 * annual entries in one list (a duration filter separates them), the same period is
 * re-reported by later filings after a restatement (latest `filed` wins), and only
 * annual report forms should count — a 10-Q carrying a year-to-date figure would
 * otherwise masquerade as a full year.
 */
export function annualByPeriodEnd(facts: EdgarFact[], isDuration = true): Map<string, number> {
  const best = new Map<string, EdgarFact>();
  for (const f of facts) {
    if (f?.end == null || typeof f.val !== 'number' || !Number.isFinite(f.val)) continue;
    const form = f.form ?? '';
    if (!/^(10-K|20-F|40-F)/.test(form)) continue;
    if (isDuration) {
      if (!f.start) continue;
      const span = days(f.start, f.end);
      if (span < 330 || span > 400) continue; // annual only, not Q or YTD stubs
    }
    const prev = best.get(f.end);
    if (!prev || (f.filed ?? '') > (prev.filed ?? '')) best.set(f.end, f);
  }
  const out = new Map<string, number>();
  for (const [end, f] of best) out.set(end, f.val);
  return out;
}

/**
 * Value for a fiscal period end, tolerating a few days of drift — Polygon's
 * `end_date` and the filer's XBRL period end can differ on 52/53-week calendars.
 */
export function valueForPeriod(
  byEnd: Map<string, number>,
  fiscalDateEnding: string,
  toleranceDays = 7,
): number | null {
  const exact = byEnd.get(fiscalDateEnding);
  if (exact != null) return exact;
  let bestVal: number | null = null;
  let bestGap = Infinity;
  for (const [end, val] of byEnd) {
    const gap = Math.abs(days(fiscalDateEnding, end));
    if (gap <= toleranceDays && gap < bestGap) { bestGap = gap; bestVal = val; }
  }
  return bestVal;
}

/* ─── the concepts the DCF needs ───────────────────────────────────── */

// Ordered by preference; the first tag a filer actually uses wins.
const CAPEX_TAGS = [
  'PaymentsToAcquirePropertyPlantAndEquipment',
  'PaymentsToAcquireProductiveAssets',
];
const INTEREST_TAGS = [
  'InterestExpense',
  'InterestExpenseNonoperating',
  'InterestExpenseDebt',
  'InterestIncomeExpenseNet',
];
const OPCF_TAGS = [
  'NetCashProvidedByUsedInOperatingActivities',
  'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
];

async function firstTagWithData(cik: string, tags: string[]): Promise<Map<string, number>> {
  for (const tag of tags) {
    const json = await edgarFetch(
      `${EDGAR_HOST}/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`,
    ) as { units?: Record<string, EdgarFact[]> } | null;
    const usd = json?.units?.USD;
    if (!usd?.length) continue;
    const byEnd = annualByPeriodEnd(usd);
    if (byEnd.size > 0) return byEnd;
  }
  return new Map();
}

export interface EdgarAnnuals {
  /** Capex as a POSITIVE outflow, exactly as XBRL reports it. */
  capex: Map<string, number>;
  interest: Map<string, number>;
  operatingCashFlow: Map<string, number>;
}

/**
 * Annual capex, interest expense and operating cash flow for a ticker. Costs at most
 * ~6 requests (fewer once a preferred tag hits) and returns empty maps rather than
 * throwing — callers treat EDGAR as an enrichment, never a hard dependency.
 */
export async function getEdgarAnnuals(ticker: string): Promise<EdgarAnnuals | null> {
  const cik = await getCik(ticker);
  if (!cik) return null;
  const [capex, interest, operatingCashFlow] = await Promise.all([
    firstTagWithData(cik, CAPEX_TAGS),
    firstTagWithData(cik, INTEREST_TAGS),
    firstTagWithData(cik, OPCF_TAGS),
  ]);
  if (capex.size === 0 && interest.size === 0 && operatingCashFlow.size === 0) return null;
  return { capex, interest, operatingCashFlow };
}
