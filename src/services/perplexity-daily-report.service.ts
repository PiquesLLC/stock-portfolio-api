import NodeCache from 'node-cache';
import { callAI } from '../utils/ai-provider';
import { extractJson, parsePerplexityJson } from '../utils/perplexity';
import { sanitizeContent } from '../utils/content-filter';
import { getPortfolio } from './portfolio.service';
import { fetchMarketNews } from './news.service';
import { fetchPortfolioNews } from './portfolio-news.service';
import { getEconomicDashboard } from './economic.service';
import { getEarningsSummary } from './earnings-summary.service';
import { ensureEmailVerifiedForAi } from './email-verification-guard.service';
import { JobExecutionError, type JobFailureCategory } from './job-runner.service';

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
  sample?: boolean;
}

interface DailyReportOptions {
  strictFailures?: boolean;
  portfolioId?: string;
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

function decodeJsonFragment(value: string): string {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\').trim();
  }
}

function extractStringField(source: string, key: string): string {
  const match = source.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i'));
  return match ? decodeJsonFragment(match[1]).trim() : '';
}

function extractStringArrayField(source: string, key: string): string[] {
  const match = source.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'i'));
  if (!match) return [];
  return Array.from(match[1].matchAll(/"((?:\\.|[^"\\])*)"/g))
    .map((entry) => decodeJsonFragment(entry[1]).trim())
    .filter(Boolean);
}

function salvageTopStories(source: string): DailyReportResponse['topStories'] {
  const storiesMatch = source.match(/"topStories"\s*:\s*\[([\s\S]*?)\]\s*(?:,|})/i);
  if (!storiesMatch) return [];

  const stories: DailyReportResponse['topStories'] = [];
  const storyRegex = /\{[\s\S]*?"headline"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]*?"body"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]*?"sentiment"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]*?"relatedTickers"\s*:\s*\[([\s\S]*?)\][\s\S]*?\}/g;

  for (const match of storiesMatch[1].matchAll(storyRegex)) {
    const relatedTickers = Array.from(match[4].matchAll(/"((?:\\.|[^"\\])*)"/g))
      .map((entry) => decodeJsonFragment(entry[1]).trim().toUpperCase())
      .filter((ticker) => ticker && !TICKER_BLACKLIST.has(ticker));

    stories.push({
      headline: stripLeakedTags(decodeJsonFragment(match[1]).slice(0, 100)),
      body: stripLeakedTags(decodeJsonFragment(match[2]).slice(0, 300)),
      sentiment: ['positive', 'negative', 'neutral'].includes(match[3]) ? match[3] as 'positive' | 'negative' | 'neutral' : 'neutral',
      relatedTickers,
    });
  }

  return stories.slice(0, 5);
}

function buildDailyReportFromPayload(
  payload: any,
  fallback: DailyReportResponse,
): DailyReportResponse {
  const topStories = Array.isArray(payload?.topStories)
    ? payload.topStories.slice(0, 5).map((s: any) => ({
      headline: sanitizeContent(stripLeakedTags(String(s?.headline || '').slice(0, 100))),
      body: sanitizeContent(stripLeakedTags(String(s?.body || '').slice(0, 300))),
      sentiment: ['positive', 'negative', 'neutral'].includes(s?.sentiment) ? s.sentiment : 'neutral',
      relatedTickers: Array.isArray(s?.relatedTickers)
        ? s.relatedTickers
          .filter((t: any) => typeof t === 'string' && t.length >= 1)
          .map((t: string) => t.toUpperCase())
          .filter((t: string) => !TICKER_BLACKLIST.has(t))
        : [],
    }))
    : fallback.topStories;

  const watchToday = Array.isArray(payload?.watchToday)
    ? payload.watchToday.slice(0, 4).map((w: any) => sanitizeContent(stripLeakedTags(String(w || '').slice(0, 300))))
    : fallback.watchToday;

  return {
    generatedAt: new Date().toISOString(),
    greeting: sanitizeContent(stripLeakedTags(String(payload?.greeting || fallback.greeting).slice(0, 200))),
    marketOverview: sanitizeContent(stripLeakedTags(String(payload?.marketOverview || fallback.marketOverview).slice(0, 500))),
    portfolioSummary: sanitizeContent(stripLeakedTags(String(payload?.portfolioSummary || fallback.portfolioSummary).slice(0, 500))),
    topStories: topStories.length > 0 ? topStories : fallback.topStories,
    watchToday: watchToday.length > 0 ? watchToday : fallback.watchToday,
    cached: false,
  };
}

function salvagePartialDailyReport(content: string, fallback: DailyReportResponse): DailyReportResponse | null {
  const extracted = extractJson(content) || content;
  const partial = {
    greeting: extractStringField(extracted, 'greeting'),
    marketOverview: extractStringField(extracted, 'marketOverview'),
    portfolioSummary: extractStringField(extracted, 'portfolioSummary'),
    topStories: salvageTopStories(extracted),
    watchToday: extractStringArrayField(extracted, 'watchToday'),
  };

  const hasUsefulContent =
    Boolean(partial.greeting || partial.marketOverview || partial.portfolioSummary) ||
    partial.topStories.length > 0 ||
    partial.watchToday.length > 0;

  return hasUsefulContent ? buildDailyReportFromPayload(partial, fallback) : null;
}

export async function getDailyReport(userId: string, portfolioId?: string): Promise<DailyReportResponse> {
  return getDailyReportInternal(userId, { portfolioId });
}

function classifyDailyReportError(error: unknown): JobFailureCategory {
  if (error instanceof JobExecutionError) return error.category;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('deadline')) {
    return 'TRANSIENT';
  }
  if (
    lower.includes('json parse') ||
    lower.includes('invalid json') ||
    lower.includes('unexpected token') ||
    lower.includes('parse failure')
  ) {
    return 'DATA_QUALITY';
  }
  return 'UNKNOWN';
}

async function getDailyReportInternal(userId: string, options: DailyReportOptions): Promise<DailyReportResponse> {
  await ensureEmailVerifiedForAi(userId);
  const portfolioId = options.portfolioId;
  const cacheKey = `daily-report:${userId}${portfolioId ? `:${portfolioId}` : ''}`;
  const cached = reportCache.get<DailyReportResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };
  const strictFailures = options.strictFailures === true;

  // Single hard deadline wrapping EVERYTHING — data gathering + AI call.
  // Daily reports are longer responses, so give Perplexity enough time to finish.
  const HARD_DEADLINE_MS = 30000;
  const startTime = Date.now();
  const weekend = isWeekendET();

  const fullPipeline = (async (): Promise<DailyReportResponse> => {
    // Gather data in parallel — 5s timeout per source (these are local/cached, should be fast)
    const withDataTimeout = <T,>(p: Promise<T>, label: string, ms = 5000): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms)),
      ]);

    const [portfolioResult, newsResult, portfolioNewsResult, economicResult, earningsResult] = await Promise.allSettled([
      withDataTimeout(getPortfolio(userId, { portfolioId }), 'portfolio'),
      withDataTimeout(fetchMarketNews(10), 'news'),
      withDataTimeout(fetchPortfolioNews(userId, 15, portfolioId), 'portfolio-news'),
      withDataTimeout(getEconomicDashboard(), 'economic'),
      withDataTimeout(getEarningsSummary(userId, portfolioId), 'earnings'),
    ]);

    const portfolio = portfolioResult.status === 'fulfilled' ? portfolioResult.value : null;
    const news = newsResult.status === 'fulfilled' ? newsResult.value : [];
    const portfolioNews = portfolioNewsResult.status === 'fulfilled' ? portfolioNewsResult.value : null;
    const economic = economicResult.status === 'fulfilled' ? economicResult.value : null;
    const earnings = earningsResult.status === 'fulfilled' ? earningsResult.value : { results: [], partial: true };

    if (!portfolio || portfolio.holdings.length === 0) {
      const now = new Date();
      const formattedDate = now.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
      return {
        generatedAt: now.toISOString(),
        greeting: `Good morning — welcome to Nala!`,
        marketOverview: `Here's what your daily brief will look like once you add holdings. Each morning, NALA will scan the market, analyze your portfolio, and write you a personalized briefing. This is a sample report so you can see the format.`,
        portfolioSummary: `Once you add stocks, this section will show your portfolio's performance, top movers, and key changes since yesterday. Start by adding a few holdings to your portfolio.`,
        topStories: [
          {
            headline: 'Your personalized market news will appear here',
            body: 'NALA reads the top financial headlines each morning and highlights the ones that matter to your holdings. Add stocks to your portfolio to get news tailored to what you own.',
            sentiment: 'neutral',
            relatedTickers: [],
          },
          {
            headline: 'Earnings, dividends, and analyst calls — all in one place',
            body: 'When companies in your portfolio report earnings or announce dividends, you\'ll see them right here in your daily brief. No more searching — it all comes to you.',
            sentiment: 'neutral',
            relatedTickers: [],
          },
        ],
        watchToday: [
          'Add your first holding to unlock your personalized daily brief.',
        ],
        cached: false,
        sample: true,
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

    // Combine general market news + portfolio-specific news for richer AI context
    const generalNews = news.slice(0, 5).map(n => `- ${n.headline}`);
    const holdingNews = portfolioNews?.items?.slice(0, 10).map(n =>
      `- ${n.headline} (related: ${n.matchedTickers?.join(', ') || 'market'})`
    ) || [];
    const newsSummary = [...new Set([...holdingNews, ...generalNews])].slice(0, 12).join('\n');

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

    const fallbackReport = buildFallbackReport(portfolio, sortedHoldings, news, upcomingEarnings, weekend);

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
    const perplexityTimeout = Math.max(20000, HARD_DEADLINE_MS - elapsedSoFar - 500);

    let resp;
    try {
      resp = await callAI([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ], { timeout: perplexityTimeout, feature: 'daily-report', userId });
    } catch (perplexityError: unknown) {
      const msg = perplexityError instanceof Error ? perplexityError.message : String(perplexityError);
      if (strictFailures) {
        throw new JobExecutionError(`[Daily Report] Perplexity call failed: ${msg}`, classifyDailyReportError(perplexityError));
      }
      console.warn(`[Daily Report] Perplexity call failed (${msg}), using data-only fallback`);
      return fallbackReport;
    }

    if (!resp || !resp.content) {
      return fallbackReport;
    }

    const parseResult = parsePerplexityJson(resp.content);
    if (!parseResult.ok) {
      const salvaged = salvagePartialDailyReport(resp.content, fallbackReport);
      if (salvaged) {
        console.warn(`[Daily Report] JSON parse failed (${parseResult.reason}), salvaged partial content`);
        return salvaged;
      }
      if (strictFailures) {
        throw new JobExecutionError(`[Daily Report] Parse failure: ${parseResult.reason}`, 'DATA_QUALITY');
      }
      console.warn(`[Daily Report] JSON parse failed (${parseResult.reason}), using fallback`);
      return fallbackReport;
    }

    return buildDailyReportFromPayload(parseResult.data, fallbackReport);
  })();

  const deadlinePromise = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), HARD_DEADLINE_MS);
  });

  try {
    const raceResult = await Promise.race([fullPipeline, deadlinePromise]);

    if (raceResult === null) {
      if (strictFailures) {
        throw new JobExecutionError(`[Daily Report] Hard deadline exceeded (${HARD_DEADLINE_MS}ms)`, 'TRANSIENT');
      }
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
    if (strictFailures) {
      if (_error instanceof JobExecutionError) throw _error;
      throw new JobExecutionError(
        _error instanceof Error ? _error.message : String(_error ?? 'Unknown daily report generation error'),
        classifyDailyReportError(_error),
      );
    }
    console.error('[Daily Report] Error:', _error);
    return buildQuickFallback(weekend);
  }
}

export async function regenerateDailyReport(userId: string, portfolioId?: string): Promise<DailyReportResponse> {
  reportCache.del(`daily-report:${userId}${portfolioId ? `:${portfolioId}` : ''}`);
  return getDailyReportInternal(userId, { portfolioId });
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

  let successCount = 0;
  let failureCount = 0;
  let skippedCached = 0;
  const failureByCategory: Record<JobFailureCategory, number> = {
    TRANSIENT: 0,
    PERMANENT: 0,
    RATE_LIMITED: 0,
    DATA_QUALITY: 0,
    UNKNOWN: 0,
  };

  for (const { userId } of users) {
    if (!userId) continue;
    const cacheKey = `daily-report:${userId}`;
    if (reportCache.has(cacheKey)) {
      skippedCached++;
      continue; // Already cached, skip
    }

    try {
      await getDailyReportInternal(userId, { strictFailures: true });
      successCount++;
    } catch (err: any) {
      // Retry once after 2s for transient failures (Perplexity timeouts, JSON parse errors)
      const category = classifyDailyReportError(err);
      console.warn(`[Daily Report Pre-Gen] First attempt failed userId=${userId} category=${category}, retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
      try {
        await getDailyReportInternal(userId, { strictFailures: true });
        successCount++;
        console.log(`[Daily Report Pre-Gen] Retry succeeded for userId=${userId}`);
      } catch (retryErr: any) {
        failureCount++;
        const retryCategory = classifyDailyReportError(retryErr);
        failureByCategory[retryCategory] += 1;
        const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.warn(`[Daily Report Pre-Gen] Retry also failed userId=${userId} category=${retryCategory} error="${message}"`);
      }
      continue;
    }
  }

  console.log(
    `[Daily Report Pre-Gen] Summary users=${users.length} success=${successCount} failed=${failureCount} skippedCached=${skippedCached} ` +
    `failuresByCategory=${JSON.stringify(failureByCategory)}`,
  );
}
