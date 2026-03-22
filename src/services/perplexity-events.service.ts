import NodeCache from 'node-cache';
import { AxiosError } from 'axios';
import { callAI } from '../utils/ai-provider';
import { normalizeSentiment, normalizeType, parsePerplexityJson } from '../utils/perplexity';
import { sanitizeContent, validateCitationUrl } from '../utils/content-filter';
import { ensureEmailVerifiedForAi } from './email-verification-guard.service';

// Cache AI events for 30 minutes per ticker+days combo
const aiEventsCache = new NodeCache({ stdTTL: 1800 });

export interface AIEvent {
  date: string; // YYYY-MM-DD
  type: 'EARNINGS' | 'ANALYST' | 'DIVIDEND';
  label: string; // 3-5 words
  insight: string; // 1-sentence summary
  sentiment: number; // -1 to 1
  source_url?: string;
}

export interface AIEventsResponse {
  ticker: string;
  events: AIEvent[];
}

const VALID_TYPES = ['EARNINGS', 'ANALYST', 'DIVIDEND'];

const SYSTEM_PROMPT = `You are a financial events researcher. Return ONLY a valid JSON array with no other text. Each object must have: date (YYYY-MM-DD), type (EARNINGS or ANALYST or DIVIDEND), label (short 3-5 word headline), insight (one sentence impact analysis), sentiment (float -1.0 to 1.0), source_url (URL or null).`;

export async function getAIEvents(ticker: string, days = 90, userId: string): Promise<AIEventsResponse> {
  await ensureEmailVerifiedForAi(userId);
  const upper = ticker.toUpperCase();
  const cacheKey = `ai-events-${upper}-${days}`;
  const cached = aiEventsCache.get<AIEventsResponse>(cacheKey);
  if (cached) return cached;

  const endDate = new Date().toISOString().slice(0, 10);
  const isMax = days >= 3650; // 10+ years = treat as MAX
  const startDate = isMax
    ? '1990-01-01'
    : new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  // Scale event count based on time range
  const eventCount = isMax ? 40 : days >= 1000 ? 30 : days >= 365 ? 20 : 15;

  const userMessage = isMax
    ? `Find ${eventCount} significant earnings reports, analyst rating changes (upgrades/downgrades/price targets), and dividend events across the ENTIRE trading history of ${upper}, going back to its IPO. IMPORTANT: Spread events evenly across all decades - include events from the 2000s, 2010s, and 2020s, not just recent years. For each decade the stock has been public, include at least 5-8 events. Focus on events that moved the stock price significantly. Include analyst firm names for rating changes, EPS beat/miss amounts for earnings, and dollar amounts for dividends.`
    : `Find up to ${eventCount} earnings reports, analyst rating changes (upgrades/downgrades/price targets), and dividend events for ${upper} from ${startDate} to ${endDate} (today). IMPORTANT: Only include events that actually occurred or were announced AFTER ${startDate}. Do NOT include any events from before ${startDate}. Spread events across the entire date range, not just the most recent months. Today's date is ${endDate}. Include analyst firm names for rating changes, EPS beat/miss amounts for earnings, and dollar amounts for dividends.`;

  try {
    const resp = await callAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ], { feature: 'ai-events', userId, ticker: upper });

    if (!resp || !resp.content) {
      console.warn(`[Perplexity] Empty response for ${upper}`);
      return { ticker: upper, events: [] };
    }

    const parsedResult = parsePerplexityJson<unknown>(resp.content);
    if (!parsedResult.ok) {
      console.warn(`[Perplexity] ${upper} parse_failed reason=${parsedResult.reason} extractedLen=${parsedResult.extracted.length}`);
      return { ticker: upper, events: [] };
    }

    let rawEvents: any[];
    const parsed = parsedResult.data as any;
    if (Array.isArray(parsed)) {
      rawEvents = parsed;
    } else if (parsed.events && Array.isArray(parsed.events)) {
      rawEvents = parsed.events;
    } else {
      rawEvents = [];
    }

    // Validate, normalize, and filter events
    const validEvents: AIEvent[] = [];
    for (const evt of rawEvents) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(evt.date)) continue;
      if (!isMax && (evt.date < startDate || evt.date > endDate)) continue;
      if (isMax && evt.date > endDate) continue;
      const mappedType = normalizeType(evt.type);
      if (!mappedType || !VALID_TYPES.includes(mappedType)) continue;

      const label = sanitizeContent(String(evt.label || '').trim().slice(0, 80));
      const insight = sanitizeContent(String(evt.insight || '').trim().slice(0, 250));
      if (!label || !insight) continue;

      const rawUrl = evt.source_url || resp.citations[validEvents.length] || undefined;
      const source_url = rawUrl && validateCitationUrl(rawUrl) ? rawUrl : undefined;

      validEvents.push({
        date: evt.date,
        type: mappedType as AIEvent['type'],
        label,
        insight,
        sentiment: normalizeSentiment(evt.sentiment),
        source_url,
      });
    }

    const result: AIEventsResponse = { ticker: upper, events: validEvents };
    // Only cache non-empty results - longer TTL for historical data
    if (validEvents.length > 0) {
      const ttl = isMax ? 7200 : days >= 365 ? 3600 : 1800; // 2hr for MAX, 1hr for 1Y+, 30min default
      aiEventsCache.set(cacheKey, result, ttl);
    }
    console.log(`[Perplexity] ${upper}: ${validEvents.length}/${rawEvents.length} events (${isMax ? 'MAX' : `${startDate} to ${endDate}`}), ${resp.citations.length} citations, cached=${validEvents.length > 0}`);
    return result;
  } catch (error: unknown) {
    if (error instanceof AxiosError && error.response?.status === 429) {
      console.warn(`[Perplexity] Rate limited for ${upper} (ai-events)`);
    } else if (error instanceof AxiosError && error.response?.status === 401) {
      console.error('[Perplexity] Invalid API key');
    } else if (error instanceof AxiosError && error.code === 'ECONNABORTED') {
      console.error(`[Perplexity] Timeout for ${upper} (ai-events)`);
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Perplexity] Error for ${upper} (ai-events): ${msg}`);
    }
    return { ticker: upper, events: [] };
  }
}
