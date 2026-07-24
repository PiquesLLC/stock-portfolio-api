/**
 * Dividend Fetch Service
 * Auto-fetches dividend events from Yahoo Finance for held tickers.
 */

import prisma from '../utils/prisma';
import { yahooGet } from '../utils/yahoo-http';
import axios from 'axios';
import NodeCache from 'node-cache';



// Track when each ticker was last synced (6h cooldown)
const syncCache = new NodeCache({ stdTTL: 6 * 3600 });

interface YahooDividendRaw {
  amount: number;
  date: number; // unix timestamp (ex-date)
}

interface ParsedDividend {
  ticker: string;
  exDate: Date;
  payDate: Date;
  amountPerShare: number;
  source: string;
  payDateEstimated: boolean;
}

/**
 * Fetch historical dividend events from Yahoo Finance chart API.
 * Returns ex-dates and amounts. Pay dates are estimated (ex + 21 days)
 * unless we can get them from quoteSummary.
 */
export async function fetchYahooDividends(ticker: string, yearsBack = 2): Promise<ParsedDividend[]> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - yearsBack * 365 * 24 * 60 * 60;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${from}&period2=${now}&interval=1d&events=div`;

    const resp = await yahooGet(url);

    const result = resp.data?.chart?.result?.[0];
    if (!result?.events?.dividends) return [];

    const divs: Record<string, YahooDividendRaw> = result.events.dividends;
    const parsed: ParsedDividend[] = [];

    for (const [, div] of Object.entries(divs)) {
      if (!div.amount || div.amount <= 0) continue;
      const exDate = new Date(div.date * 1000);
      // Estimate pay date as ex-date + 21 calendar days
      const payDate = new Date(exDate);
      payDate.setDate(payDate.getDate() + 21);

      parsed.push({
        ticker: ticker.toUpperCase(),
        exDate,
        payDate,
        amountPerShare: Math.round(div.amount * 10000) / 10000,
        source: 'yahoo',
        payDateEstimated: true,
      });
    }

    return parsed;
  } catch (err) {
    console.warn(`[Dividend Fetch] Yahoo historical failed for ${ticker}:`, err instanceof Error ? err.message : err);
  }

  // Polygon.io fallback for dividend data
  try {
    const { config } = await import('../config');
    if (config.polygonApiKey) {
      const url = `https://api.polygon.io/v3/reference/dividends?ticker=${ticker.toUpperCase()}&limit=20&order=desc&apiKey=${config.polygonApiKey}`;
      const resp = await axios.get(url, { timeout: 10000 });
      if (resp.data?.results && resp.data.results.length > 0) {
        const parsed: ParsedDividend[] = [];
        for (const div of resp.data.results) {
          if (!div.cash_amount || div.cash_amount <= 0) continue;
          const exDate = new Date(div.ex_dividend_date + 'T14:30:00Z');
          const payDate = div.pay_date
            ? new Date(div.pay_date + 'T14:30:00Z')
            : new Date(exDate.getTime() + 21 * 86400000);
          parsed.push({
            ticker: ticker.toUpperCase(),
            exDate,
            payDate,
            amountPerShare: Math.round(div.cash_amount * 10000) / 10000,
            source: 'polygon',
            payDateEstimated: !div.pay_date,
          });
        }
        if (parsed.length > 0) {
          console.log(`[Dividend Fetch] Polygon returned ${parsed.length} dividends for ${ticker}`);
          return parsed;
        }
      }
    }
  } catch (polyErr) {
    console.warn(`[Dividend Fetch] Polygon fallback failed for ${ticker}:`, polyErr instanceof Error ? polyErr.message : polyErr);
  }

  return [];
}

/**
 * Fetch upcoming dividend info from Yahoo quoteSummary calendarEvents module.
 * This can provide actual pay dates for upcoming dividends.
 */
export async function fetchUpcomingDividend(ticker: string): Promise<ParsedDividend | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=calendarEvents`;
    const resp = await yahooGet(url);

    const cal = resp.data?.quoteSummary?.result?.[0]?.calendarEvents;
    if (!cal) return null;

    const exDate = cal.exDividendDate?.raw;
    const _divAmount = cal.dividendRate?.raw; // annual rate
    const _divPerShare = cal.dividendDate?.raw ? null : null; // not directly available per-quarter

    // Try to get per-share from trailingAnnualDividendRate / frequency
    // Or use the last quarterly amount from historical data
    if (!exDate) return null;

    // calendarEvents gives annual rate, not per-share quarterly.
    // We'll rely on historical data for amount and just use this for pay date.
    const payDateRaw = cal.dividendDate?.raw;

    if (payDateRaw && exDate) {
      return {
        ticker: ticker.toUpperCase(),
        exDate: new Date(exDate * 1000),
        payDate: new Date(payDateRaw * 1000),
        amountPerShare: 0, // will be filled from historical pattern
        source: 'yahoo',
        payDateEstimated: false,
      };
    }

    return null;
  } catch {
    // quoteSummary may not be available for all tickers
    return null;
  }
}

/**
 * Fetch DECLARED dividends whose ex-date is still in the future (announced but
 * not yet ex) from Polygon. Polygon exposes declaration_date + cash_amount, so
 * ingesting these lets the dividend-change detector fire within ~24h of the
 * ANNOUNCEMENT instead of only at the ex-date (~10 days later) via the historical
 * Yahoo feed. Regular cash dividends only — specials would create false raise/cut
 * signals. Returns [] when no Polygon key, nothing upcoming, or on error.
 */
export async function fetchPolygonUpcomingDividends(ticker: string): Promise<ParsedDividend[]> {
  try {
    const { config } = await import('../config');
    if (!config.polygonApiKey) return [];

    const today = new Date().toISOString().slice(0, 10);
    const url = `https://api.polygon.io/v3/reference/dividends?ticker=${ticker.toUpperCase()}&ex_dividend_date.gte=${today}&limit=10&order=asc&apiKey=${config.polygonApiKey}`;
    const resp = await axios.get(url, { timeout: 10000 });

    const results = resp.data?.results;
    if (!Array.isArray(results) || results.length === 0) return [];

    const parsed: ParsedDividend[] = [];
    for (const div of results) {
      if (!div.cash_amount || div.cash_amount <= 0) continue;
      if (!div.ex_dividend_date) continue;
      // Regular cash dividends only ('CD'); skip specials/variable distributions.
      if (div.dividend_type && div.dividend_type !== 'CD') continue;

      const exDate = new Date(div.ex_dividend_date + 'T14:30:00Z');
      const payDate = div.pay_date
        ? new Date(div.pay_date + 'T14:30:00Z')
        : new Date(exDate.getTime() + 21 * 86400000);

      parsed.push({
        ticker: ticker.toUpperCase(),
        exDate,
        payDate,
        amountPerShare: Math.round(div.cash_amount * 10000) / 10000,
        source: 'polygon',
        payDateEstimated: !div.pay_date,
      });
    }

    if (parsed.length > 0) {
      console.log(`[Dividend Fetch] Polygon: ${parsed.length} declared upcoming dividend(s) for ${ticker}`);
    }
    return parsed;
  } catch (err) {
    console.warn(`[Dividend Fetch] Polygon upcoming failed for ${ticker}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Sync dividend events for a single ticker into the database.
 * Upserts by (ticker, exDate, amountPerShare) unique constraint.
 */
export async function syncDividendEventsForTicker(ticker: string): Promise<number> {
  const upperTicker = ticker.toUpperCase();

  // Check cooldown
  if (syncCache.get(upperTicker)) return 0;

  const historical = await fetchYahooDividends(upperTicker);
  const upcoming = await fetchUpcomingDividend(upperTicker);
  // Declared-but-not-yet-ex dividends (future ex-date) — this is what lets the
  // change detector fire within ~24h of the ANNOUNCEMENT, not only at ex-date.
  const declared = await fetchPolygonUpcomingDividends(upperTicker);

  // If upcoming has a real pay date, try to match/update the most recent historical event
  if (upcoming && upcoming.payDate && !upcoming.payDateEstimated) {
    const match = historical.find(
      h => Math.abs(h.exDate.getTime() - upcoming.exDate.getTime()) < 2 * 86400000
    );
    if (match) {
      match.payDate = upcoming.payDate;
      match.payDateEstimated = false;
    }
  }

  // Merge freshly-declared future dividends not already present in the historical feed.
  const events = [...historical];
  for (const d of declared) {
    const dup = events.some(
      h => Math.abs(h.exDate.getTime() - d.exDate.getTime()) < 2 * 86400000
        && Math.abs(h.amountPerShare - d.amountPerShare) < 1e-9
    );
    if (!dup) events.push(d);
  }

  // Existing rows for this ticker, matched in JS below. See upsertByExDateDay.
  // orderBy is load-bearing: with duplicates still present, `find` below returns
  // the FIRST match, so this decides which row receives the confirmed payDate.
  // Unordered, SQLite's natural order is unstable across the pending storage
  // normalisation (INTEGERs sort below TEXT), and the dedupe migration keeps the
  // oldest row — so both must agree on "oldest wins".
  const existing = await prisma.dividendEvent.findMany({
    where: { ticker: upperTicker },
    orderBy: { createdAt: 'asc' },
    select: { id: true, exDate: true, amountPerShare: true },
  });

  let upserted = 0;
  for (const div of events) {
    try {
      await upsertByExDateDay(existing, div);
      upserted++;
    } catch (err) {
      // Skip duplicates or constraint violations
      console.warn(`[Dividend Fetch] Upsert failed for ${div.ticker} ${div.exDate.toISOString().slice(0, 10)}:`, err instanceof Error ? err.message : err);
    }
  }

  syncCache.set(upperTicker, true);
  return upserted;
}

/** UTC calendar day of an ex-dividend date. An ex-date is a calendar date, not an instant. */
function exDateDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Per-share amounts are equal to the cent-fraction the feeds actually publish.
 *
 * Both feeds round to 4dp before writing, but manual entries and legacy rows
 * predate that rounding — a stored 0.24499 against a fed 0.245 differs by 1e-5,
 * four orders of magnitude above a 1e-9 epsilon, so an exact-ish comparison
 * would treat them as different dividends and leave the duplicate in place.
 * 4dp is the feeds' own precision, so this cannot merge two genuinely distinct
 * amounts (a special dividend never differs from a regular one by <0.00005).
 */
function sameAmount(a: number, b: number): boolean {
  return Math.round(a * 10000) === Math.round(b * 10000);
}

/**
 * Upsert keyed on the ex-dividend CALENDAR DAY rather than the exact timestamp.
 *
 * `@@unique([ticker, exDate, amountPerShare])` compares `exDate` exactly, but our
 * two feeds disagree on its time component for the same dividend — Yahoo stamps
 * 13:30Z, Polygon 14:30Z. The same event therefore hashed to two distinct keys,
 * the upsert's `where` never matched, and it silently took the `create` branch.
 * Measured on prod 2026-07-24: 471 duplicate groups from this alone (plus 386
 * more within the legacy INTEGER rows), 2,631 excess rows across 96 tickers —
 * over half the table. Those duplicates are then double-counted by the
 * `payDate < now` growth query, inflating dividend growth and forward yield.
 *
 * Matching happens in JS, after Prisma has decoded the rows, for two reasons.
 * A SQL day-window predicate on `exDate` would itself be unreliable while the
 * column still holds both TEXT ISO-8601 and INTEGER epoch-ms values (SQLite
 * orders every INTEGER below every TEXT, so a bound of either form silently
 * skips the other). And it keeps this correct both before and after the pending
 * storage normalisation, so the code and the data migration need not ship
 * together. Per-ticker row counts are small (~50).
 *
 * We deliberately do NOT rewrite the time component on create: existing rows sit
 * at 13:30/14:30Z, which render as 09:30 ET — the correct calendar day. Snapping
 * to midnight UTC would render as the PREVIOUS day for any consumer formatting
 * in ET. First writer wins the time; later feeds update that row in place.
 */
async function upsertByExDateDay(
  existing: { id: string; exDate: Date; amountPerShare: number }[],
  div: { ticker: string; exDate: Date; payDate: Date; amountPerShare: number; source: string; payDateEstimated?: boolean },
): Promise<void> {
  const day = exDateDay(div.exDate);
  const match = existing.find(
    e => exDateDay(e.exDate) === day && sameAmount(e.amountPerShare, div.amountPerShare),
  );

  if (match) {
    // Only promote the pay date once we have a confirmed one — same rule as before.
    if (!div.payDateEstimated) {
      await prisma.dividendEvent.update({
        where: { id: match.id },
        data: { payDate: div.payDate, status: 'confirmed' },
      });
    }
    return;
  }

  const created = await prisma.dividendEvent.create({
    data: {
      ticker: div.ticker,
      exDate: div.exDate,
      payDate: div.payDate,
      amountPerShare: div.amountPerShare,
      source: div.source,
      status: div.payDateEstimated ? 'preliminary' : 'confirmed',
      // Explicit so the change detector / growth math (which filter on
      // dividendType: 'regular') keep matching even if the column default moves.
      dividendType: 'regular',
    },
    select: { id: true, exDate: true, amountPerShare: true },
  });
  // Keep the in-memory index current so two events in the same batch that share
  // a day+amount can't both create.
  existing.push(created);
}

/**
 * Sync dividend events for all currently held tickers.
 * Rate-limited to ~1 ticker/second to avoid Yahoo throttling.
 */
export async function syncAllHeldTickers(userId?: string): Promise<{ synced: number; tickers: number }> {
  // Get distinct tickers — scoped to user if provided, otherwise global (for background jobs)
  const holdings = await prisma.holding.findMany({
    where: userId ? { userId } : undefined,
    select: { ticker: true },
    distinct: ['ticker'],
  });

  const tickers = holdings.map(h => h.ticker);
  let totalSynced = 0;

  console.log(`[Dividend Sync] Starting sync for ${tickers.length} tickers`);

  for (const ticker of tickers) {
    try {
      const count = await syncDividendEventsForTicker(ticker);
      if (count > 0) {
        console.log(`[Dividend Sync] ${ticker}: ${count} events upserted`);
      }
      totalSynced += count;
    } catch (err) {
      // Retry once after 3s for transient Yahoo Finance rate limits / timeouts
      console.warn(`[Dividend Sync] First attempt failed for ${ticker}:`, err instanceof Error ? err.message : err);
      await new Promise(r => setTimeout(r, 3000));
      try {
        const count = await syncDividendEventsForTicker(ticker);
        if (count > 0) {
          console.log(`[Dividend Sync] ${ticker}: ${count} events upserted (retry)`);
        }
        totalSynced += count;
        console.log(`[Dividend Sync] Retry succeeded for ${ticker}`);
      } catch (retryErr) {
        console.warn(`[Dividend Sync] Retry also failed for ${ticker}:`, retryErr instanceof Error ? retryErr.message : retryErr);
      }
    }
    // Rate limit: 1.5 seconds between tickers to reduce Yahoo rate limiting
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`[Dividend Sync] Complete: ${totalSynced} events across ${tickers.length} tickers`);
  return { synced: totalSynced, tickers: tickers.length };
}

