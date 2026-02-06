import NodeCache from 'node-cache';
import { callPerplexity, extractJson } from '../utils/perplexity';

// Cache AI events for 2 hours per ticker+days combo
const aiEventsCache = new NodeCache({ stdTTL: 7200 });

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

// Normalize type strings — sonar-pro returns various casings and non-standard types
function normalizeType(raw: string): string | null {
  const upper = String(raw || '').toUpperCase().trim();
  if (VALID_TYPES.includes(upper)) return upper;
  const remap: Record<string, string> = {
    PRODUCT: 'ANALYST', CORPORATE: 'ANALYST', REGULATORY: 'ANALYST',
    NEWS: 'ANALYST', SPLIT: 'DIVIDEND', 'STOCK SPLIT': 'DIVIDEND',
  };
  return remap[upper] || null;
}

// Normalize sentiment — sonar-pro sometimes returns strings like "positive"
function normalizeSentiment(raw: unknown): number {
  if (typeof raw === 'number') return Math.max(-1, Math.min(1, raw));
  const str = String(raw || '').toLowerCase();
  if (str === 'positive') return 0.7;
  if (str === 'negative') return -0.7;
  if (str === 'neutral') return 0;
  const parsed = parseFloat(str);
  return isNaN(parsed) ? 0 : Math.max(-1, Math.min(1, parsed));
}

export async function getAIEvents(ticker: string, days = 90): Promise<AIEventsResponse> {
  const upper = ticker.toUpperCase();
  const cacheKey = `ai-events-${upper}-${days}`;
  const cached = aiEventsCache.get<AIEventsResponse>(cacheKey);
  if (cached) return cached;

  const endDate = new Date().toISOString().slice(0, 10);
  const isMax = days >= 3650; // 10+ years = treat as MAX
  const startDate = isMax
    ? '1990-01-01'
    : new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const userMessage = isMax
    ? `Find the 15-20 most significant earnings reports, analyst rating changes (upgrades/downgrades/price targets), and dividend events in the entire trading history of ${upper}. Focus on events that moved the stock price significantly. Include analyst firm names for rating changes, EPS beat/miss amounts for earnings, and dollar amounts for dividends.`
    : `Find all earnings reports, analyst rating changes (upgrades/downgrades/price targets), and dividend events for ${upper} between ${startDate} and ${endDate}. Include analyst firm names for rating changes, EPS beat/miss amounts for earnings, and dollar amounts for dividends.`;

  try {
    const resp = await callPerplexity([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ]);

    if (!resp || !resp.content) {
      console.warn(`[Perplexity] Empty response for ${upper}`);
      return { ticker: upper, events: [] };
    }

    const jsonStr = extractJson(resp.content);

    let rawEvents: any[];
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr: any) {
      console.error(`[Perplexity] JSON parse failed for ${upper}:`, parseErr.message);
      console.error(`[Perplexity] Content (first 300 chars):`, resp.content.slice(0, 300));
      return { ticker: upper, events: [] };
    }

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
      if (!mappedType) continue;

      validEvents.push({
        date: evt.date,
        type: mappedType as AIEvent['type'],
        label: String(evt.label || '').slice(0, 80),
        insight: String(evt.insight || '').slice(0, 250),
        sentiment: normalizeSentiment(evt.sentiment),
        source_url: evt.source_url || resp.citations[validEvents.length] || undefined,
      });
    }

    const result: AIEventsResponse = { ticker: upper, events: validEvents };
    // Only cache non-empty results
    if (validEvents.length > 0) {
      aiEventsCache.set(cacheKey, result);
    }
    console.log(`[Perplexity] ${upper}: ${validEvents.length}/${rawEvents.length} events (${isMax ? 'MAX' : `${startDate} to ${endDate}`}), ${resp.citations.length} citations`);
    return result;
  } catch (error: any) {
    if (error.response?.status === 429) {
      console.warn(`[Perplexity] Rate limited for ${upper}`);
    } else if (error.response?.status === 401) {
      console.error(`[Perplexity] Invalid API key`);
    } else {
      console.error(`[Perplexity] Error for ${upper}:`, error.message);
    }
    return { ticker: upper, events: [] };
  }
}
