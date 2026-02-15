import NodeCache from 'node-cache';
import { callPerplexity, extractJson } from '../utils/perplexity';
import { getPortfolio } from './portfolio.service';
import { fetchMarketNews } from './news.service';
import { getEconomicDashboard } from './economic.service';
import { getEarningsSummary } from './earnings-summary.service';

// Cache daily reports for 4 hours
const reportCache = new NodeCache({ stdTTL: 14400 });
const DAILY_REPORT_CACHE_KEY = 'daily-report';

// Non-ticker acronyms that Perplexity sometimes returns as "relatedTickers"
const TICKER_BLACKLIST = new Set([
  'YTD', 'QTD', 'MTD', 'ATH', 'ATL', 'EPS', 'ROE', 'ROA', 'ROI', 'NAV', 'AUM',
  'DCF', 'FCF', 'EBIT', 'WACC', 'CAGR', 'GAAP', 'IFRS',
  'CPI', 'GDP', 'PCE', 'PPI', 'PMI', 'ISM', 'FOMC', 'FED', 'SEC', 'IPO', 'ETF',
  'NYSE', 'YOY', 'QOQ', 'MOM', 'BPS', 'CEO', 'CFO', 'COO', 'CTO',
  'SK', 'AI', 'EV', 'IV', 'PE', 'PB', 'PS',
]);

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
  const cached = reportCache.get<DailyReportResponse>(DAILY_REPORT_CACHE_KEY);
  if (cached) return { ...cached, cached: true };

  // Gather data in parallel
  const [portfolioResult, newsResult, economicResult, earningsResult] = await Promise.allSettled([
    getPortfolio(),
    fetchMarketNews(10),
    getEconomicDashboard(),
    getEarningsSummary(),
  ]);

  const portfolio = portfolioResult.status === 'fulfilled' ? portfolioResult.value : null;
  const news = newsResult.status === 'fulfilled' ? newsResult.value : [];
  const economic = economicResult.status === 'fulfilled' ? economicResult.value : null;
  const earnings = earningsResult.status === 'fulfilled' ? earningsResult.value : { results: [], partial: true };

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

  // Build upcoming earnings (next 7 days)
  const upcomingEarnings = earnings.results
    .filter(e => e.daysUntil >= 0 && e.daysUntil <= 7)
    .slice(0, 8)
    .map(e => {
      const date = new Date(e.reportDate);
      const dow = date.toLocaleDateString('en-US', { weekday: 'short' });
      return `${e.ticker} (${dow})`;
    });
  const earningsSummaryLine = upcomingEarnings.length > 0
    ? `UPCOMING EARNINGS THIS WEEK: ${upcomingEarnings.join(', ')}`
    : 'UPCOMING EARNINGS THIS WEEK: None';

  const userMessage =
    `Today is ${formattedDate}. Generate my daily portfolio briefing.\n\n` +
    `MY PORTFOLIO (${portfolio.holdings.length} holdings, total value $${portfolio.netEquity.toFixed(0)}):\n` +
    `${holdingsSummary}\n` +
    `Yesterday's change: $${portfolio.dayChange.toFixed(0)} (${portfolio.dayChangePercent >= 0 ? '+' : ''}${portfolio.dayChangePercent.toFixed(1)}%)\n\n` +
    `MARKET HEADLINES:\n${newsSummary}\n\n` +
    `ECONOMIC SNAPSHOT:\n${economicSummary}\n\n` +
    `${earningsSummaryLine}\n\n` +
    `Give me 3-5 top stories relevant to my portfolio and the broader market.\n` +
    `Give me 2-3 things to watch today.`;

  const buildFallback = (): DailyReportResponse => {
    const dayChange = portfolio.dayChangePercent ?? 0;
    const watchToday = upcomingEarnings.length > 0 ? [upcomingEarnings.join(', ')] : [];
    return {
      generatedAt: new Date().toISOString(),
      greeting: 'Good morning!',
      marketOverview: 'Daily report generated in basic mode.',
      portfolioSummary: `Your portfolio is ${dayChange >= 0 ? 'up' : 'down'} ${Math.abs(dayChange).toFixed(2)}% today.`,
      topStories: [],
      watchToday,
      cached: false,
    };
  };

  try {
    const startTime = Date.now();
    const resp = await callPerplexity([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ], { timeout: 60000 });

    if (!resp || !resp.content) {
      return buildFallback();
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
          ? s.relatedTickers.filter((t: any) => typeof t === 'string' && t.length >= 1 && !TICKER_BLACKLIST.has(t.toUpperCase()))
          : [],
      })),
      watchToday: (parsed.watchToday || []).slice(0, 4).map((w: any) => String(w || '').slice(0, 300)),
      cached: false,
    };

    if (result.topStories.length > 0) {
      reportCache.set(DAILY_REPORT_CACHE_KEY, result);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Perplexity Daily Report] Generated ${result.topStories.length} stories, ${result.watchToday.length} watch items in ${elapsed}ms`);
    return result;
  } catch (error: any) {
    console.error('[Perplexity Daily Report] Error:', error.message);
    return buildFallback();
  }
}

export async function regenerateDailyReport(): Promise<DailyReportResponse> {
  reportCache.del(DAILY_REPORT_CACHE_KEY);
  return getDailyReport();
}
