import NodeCache from 'node-cache';
import { callAI } from '../utils/ai-provider';
import { parsePerplexityJson } from '../utils/perplexity';
import { sanitizeContent, validateCitationUrl } from '../utils/content-filter';
import { getPortfolio } from './portfolio.service';
import { ensureEmailVerifiedForAi } from './email-verification-guard.service';
import { getHoldingPeriodReturns } from './period-returns.service';

// Cache briefings for 2 hours (7200s) -- weekly analysis doesn't need 30-min refresh
const briefingCache = new NodeCache({ stdTTL: 7200 });
export const VALID_BRIEFING_PERIODS = ['daily', 'weekly', 'monthly', 'ytd', '1y'] as const;
export type BriefingPeriod = typeof VALID_BRIEFING_PERIODS[number];

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
  holdingReturns?: Record<string, number>;
  cached: boolean;
}

function getSystemPrompt(period: BriefingPeriod): string {
  return `You are a Wall Street-caliber portfolio analyst writing a ${period} briefing for a sophisticated retail investor. This is a premium product — the analysis must feel worth paying for.

Return ONLY valid JSON:
{
  "verdict": "Bold, specific assessment of what happened and what it means — not generic filler",
  "headline": "One punchy sentence with a specific number that captures the day's story",
  "sections": [
    { "title": "Clear, specific headline", "takeaway": "The one thing the investor must know", "body": "3-4 sentences of real analysis with specific data points", "sentiment": "positive|neutral|negative" }
  ]
}

QUALITY STANDARDS — every section must meet ALL of these:
- Write 5-7 sections minimum
- Each section body: 3-4 substantive sentences with SPECIFIC numbers, dates, and company names
- Name specific catalysts: earnings dates, Fed meetings, economic data releases, geopolitical events
- Explain the WHY behind every move — "ASML rose 4% because..." not just "ASML rose 4%"
- Connect macro trends to specific portfolio holdings — "The 10Y yield dropping to X% benefits your GOOGL position because..."
- Include at least one forward-looking insight per section — what to watch this week
- Reference specific news events from TODAY — analyst upgrades/downgrades, CEO comments, regulatory actions
- Compare performance to benchmarks — "Your portfolio outperformed SPY by X basis points because..."
- Mention sector rotation, money flow patterns, or institutional positioning when relevant

WHAT MAKES A BAD BRIEFING (avoid these):
- Generic statements like "markets were mixed" or "your portfolio performed well"
- Restating numbers the user already sees on their dashboard
- Vague analysis without specific causes or events
- Sections shorter than 2 sentences
- Missing the biggest story of the day

TONE: Confident, direct, opinionated. Like a morning note from Goldman Sachs, not a Wikipedia summary.

RULES:
- Never include exact share counts
- Round dollar values to nearest whole dollar
- Never recommend buying or selling
- Use the EXACT portfolio total value from the user message — never estimate
- Prefer "because" over "while"`;
}

function normalizeBriefingPeriod(period?: string): BriefingPeriod {
  return VALID_BRIEFING_PERIODS.includes(period as BriefingPeriod) ? period as BriefingPeriod : 'daily';
}

function getPeriodConfig(period: BriefingPeriod): {
  prompt: string;
  headline: string;
  emptyHeadline: string;
  timeframeLabel: string;
  moversTitle: string;
  useDayChange: boolean;
  returnsPeriod?: 'weekly' | 'monthly' | 'ytd' | '1y';
  returnsLabel: string;
  analysisHint: string;
} {
  switch (period) {
    case 'weekly':
      return {
        prompt: "Write a weekly portfolio briefing about this week's trends",
        headline: 'Your portfolio this week',
        emptyHeadline: 'Add holdings to your portfolio to receive a weekly briefing.',
        timeframeLabel: 'this week',
        moversTitle: 'Top movers',
        useDayChange: false,
        returnsPeriod: 'weekly',
        returnsLabel: '7-day return',
        analysisHint: "Use the provided 7-day return for each holding and frame the analysis around this week's broader trends.",
      };
    case 'monthly':
      return {
        prompt: 'Write a monthly portfolio briefing reviewing the past month',
        headline: 'Your portfolio this month',
        emptyHeadline: 'Add holdings to your portfolio to receive a monthly briefing.',
        timeframeLabel: 'this month',
        moversTitle: 'Top movers',
        useDayChange: false,
        returnsPeriod: 'monthly',
        returnsLabel: '1-month return',
        analysisHint: 'Use the provided 1-month return for each holding and focus on broader trends.',
      };
    case 'ytd':
      return {
        prompt: 'Write a year-to-date portfolio briefing',
        headline: 'Your portfolio year-to-date',
        emptyHeadline: 'Add holdings to your portfolio to receive a year-to-date briefing.',
        timeframeLabel: 'year-to-date',
        moversTitle: 'Top movers',
        useDayChange: false,
        returnsPeriod: 'ytd',
        returnsLabel: 'YTD return',
        analysisHint: 'Use the provided year-to-date return for each holding and focus on broader trends.',
      };
    case '1y':
      return {
        prompt: 'Write a 1-year portfolio briefing',
        headline: 'Your portfolio over the past year',
        emptyHeadline: 'Add holdings to your portfolio to receive a 1-year briefing.',
        timeframeLabel: 'over the past year',
        moversTitle: 'Top movers',
        useDayChange: false,
        returnsPeriod: '1y',
        returnsLabel: '1-year return',
        analysisHint: 'Use the provided 1-year return for each holding and focus on broader trends.',
      };
    case 'daily':
    default:
      return {
        prompt: "Write a daily portfolio briefing about today's moves",
        headline: 'Your portfolio is',
        emptyHeadline: 'Add holdings to your portfolio to receive a daily briefing.',
        timeframeLabel: 'today',
        moversTitle: "Today's movers",
        useDayChange: true,
        returnsLabel: "today's change",
        analysisHint: "Use dayChangePercent as the main lens and focus on today's moves.",
      };
  }
}

export async function getPortfolioBriefing(
  userId: string,
  portfolioId?: string,
  period: BriefingPeriod = 'daily',
): Promise<PortfolioBriefingResponse> {
  await ensureEmailVerifiedForAi(userId);
  const normalizedPeriod = normalizeBriefingPeriod(period);
  const periodConfig = getPeriodConfig(normalizedPeriod);
  const cacheKey = `portfolio-briefing:${userId}:${portfolioId ?? 'default'}:${normalizedPeriod}`;
  const cached = briefingCache.get<PortfolioBriefingResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  let portfolio;
  try {
    portfolio = await getPortfolio(userId, { portfolioId });
  } catch (err) {
    console.error('[Perplexity Briefing] Failed to load portfolio:', err);
    return {
      generatedAt: new Date().toISOString(),
      verdict: 'Briefing temporarily unavailable.',
      headline: 'Unable to load portfolio data.',
      sections: [],
      holdingCount: 0,
      holdingReturns: {},
      cached: false,
    };
  }

  if (portfolio.holdings.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      verdict: '',
      headline: periodConfig.emptyHeadline,
      sections: [],
      holdingCount: 0,
      holdingReturns: {},
      cached: false,
    };
  }

  const tickers = portfolio.holdings.map(holding => holding.ticker);
  let holdingPeriodReturns = new Map<string, number>();
  if (periodConfig.returnsPeriod) {
    try {
      holdingPeriodReturns = await getHoldingPeriodReturns(tickers, periodConfig.returnsPeriod);
    } catch (error) {
      console.error('[Perplexity Briefing] Failed to load holding period returns:', error);
    }
  } else {
    holdingPeriodReturns = new Map(
      portfolio.holdings.map(holding => [holding.ticker, holding.dayChangePercent ?? 0]),
    );
  }
  const holdingReturns = Object.fromEntries(holdingPeriodReturns);

  const getHoldingMetric = (holding: typeof portfolio.holdings[number]) =>
    periodConfig.useDayChange
      ? (holding.dayChangePercent ?? 0)
      : (holdingPeriodReturns.get(holding.ticker) ?? 0);

  // Build holdings summary for the prompt (top 25 by value)
  const holdingsSummary = portfolio.holdings
    .sort((a, b) => b.currentValue - a.currentValue)
    .slice(0, 25)
    .map(h =>
      `${h.ticker}: ${h.shares} shares, value $${h.currentValue.toFixed(0)}, ` +
      `${periodConfig.useDayChange ? 'day change' : periodConfig.returnsLabel} ${getHoldingMetric(h) >= 0 ? '+' : ''}${getHoldingMetric(h).toFixed(1)}%, ` +
      `total P/L ${h.profitLossPercent >= 0 ? '+' : ''}${h.profitLossPercent.toFixed(1)}%`
    )
    .join('\n');

  const totalValue = portfolio.netEquity.toFixed(0);
  const userMessage =
    `PORTFOLIO TOTAL VALUE: $${totalValue} (use this exact number if referencing portfolio value)\n\n` +
    `Here is my stock portfolio (${portfolio.holdings.length} positions, ` +
    `total value $${totalValue}` +
    `${periodConfig.useDayChange
      ? `, ${periodConfig.returnsLabel} ${(portfolio.dayChangePercent ?? 0) >= 0 ? '+' : ''}${(portfolio.dayChangePercent ?? 0).toFixed(1)}%`
      : ''}):\n\n` +
    `${holdingsSummary}\n\n` +
    `${periodConfig.prompt}. Research recent news and events for these stocks. ` +
    `${periodConfig.analysisHint} ` +
    `What drove the biggest movers? Any upcoming earnings, FDA decisions, or macro events to watch?`;

  const buildFallback = (): PortfolioBriefingResponse => {
    const holdingsSorted = [...portfolio.holdings].sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0));
    const top = holdingsSorted.slice(0, 5);
    const movers = [...portfolio.holdings]
      .sort((a, b) => Math.abs(getHoldingMetric(b)) - Math.abs(getHoldingMetric(a)))
      .slice(0, 5);
    const gainers = movers.filter(h => getHoldingMetric(h) > 0);
    const losers = movers.filter(h => getHoldingMetric(h) < 0);

    const pctChange = periodConfig.useDayChange
      ? (portfolio.dayChangePercent ?? 0)
      : movers.length > 0
        ? movers.reduce((sum, holding) => sum + getHoldingMetric(holding), 0) / movers.length
        : 0;
    const periodDir = pctChange >= 0 ? 'up' : 'down';
    const periodAbs = Math.abs(pctChange).toFixed(1);
    const equity = portfolio.netEquity || 1; // prevent division by zero

    const sections: BriefingSection[] = [];

    sections.push({
      title: 'Portfolio overview',
      takeaway: `Your portfolio is ${periodDir} ${periodAbs}% ${periodConfig.timeframeLabel} across ${portfolio.holdings.length} positions.`,
      body: `Your largest holdings are ${top.slice(0, 3).map(h => h.ticker).join(', ')}, which make up the core of your portfolio. ` +
        `Total portfolio value is $${Math.round(equity).toLocaleString()}.`,
      sentiment: pctChange >= 0.5 ? 'positive' : pctChange <= -0.5 ? 'negative' : 'neutral',
    });

    if (losers.length > 0 || gainers.length > 0) {
      const moverNames = movers.slice(0, 3).map(h =>
        `${h.ticker} (${getHoldingMetric(h) >= 0 ? '+' : ''}${getHoldingMetric(h).toFixed(1)}%)`
      ).join(', ');
      sections.push({
        title: periodConfig.moversTitle,
        takeaway: `The biggest moves came from ${movers.slice(0, 2).map(h => h.ticker).join(' and ')}.`,
        body: `The most active names ${periodConfig.useDayChange ? 'today' : 'in this timeframe'} were ${moverNames}. ` +
          (losers.length > gainers.length
            ? 'Selling pressure was broad-based across the portfolio.'
            : gainers.length > losers.length
              ? `Buyers stepped in on several positions ${periodConfig.useDayChange ? 'today' : 'across the broader period'}.`
              : 'The portfolio saw mixed action with gains and losses roughly balanced.'),
        sentiment: gainers.length > losers.length ? 'positive' : losers.length > gainers.length ? 'negative' : 'neutral',
      });
    }

    if (top.length > 0) {
      const topPct = (((top[0].currentValue ?? 0) / equity) * 100).toFixed(0);
      const top3Pct = ((top.slice(0, 3).reduce((s, h) => s + (h.currentValue ?? 0), 0) / equity) * 100).toFixed(0);
      sections.push({
        title: 'Concentration check',
        takeaway: `Your top 3 positions represent ${top3Pct}% of the portfolio.`,
        body: `${top[0].ticker} is your largest position at ${topPct}% of portfolio value. ` +
          `The top 3 holdings (${top.slice(0, 3).map(h => h.ticker).join(', ')}) account for ${top3Pct}% of your total exposure.`,
        sentiment: Number(top3Pct) > 50 ? 'negative' : 'neutral',
      });
    }

    const bestPerformer = [...portfolio.holdings].sort((a, b) => getHoldingMetric(b) - getHoldingMetric(a))[0];
    const worstPerformer = [...portfolio.holdings].sort((a, b) => getHoldingMetric(a) - getHoldingMetric(b))[0];
    if (bestPerformer && worstPerformer && bestPerformer.ticker !== worstPerformer.ticker) {
      const bestPct = getHoldingMetric(bestPerformer);
      const worstPct = getHoldingMetric(worstPerformer);
      sections.push({
        title: 'Best & worst performers',
        takeaway: `${bestPerformer.ticker} leads your winners while ${worstPerformer.ticker} is lagging.`,
        body: `${bestPerformer.ticker} is your best performer at ${bestPct >= 0 ? '+' : ''}${bestPct.toFixed(1)}% ${periodConfig.useDayChange ? 'today' : 'in this period'}. ` +
          `On the other side, ${worstPerformer.ticker} is your weakest position at ${worstPct >= 0 ? '+' : ''}${worstPct.toFixed(1)}%.`,
        sentiment: 'neutral',
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      verdict: '',
      headline: normalizedPeriod === 'daily'
        ? `Your portfolio is ${periodDir} ${periodAbs}% today at $${Math.round(equity).toLocaleString()}.`
        : `${periodConfig.headline} at $${Math.round(equity).toLocaleString()}.`,
      sections,
      holdingCount: portfolio.holdings.length,
      holdingReturns,
      cached: false,
    };
  };

  try {
    const resp = await callAI([
      { role: 'system', content: getSystemPrompt(normalizedPeriod) },
      { role: 'user', content: userMessage },
    ], { timeout: 30000, feature: 'portfolio-briefing', userId, useSearch: true });

    if (!resp || !resp.content) {
      console.warn(`[Perplexity Briefing] AI returned null/empty — resp=${!!resp} content=${!!resp?.content}`);
      return buildFallback();
    }
    console.log(`[Perplexity Briefing] AI response length=${resp.content.length} preview=${resp.content.slice(0, 100)}`);

    const parsedResult = parsePerplexityJson<unknown>(resp.content);
    if (!parsedResult.ok) {
      console.warn(`[Perplexity Briefing] parse_failed reason=${parsedResult.reason} extractedLen=${parsedResult.extracted.length}`);
      return buildFallback();
    }
    const parsed = parsedResult.data as any;

    const result: PortfolioBriefingResponse = {
      generatedAt: new Date().toISOString(),
      verdict: sanitizeContent(String(parsed.verdict || '').slice(0, 200)),
      headline: sanitizeContent(String(parsed.headline || '').slice(0, 200)),
      sections: (Array.isArray(parsed.sections) ? parsed.sections : []).map((s: any) => ({
        title: sanitizeContent(String(s.title || '').trim().slice(0, 100)),
        takeaway: sanitizeContent(String(s.takeaway || s.summary || '').trim().slice(0, 200)),
        body: sanitizeContent(String(s.body || s.content || s.text || s.description || '').trim().slice(0, 1000)),
        sentiment: ['positive', 'neutral', 'negative'].includes(s.sentiment) ? s.sentiment : 'neutral',
      })).filter((s: BriefingSection) => s.title.length > 0 && s.body.length > 0),
      holdingCount: portfolio.holdings.length,
      holdingReturns,
      cached: false,
    };

    if (result.sections.length > 0) {
      briefingCache.set(cacheKey, result);
      console.log(`[Perplexity Briefing] Generated ${result.sections.length} sections for ${portfolio.holdings.length} holdings`);
      return result;
    }

    // AI returned valid JSON but with wrong structure (no usable sections) — use fallback
    console.warn(`[Perplexity Briefing] AI response parsed but produced 0 sections — using fallback`);
    return buildFallback();
  } catch (_error) {
    const msg = _error instanceof Error ? _error.message : String(_error);
    console.error(`[Perplexity Briefing] Error: ${msg}`);
    return buildFallback();
  }
}

// --- Briefing Section Deep Dive ---

const explainCache = new NodeCache({ stdTTL: 3600 }); // 1hr cache

export interface BriefingExplainResponse {
  explanation: string;
  citations: string[];
  cached: boolean;
}

const EXPLAIN_SYSTEM_PROMPT = `You are a senior financial analyst explaining context to a retail investor -- like a knowledgeable colleague in Slack, not a research report.

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

export async function explainBriefingSection(title: string, body: string, userId: string): Promise<BriefingExplainResponse> {
  await ensureEmailVerifiedForAi(userId);
  // Include userId in cache key to prevent cross-user data leakage
  const cacheKey = `briefing-explain-${userId}-${title.toLowerCase().replace(/\s+/g, '-').slice(0, 50)}`;
  const cached = explainCache.get<BriefingExplainResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  const resp = await callAI([
    { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
    { role: 'user', content: `Briefing section: "${title}"\n\nSummary: ${body}\n\nPlease provide the full detailed context and explanation.` },
  ], { timeout: 30000, feature: 'briefing-explain', userId });

  if (!resp || !resp.content) {
    return { explanation: 'Unable to load detailed explanation at this time.', citations: [], cached: false };
  }

  const result: BriefingExplainResponse = {
    explanation: sanitizeContent(resp.content.trim()),
    citations: (resp.citations || []).filter(validateCitationUrl),
    cached: false,
  };

  if (result.explanation.length > 0) {
    explainCache.set(cacheKey, result);
  }
  console.log(`[Perplexity Briefing Explain] Generated explanation for "${title}"`);
  return result;
}
