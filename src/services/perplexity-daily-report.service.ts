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
import { getMarketStateET, getETDateBucket, type MarketState } from '../utils/market-state';

const reportCache = new NodeCache();

// Bump this whenever the editorial schema, prompt template, or fallback shape
// changes — every running replica's NodeCache is process-local and won't
// otherwise drop pre-deploy entries until TTL elapses, leaving users on stale
// payloads (missing fields, old layout shape) until the bucket flips.
const REPORT_SCHEMA_VERSION = 'v2-2026-05-07';

function ttlForState(state: MarketState): number {
  if (state === 'intraday') return 20 * 60;        // 20 min
  if (state === 'weekend')  return 24 * 60 * 60;   // 24 h
  return 4 * 60 * 60;                               // pre_open / post_close
}

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
  positionMoves?: {
    ticker: string;
    changePercent: number;
    changeDollar?: number;
    reason: string;
  }[];
  topStories: {
    headline: string;
    body: string;
    sentiment: 'positive' | 'negative' | 'neutral';
    relatedTickers: string[];
  }[];
  questionsOfTheDay?: {
    question: string;
    answer: string;
  }[];
  watchToday: string[];
  cached: boolean;
  generating?: boolean; // true on a "still generating" fallback — client shows a generating state + polls faster
  sample?: boolean;
}

interface DailyReportOptions {
  strictFailures?: boolean;
  portfolioId?: string;
}

const SCHEMA_BLOCK = `Return ONLY valid JSON with this structure:
{
  "greeting": "One-sentence market headline. Do NOT include the date, 'morning brief', 'recap', or 'good morning' — just the key market theme and portfolio impact.",
  "marketOverview": "4-6 sentences covering: major index moves with exact percentages, key macro drivers (yields, oil, dollar, VIX), geopolitical catalysts, and the dominant theme. Include specific numbers — Fed rate, 10Y yield level, oil price, VIX level. Tone should match a premium institutional desk note.",
  "portfolioSummary": "4-6 sentences analyzing the user's specific holdings: which positions are responsible for gains/losses and WHY (not just the magnitude of the move), how the portfolio compares to SPY, any notable sector rotation impacting holdings, and one forward-looking insight. Reference specific company news, analyst actions, or earnings tied to their stocks.",
  "positionMoves": [
    {
      "ticker": "AAPL",
      "changePercent": -2.34,
      "reason": "1-2 sentences explaining the SPECIFIC catalyst behind this stock's move. Name the news event, analyst action, or macro factor."
    }
  ],
  "topStories": [
    {
      "headline": "Specific, punchy headline with a number — max 100 chars",
      "body": "3-4 sentences of real analysis. Name the companies involved, the specific catalyst (earnings beat, analyst upgrade, FDA decision, trade policy), the magnitude of the move, and what it means for the investor's portfolio. Every story must connect back to either a holding or a macro theme touching their positions.",
      "sentiment": "positive|negative|neutral",
      "relatedTickers": ["AAPL", "MSFT"]
    }
  ],
  "questionsOfTheDay": [
    {
      "question": "A thought-provoking market insight or portfolio observation phrased as a bold statement or question",
      "answer": "2-3 sentences with historical context, data, or actionable insight. Reference specific numbers and how it relates to the user's portfolio."
    }
  ],
  "watchToday": [
    "Specific, actionable item with date/time: 'Initial jobless claims at 8:30 AM ET — consensus 220K, last week 223K. A miss could pressure your SPY and tech holdings.'"
  ]
}

QUALITY REQUIREMENTS:
- marketOverview: MUST include at least 4 specific data points (index %, yield level, oil price, VIX)
- portfolioSummary: MUST reference at least 3 of the user's actual holdings by ticker with specific % moves
- positionMoves: Pick the 3-5 holdings with the LARGEST absolute % moves. For each, explain the specific catalyst (earnings, analyst action, sector rotation, macro event). Use the actual changePercent from the portfolio data provided. This is the most important section — users want to know WHY their money is moving.
- topStories: Write 5-7 stories, each 3-4 sentences with specific catalysts and numbers
- questionsOfTheDay: Write 2 insightful observations. One should be a historical/statistical market insight relevant to today. The other should be a specific observation about the user's portfolio (concentration risk, correlation, sector exposure, etc). Make them thought-provoking and educational.
- watchToday: REQUIRED — 3-5 items. Each must have a specific time (e.g. "8:30 AM ET"), what's happening, consensus/expected value, and how it could affect the user's holdings. Include economic data releases, earnings reports, Fed speeches, or major corporate events. This section must NEVER be empty.
- Every section must use real, current data — never generic filler
- For any holding with a >2% absolute move, explain exactly WHY with a specific news catalyst
- Include at least one story about sector rotation or money flow patterns
- Reference analyst upgrades/downgrades if any are relevant to the user's holdings`;

const SHARED_OPENER = `You are a Wall Street desk analyst writing a premium briefing for an institutional client. This must feel like a paid Bloomberg terminal note — specific, data-rich, and actionable.`;

// Negative-verb list lives in this system-prompt voice block, not in the user message.
// In the system prompt the model treats it as a rule; in the user message it tends to
// echo banned words back as content.
const VOICE_INTRADAY = `=== TENSE OVERRIDE (highest priority) ===
MARKETS ARE OPEN RIGHT NOW. The trading session is in progress. WRITE EVERY SENTENCE IN PRESENT TENSE.

REQUIRED phrasing — use present-tense and present-progressive throughout:
- "the S&P is trading at..." / "the S&P is up X%"
- "the VIX is sitting at..."
- "AMZN is climbing X%" / "AMZN is down X% in the session"
- "yields are holding at 4.25%"
- "your portfolio is up X% so far today"
- Pepper in "so far today", "currently", "intraday", "in the session", "live", "as of now"

CATEGORICALLY FORBIDDEN — the session has not ended.
- No past-tense verbs for the regular-session action: do NOT use simple past forms of advance, rise, fall, drop, climb, slide, gain, lose, post, hold, finish, end, settle, wrap, or any synonym describing a completed market move. Convert every such verb to present-progressive ("is climbing") or simple present ("is up").
- No language framing the day, the week, or a session as a completed period. The trading day is unfinished. The week is still in progress.
- No references to a settlement print, an ending bell, or any kind of session wrap-up.
- Do not describe the user's portfolio with finished-action verbs ("posted", "ended", "finished") — use present forms ("is up", "is down", "is sitting at", "is outperforming SPY by X%").

If you slip into past tense or end-of-session framing, that response is wrong. Re-read every sentence and convert before returning the JSON.`;

const VOICE_PRE_OPEN = `=== TENSE OVERRIDE (highest priority) ===
THE REGULAR SESSION HAS NOT YET OPENED. Write in forward-looking and pre-market framing.

REQUIRED phrasing:
- Reference S&P futures (ES), Nasdaq futures (NQ), overnight Asian/European moves, pre-market gappers
- "futures point to", "opens at", "set to open", "pre-market", "overnight", "ahead of the open"
- Past tense is OK ONLY for overnight / yesterday's close as historical context. The current session's action does not exist yet.

FORBIDDEN: do not write past-tense statements about today's regular session as if it has happened.`;

const VOICE_POST_CLOSE = `You are on the morning desk writing the post-close recap of the previous trading day.

VOICE: post-close recap. Use phrases like "closed today", "today's close", "at the close", "finished the day".`;

const VOICE_WEEKEND = `You are writing a WEEKEND brief. The session is closed for the weekend — recap the week that ended Friday and preview Monday's open.

VOICE: "this week", "last week", "Monday", "next week", "recap", "week ahead". Past tense for last week's action.`;

export function buildSystemPrompt(state: MarketState): string {
  let voice: string;
  switch (state) {
    case 'intraday':   voice = VOICE_INTRADAY;   break;
    case 'pre_open':   voice = VOICE_PRE_OPEN;   break;
    case 'weekend':    voice = VOICE_WEEKEND;    break;
    case 'post_close':
    default:           voice = VOICE_POST_CLOSE; break;
  }
  // Voice block last: LLMs weight late-prompt instructions more heavily, and the schema
  // block above carries strong behavioral pull on its own.
  return `${SHARED_OPENER}\n\n${SCHEMA_BLOCK}\n\n${voice}`;
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
    generating: true,
  };
}

/** Rich fallback using actual portfolio + news data */
function buildFallbackReport(
  portfolio: any,
  sortedHoldings: any[],
  news: any[],
  upcomingEarnings: string[],
  marketState: MarketState,
): DailyReportResponse {
  const weekend = marketState === 'weekend';
  const isLive = marketState === 'intraday' || marketState === 'pre_open';
  const verbUp = isLive ? 'is up' : 'gained';
  const verbDown = isLive ? 'is down' : 'lost';
  const todayWord = isLive ? 'so far today' : 'today';
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
      body: `Your biggest moves ${todayWord} among your ${portfolio.holdings.length} holdings.`,
      sentiment: movers[0].dayChangePercent >= 0 ? 'positive' as const : 'negative' as const,
      relatedTickers: movers.map((m: any) => m.ticker),
    });
  }

  const watchToday: string[] = [];
  if (upcomingEarnings.length > 0) {
    watchToday.push(`Earnings to watch: ${upcomingEarnings.join(', ')}`);
  }
  // Add top movers as watch items
  if (movers.length > 0) {
    for (const m of movers.slice(0, 2)) {
      watchToday.push(`${m.ticker} ${m.dayChangePercent >= 0 ? 'up' : 'down'} ${Math.abs(m.dayChangePercent).toFixed(1)}% — watch for continuation or reversal`);
    }
  }

  // Build positionMoves from top movers
  const allMovers = sortedHoldings
    .filter(h => Math.abs(h.dayChangePercent) > 0.1)
    .slice(0, 5);
  const positionMoves = allMovers.map((h: any) => ({
    ticker: h.ticker,
    changePercent: h.dayChangePercent ?? 0,
    reason: `${h.ticker} ${h.dayChangePercent >= 0 ? verbUp : verbDown} ${Math.abs(h.dayChangePercent).toFixed(1)}% ${todayWord}.`,
  }));

  return {
    generatedAt: new Date().toISOString(),
    greeting: weekend ? 'Happy weekend!' : 'Good morning!',
    marketOverview: 'Your AI briefing is generating — refresh in a moment for the full report.',
    portfolioSummary: `Your portfolio ($${totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}) is ${dayChange >= 0 ? 'up' : 'down'} ${Math.abs(dayChange).toFixed(2)}% ($${Math.abs(dollarChange).toFixed(0)}) ${todayWord}.`,
    topStories: fallbackStories.slice(0, 5),
    watchToday,
    positionMoves,
    cached: false,
    generating: true,
  } as DailyReportResponse;
}

/** Truncate text at the last sentence boundary within maxLen, or at last word boundary */
function truncateCleanly(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const trimmed = text.slice(0, maxLen);
  // Try to cut at last sentence-ending punctuation
  const sentenceEnd = Math.max(trimmed.lastIndexOf('. '), trimmed.lastIndexOf('.) '), trimmed.lastIndexOf('."'));
  if (sentenceEnd > maxLen * 0.5) return trimmed.slice(0, sentenceEnd + 1).trim();
  // Fall back to last period
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot > maxLen * 0.5) return trimmed.slice(0, lastDot + 1).trim();
  // Fall back to last word boundary
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.5) return trimmed.slice(0, lastSpace).trim() + '…';
  return trimmed.trim() + '…';
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
      headline: stripLeakedTags(decodeJsonFragment(match[1]).slice(0, 120)),
      body: truncateCleanly(stripLeakedTags(decodeJsonFragment(match[2])), 600),
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
      headline: sanitizeContent(stripLeakedTags(String(s?.headline || '').slice(0, 120))),
      body: truncateCleanly(sanitizeContent(stripLeakedTags(String(s?.body || ''))), 600),
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
    ? payload.watchToday.slice(0, 5).map((w: any) => truncateCleanly(sanitizeContent(stripLeakedTags(String(w || ''))), 400))
    : fallback.watchToday;

  const positionMoves = Array.isArray(payload?.positionMoves)
    ? payload.positionMoves.slice(0, 5).map((m: any) => ({
      ticker: String(m?.ticker || '').toUpperCase(),
      changePercent: typeof m?.changePercent === 'number' ? m.changePercent : 0,
      reason: truncateCleanly(sanitizeContent(stripLeakedTags(String(m?.reason || ''))), 300),
    })).filter((m: any) => m.ticker && m.reason)
    : undefined;

  const questionsOfTheDay = Array.isArray(payload?.questionsOfTheDay)
    ? payload.questionsOfTheDay.slice(0, 2).map((q: any) => ({
      question: sanitizeContent(stripLeakedTags(String(q?.question || ''))).slice(0, 200),
      answer: truncateCleanly(sanitizeContent(stripLeakedTags(String(q?.answer || ''))), 500),
    })).filter((q: any) => q.question && q.answer)
    : undefined;

  return {
    generatedAt: new Date().toISOString(),
    greeting: sanitizeContent(stripLeakedTags(String(payload?.greeting || fallback.greeting).slice(0, 250))),
    marketOverview: truncateCleanly(sanitizeContent(stripLeakedTags(String(payload?.marketOverview || fallback.marketOverview))), 1000),
    portfolioSummary: truncateCleanly(sanitizeContent(stripLeakedTags(String(payload?.portfolioSummary || fallback.portfolioSummary))), 1000),
    positionMoves: positionMoves && positionMoves.length > 0 ? positionMoves : fallback.positionMoves,
    topStories: topStories.length > 0 ? topStories : fallback.topStories,
    questionsOfTheDay: questionsOfTheDay && questionsOfTheDay.length > 0 ? questionsOfTheDay : undefined,
    watchToday: watchToday.length > 0 ? watchToday : fallback.watchToday,
    cached: false,
  };
}

function salvagePositionMoves(source: string): { ticker: string; changePercent: number; reason: string }[] {
  const movesMatch = source.match(/"positionMoves"\s*:\s*\[([\s\S]*?)\]\s*(?:,|})/i);
  if (!movesMatch) return [];

  const moves: { ticker: string; changePercent: number; reason: string }[] = [];
  const moveRegex = /\{[\s\S]*?"ticker"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]*?"changePercent"\s*:\s*(-?\d+(?:\.\d+)?)[\s\S]*?"reason"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]*?\}/g;

  for (const match of movesMatch[1].matchAll(moveRegex)) {
    const ticker = decodeJsonFragment(match[1]).trim().toUpperCase();
    const changePercent = parseFloat(match[2]);
    const reason = truncateCleanly(sanitizeContent(stripLeakedTags(decodeJsonFragment(match[3]))), 300);
    if (ticker && reason) {
      moves.push({ ticker, changePercent: isNaN(changePercent) ? 0 : changePercent, reason });
    }
  }

  return moves.slice(0, 5);
}

function salvagePartialDailyReport(content: string, fallback: DailyReportResponse): DailyReportResponse | null {
  const extracted = extractJson(content) || content;
  const partial = {
    greeting: extractStringField(extracted, 'greeting'),
    marketOverview: extractStringField(extracted, 'marketOverview'),
    portfolioSummary: extractStringField(extracted, 'portfolioSummary'),
    topStories: salvageTopStories(extracted),
    positionMoves: salvagePositionMoves(extracted),
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
  const etBucket = getETDateBucket();
  const marketState = getMarketStateET();
  const cacheKey = `daily-report:${REPORT_SCHEMA_VERSION}:${userId}:${portfolioId ?? '_'}:${etBucket}:${marketState}`;
  const cached = reportCache.get<DailyReportResponse>(cacheKey);
  if (cached) return { ...cached, cached: true };
  const strictFailures = options.strictFailures === true;

  // Single hard deadline wrapping EVERYTHING — data gathering + AI call.
  // Gemini 2.5 Flash can take 15-25s for rich daily reports + needs retry room for 503s.
  const HARD_DEADLINE_MS = 55000;
  const startTime = Date.now();
  const weekend = marketState === 'weekend';

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
      const _formattedDate = now.toLocaleDateString('en-US', {
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

    const fallbackReport = buildFallbackReport(portfolio, sortedHoldings, news, upcomingEarnings, marketState);

    const weekendNote = weekend
      ? `Weekend. Recap last week, preview next week.\n`
      : '';

    const stateLabel: Record<MarketState, string> = {
      pre_open: 'Pre-market',
      intraday: 'Intraday',
      post_close: 'Post-close',
      weekend: 'Weekend',
    };

    const intradayTimestamp = marketState === 'intraday'
      ? new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' }) + ' ET'
      : '';
    const intradayPrefix = marketState === 'intraday'
      ? `*** MARKETS ARE OPEN RIGHT NOW. Current time: ${intradayTimestamp}. The trading session is in progress — WRITE IN PRESENT TENSE THROUGHOUT. ***\nLive snapshot at ${intradayTimestamp}:\n`
      : '';
    const preOpenPrefix = marketState === 'pre_open'
      ? `*** PRE-MARKET — the regular session has NOT opened yet. Reference futures and overnight moves; do not describe today's regular trading in past tense. ***\n`
      : '';

    const userMessage =
      `${formattedDate}. ${stateLabel[marketState]} briefing.\n` +
      weekendNote +
      intradayPrefix +
      preOpenPrefix +
      `Portfolio: ${portfolio.holdings.length} holdings, $${portfolio.netEquity.toFixed(0)}, ${portfolio.dayChangePercent >= 0 ? '+' : ''}${portfolio.dayChangePercent.toFixed(1)}% ($${portfolio.dayChange.toFixed(0)})\n` +
      `Top: ${holdingsSummary}\n` +
      `News:\n${newsSummary}\n` +
      (economicSummary ? `Macro: ${economicSummary}\n` : '') +
      earningsSummaryLine +
      `\nIMPORTANT: You MUST include "positionMoves" in your JSON response. Pick the 3-5 holdings with the largest absolute % moves from the portfolio data above and explain the specific catalyst for each.` +
      (marketState === 'intraday'
        ? `\n\nFINAL REMINDER: every sentence in your response must be in present tense. The trading session is in progress.`
        : '');

    // How much time is left for Perplexity after data gathering?
    const elapsedSoFar = Date.now() - startTime;
    const perplexityTimeout = Math.max(20000, HARD_DEADLINE_MS - elapsedSoFar - 500);

    let resp;
    try {
      resp = await callAI([
        { role: 'system', content: buildSystemPrompt(marketState) },
        { role: 'user', content: userMessage },
      ], { timeout: perplexityTimeout, feature: 'daily-report', userId, useSearch: true });
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
        if (aiResult.topStories.length > 0 && !aiResult.generating) {
          reportCache.set(cacheKey, aiResult, ttlForState(marketState));
          console.log(`[Daily Report] Background generation complete, cached`);
        }
      }).catch(() => {});
      return fallback;
    }

    const result = raceResult;
    // Only cache AI-generated reports, never fallback reports
    if (result.topStories.length > 0 && !result.generating) {
      reportCache.set(cacheKey, result, ttlForState(marketState));
    }
    console.log(`[Daily Report] Generated ${result.topStories.length} stories in ${Date.now() - startTime}ms${result.generating ? ' (fallback — not cached)' : ''}`);
    // Keep `generating` on the response so the client can show a generating state + poll faster.
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
  const etBucket = getETDateBucket();
  const marketState = getMarketStateET();
  const cacheKey = `daily-report:${REPORT_SCHEMA_VERSION}:${userId}:${portfolioId ?? '_'}:${etBucket}:${marketState}`;
  reportCache.del(cacheKey);
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

  const etBucket = getETDateBucket();
  const marketState = getMarketStateET();

  for (const { userId } of users) {
    if (!userId) continue;
    const cacheKey = `daily-report:${REPORT_SCHEMA_VERSION}:${userId}:_:${etBucket}:${marketState}`;
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

export function applyLivePositionMoveData(
  report: DailyReportResponse,
  livePortfolio: { holdings: { ticker: string; dayChangePercent: number; dayChange: number }[] },
): DailyReportResponse {
  if (!report.positionMoves) return report;
  const byTicker = new Map(
    livePortfolio.holdings.map(h => [h.ticker.toUpperCase(), h]),
  );
  // Drop position moves for tickers no longer in the live portfolio (sold, delisted,
  // or LLM hallucination) — showing a stale percent for a non-position is misleading.
  const refreshed = report.positionMoves.flatMap(m => {
    const live = byTicker.get(m.ticker.toUpperCase());
    if (!live) return [];
    return [{ ...m, changePercent: live.dayChangePercent, changeDollar: live.dayChange }];
  });
  return { ...report, positionMoves: refreshed };
}

export function detectDirectionMismatch(
  report: DailyReportResponse,
  livePortfolio: { holdings: { ticker: string; dayChangePercent: number }[] },
): boolean {
  if (!report.positionMoves || report.positionMoves.length === 0) return false;
  const byTicker = new Map(
    livePortfolio.holdings.map(h => [h.ticker.toUpperCase(), h.dayChangePercent]),
  );
  // EPS in percent units. Asymmetric: we only suppress when the *live* side is below
  // the noise floor (genuinely flat). If the cached side is flat (LLM wrote "roughly
  // flat") but live shows a real opposite move, that prose is wrong and we want regen.
  const EPS = 0.25;
  return report.positionMoves.some(m => {
    const live = byTicker.get(m.ticker.toUpperCase());
    if (live == null) return false;
    if (Math.abs(live) < EPS) return false;
    return Math.sign(live) !== Math.sign(m.changePercent);
  });
}

// Per-user-portfolio cooldown for auto-regenerations triggered by direction mismatch.
// Without this, every fetch by every user during a volatile session could trigger a fresh
// Perplexity call, blocking the HTTP response and stampeding the upstream.
const autoRegenLastAt = new Map<string, number>();
const AUTO_REGEN_COOLDOWN_MS = 5 * 60 * 1000;

function pruneAutoRegenMap(now: number): void {
  const cutoff = now - AUTO_REGEN_COOLDOWN_MS * 2;
  for (const [k, ts] of autoRegenLastAt) {
    if (ts < cutoff) autoRegenLastAt.delete(k);
  }
}

export function shouldAutoRegenerate(userId: string, portfolioId?: string): boolean {
  const now = Date.now();
  pruneAutoRegenMap(now);
  const key = `${userId}:${portfolioId ?? '_'}`;
  const last = autoRegenLastAt.get(key) ?? 0;
  if (now - last < AUTO_REGEN_COOLDOWN_MS) return false;
  autoRegenLastAt.set(key, now);
  return true;
}

// Test seam — clear the cooldown map between unit tests.
export function _resetAutoRegenCooldownForTests(): void {
  autoRegenLastAt.clear();
}
