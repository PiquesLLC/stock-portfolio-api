import NodeCache from 'node-cache';
import { getEarningsSummary, EarningsSummaryItem } from './earnings-summary.service';
import { getEarningsTrack, EarningsTrackResult } from './earnings-track.service';
import { ensureEmailVerifiedForAi } from './email-verification-guard.service';

const UPCOMING_WINDOW_DAYS = 14;
const previewCache = new NodeCache({ stdTTL: 4 * 60 * 60 }); // 4 hours

interface AiPreviewPayload {
  whatToWatch: string;
  analystSentiment: string;
  catalysts: string[];
  riskFactors: string[];
}

export interface EarningsPreviewItem {
  ticker: string;
  reportDate: string;
  daysUntil: number;
  estimatedEPS: number | null;
  beatRate: number;
  avgSurprisePct: number;
  currentStreak: {
    type: 'beat' | 'miss' | 'meet' | 'none';
    count: number;
  };
  consistencyScore: number;
  recentQuarters: EarningsTrackResult['recentQuarters'];
  preview: AiPreviewPayload | null;
  citations: string[];
  generatedAt: string;
}

export interface EarningsPreviewResponse {
  results: EarningsPreviewItem[];
  partial: boolean;
}

// Build preview from data — no AI calls needed
function buildDataPreview(item: EarningsPreviewItem): AiPreviewPayload {
  const { ticker, beatRate, avgSurprisePct, currentStreak, consistencyScore, estimatedEPS, recentQuarters } = item;

  // What to watch
  const streakText = currentStreak.type === 'beat' && currentStreak.count >= 2
    ? `${ticker} has beaten estimates ${currentStreak.count} quarters in a row.`
    : currentStreak.type === 'miss' && currentStreak.count >= 2
    ? `${ticker} has missed estimates ${currentStreak.count} consecutive quarters.`
    : '';

  const epsText = estimatedEPS != null
    ? `Analysts expect EPS of $${estimatedEPS.toFixed(2)}.`
    : '';

  const beatText = beatRate > 0
    ? `Historical beat rate is ${beatRate}% with an average surprise of ${avgSurprisePct >= 0 ? '+' : ''}${avgSurprisePct.toFixed(1)}%.`
    : '';

  const whatToWatch = [streakText, epsText, beatText].filter(Boolean).join(' ')
    || `${ticker} reports earnings soon. Watch for revenue growth and forward guidance.`;

  // Analyst sentiment
  const analystSentiment = consistencyScore >= 75
    ? `${ticker} has strong earnings consistency (${consistencyScore}/100), suggesting predictable results.`
    : consistencyScore >= 50
    ? `${ticker} shows moderate earnings consistency (${consistencyScore}/100).`
    : `${ticker} has volatile earnings history (${consistencyScore}/100) — expect wider outcome range.`;

  // Catalysts
  const catalysts: string[] = [];
  if (beatRate >= 75) catalysts.push(`Strong beat rate (${beatRate}%) suggests upside potential`);
  if (currentStreak.type === 'beat' && currentStreak.count >= 3) catalysts.push(`${currentStreak.count}-quarter beat streak could continue`);
  if (avgSurprisePct > 5) catalysts.push(`Historically large positive surprises (avg +${avgSurprisePct.toFixed(1)}%)`);
  if (recentQuarters.length > 0) {
    const lastQ = recentQuarters[0];
    if (lastQ.surprisePct != null && lastQ.surprisePct > 5) catalysts.push(`Last quarter surprised by +${lastQ.surprisePct.toFixed(1)}%`);
  }
  if (catalysts.length === 0) catalysts.push('Watch for forward guidance and revenue growth commentary');

  // Risk factors
  const riskFactors: string[] = [];
  if (beatRate < 50) riskFactors.push(`Below-average beat rate (${beatRate}%) increases miss risk`);
  if (currentStreak.type === 'miss' && currentStreak.count >= 2) riskFactors.push(`${currentStreak.count}-quarter miss streak is concerning`);
  if (consistencyScore < 40) riskFactors.push(`Low consistency score (${consistencyScore}/100) means unpredictable results`);
  if (avgSurprisePct < -2) riskFactors.push(`Historically negative surprises (avg ${avgSurprisePct.toFixed(1)}%)`);
  if (riskFactors.length === 0) riskFactors.push('Post-earnings volatility could impact short-term price action');

  return { whatToWatch, analystSentiment, catalysts: catalysts.slice(0, 3), riskFactors: riskFactors.slice(0, 3) };
}

function buildBaseItem(summary: EarningsSummaryItem, track: EarningsTrackResult): EarningsPreviewItem {
  return {
    ticker: summary.ticker,
    reportDate: summary.reportDate,
    daysUntil: summary.daysUntil,
    estimatedEPS: summary.estimatedEPS,
    beatRate: track.beatRate,
    avgSurprisePct: track.avgSurprisePct,
    currentStreak: track.currentStreak,
    consistencyScore: track.consistencyScore,
    recentQuarters: track.recentQuarters,
    preview: null,
    citations: [],
    generatedAt: new Date().toISOString(),
  };
}

export async function getEarningsPreviews(userId: string, portfolioId?: string): Promise<EarningsPreviewResponse> {
  await ensureEmailVerifiedForAi(userId);

  const cacheKey = `earnings-previews:${userId}:${portfolioId ?? 'default'}`;
  const cached = previewCache.get<EarningsPreviewResponse>(cacheKey);
  if (cached) return cached;

  const summary = await getEarningsSummary(userId, portfolioId);
  const upcoming = summary.results.filter(item => item.daysUntil >= 0 && item.daysUntil <= UPCOMING_WINDOW_DAYS);
  if (upcoming.length === 0) return { results: [], partial: summary.partial };

  // Fetch all earnings tracks in parallel — no sequential batching needed without AI calls
  const trackResults = await Promise.allSettled(
    upcoming.map(async (item) => {
      const track = await getEarningsTrack(item.ticker);
      const base = buildBaseItem(item, track);
      const preview = buildDataPreview(base);
      return { ...base, preview, generatedAt: new Date().toISOString() };
    })
  );

  const previews: EarningsPreviewItem[] = [];
  let partial = summary.partial;
  for (const result of trackResults) {
    if (result.status === 'fulfilled') {
      previews.push(result.value);
    } else {
      partial = true;
    }
  }

  previews.sort((a, b) => {
    if (a.reportDate === b.reportDate) return a.ticker.localeCompare(b.ticker);
    return a.reportDate.localeCompare(b.reportDate);
  });

  const response = { results: previews, partial };
  previewCache.set(cacheKey, response);
  return response;
}
