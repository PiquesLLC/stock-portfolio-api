import NodeCache from 'node-cache';
import { fetchTickerNews, fetchMarketNews, MarketNewsItem } from './news.service';
import prisma from '../utils/prisma';

export interface PortfolioNewsItem extends MarketNewsItem {
  matchedTickers: string[];
  portfolioRelevance: number; // 0-100 based on matched holdings weight
}

export interface PortfolioNewsResponse {
  items: PortfolioNewsItem[];
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
  const [tickerResults, marketNews] = await Promise.all([
    Promise.allSettled(tickersToFetch.map(t => fetchTickerNews(t, 15))),
    fetchMarketNews(30),
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

    return { ...item, matchedTickers, portfolioRelevance };
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
