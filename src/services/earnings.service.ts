/**
 * Earnings Service
 *
 * Fetches quarterly and annual EPS data from Alpha Vantage.
 * Shares the FundamentalsCache table (earningsJson column).
 */

import { PrismaClient } from '@prisma/client';
import { fetchEarnings, parseAVNumber, getDailyCallsRemaining, AVQuarterlyEarning } from '../utils/alpha-vantage';

const prisma = new PrismaClient();

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
    return empty;
  }

  try {
    const raw = await fetchEarnings(upper);
    if (!raw) return cached?.earningsJson
      ? { ticker: upper, ...JSON.parse(cached.earningsJson), lastUpdated: new Date(cached.lastFetchedAt).toISOString(), dataAge: 'stale' }
      : empty;

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
    return empty;
  }
}
