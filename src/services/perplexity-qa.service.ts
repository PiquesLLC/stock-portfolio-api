import { callPerplexity } from '../utils/perplexity';
import { ensureEmailVerifiedForAi } from './email-verification-guard.service';

export interface StockQAResponse {
  ticker: string;
  question: string;
  answer: string;
  citations: string[];
  answeredAt: string;
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

  try {
    const resp = await callPerplexity([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Stock: ${upperTicker}\n\nQuestion: ${question}` },
    ], { timeout: 30000 });

    if (!resp || !resp.content) {
      return {
        ticker: upperTicker,
        question,
        answer: 'Unable to get an answer at this time. Please try again.',
        citations: [],
        answeredAt: new Date().toISOString(),
      };
    }

    return {
      ticker: upperTicker,
      question,
      answer: resp.content.trim(),
      citations: resp.citations,
      answeredAt: new Date().toISOString(),
    };
  } catch (_error) {
    console.error(`[Perplexity Q&A] Error for ${upperTicker}`);
    return {
      ticker: upperTicker,
      question,
      answer: 'Unable to get an answer at this time. Please try again.',
      citations: [],
      answeredAt: new Date().toISOString(),
    };
  }
}
