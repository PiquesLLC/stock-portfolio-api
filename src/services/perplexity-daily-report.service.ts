import NodeCache from 'node-cache';
import { callPerplexity, extractJson } from '../utils/perplexity';
import { getPortfolio } from './portfolio.service';
import { fetchMarketNews } from './news.service';
import { getEconomicDashboard } from './economic.service';
import { getEarningsSummary } from './earnings-summary.service';
import { ensureEmailVerifiedForAi } from './email-verification-guard.service';

// Cache daily reports for 8 hours (28800s) — news doesn't shift fast enough to justify 4h
const reportCache = new NodeCache({ stdTTL: 28800 });

// Strip internal prompt section tags that Perplexity sometimes echoes back
const LEAKED_TAGS = /\[(?:ECONOMIC SNAPSHOT|MARKET HEADLINES|UPCOMING EARNINGS|MY PORTFOLIO)\]/gi;
function stripLeakedTags(text: string): string {
  return text.replace(LEAKED_TAGS, '').replace(/\s{2,}/g, ' ').trim();
}

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

const SYSTEM_PROMPT = `Portfolio analyst. Return valid JSON only:
{"greeting":"1 sentence","marketOverview":"2-3 sentences on macro","portfolioSummary":"2-3 sentences on portfolio","topStories":[{"headline":"max 80 chars","body":"1-2 sentences","sentiment":"positive|negative|neutral","relatedTickers":["AAPL"]}],"watchToday":["1-2 sentence item"]}
3-5 stories, 2-3 watch items. No bracketed tags. JSON only.`;

function isWeekendET(): boolean {
  const etDay = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return etDay === 'Sat' || etDay === 'Sun';
}

/** Quick fallback when deadline hits before data is even gathered */
function buildQuickFallback(weekend: boolean): DailyReportResponse {
  return {
    generatedAt: new Date().toISOString(),
    greeting: weekend ? 'Happy weekend!' : 'Good morning!',
    marketOverview: 'Markets are active. Your AI briefing is generating in the background — refresh in a moment for the full report.',
    portfolioSummary: '',
    topStories: [],
    watchToday: [],
    cached: false,
  };
}

/** Rich fallback using actual portfolio + news data */
function buildFallbackReport(
  portfolio: any,
  sortedHoldings: any[],
  news: any[],
  upcomingEarnings: string[],
  weekend: boolean,
): DailyReportResponse {
  const dayChange = portfolio.dayChangePercent ?? 0;
  const totalValue = portfolio.netEquity ?? 0;
  const dollarChange = portfolio.dayChange ?? 0;

  const fallbackStories: { headline: string; body: string; sentiment: 'positive' | 'negative' | 'neutral'; relatedTickers: string[] }[] = news.slice(0, 3).map((n: any) => ({
    headline: n.headline?.slice(0, 100) || 'Market Update',
    body: n.summary?.slice(0, 200) || '',
    sentiment: 'neutral' as const,
    relatedTickers: [] as string[],
  }));

  const movers = sortedHoldings
    .filter(h => Math.abs(h.dayChangePercent) > 1)
    .slice(0, 3);
  if (movers.length > 0) {
    fallbackStories.unshift({
      headline: `Portfolio movers: ${movers.map((m: any) => `${m.ticker} ${m.dayChangePercent >= 0 ? '+' : ''}${m.dayChangePercent.toFixed(1)}%`).join(', ')}`,
      body: `Your biggest moves today among your ${portfolio.holdings.length} holdings.`,
      sentiment: movers[0].dayChangePercent >= 0 ? 'positive' as const : 'negative' as const,
      relatedTickers: movers.map((m: any) => m.ticker),
    });
  }

  const watchToday: string[] = [];
  if (upcomingEarnings.length > 0) {
    watchToday.push(`Upcoming earnings: ${upcomingEarnings.join(', ')}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    greeting: weekend ? 'Happy weekend!' : 'Good morning!',
    marketOverview: news.length > 0
      ? `Here's what's driving markets: ${news[0]?.headline || 'Markets are active today.'}`
      : 'Markets are open. Check back shortly for AI-powered analysis.',
    portfolioSummary: `Your portfolio ($${totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}) is ${dayChange >= 0 ? 'up' : 'down'} ${Math.abs(dayChange).toFixed(2)}% ($${Math.abs(dollarChange).toFixed(0)}) today.`,
    topStories: fallbackStories.slice(0, 5),
    watchToday,
    cached: false,
  };
}

export async function getDailyReport(userId: string): Promise<DailyReportResponse> {
  await ensureEmailVerifiedForAi(userId);
  const cacheKey = `daily-report:${userId}`;
  const cached = reportCache.get<DailyReportResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };

  // Single hard deadline wrapping EVERYTHING — data gathering + AI call.
  // User never waits more than 12 seconds.
  const HARD_DEADLINE_MS = 12000;
  const startTime = Date.now();
  const weekend = isWeekendET();

  const fullPipeline = (async (): Promise<DailyReportResponse> => {
    // Gather data in parallel — 5s timeout per source (these are local/cached, should be fast)
    const withDataTimeout = <T,>(p: Promise<T>, label: string, ms = 5000): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms)),
      ]);

    const [portfolioResult, newsResult, economicResult, earningsResult] = await Promise.allSettled([
      withDataTimeout(getPortfolio(userId), 'portfolio'),
      withDataTimeout(fetchMarketNews(10), 'news'),
      withDataTimeout(getEconomicDashboard(), 'economic'),
      withDataTimeout(getEarningsSummary(userId), 'earnings'),
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

    const now = new Date();
    const formattedDate = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const sortedHoldings = portfolio.holdings
      .sort((a, b) => b.currentValue - a.currentValue)
      .slice(0, 10);

    const holdingsSummary = sortedHoldings
      .map(h =>
        `${h.ticker} $${h.currentValue.toFixed(0)} ${h.dayChangePercent >= 0 ? '+' : ''}${h.dayChangePercent.toFixed(1)}%`
      )
      .join(', ');

    const newsSummary = news.slice(0, 5)
      .map(n => `- ${n.headline}`)
      .join('\n');

    let economicSummary = '';
    if (economic) {
      const ind = economic.indicators;
      const parts: string[] = [];
      if (ind.fedFundsRate?.latestValue != null) parts.push(`Fed rate: ${ind.fedFundsRate.latestValue}%`);
      if (ind.treasuryYield10Y?.latestValue != null) parts.push(`10Y: ${ind.treasuryYield10Y.latestValue}%`);
      if (ind.cpi?.latestValue != null) parts.push(`CPI: ${ind.cpi.latestValue}%`);
      economicSummary = parts.join(', ');
    }

    const upcomingEarnings = earnings.results
      .filter(e => e.daysUntil >= 0 && e.daysUntil <= 7)
      .slice(0, 8)
      .map(e => {
        const date = new Date(e.reportDate);
        const dow = date.toLocaleDateString('en-US', { weekday: 'short' });
        return `${e.ticker} (${dow})`;
      });
    const earningsSummaryLine = upcomingEarnings.length > 0
      ? `Earnings: ${upcomingEarnings.join(', ')}`
      : '';

    const weekendNote = weekend
      ? `Weekend. Recap last week, preview next week.\n`
      : '';

    const userMessage =
      `${formattedDate}. ${weekend ? 'Weekend' : 'Daily'} briefing.\n` +
      weekendNote +
      `Portfolio: ${portfolio.holdings.length} holdings, $${portfolio.netEquity.toFixed(0)}, ${portfolio.dayChangePercent >= 0 ? '+' : ''}${portfolio.dayChangePercent.toFixed(1)}% ($${portfolio.dayChange.toFixed(0)})\n` +
      `Top: ${holdingsSummary}\n` +
      `News:\n${newsSummary}\n` +
      (economicSummary ? `Macro: ${economicSummary}\n` : '') +
      earningsSummaryLine;

    // How much time is left for Perplexity after data gathering?
    const elapsedSoFar = Date.now() - startTime;
    const perplexityTimeout = Math.max(3000, HARD_DEADLINE_MS - elapsedSoFar - 500);

    const resp = await callPerplexity([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ], { timeout: perplexityTimeout, feature: 'daily-report', userId, model: 'sonar' });

    if (!resp || !resp.content) {
      return buildFallbackReport(portfolio, sortedHoldings, news, upcomingEarnings, weekend);
    }

    const jsonStr = extractJson(resp.content);
    const parsed = JSON.parse(jsonStr);

    return {
      generatedAt: new Date().toISOString(),
      greeting: stripLeakedTags(String(parsed.greeting || '').slice(0, 200)),
      marketOverview: stripLeakedTags(String(parsed.marketOverview || '').slice(0, 500)),
      portfolioSummary: stripLeakedTags(String(parsed.portfolioSummary || '').slice(0, 500)),
      topStories: (parsed.topStories || []).slice(0, 5).map((s: any) => ({
        headline: stripLeakedTags(String(s.headline || '').slice(0, 100)),
        body: stripLeakedTags(String(s.body || '').slice(0, 300)),
        sentiment: ['positive', 'negative', 'neutral'].includes(s.sentiment) ? s.sentiment : 'neutral',
        relatedTickers: Array.isArray(s.relatedTickers)
          ? s.relatedTickers.filter((t: any) => typeof t === 'string' && t.length >= 1 && !TICKER_BLACKLIST.has(t.toUpperCase()))
          : [],
      })),
      watchToday: (parsed.watchToday || []).slice(0, 4).map((w: any) => stripLeakedTags(String(w || '').slice(0, 300))),
      cached: false,
    };
  })();

  const deadlinePromise = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), HARD_DEADLINE_MS);
  });

  try {
    const raceResult = await Promise.race([fullPipeline, deadlinePromise]);

    if (raceResult === null) {
      console.warn(`[Daily Report] Hard deadline (${HARD_DEADLINE_MS}ms) hit, returning fallback`);
      const fallback = buildQuickFallback(weekend);
      // Let pipeline finish in background and cache
      fullPipeline.then(aiResult => {
        if (aiResult.topStories.length > 0) {
          reportCache.set(cacheKey, aiResult);
          console.log(`[Daily Report] Background generation complete, cached`);
        }
      }).catch(() => {});
      return fallback;
    }

    const result = raceResult;
    if (result.topStories.length > 0) {
      reportCache.set(cacheKey, result);
    }
    console.log(`[Daily Report] Generated ${result.topStories.length} stories in ${Date.now() - startTime}ms`);
    return result;
  } catch (_error) {
    console.error('[Daily Report] Error:', _error);
    return buildQuickFallback(weekend);
  }
}

export async function regenerateDailyReport(userId: string): Promise<DailyReportResponse> {
  reportCache.del(`daily-report:${userId}`);
  return getDailyReport(userId);
}

/**
 * Pre-generate daily reports for all users with holdings.
 * Called by a background job so reports are cached before users open the modal.
 */
export async function preGenerateDailyReports(): Promise<void> {
  // Dynamic import to avoid circular dependency
  const prisma = (await import('../utils/prisma')).default;
  const users = await prisma.holding.findMany({
    select: { userId: true },
    distinct: ['userId'],
    where: { shares: { gt: 0 }, userId: { not: null } },
  });

  let generated = 0;
  for (const { userId } of users) {
    if (!userId) continue;
    const cacheKey = `daily-report:${userId}`;
    if (reportCache.has(cacheKey)) continue; // Already cached, skip

    try {
      await getDailyReport(userId);
      generated++;
    } catch (err: any) {
      console.warn(`[Daily Report Pre-Gen] Failed for user ${userId.slice(0, 8)}: ${err.message}`);
    }
  }

  if (generated > 0) {
    console.log(`[Daily Report Pre-Gen] Pre-generated ${generated} reports for ${users.length} users`);
  }
}
