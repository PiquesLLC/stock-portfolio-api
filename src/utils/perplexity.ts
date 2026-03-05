import axios from 'axios';
import { config } from '../config';

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

// sonar-pro pricing: $3/M input, $15/M output, $5/1K searches
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

/**
 * Call the Perplexity sonar-pro model.
 * Returns null if API key is not configured.
 */
export async function callPerplexity(
  messages: PerplexityMessage[],
  options?: PerplexityCallOptions
): Promise<PerplexityResponse | null> {
  if (!config.perplexityApiKey) return null;

  const startMs = Date.now();

  const resp = await axios.post(
    'https://api.perplexity.ai/chat/completions',
    {
      model: 'sonar-pro',
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

  const durationMs = Date.now() - startMs;
  const content = resp.data?.choices?.[0]?.message?.content || '';
  const citations: string[] = resp.data?.citations || [];

  // Extract token usage from API response
  const inputTokens = resp.data?.usage?.prompt_tokens ?? 0;
  const outputTokens = resp.data?.usage?.completion_tokens ?? 0;
  const costUsdEstimate = inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN;

  const usage: PerplexityUsage = { inputTokens, outputTokens, costUsdEstimate };

  // Fire-and-forget DB logging (don't block the response)
  if (options?.feature) {
    logApiUsage({
      provider: 'perplexity',
      model: 'sonar-pro',
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

/**
 * Extract JSON from Perplexity response content.
 * Handles markdown fences, surrounding prose, and nested brackets.
 */
export function extractJson(content: string): string {
  let jsonStr = content.trim();

  // Strip markdown fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // If not starting with [ or {, find the first one
  if (!jsonStr.startsWith('[') && !jsonStr.startsWith('{')) {
    const arrStart = jsonStr.indexOf('[');
    const objStart = jsonStr.indexOf('{');
    const start = arrStart >= 0 && objStart >= 0
      ? Math.min(arrStart, objStart)
      : Math.max(arrStart, objStart);
    if (start >= 0) {
      jsonStr = jsonStr.slice(start);
    }
  }

  // Trim trailing text after JSON by finding the matching closing bracket
  let bracketDepth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[' || ch === '{') bracketDepth++;
    if (ch === ']' || ch === '}') {
      bracketDepth--;
      if (bracketDepth === 0) { jsonEnd = i + 1; break; }
    }
  }
  if (jsonEnd > 0) {
    jsonStr = jsonStr.slice(0, jsonEnd);
  }

  return jsonStr;
}
