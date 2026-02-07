import NodeCache from 'node-cache';
import { callPerplexity, extractJson } from '../utils/perplexity';
import { getPortfolio } from './portfolio.service';
import { fetchMarketNews } from './news.service';
import { getEconomicDashboard } from './economic.service';

// Cache daily reports for 4 hours
const reportCache = new NodeCache({ stdTTL: 14400 });

export interface DailyReportResponse {
  generatedAt: string;
  greeting: string;
  marketOverview: string;
  portfolioSummary: string;
  topStories: {
    headline: string;
    body: string;
    sentiment: 'positive' | 'negative' | 'neutral';
    relatedTickers: string[];
  }[];
  watchToday: string[];
  cached: boolean;
}

const SYSTEM_PROMPT = `You are a portfolio analyst writing a concise daily morning briefing. Return valid JSON only with this exact structure:
{
  "greeting": "short friendly 1-sentence greeting referencing the day and market mood",
  "marketOverview": "2-3 sentence summary of today's macro environment — indices, rates, key headlines",
  "portfolioSummary": "2-3 sentence summary of the user's portfolio — value, daily change, notable movers",
  "topStories": [
    { "headline": "short headline max 80 chars", "body": "1-2 sentence explanation of why this matters to the portfolio", "sentiment": "positive or negative or neutral", "relatedTickers": ["AAPL"] }
  ],
  "watchToday": ["1-2 sentence actionable item to watch today"]
}
Return 3-5 top stories and 2-3 watch items. Focus on what's actionable and relevant to the user's holdings.`;

export async function getDailyReport(): Promise<DailyReportResponse> {
  const cacheKey = 'daily-report';
  const cached = reportCache.get<DailyReportResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  // Gather data in parallel
  const [portfolioResult, newsResult, economicResult] = await Promise.allSettled([
    getPortfolio(),
    fetchMarketNews(10),
    getEconomicDashboard(),
  ]);

  const portfolio = portfolioResult.status === 'fulfilled' ? portfolioResult.value : null;
  const news = newsResult.status === 'fulfilled' ? newsResult.value : [];
  const economic = economicResult.status === 'fulfilled' ? economicResult.value : null;

  if (!portfolio || portfolio.holdings.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      greeting: 'Good morning!',
      marketOverview: 'Add holdings to your portfolio to receive a daily briefing.',
      portfolioSummary: '',
      topStories: [],
      watchToday: [],
      cached: false,
    };
  }

  // Format date like "Thursday, February 6, 2026"
  const now = new Date();
  const formattedDate = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Build holdings summary (top 25 by value)
  const sortedHoldings = portfolio.holdings
    .sort((a, b) => b.currentValue - a.currentValue)
    .slice(0, 25);

  const holdingsSummary = sortedHoldings
    .map(h =>
      `${h.ticker}: ${h.shares} shares, $${h.currentValue.toFixed(0)}, ` +
      `day ${h.dayChangePercent >= 0 ? '+' : ''}${h.dayChangePercent.toFixed(1)}%, ` +
      `total P/L ${h.profitLossPercent >= 0 ? '+' : ''}${h.profitLossPercent.toFixed(1)}%`
    )
    .join('\n');

  // Build news summary
  const newsSummary = news
    .map(n => `- ${n.headline} (${n.source}): ${n.summary}`)
    .join('\n');

  // Build economic snapshot
  let economicSummary = '';
  if (economic) {
    const indicators = economic.indicators;
    const parts: string[] = [];
    if (indicators.cpi?.latestValue != null) {
      parts.push(`Consumer Price Index: ${indicators.cpi.latestValue}${indicators.cpi.unit} (prev: ${indicators.cpi.previousValue})`);
    }
    if (indicators.fedFundsRate?.latestValue != null) {
      parts.push(`Federal Funds Rate: ${indicators.fedFundsRate.latestValue}${indicators.fedFundsRate.unit} (prev: ${indicators.fedFundsRate.previousValue})`);
    }
    if (indicators.treasuryYield10Y?.latestValue != null) {
      parts.push(`10-Year Treasury Yield: ${indicators.treasuryYield10Y.latestValue}${indicators.treasuryYield10Y.unit} (prev: ${indicators.treasuryYield10Y.previousValue})`);
    }
    if (indicators.unemployment?.latestValue != null) {
      parts.push(`Unemployment Rate: ${indicators.unemployment.latestValue}${indicators.unemployment.unit} (prev: ${indicators.unemployment.previousValue})`);
    }
    if (indicators.gdp?.latestValue != null) {
      parts.push(`Real GDP: ${indicators.gdp.latestValue}${indicators.gdp.unit} (prev: ${indicators.gdp.previousValue})`);
    }
    economicSummary = parts.join('\n');
  }

  const userMessage =
    `Today is ${formattedDate}. Generate my daily portfolio briefing.\n\n` +
    `MY PORTFOLIO (${portfolio.holdings.length} holdings, total value $${portfolio.holdingsValue.toFixed(0)}):\n` +
    `${holdingsSummary}\n` +
    `Yesterday's change: $${portfolio.dayChange.toFixed(0)} (${portfolio.dayChangePercent >= 0 ? '+' : ''}${portfolio.dayChangePercent.toFixed(1)}%)\n\n` +
    `MARKET HEADLINES:\n${newsSummary}\n\n` +
    `ECONOMIC SNAPSHOT:\n${economicSummary}\n\n` +
    `Give me 3-5 top stories relevant to my portfolio and the broader market.\n` +
    `Give me 2-3 things to watch today.`;

  try {
    const startTime = Date.now();
    const resp = await callPerplexity([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ], { timeout: 60000 });

    if (!resp || !resp.content) {
      return {
        generatedAt: new Date().toISOString(),
        greeting: 'Good morning!',
        marketOverview: 'Unable to generate market overview at this time.',
        portfolioSummary: 'Unable to generate portfolio summary at this time.',
        topStories: [],
        watchToday: [],
        cached: false,
      };
    }

    const jsonStr = extractJson(resp.content);
    const parsed = JSON.parse(jsonStr);

    const result: DailyReportResponse = {
      generatedAt: new Date().toISOString(),
      greeting: String(parsed.greeting || '').slice(0, 200),
      marketOverview: String(parsed.marketOverview || '').slice(0, 500),
      portfolioSummary: String(parsed.portfolioSummary || '').slice(0, 500),
      topStories: (parsed.topStories || []).slice(0, 5).map((s: any) => ({
        headline: String(s.headline || '').slice(0, 100),
        body: String(s.body || '').slice(0, 300),
        sentiment: ['positive', 'negative', 'neutral'].includes(s.sentiment) ? s.sentiment : 'neutral',
        relatedTickers: Array.isArray(s.relatedTickers)
          ? s.relatedTickers.filter((t: any) => typeof t === 'string')
          : [],
      })),
      watchToday: (parsed.watchToday || []).slice(0, 4).map((w: any) => String(w || '').slice(0, 300)),
      cached: false,
    };

    if (result.topStories.length > 0) {
      reportCache.set(cacheKey, result);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Perplexity Daily Report] Generated ${result.topStories.length} stories, ${result.watchToday.length} watch items in ${elapsed}ms`);
    return result;
  } catch (error: any) {
    console.error('[Perplexity Daily Report] Error:', error.message);
    return {
      generatedAt: new Date().toISOString(),
      greeting: 'Good morning!',
      marketOverview: 'Daily report temporarily unavailable.',
      portfolioSummary: '',
      topStories: [],
      watchToday: [],
      cached: false,
    };
  }
}
