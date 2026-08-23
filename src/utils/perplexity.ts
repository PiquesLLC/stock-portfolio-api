import axios from 'axios';
import { config } from '../config';
import { assertAiBudget } from './ai-spend-guard';

export interface PerplexityMessage {
  role: 'system' | 'user';
  content: string;
}

export interface PerplexityUsage {
  inputTokens: number;
  outputTokens: number;
  costUsdEstimate: number;
}

export interface PerplexityResponse {
  content: string;
  citations: string[];
  usage?: PerplexityUsage;
}

export interface PerplexityCallOptions {
  timeout?: number;
  feature?: string;
  userId?: string;
  ticker?: string;
}

export type PerplexityJsonParseFailureReason = 'empty_response' | 'no_json_found' | 'invalid_json';

export type PerplexityJsonParseResult<T> =
  | { ok: true; data: T; extracted: string }
  | { ok: false; reason: PerplexityJsonParseFailureReason; error?: string; extracted: string };

// Pricing per model (per token)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'sonar-pro': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'sonar': { input: 1 / 1_000_000, output: 1 / 1_000_000 },
};

/**
 * Call a Perplexity model (sonar or sonar-pro).
 * Returns null if API key is not configured.
 */
export async function callPerplexity(
  messages: PerplexityMessage[],
  options?: PerplexityCallOptions & { model?: string }
): Promise<PerplexityResponse | null> {
  if (!config.perplexityApiKey) return null;

  // Platform-wide spend backstop (M6) — throws if the rolling-24h budget is
  // exhausted or AI is hard-disabled. Covers every caller, including the direct
  // callPerplexity in yahoo-finance ETF fallback.
  // M-11: pass the caller so the guard can enforce a per-user hourly ceiling,
  // not just the platform-wide daily cap.
  await assertAiBudget(options?.feature, options?.userId);

  const startMs = Date.now();
  const model = options?.model || 'sonar-pro';

  let resp;
  try {
    resp = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model,
        messages,
      },
      {
        headers: {
          'Authorization': `Bearer ${config.perplexityApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: options?.timeout ?? 45000,
      }
    );
  } catch (error: unknown) {
    const err = error as { code?: string; response?: { status?: number }; message?: string };
    const durationMs = Date.now() - startMs;
    const status = err.response?.status;
    const category =
      status === 429 ? 'rate_limited'
      : status === 401 || status === 403 ? 'auth'
      : err.code === 'ECONNABORTED' ? 'timeout'
      : status && status >= 500 ? 'upstream_5xx'
      : 'request_failed';
    console.warn(`[Perplexity] call_failed feature=${options?.feature || 'unknown'} category=${category} status=${status || 'n/a'} durationMs=${durationMs} ticker=${options?.ticker || 'n/a'} message=${err.message || 'unknown'}`);
    throw error;
  }

  const durationMs = Date.now() - startMs;
  const content = resp.data?.choices?.[0]?.message?.content || '';
  const citations: string[] = resp.data?.citations || [];

  // Extract token usage from API response
  const inputTokens = resp.data?.usage?.prompt_tokens ?? 0;
  const outputTokens = resp.data?.usage?.completion_tokens ?? 0;
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['sonar-pro'];
  const costUsdEstimate = inputTokens * pricing.input + outputTokens * pricing.output;

  const usage: PerplexityUsage = { inputTokens, outputTokens, costUsdEstimate };

  // Fire-and-forget DB logging (don't block the response)
  if (options?.feature) {
    logApiUsage({
      provider: 'perplexity',
      model,
      feature: options.feature,
      inputTokens,
      outputTokens,
      costUsdEstimate,
      userId: options.userId,
      ticker: options.ticker,
      durationMs,
    }).catch(err => {
      console.error('[ApiUsageLog] Failed to log:', err.message);
    });
  }

  return { content, citations, usage };
}

/**
 * Fire-and-forget insert to ApiUsageLog.
 */
async function logApiUsage(data: {
  provider: string;
  model: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  costUsdEstimate: number;
  userId?: string;
  ticker?: string;
  durationMs: number;
}): Promise<void> {
  // Dynamic import to avoid circular dependency (prisma → generated → ...)
  const prisma = (await import('./prisma')).default;
  await prisma.apiUsageLog.create({ data });
}

function normalizeJsonLikeText(content: string): string {
  return content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, '\'')
    .trim();
}

function stripMarkdownFences(content: string): string {
  const trimmed = content.trim();
  const fullFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fullFenceMatch) return fullFenceMatch[1].trim();
  return trimmed.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
}

function extractMarkdownFenceBlocks(content: string): string[] {
  const blocks: string[] = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;

  for (const match of content.matchAll(fenceRegex)) {
    const block = match[1]?.trim();
    if (block) blocks.push(block);
  }

  return blocks;
}

function trimToBalancedJson(content: string): string {
  let bracketDepth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[' || ch === '{') bracketDepth++;
    if (ch === ']' || ch === '}') {
      bracketDepth--;
      if (bracketDepth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }

  return jsonEnd > 0 ? content.slice(0, jsonEnd).trim() : content.trim();
}

function findFirstJsonStart(content: string): string {
  if (content.startsWith('[') || content.startsWith('{')) return content;

  const arrStart = content.indexOf('[');
  const objStart = content.indexOf('{');
  const start = arrStart >= 0 && objStart >= 0
    ? Math.min(arrStart, objStart)
    : Math.max(arrStart, objStart);

  return start >= 0 ? content.slice(start).trim() : '';
}

function removeTrailingCommas(content: string): string {
  return content.replace(/,\s*([}\]])/g, '$1').trim();
}

function buildJsonCandidates(content: string): string[] {
  const normalized = normalizeJsonLikeText(content);
  if (!normalized) return [];

  const stripped = stripMarkdownFences(normalized);
  const fencedBlocks = extractMarkdownFenceBlocks(normalized);
  const candidates = [
    stripped,
    findFirstJsonStart(stripped),
    trimToBalancedJson(findFirstJsonStart(stripped)),
    removeTrailingCommas(trimToBalancedJson(findFirstJsonStart(stripped))),
    removeTrailingCommas(findFirstJsonStart(stripped)),
    ...fencedBlocks,
    ...fencedBlocks.map(findFirstJsonStart),
    ...fencedBlocks.map(block => trimToBalancedJson(findFirstJsonStart(block))),
    ...fencedBlocks.map(block => removeTrailingCommas(trimToBalancedJson(findFirstJsonStart(block)))),
  ];

  return Array.from(new Set(candidates.filter(Boolean)));
}

/**
 * Extract JSON from Perplexity response content.
 * Handles markdown fences, surrounding prose, trailing text, and simple JSON cleanup.
 */
export function extractJson(content: string): string {
  const candidates = buildJsonCandidates(content);
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return candidates[0] ?? '';
}

export function parsePerplexityJson<T = unknown>(content: string): PerplexityJsonParseResult<T> {
  if (!content || !content.trim()) {
    return { ok: false, reason: 'empty_response', extracted: '' };
  }
  const candidates = buildJsonCandidates(content);
  const extracted = candidates[0] ?? '';
  if (!extracted) {
    return { ok: false, reason: 'no_json_found', extracted: '' };
  }

  for (const candidate of candidates) {
    try {
      return { ok: true, data: JSON.parse(candidate) as T, extracted: candidate };
    } catch {
      // Try the next cleaned candidate.
    }
  }

  try {
    const cleaned = removeTrailingCommas(trimToBalancedJson(findFirstJsonStart(stripMarkdownFences(normalizeJsonLikeText(content)))));
    return { ok: true, data: JSON.parse(cleaned) as T, extracted: cleaned };
  } catch (retryError) {
    const parseErr = retryError instanceof Error ? retryError.message : String(retryError);
    return { ok: false, reason: 'invalid_json', error: parseErr, extracted };
  }
}

const VALID_EVENT_TYPES = ['EARNINGS', 'ANALYST', 'DIVIDEND'] as const;

export function normalizeType(raw: unknown): (typeof VALID_EVENT_TYPES)[number] | null {
  const upper = String(raw || '').toUpperCase().trim();
  if ((VALID_EVENT_TYPES as readonly string[]).includes(upper)) {
    return upper as (typeof VALID_EVENT_TYPES)[number];
  }
  const remap: Record<string, (typeof VALID_EVENT_TYPES)[number]> = {
    PRODUCT: 'ANALYST',
    CORPORATE: 'ANALYST',
    REGULATORY: 'ANALYST',
    NEWS: 'ANALYST',
    SPLIT: 'DIVIDEND',
    'STOCK SPLIT': 'DIVIDEND',
  };
  const mapped = remap[upper] || null;
  if (!mapped && upper) {
    console.warn(`[Perplexity] unmapped event type: "${upper}"`);
  }
  return mapped;
}

export function normalizeSentiment(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(-1, Math.min(1, raw));
  }
  const str = String(raw || '').toLowerCase().trim();
  if (str === 'positive') return 0.7;
  if (str === 'negative') return -0.7;
  if (str === 'neutral') return 0;
  const parsed = parseFloat(str);
  return Number.isFinite(parsed) ? Math.max(-1, Math.min(1, parsed)) : 0;
}
