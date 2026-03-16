import { config } from '../config';
import { callPerplexity } from './perplexity';
import { callGemini } from './gemini';
import type { PerplexityMessage, PerplexityResponse, PerplexityCallOptions } from './perplexity';

/**
 * Route AI calls to the configured provider.
 * Set AI_PROVIDER=gemini to use Gemini, defaults to perplexity.
 *
 * Features that need web search (daily report, events) pass useSearch: true.
 * Gemini uses Google Search grounding; Perplexity uses built-in web search.
 */
export async function callAI(
  messages: PerplexityMessage[],
  options?: PerplexityCallOptions & { model?: string; useSearch?: boolean },
): Promise<PerplexityResponse | null> {
  if (config.aiProvider === 'gemini') {
    return callGemini(messages, options);
  }
  return callPerplexity(messages, options);
}

export { type PerplexityMessage, type PerplexityResponse, type PerplexityCallOptions };
