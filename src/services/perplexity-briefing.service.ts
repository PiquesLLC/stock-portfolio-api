import NodeCache from 'node-cache';
import { callPerplexity, extractJson } from '../utils/perplexity';
import { getPortfolio } from './portfolio.service';

// Cache briefings for 30 minutes
const briefingCache = new NodeCache({ stdTTL: 1800 });

export interface BriefingSection {
  title: string;
  takeaway: string;
  body: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
}

export interface PortfolioBriefingResponse {
  generatedAt: string;
  verdict: string;
  headline: string;
  sections: BriefingSection[];
  holdingCount: number;
  cached: boolean;
}

const SYSTEM_PROMPT = `You are a senior portfolio analyst explaining a weekly briefing to a retail investor in Slack — not writing a report.
Return ONLY valid JSON with this structure:
{
  "verdict": "One calm sentence framing the week's theme (e.g. 'This week was about stability, not momentum.')",
  "headline": "One sentence portfolio summary with one key number",
  "sections": [
    { "title": "Plain-English Headline", "takeaway": "One sentence the user should remember", "body": "2-3 sentences of analysis", "sentiment": "positive|neutral|negative" }
  ]
}
Rules:
- Write 3-5 sections
- 1 idea per paragraph, 2-3 sentences max
- Only include numbers when they change interpretation
- Prefer "because" over "while"
- Be specific about company names and events
- Use plain language, no jargon or parentheticals
- The title should be a clear headline — if a user reads only titles, they understand the week
- The takeaway is a single memorable sentence summarizing the section
- Focus on: what drove gains/losses and WHY, upcoming catalysts to watch
- Do NOT repeat raw numbers the user already sees — add insight and context
- Do NOT recommend buying or selling
- CRITICAL: Never invent or estimate portfolio dollar values. Use ONLY the exact total value provided in the user message. If you mention the portfolio value, use the exact number given.`;

export async function getPortfolioBriefing(): Promise<PortfolioBriefingResponse> {
  const cacheKey = 'portfolio-briefing';
  const cached = briefingCache.get<PortfolioBriefingResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  const portfolio = await getPortfolio();

  if (portfolio.holdings.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      verdict: '',
      headline: 'Add holdings to your portfolio to receive a weekly briefing.',
      sections: [],
      holdingCount: 0,
      cached: false,
    };
  }

  // Build holdings summary for the prompt (top 25 by value)
  const holdingsSummary = portfolio.holdings
    .sort((a, b) => b.currentValue - a.currentValue)
    .slice(0, 25)
    .map(h =>
      `${h.ticker}: ${h.shares} shares, value $${h.currentValue.toFixed(0)}, ` +
      `day change ${h.dayChangePercent >= 0 ? '+' : ''}${h.dayChangePercent.toFixed(1)}%, ` +
      `total P/L ${h.profitLossPercent >= 0 ? '+' : ''}${h.profitLossPercent.toFixed(1)}%`
    )
    .join('\n');

  const totalValue = portfolio.holdingsValue.toFixed(0);
  const userMessage =
    `PORTFOLIO TOTAL VALUE: $${totalValue} (use this exact number if referencing portfolio value)\n\n` +
    `Here is my stock portfolio (${portfolio.holdings.length} positions, ` +
    `total value $${totalValue}, ` +
    `today's change ${portfolio.dayChangePercent >= 0 ? '+' : ''}${portfolio.dayChangePercent.toFixed(1)}%):\n\n` +
    `${holdingsSummary}\n\n` +
    `Write a weekly portfolio briefing. Research recent news and events for these stocks. ` +
    `What drove the biggest movers? Any upcoming earnings, FDA decisions, or macro events to watch?`;

  try {
    const resp = await callPerplexity([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ], { timeout: 60000 });

    if (!resp || !resp.content) {
      return {
        generatedAt: new Date().toISOString(),
        verdict: '',
        headline: 'Unable to generate briefing at this time.',
        sections: [],
        holdingCount: portfolio.holdings.length,
        cached: false,
      };
    }

    const jsonStr = extractJson(resp.content);
    const parsed = JSON.parse(jsonStr);

    const result: PortfolioBriefingResponse = {
      generatedAt: new Date().toISOString(),
      verdict: String(parsed.verdict || '').slice(0, 200),
      headline: String(parsed.headline || '').slice(0, 200),
      sections: (parsed.sections || []).map((s: any) => ({
        title: String(s.title || '').slice(0, 100),
        takeaway: String(s.takeaway || '').slice(0, 200),
        body: String(s.body || '').slice(0, 1000),
        sentiment: ['positive', 'neutral', 'negative'].includes(s.sentiment) ? s.sentiment : 'neutral',
      })),
      holdingCount: portfolio.holdings.length,
      cached: false,
    };

    if (result.sections.length > 0) {
      briefingCache.set(cacheKey, result);
    }
    console.log(`[Perplexity Briefing] Generated ${result.sections.length} sections for ${portfolio.holdings.length} holdings`);
    return result;
  } catch (error: any) {
    console.error('[Perplexity Briefing] Error:', error.message);
    return {
      generatedAt: new Date().toISOString(),
      verdict: '',
      headline: 'Briefing temporarily unavailable.',
      sections: [],
      holdingCount: portfolio.holdings.length,
      cached: false,
    };
  }
}

// --- Briefing Section Deep Dive ---

const explainCache = new NodeCache({ stdTTL: 3600 }); // 1hr cache

export interface BriefingExplainResponse {
  explanation: string;
  citations: string[];
  cached: boolean;
}

const EXPLAIN_SYSTEM_PROMPT = `You are a senior financial analyst explaining context to a retail investor — like a knowledgeable colleague in Slack, not a research report.

The user will give you a brief summary from their portfolio briefing. Explain the full context:
- What happened and why (news, events, policy changes, earnings)
- How it affects the companies mentioned
- Any broader market implications

Writing rules (non-negotiable):
- 1 idea per paragraph
- 2-3 sentences max per paragraph
- Only include numbers when they change interpretation
- No parentheticals, no inline citations like [1] or [2]
- Prefer "because" over "while"
- Write 4-6 short paragraphs
- Be specific about dates and events
- Do NOT recommend buying or selling
- Do NOT give investment advice`;

export async function explainBriefingSection(title: string, body: string): Promise<BriefingExplainResponse> {
  const cacheKey = `briefing-explain-${title.toLowerCase().replace(/\s+/g, '-').slice(0, 50)}`;
  const cached = explainCache.get<BriefingExplainResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  const resp = await callPerplexity([
    { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
    { role: 'user', content: `Briefing section: "${title}"\n\nSummary: ${body}\n\nPlease provide the full detailed context and explanation.` },
  ], { timeout: 30000 });

  if (!resp || !resp.content) {
    return { explanation: 'Unable to load detailed explanation at this time.', citations: [], cached: false };
  }

  const result: BriefingExplainResponse = {
    explanation: resp.content,
    citations: resp.citations || [],
    cached: false,
  };

  explainCache.set(cacheKey, result);
  console.log(`[Perplexity Briefing Explain] Generated explanation for "${title}"`);
  return result;
}
