/**
 * Dividend Fetch Service
 * Auto-fetches dividend events from Yahoo Finance for held tickers.
 */

import { PrismaClient } from '@prisma/client';
import { yahooGet } from '../utils/yahoo-http';
import NodeCache from 'node-cache';

const prisma = new PrismaClient();

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
    return [];
  }
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
    const divAmount = cal.dividendRate?.raw; // annual rate
    const divPerShare = cal.dividendDate?.raw ? null : null; // not directly available per-quarter

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
 * Sync dividend events for a single ticker into the database.
 * Upserts by (ticker, exDate, amountPerShare) unique constraint.
 */
export async function syncDividendEventsForTicker(ticker: string): Promise<number> {
  const upperTicker = ticker.toUpperCase();

  // Check cooldown
  if (syncCache.get(upperTicker)) return 0;

  const historical = await fetchYahooDividends(upperTicker);
  const upcoming = await fetchUpcomingDividend(upperTicker);

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

  let upserted = 0;
  for (const div of historical) {
    try {
      await prisma.dividendEvent.upsert({
        where: {
          ticker_exDate_amountPerShare: {
            ticker: div.ticker,
            exDate: div.exDate,
            amountPerShare: div.amountPerShare,
          },
        },
        create: {
          ticker: div.ticker,
          exDate: div.exDate,
          payDate: div.payDate,
          amountPerShare: div.amountPerShare,
          source: div.source,
          status: div.payDateEstimated ? 'preliminary' : 'confirmed',
        },
        update: {
          // Only update pay date if we now have a confirmed one
          ...(div.payDateEstimated ? {} : { payDate: div.payDate, status: 'confirmed' }),
        },
      });
      upserted++;
    } catch (err) {
      // Skip duplicates or constraint violations
      console.warn(`[Dividend Fetch] Upsert failed for ${div.ticker} ${div.exDate.toISOString().slice(0, 10)}:`, err instanceof Error ? err.message : err);
    }
  }

  syncCache.set(upperTicker, true);
  return upserted;
}

/**
 * Sync dividend events for all currently held tickers.
 * Rate-limited to ~1 ticker/second to avoid Yahoo throttling.
 */
export async function syncAllHeldTickers(): Promise<{ synced: number; tickers: number }> {
  // Get all distinct tickers from holdings
  const holdings = await prisma.holding.findMany({
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
      console.warn(`[Dividend Sync] Failed for ${ticker}:`, err instanceof Error ? err.message : err);
    }
    // Rate limit: 1 second between tickers
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`[Dividend Sync] Complete: ${totalSynced} events across ${tickers.length} tickers`);
  return { synced: totalSynced, tickers: tickers.length };
}
