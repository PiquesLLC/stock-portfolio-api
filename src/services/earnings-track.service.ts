/**
 * Earnings Track Service — computes beat/miss record per ticker.
 * Uses existing getEarningsData() which fetches from Alpha Vantage / Finnhub.
 */

import NodeCache from 'node-cache';
import { getEarningsData, ParsedQuarterlyEarning } from './earnings.service';

const cache = new NodeCache({ stdTTL: 86400 }); // 24h cache

export interface EarningsTrackResult {
  ticker: string;
  beatCount: number;
  missCount: number;
  meetCount: number;
  totalQuarters: number;
  beatRate: number;
  avgSurprisePct: number;
  avgBeatSurprisePct: number;
  currentStreak: {
    type: 'beat' | 'miss' | 'meet' | 'none';
    count: number;
  };
  recentQuarters: {
    fiscalDate: string;
    reportedDate: string;
    reportedEPS: number | null;
    estimatedEPS: number | null;
    surprise: number | null;
    surprisePct: number | null;
    beat: boolean | null;
  }[];
  consistencyScore: number;
}

export async function getEarningsTrack(ticker: string): Promise<EarningsTrackResult> {
  const upper = ticker.toUpperCase();
  const cached = cache.get<EarningsTrackResult>(upper);
  if (cached) return cached;

  const earnings = await getEarningsData(upper);
  const quarters = earnings.quarterly.filter(
    q => q.beat != null && q.reportedEPS != null
  );

  if (quarters.length === 0) {
    const empty: EarningsTrackResult = {
      ticker: upper,
      beatCount: 0, missCount: 0, meetCount: 0,
      totalQuarters: 0, beatRate: 0,
      avgSurprisePct: 0, avgBeatSurprisePct: 0,
      currentStreak: { type: 'none', count: 0 },
      recentQuarters: [],
      consistencyScore: 0,
    };
    cache.set(upper, empty);
    return empty;
  }

  let beatCount = 0;
  let missCount = 0;
  let meetCount = 0;
  const surprisePcts: number[] = [];
  const beatSurprisePcts: number[] = [];

  for (const q of quarters) {
    if (q.surprise != null && q.surprise > 0) {
      beatCount++;
      if (q.surprisePercentage != null) beatSurprisePcts.push(q.surprisePercentage);
    } else if (q.surprise != null && q.surprise < 0) {
      missCount++;
    } else {
      meetCount++;
    }
    if (q.surprisePercentage != null) surprisePcts.push(q.surprisePercentage);
  }

  const totalQuarters = quarters.length;
  const beatRate = totalQuarters > 0 ? (beatCount / totalQuarters) * 100 : 0;
  const avgSurprisePct = surprisePcts.length > 0
    ? surprisePcts.reduce((s, v) => s + v, 0) / surprisePcts.length
    : 0;
  const avgBeatSurprisePct = beatSurprisePcts.length > 0
    ? beatSurprisePcts.reduce((s, v) => s + v, 0) / beatSurprisePcts.length
    : 0;

  // Current streak — iterate from most recent
  let streakType: 'beat' | 'miss' | 'meet' | 'none' = 'none';
  let streakCount = 0;
  for (const q of quarters) {
    const qType = q.surprise != null && q.surprise > 0 ? 'beat'
      : q.surprise != null && q.surprise < 0 ? 'miss' : 'meet';
    if (streakCount === 0) {
      streakType = qType;
      streakCount = 1;
    } else if (qType === streakType) {
      streakCount++;
    } else {
      break;
    }
  }

  // Consistency score: 60% beatRate + 20% streak bonus + 20% low variance
  const variance = surprisePcts.length > 1
    ? surprisePcts.reduce((s, v) => s + Math.pow(v - avgSurprisePct, 2), 0) / surprisePcts.length
    : 0;
  const stdDev = Math.sqrt(variance);
  const varianceScore = Math.max(0, 100 - stdDev * 5);
  const streakBonus = Math.min(100, streakType === 'beat' ? streakCount * 20 : 0);
  const consistencyScore = Math.round(beatRate * 0.6 + streakBonus * 0.2 + varianceScore * 0.2);

  const recentQuarters = quarters.slice(0, 8).map(q => ({
    fiscalDate: q.fiscalDateEnding,
    reportedDate: q.reportedDate,
    reportedEPS: q.reportedEPS,
    estimatedEPS: q.estimatedEPS,
    surprise: q.surprise,
    surprisePct: q.surprisePercentage,
    beat: q.beat,
  }));

  const result: EarningsTrackResult = {
    ticker: upper,
    beatCount,
    missCount,
    meetCount,
    totalQuarters,
    beatRate: Math.round(beatRate * 10) / 10,
    avgSurprisePct: Math.round(avgSurprisePct * 100) / 100,
    avgBeatSurprisePct: Math.round(avgBeatSurprisePct * 100) / 100,
    currentStreak: { type: streakType, count: streakCount },
    recentQuarters,
    consistencyScore: Math.min(100, Math.max(0, consistencyScore)),
  };

  cache.set(upper, result);
  return result;
}
