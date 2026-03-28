import NodeCache from 'node-cache';
import { callAI } from '../utils/ai-provider';
import { sanitizeContent, validateCitationUrl } from '../utils/content-filter';
import { ensureEmailVerifiedForAi } from './email-verification-guard.service';

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

    if (!resp || !resp.content) {
      return {
        ticker: upperTicker,
        question,
        answer: 'Unable to get an answer at this time. Please try again.',
        citations: [],
        answeredAt: new Date().toISOString(),
      };
    }

    const result: StockQAResponse = {
      ticker: upperTicker,
      question,
      answer: sanitizeContent(resp.content.trim()),
      citations: (resp.citations || []).filter(validateCitationUrl),
      answeredAt: new Date().toISOString(),
    };

    // Only cache successful answers
    qaCache.set(cacheKey, result);
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
