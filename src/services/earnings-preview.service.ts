import NodeCache from 'node-cache';
import { callPerplexity, extractJson } from '../utils/perplexity';
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

const SYSTEM_PROMPT = `Return ONLY valid JSON:
{
  "whatToWatch": "2-3 sentences on what matters for this earnings report",
  "analystSentiment": "short neutral sentence on sentiment trend",
  "catalysts": ["1 short catalyst", "1 short catalyst"],
  "riskFactors": ["1 short risk", "1 short risk"]
}`;

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

async function getAiPreview(
  item: EarningsPreviewItem,
  userId: string
): Promise<{ preview: AiPreviewPayload | null; citations: string[] }> {
  const cacheKey = `earnings-preview:${item.ticker}`;
  const cached = previewCache.get<{ preview: AiPreviewPayload | null; citations: string[] }>(cacheKey);
  if (cached) return cached;

  const recent = item.recentQuarters.slice(0, 4)
    .map(q => `${q.reportedDate}: est ${q.estimatedEPS ?? 'n/a'}, rep ${q.reportedEPS ?? 'n/a'}, surprise% ${q.surprisePct ?? 'n/a'}`)
    .join('\n');

  const userMessage =
    `Feature: earnings-preview\n` +
    `UserId: ${userId}\n` +
    `Ticker: ${item.ticker}\n` +
    `Report date: ${item.reportDate} (${item.daysUntil} days)\n` +
    `Estimated EPS: ${item.estimatedEPS ?? 'n/a'}\n` +
    `Beat rate: ${item.beatRate}%\n` +
    `Average surprise: ${item.avgSurprisePct}%\n` +
    `Current streak: ${item.currentStreak.type} x${item.currentStreak.count}\n` +
    `Consistency score: ${item.consistencyScore}/100\n` +
    `Recent quarters:\n${recent}\n\n` +
    `What should investors watch for this earnings report?`;

  const resp = await callPerplexity(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    { timeout: 45000, feature: 'earnings-preview', userId, ticker: item.ticker }
  );

  if (!resp || !resp.content) {
    const fallback = { preview: null, citations: [] as string[] };
    previewCache.set(cacheKey, fallback);
    return fallback;
  }

  try {
    const parsed = JSON.parse(extractJson(resp.content)) as Partial<AiPreviewPayload>;
    const normalized: AiPreviewPayload = {
      whatToWatch: String(parsed.whatToWatch || '').slice(0, 400),
      analystSentiment: String(parsed.analystSentiment || '').slice(0, 250),
      catalysts: Array.isArray(parsed.catalysts) ? parsed.catalysts.map(v => String(v).slice(0, 160)).slice(0, 5) : [],
      riskFactors: Array.isArray(parsed.riskFactors) ? parsed.riskFactors.map(v => String(v).slice(0, 160)).slice(0, 5) : [],
    };
    const payload = { preview: normalized, citations: resp.citations || [] };
    previewCache.set(cacheKey, payload);
    return payload;
  } catch {
    const fallback = { preview: null, citations: [] as string[] };
    previewCache.set(cacheKey, fallback);
    return fallback;
  }
}

export async function getEarningsPreviews(userId: string): Promise<EarningsPreviewResponse> {
  await ensureEmailVerifiedForAi(userId);
  const summary = await getEarningsSummary(userId);
  const upcoming = summary.results.filter(item => item.daysUntil >= 0 && item.daysUntil <= UPCOMING_WINDOW_DAYS);
  if (upcoming.length === 0) return { results: [], partial: summary.partial };

  const results = await Promise.allSettled(upcoming.map(async (item) => {
    const track = await getEarningsTrack(item.ticker);
    const base = buildBaseItem(item, track);
    try {
      const ai = await getAiPreview(base, userId);
      return { ...base, preview: ai.preview, citations: ai.citations, generatedAt: new Date().toISOString() };
    } catch {
      return base;
    }
  }));

  const previews: EarningsPreviewItem[] = [];
  let partial = summary.partial;
  for (const result of results) {
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

  return { results: previews, partial };
}
