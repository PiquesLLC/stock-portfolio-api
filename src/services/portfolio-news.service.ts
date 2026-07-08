import NodeCache from 'node-cache';
import { fetchTickerNews, fetchMarketNews, MarketNewsItem } from './news.service';
import prisma from '../utils/prisma';
import { callAI } from '../utils/ai-provider';
import { sanitizeContent, validateCitationUrl } from '../utils/content-filter';

export interface PortfolioNewsItem extends MarketNewsItem {
  matchedTickers: string[];
  portfolioRelevance: number; // 0-100 based on matched holdings weight
}

export interface MacroSummary {
  overview: string;        // 2-3 sentence market overview
  portfolioImpact: string; // How it specifically affects this portfolio
  outlook: string;         // Forward-looking 1-2 sentences
  keyThemes: string[];     // 3-5 short theme labels
  sentiment: 'bullish' | 'bearish' | 'neutral' | 'mixed';
  citations: string[];
  generatedAt: string;
  cached: boolean;
}

export interface PortfolioNewsResponse {
  items: PortfolioNewsItem[];
  summary?: MacroSummary;
  holdingCount: number;
  tickersFetched: string[];
  generatedAt: string;
}

const portfolioNewsCache = new NodeCache({ stdTTL: 180 }); // 3 min

export async function fetchPortfolioNews(userId: string, limit = 30, portfolioId?: string): Promise<PortfolioNewsResponse> {
  const cacheKey = `portfolio-news-${userId}-${portfolioId || 'default'}`;
  const cached = portfolioNewsCache.get<PortfolioNewsResponse>(cacheKey);
  if (cached) return { ...cached, items: cached.items.slice(0, limit) };

  // Get user's holdings
  const portfolio = await prisma.portfolio.findFirst({
    where: portfolioId ? { id: portfolioId, userId } : { userId, isDefault: true },
    include: { holdings: { where: { shares: { gt: 0 } }, select: { ticker: true, shares: true, averageCost: true } } },
  });

  if (!portfolio || portfolio.holdings.length === 0) {
    return { items: [], holdingCount: 0, tickersFetched: [], generatedAt: new Date().toISOString() };
  }

  // Use shares * averageCost as proxy for position size (avoids extra quote API calls)
  const holdings = portfolio.holdings
    .map(h => ({ ticker: h.ticker, estimatedValue: h.shares * h.averageCost }))
    .sort((a, b) => b.estimatedValue - a.estimatedValue);
  const totalValue = holdings.reduce((sum, h) => sum + h.estimatedValue, 0);

  // Build weight map for ALL holdings (used for relevance scoring)
  const weightMap = new Map<string, number>();
  for (const h of holdings) {
    weightMap.set(h.ticker, totalValue > 0 ? (h.estimatedValue / totalValue) * 100 : 0);
  }
  const allTickers = new Set(holdings.map(h => h.ticker));

  // Fetch news for top 10 tickers + market news concurrently
  const tickersToFetch = holdings.slice(0, 10).map(h => h.ticker);
  // Market news failure must not poison the batch — ticker news that already
  // succeeded should still render (one Finnhub 429 here used to 500 the endpoint).
  const [tickerResults, marketNews] = await Promise.all([
    Promise.allSettled(tickersToFetch.map(t => fetchTickerNews(t, 15))),
    fetchMarketNews(30).catch(() => [] as MarketNewsItem[]),
  ]);

  // Flatten all news items
  const allNews: MarketNewsItem[] = [];
  for (const result of tickerResults) {
    if (result.status === 'fulfilled') allNews.push(...result.value);
  }
  allNews.push(...marketNews);

  // Deduplicate by id
  const seen = new Set<number>();
  const unique: MarketNewsItem[] = [];
  for (const item of allNews) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      unique.push(item);
    }
  }

  // Tag each article with matched portfolio tickers and compute relevance
  const tagged: PortfolioNewsItem[] = unique.map(item => {
    const relatedTickers = (item.related || '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    const matchedTickers = relatedTickers.filter(t => allTickers.has(t));

    // Also check headline/summary for ticker mentions
    for (const ticker of allTickers) {
      if (!matchedTickers.includes(ticker)) {
        const pattern = new RegExp(`\\b${ticker}\\b`, 'i');
        if (pattern.test(item.headline) || pattern.test(item.summary)) {
          matchedTickers.push(ticker);
        }
      }
    }

    // Relevance = sum of matched tickers' portfolio weights
    const portfolioRelevance = matchedTickers.reduce((sum, t) => sum + (weightMap.get(t) ?? 0), 0);

    return {
      ...item,
      headline: sanitizeContent(item.headline),
      summary: sanitizeContent(item.summary),
      matchedTickers,
      portfolioRelevance,
    };
  });

  // Filter to only items relevant to portfolio (at least one matched ticker)
  const relevant = tagged.filter(item =>
    item.matchedTickers.length > 0 || item.portfolioRelevance > 0
  );

  // Sort by relevance desc, then datetime desc
  relevant.sort((a, b) => {
    if (b.portfolioRelevance !== a.portfolioRelevance) return b.portfolioRelevance - a.portfolioRelevance;
    return b.datetime - a.datetime;
  });

  const response: PortfolioNewsResponse = {
    items: relevant.slice(0, 50), // cache up to 50
    holdingCount: holdings.length,
    tickersFetched: tickersToFetch,
    generatedAt: new Date().toISOString(),
  };

  portfolioNewsCache.set(cacheKey, response);
  return { ...response, items: response.items.slice(0, limit) };
}

// ── AI Macro Summary ──────────────────────────────────────────

const summaryCache = new NodeCache({ stdTTL: 1800 }); // 30 min

export async function generateMacroSummary(userId: string, portfolioId?: string): Promise<MacroSummary | null> {
  const cacheKey = `macro-summary-${userId}-${portfolioId || 'default'}`;
  const cached = summaryCache.get<MacroSummary>(cacheKey);
  if (cached) return { ...cached, cached: true };

  // Get news + holdings context
  const newsData = await fetchPortfolioNews(userId, 20, portfolioId);
  if (newsData.items.length === 0) return null;

  // Build holdings context
  const portfolio = await prisma.portfolio.findFirst({
    where: portfolioId ? { id: portfolioId, userId } : { userId, isDefault: true },
    include: { holdings: { where: { shares: { gt: 0 } }, select: { ticker: true, shares: true, averageCost: true } } },
  });
  if (!portfolio) return null;

  const sortedHoldings = portfolio.holdings
    .map(h => ({ ticker: h.ticker, costBasis: h.shares * h.averageCost }))
    .sort((a, b) => b.costBasis - a.costBasis)
    .slice(0, 15);
  const holdingTickers = sortedHoldings.map(h => h.ticker).join(', ');
  const topThree = sortedHoldings.slice(0, 3).map(h => h.ticker).join(', ');

  // Build news headlines for AI context
  const headlines = newsData.items
    .slice(0, 15)
    .map(item => `- ${item.headline} (${item.source}, ${item.matchedTickers.join('/')})`)
    .join('\n');

  const systemPrompt = `You are a sharp portfolio analyst writing a personal market brief. JSON only. No markdown fences.`;

  const userPrompt = `Portfolio tickers: ${holdingTickers}
Top 3 positions: ${topThree}

Today's relevant news:
${headlines}

Write a personalized market brief for this investor. Return JSON:
{
  "overview": "2-3 sentences. Lead with their biggest holdings by name. What is happening in the market RIGHT NOW that matters for THEIR specific positions? Not generic market commentary — tie every sentence to their tickers.",
  "portfolioImpact": "2-3 sentences. Name specific tickers being affected and explain WHY (earnings, sector rotation, macro headwinds, analyst action, etc). Use plain language.",
  "outlook": "1-2 sentences. What should this investor watch next? Name the tickers or events that matter most for their portfolio in the coming days.",
  "keyThemes": ["theme1", "theme2", "theme3"],
  "sentiment": "bullish" | "bearish" | "neutral" | "mixed"
}

Critical rules:
- EVERY paragraph must name specific tickers from their portfolio — no generic "your holdings" or "broad market" without naming names
- Lead the overview with their top holdings (${topThree}), not with "the market"
- portfolioImpact should feel like a friend explaining what's going on, not a research report
- keyThemes: 2-4 word labels capturing what's driving their portfolio today
- sentiment: overall outlook for THIS portfolio, not the market in general`;

  try {
    const response = await callAI(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { timeout: 15000, feature: 'macro-summary', userId },
    );

    if (!response?.content) return null;

    // Parse JSON from response (may be wrapped in markdown fences)
    let jsonStr = response.content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    const parsed = JSON.parse(jsonStr);

    const summary: MacroSummary = {
      overview: sanitizeContent(parsed.overview || ''),
      portfolioImpact: sanitizeContent(parsed.portfolioImpact || ''),
      outlook: sanitizeContent(parsed.outlook || ''),
      keyThemes: Array.isArray(parsed.keyThemes) ? parsed.keyThemes.slice(0, 5).map((t: string) => sanitizeContent(t)) : [],
      sentiment: ['bullish', 'bearish', 'neutral', 'mixed'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral',
      citations: (response.citations || []).filter(validateCitationUrl),
      generatedAt: new Date().toISOString(),
      cached: false,
    };

    summaryCache.set(cacheKey, summary);
    return summary;
  } catch (err) {
    console.error('[MacroSummary] AI call failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
