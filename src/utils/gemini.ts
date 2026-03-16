import axios from 'axios';
import { config } from '../config';
import type { PerplexityMessage, PerplexityResponse, PerplexityCallOptions } from './perplexity';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Call Google Gemini as a drop-in replacement for callPerplexity.
 * Uses gemini-2.5-flash by default (free tier: 1500 req/day).
 * Accepts the same message format (system + user) and returns
 * the same PerplexityResponse shape so services don't need changes.
 */
export async function callGemini(
  messages: PerplexityMessage[],
  options?: PerplexityCallOptions & { model?: string; useSearch?: boolean },
): Promise<PerplexityResponse | null> {
  if (!config.googleGeminiApiKey) return null;

  const startMs = Date.now();
  const model = options?.model || 'gemini-2.5-flash';

  // Build Gemini request — map system/user messages to Gemini format
  const systemMessage = messages.find(m => m.role === 'system')?.content || '';
  const userMessages = messages.filter(m => m.role === 'user');

  const contents = userMessages.map(m => ({
    role: 'user' as const,
    parts: [{ text: m.content }],
  }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
    },
  };

  // System instruction
  if (systemMessage) {
    body.systemInstruction = { parts: [{ text: systemMessage }] };
  }

  // Google Search grounding (for features that need current data)
  if (options?.useSearch) {
    body.tools = [{ googleSearch: {} }];
  }

  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${config.googleGeminiApiKey}`;

  let resp;
  try {
    resp = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: options?.timeout ?? 30000,
    });
  } catch (error: unknown) {
    const err = error as { code?: string; response?: { status?: number; data?: any }; message?: string };
    const durationMs = Date.now() - startMs;
    const status = err.response?.status;
    const category =
      status === 429 ? 'rate_limited'
      : status === 401 || status === 403 ? 'auth'
      : err.code === 'ECONNABORTED' ? 'timeout'
      : status && status >= 500 ? 'upstream_5xx'
      : 'request_failed';
    console.warn(`[Gemini] call_failed feature=${options?.feature || 'unknown'} category=${category} status=${status || 'n/a'} durationMs=${durationMs} ticker=${options?.ticker || 'n/a'} message=${err.message || 'unknown'}`);
    throw error;
  }

  const durationMs = Date.now() - startMs;

  // Extract content from Gemini response
  // Gemini 2.5 models include "thought" parts (internal reasoning) alongside
  // actual text parts. Filter out thought parts to get only the real response,
  // otherwise thinking text gets prepended to JSON and breaks parsing.
  const candidates = resp.data?.candidates;
  const allParts: any[] = candidates?.[0]?.content?.parts || [];
  const content = allParts
    .filter((p: any) => !p.thought)
    .map((p: any) => p.text || '')
    .join('') || '';

  // Extract search citations if available
  const groundingMetadata = candidates?.[0]?.groundingMetadata;
  const citations: string[] = groundingMetadata?.groundingChunks
    ?.map((c: any) => c.web?.uri)
    .filter(Boolean) || [];

  // Token usage
  const usageMetadata = resp.data?.usageMetadata;
  const inputTokens = usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = usageMetadata?.candidatesTokenCount ?? 0;

  // Gemini Flash is free, but log for tracking
  if (options?.feature) {
    logApiUsage({
      provider: 'gemini',
      model,
      feature: options.feature,
      inputTokens,
      outputTokens,
      costUsdEstimate: 0, // Free tier
      userId: options.userId,
      ticker: options.ticker,
      durationMs,
    }).catch(err => {
      console.error('[ApiUsageLog] Failed to log:', err.message);
    });
  }

  console.log(`[Gemini] feature=${options?.feature || 'unknown'} model=${model} search=${!!options?.useSearch} tokens=${inputTokens}+${outputTokens} durationMs=${durationMs}`);

  return { content, citations };
}

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
  const prisma = (await import('./prisma')).default;
  await prisma.apiUsageLog.create({ data });
}
