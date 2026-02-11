/**
 * Earnings Service
 *
 * Fetches quarterly and annual EPS data from Alpha Vantage.
 * Shares the FundamentalsCache table (earningsJson column).
 */

import prisma from '../utils/prisma';
import axios from 'axios';
import { fetchEarnings, parseAVNumber, getDailyCallsRemaining, AVQuarterlyEarning } from '../utils/alpha-vantage';
import { config } from '../config';



const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ParsedQuarterlyEarning {
  fiscalDateEnding: string;
  reportedDate: string;
  reportedEPS: number | null;
  estimatedEPS: number | null;
  surprise: number | null;
  surprisePercentage: number | null;
  reportTime: string;
  beat: boolean | null;
}

export interface ParsedAnnualEarning {
  fiscalDateEnding: string;
  reportedEPS: number | null;
}

export interface EarningsResponse {
  ticker: string;
  quarterly: ParsedQuarterlyEarning[];
  annual: ParsedAnnualEarning[];
  lastUpdated: string;
  dataAge: 'fresh' | 'cached' | 'stale';
}

function parseQuarterly(raw: AVQuarterlyEarning[]): ParsedQuarterlyEarning[] {
  return raw.map(q => {
    const reported = parseAVNumber(q.reportedEPS);
    const estimated = parseAVNumber(q.estimatedEPS);
    const surprise = parseAVNumber(q.surprise);
    return {
      fiscalDateEnding: q.fiscalDateEnding,
      reportedDate: q.reportedDate,
      reportedEPS: reported,
      estimatedEPS: estimated,
      surprise,
      surprisePercentage: parseAVNumber(q.surprisePercentage),
      reportTime: q.reportedDate ? '' : '',
      beat: surprise != null ? surprise > 0 : null,
    };
  });
}

/** Get earnings data from cache, fetching if stale. Uses 1 API call. */
export async function getEarningsData(ticker: string): Promise<EarningsResponse> {
  const upper = ticker.toUpperCase();

  const empty: EarningsResponse = {
    ticker: upper,
    quarterly: [],
    annual: [],
    lastUpdated: '',
    dataAge: 'stale',
  };

  // Check if we already have earnings cached in FundamentalsCache
  const cached = await prisma.fundamentalsCache.findUnique({ where: { ticker: upper } });

  if (cached?.earningsJson) {
    const ageMs = Date.now() - new Date(cached.lastFetchedAt).getTime();
    const dataAge: 'fresh' | 'cached' | 'stale' =
      ageMs < 24 * 60 * 60 * 1000 ? 'fresh' :
      ageMs < CACHE_MAX_AGE_MS ? 'cached' : 'stale';

    const data = JSON.parse(cached.earningsJson);

    if (dataAge !== 'stale') {
      return { ticker: upper, ...data, lastUpdated: new Date(cached.lastFetchedAt).toISOString(), dataAge };
    }
  }

  // Try to fetch from AV
  const remaining = await getDailyCallsRemaining();
  if (remaining < 1) {
    // Return whatever we have cached, even if stale
    if (cached?.earningsJson) {
      const data = JSON.parse(cached.earningsJson);
      return { ticker: upper, ...data, lastUpdated: new Date(cached.lastFetchedAt).toISOString(), dataAge: 'stale' };
    }
    // AV budget exhausted and no cache â€” fall back to Yahoo Finance
    return fetchFinnhubFallback(upper);
  }

  try {
    const raw = await fetchEarnings(upper);
    if (!raw) {
      if (cached?.earningsJson) {
        return { ticker: upper, ...JSON.parse(cached.earningsJson), lastUpdated: new Date(cached.lastFetchedAt).toISOString(), dataAge: 'stale' };
      }
      // AV returned nothing â€” fall back to Yahoo Finance
      return fetchFinnhubFallback(upper);
    }

    const quarterly = parseQuarterly(raw.quarterlyEarnings || []);
    const annual: ParsedAnnualEarning[] = (raw.annualEarnings || []).map(a => ({
      fiscalDateEnding: a.fiscalDateEnding,
      reportedEPS: parseAVNumber(a.reportedEPS),
    }));

    const earningsData = { quarterly, annual };

    // Save to cache
    await prisma.fundamentalsCache.upsert({
      where: { ticker: upper },
      update: { earningsJson: JSON.stringify(earningsData), lastFetchedAt: new Date() },
      create: { ticker: upper, earningsJson: JSON.stringify(earningsData), lastFetchedAt: new Date() },
    });

    return { ticker: upper, ...earningsData, lastUpdated: new Date().toISOString(), dataAge: 'fresh' };
  } catch (err) {
    console.error(`[AV Earnings] Fetch failed for ${upper}:`, (err as Error).message);
    if (cached?.earningsJson) {
      const data = JSON.parse(cached.earningsJson);
      return { ticker: upper, ...data, lastUpdated: new Date(cached.lastFetchedAt).toISOString(), dataAge: 'stale' };
    }
    // AV failed completely â€” fall back to Yahoo Finance
    return fetchFinnhubFallback(upper);
  }
}

/**
 * Finnhub fallback for earnings data.
 * Used when Alpha Vantage budget is exhausted or returns no data.
 * Finnhub provides ~4 quarters of history + upcoming earnings dates.
 */
async function fetchFinnhubFallback(ticker: string): Promise<EarningsResponse> {
  if (!config.finnhubApiKey) {
    return { ticker, quarterly: [], annual: [], lastUpdated: '', dataAge: 'stale' };
  }

  try {
    // Fetch historical earnings + upcoming calendar in parallel
    const now = new Date();
    const threeMonthsLater = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const fromDate = now.toISOString().slice(0, 10);
    const toDate = threeMonthsLater.toISOString().slice(0, 10);

    const [histResp, calResp] = await Promise.all([
      axios.get('https://finnhub.io/api/v1/stock/earnings', {
        params: { symbol: ticker, token: config.finnhubApiKey },
        timeout: 10000,
      }).catch(() => null),
      axios.get('https://finnhub.io/api/v1/calendar/earnings', {
        params: { symbol: ticker, from: fromDate, to: toDate, token: config.finnhubApiKey },
        timeout: 10000,
      }).catch(() => null),
    ]);

    const historical: ParsedQuarterlyEarning[] = (histResp?.data || []).map((h: {
      actual: number | null; estimate: number | null; period: string;
      surprise: number | null; surprisePercent: number | null;
    }) => ({
      fiscalDateEnding: h.period || '',
      reportedDate: h.period || '',
      reportedEPS: h.actual ?? null,
      estimatedEPS: h.estimate ?? null,
      surprise: h.surprise ?? null,
      surprisePercentage: h.surprisePercent ?? null,
      reportTime: '',
      beat: h.surprise != null ? h.surprise > 0 : null,
    })).filter((q: ParsedQuarterlyEarning) => q.fiscalDateEnding);

    // Sort by fiscal date descending (most recent first)
    historical.sort((a: ParsedQuarterlyEarning, b: ParsedQuarterlyEarning) =>
      b.fiscalDateEnding.localeCompare(a.fiscalDateEnding));

    // Add upcoming earnings from calendar
    const upcoming = calResp?.data?.earningsCalendar || [];
    for (const u of upcoming) {
      if (!u.date) continue;
      const alreadyHas = historical.some((q: ParsedQuarterlyEarning) => q.fiscalDateEnding === u.date);
      if (!alreadyHas) {
        historical.unshift({
          fiscalDateEnding: u.date,
          reportedDate: u.date,
          reportedEPS: u.epsActual ?? null,
          estimatedEPS: u.epsEstimate ?? null,
          surprise: null,
          surprisePercentage: null,
          reportTime: u.hour === 'bmo' ? 'Before Market Open' : u.hour === 'amc' ? 'After Market Close' : '',
          beat: null,
        });
      }
    }

    if (historical.length === 0) {
      return { ticker, quarterly: [], annual: [], lastUpdated: '', dataAge: 'stale' };
    }

    const earningsData = { quarterly: historical, annual: [] as ParsedAnnualEarning[] };

    // Cache Finnhub results
    await prisma.fundamentalsCache.upsert({
      where: { ticker },
      update: { earningsJson: JSON.stringify(earningsData), lastFetchedAt: new Date() },
      create: { ticker, earningsJson: JSON.stringify(earningsData), lastFetchedAt: new Date() },
    });

    console.log(`[Finnhub Earnings Fallback] ${ticker}: ${historical.length} quarters`);
    return { ticker, ...earningsData, lastUpdated: new Date().toISOString(), dataAge: 'cached' };
  } catch (err) {
    console.warn(`[Finnhub Earnings Fallback] Failed for ${ticker}:`, (err as Error).message);
    return { ticker, quarterly: [], annual: [], lastUpdated: '', dataAge: 'stale' };
  }
}

