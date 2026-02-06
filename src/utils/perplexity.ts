import axios from 'axios';
import { config } from '../config';

export interface PerplexityMessage {
  role: 'system' | 'user';
  content: string;
}

export interface PerplexityResponse {
  content: string;
  citations: string[];
}

/**
 * Call the Perplexity sonar-pro model.
 * Returns null if API key is not configured.
 */
export async function callPerplexity(
  messages: PerplexityMessage[],
  options?: { timeout?: number }
): Promise<PerplexityResponse | null> {
  if (!config.perplexityApiKey) return null;

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

  const content = resp.data?.choices?.[0]?.message?.content || '';
  const citations: string[] = resp.data?.citations || [];
  return { content, citations };
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
