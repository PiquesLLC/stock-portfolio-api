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
      maxOutputTokens: 4096,
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

  // Use header-based auth instead of query string to prevent API key leaking
  // into Axios error objects (config.url, request.path), server logs, and Sentry.
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;

  const reqTimeout = options?.timeout ?? 30000;
  const maxAttempts = 2; // Retry once on transient 503/429
  let resp;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      resp = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.googleGeminiApiKey,
        },
        timeout: reqTimeout,
      });
      break; // Success
    } catch (error: unknown) {
      lastError = error;
      const err = error as { code?: string; response?: { status?: number; data?: any }; message?: string };
      const durationMs = Date.now() - startMs;
      const status = err.response?.status;
      const category =
        status === 429 ? 'rate_limited'
        : status === 401 || status === 403 ? 'auth'
        : err.code === 'ECONNABORTED' ? 'timeout'
        : status && status >= 500 ? 'upstream_5xx'
        : 'request_failed';

      const retryable = status === 503 || status === 429 || status === 500;
      if (retryable && attempt < maxAttempts) {
        const backoffMs = status === 429 ? 3000 : 2000;
        console.warn(`[Gemini] attempt=${attempt} retryable ${status}, retrying in ${backoffMs}ms feature=${options?.feature || 'unknown'}`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      console.warn(`[Gemini] call_failed feature=${options?.feature || 'unknown'} category=${category} status=${status || 'n/a'} durationMs=${durationMs} ticker=${options?.ticker || 'n/a'} attempts=${attempt} message=${err.message || 'unknown'}`);
      // Sanitize the error: strip config.headers which contains the API key
      // before re-throwing so Sentry/callers don't capture it.
      if (err && typeof err === 'object' && 'config' in err) {
        const axiosErr = err as { config?: { headers?: Record<string, unknown> } };
        if (axiosErr.config?.headers) {
          delete axiosErr.config.headers['x-goog-api-key'];
        }
      }
      throw error;
    }
  }

  if (!resp) throw lastError ?? new Error('Gemini: no response after retries');
  const durationMs = Date.now() - startMs;

  // Extract content from Gemini response
  // Gemini 2.5 models include "thought" parts (internal reasoning) alongside
  // actual text parts. Filter out thought parts to get only the real response.
  // With search grounding, Gemini can produce multiple text parts (draft + grounded).
  // Use only the LAST non-thought text part to avoid duplicate/concatenated JSON.
  const candidates = resp.data?.candidates;
  const allParts: any[] = candidates?.[0]?.content?.parts || [];
  const textParts = allParts.filter((p: any) => !p.thought && p.text);
  const content = textParts.length > 0 ? textParts[textParts.length - 1].text : '';

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
