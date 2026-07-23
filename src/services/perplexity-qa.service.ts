import NodeCache from 'node-cache';
import { callAI } from '../utils/ai-provider';
import { sanitizeContent, validateCitationUrl } from '../utils/content-filter';
import { ensureEmailVerifiedForAi } from './email-verification-guard.service';
import { enforceAiText } from '../eval/financial-safety/enforce';

export interface StockQAResponse {
  ticker: string;
  question: string;
  answer: string;
  citations: string[];
  answeredAt: string;
}

// Cache QA answers for 15 minutes — keyed by normalized(ticker + question)
const qaCache = new NodeCache({ stdTTL: 900 });

/** Normalize question for cache key: lowercase, trim, collapse whitespace, strip trailing punctuation */
function normalizeQuestion(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[?.!]+$/, '');
}

const SYSTEM_PROMPT = `You are a stock research assistant. Answer the user's question about the given stock ticker.
Be specific, data-driven, and concise. Use 2-4 paragraphs. Include relevant numbers (market cap, P/E, revenue growth, etc.) where helpful.
If the question asks for a comparison, provide a balanced analysis of both sides.
If you don't know something, say so rather than guessing.
Always cite your sources when making factual claims.
Return plain text (markdown formatting allowed). Do NOT return JSON.`;

export async function askStockQuestion(
  ticker: string,
  question: string,
  userId: string
): Promise<StockQAResponse> {
  await ensureEmailVerifiedForAi(userId);
  const upperTicker = ticker.toUpperCase();

  // Strong cache key: ticker + normalized question (not user-specific since answers are stock-specific, not portfolio-aware)
  const cacheKey = `qa:${upperTicker}:${normalizeQuestion(question)}`;
  const cached = qaCache.get<StockQAResponse>(cacheKey);
  if (cached) return cached;

  try {
    const resp = await callAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Stock: ${upperTicker}\n\nQuestion: ${question}` },
    ], { timeout: 30000, feature: 'stock-qa', userId, ticker: upperTicker });

    // Treat a null OR whitespace-only generation as "no answer" (don't cache an
    // empty string under the shared key).
    const cleaned = resp?.content ? sanitizeContent(resp.content.trim()) : '';
    if (!cleaned) {
      return {
        ticker: upperTicker,
        question,
        answer: 'Unable to get an answer at this time. Please try again.',
        citations: [],
        answeredAt: new Date().toISOString(),
      };
    }

    // Deterministic safety backstop: the system prompt has no advice guard, so
    // scan the generation and fail closed (serve an educational fallback) if it
    // contains a guarantee, buy/sell imperative, leverage, all-in coaching, a
    // model-asserted price target, or personalized directive advice. Q&A is the
    // free-form "should I buy X?" surface, so it uses the stricter 'high' gate.
    const { text: answer, blocked } = enforceAiText(cleaned, {
      feature: 'stock-qa',
      gate: 'high',
      fallback:
        `I can't give a direct recommendation on ${upperTicker}. I can share general, educational information — ` +
        `its fundamentals, business, recent news, or risks. This is not financial advice; consider your own situation ` +
        `and a qualified advisor before making any decision.`,
    });

    const result: StockQAResponse = {
      ticker: upperTicker,
      question,
      answer,
      // Drop citations on a block — they were sources for the withheld answer.
      citations: blocked ? [] : (resp?.citations || []).filter(validateCitationUrl),
      answeredAt: new Date().toISOString(),
    };

    // Cache only clean answers — never persist a blocked fallback under the
    // shared key (a later request may regenerate a serviceable answer).
    if (!blocked) qaCache.set(cacheKey, result);
    return result;
  } catch (_error) {
    console.error(`[Perplexity Q&A] Error for ${upperTicker}`, _error instanceof Error ? _error.message : String(_error));
    return {
      ticker: upperTicker,
      question,
      answer: 'Unable to get an answer at this time. Please try again.',
      citations: [],
      answeredAt: new Date().toISOString(),
    };
  }
}
