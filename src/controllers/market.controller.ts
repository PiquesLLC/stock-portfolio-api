import { Request, Response } from 'express';
import { fetchPrices, fetchQuote, fetchFastQuote, searchTickers, fetchStockDetails, fetchIntradayCandles, fetchHourlyCandles, fetchDailyCandles, fetchCandles, TickerNotFoundError } from '../services/market.service';
import { getBenchmarkCandles } from '../utils/candle-cache';
import { fetchMarketNews, fetchTickerNews } from '../services/news.service';
import { getETFHoldings, getAssetAbout } from '../utils/yahoo-finance';
import { getAIEvents } from '../services/perplexity-events.service';
import { askStockQuestion } from '../services/perplexity-qa.service';
import { getHistoricalCAGRs } from '../services/historical-cagr.service';
import { getHeatmapData, HeatmapPeriod } from '../services/market-heatmap.service';
import { getEarningsTrack } from '../services/earnings-track.service';
import { getMarketSentiment } from '../services/market-sentiment.service';
import { MarketIndex } from '../utils/sectors';
import { AxiosError } from 'axios';
import { AuthRequest } from '../types/auth';
import { EmailVerificationRequiredError } from '../services/email-verification-guard.service';
import {
  aiEventsQuerySchema,
  benchmarkParamSchema,
  candleQuerySchema,
  heatmapQuerySchema,
  historicalCagrQuerySchema,
  hourlyCandlesQuerySchema,
  marketNewsQuerySchema,
  pricesQuerySchema,
  searchSymbolsQuerySchema,
  stockQuestionSchema,
  tickerNewsQuerySchema,
  tickerParamSchema,
} from '../validators/market.validators';

interface PriceResult {
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  isStale?: boolean;
  isRepricing?: boolean;
  quoteAgeSeconds?: number;
  session?: string;
}

function normalizeCandleInterval(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  if (value === '1m' || value === '5m' || value === '15m' || value === '1h') {
    return value;
  }

  const upper = value.toUpperCase();
  if (upper === '1D' || upper === '1W' || upper === '1M') {
    return upper;
  }

  return value;
}

export async function getPrices(req: Request, res: Response): Promise<void> {
  try {
    const parsed = pricesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { tickers } = parsed.data;

    const { quotes, staleCount, repricingCount, failedTickers, provider } = await fetchPrices(tickers);

    const result: Record<string, PriceResult> = {};
    for (const [ticker, quote] of quotes) {
      result[ticker] = {
        price: quote.currentPrice,
        change: quote.change,
        changePercent: quote.changePercent,
        previousClose: quote.previousClose,
        isStale: quote.isStale,
        isRepricing: quote.isRepricing,
        quoteAgeSeconds: quote.quoteAgeSeconds,
        session: quote.session,
      };
    }

    // Include metadata about quotes
    const response = {
      prices: result,
      meta: {
        staleCount,
        repricingCount,
        failedTickers,
        provider,
        timestamp: Date.now(),
      },
    };

    res.json(response);
  } catch (error: unknown) {
    console.error('[Market] getPrices error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
}

export async function getQuote(req: Request, res: Response): Promise<void> {
  try {
    const parsed = tickerParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { ticker } = parsed.data;

    const quote = await fetchQuote(ticker);
    res.json(quote);
  } catch (error: unknown) {
    console.error('[Market] getQuote error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
}

/**
 * Fast quote endpoint using Yahoo Finance directly - no queue delays.
 * Used for progressive loading to show price immediately.
 */
export async function getFastQuote(req: Request, res: Response): Promise<void> {
  try {
    const parsed = tickerParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { ticker } = parsed.data;

    const quote = await fetchFastQuote(ticker);
    if (!quote) {
      res.status(404).json({ error: `No quote data available for ${ticker}` });
      return;
    }
    res.json(quote);
  } catch (error: unknown) {
    console.error('[Market] getFastQuote error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
}

export async function getStockDetails(req: Request, res: Response): Promise<void> {
  try {
    const parsed = tickerParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { ticker } = parsed.data;
    const details = await fetchStockDetails(ticker);
    res.json(details);
  } catch (error: unknown) {
    if (error instanceof TickerNotFoundError) {
      res.status(404).json({ error: 'Stock not found' });
      return;
    }
    console.error('[Market] getStockDetails error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch stock details' });
  }
}

export async function getIntraday(req: Request, res: Response): Promise<void> {
  try {
    const parsed = tickerParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { ticker } = parsed.data;
    const [candles, quote] = await Promise.all([
      fetchIntradayCandles(ticker),
      fetchQuote(ticker).catch(() => null),
    ]);
    // The 1D intraday chart baseline must be YESTERDAY's close so the line shows
    // today's full move from the prior session. `previousClose` is yesterday's
    // close across all quote sources. During POST (after-hours) `regularClose`
    // is TODAY's regular-session close — the WRONG baseline (it would anchor the
    // chart on today's close and flatten/invert the day's shape). Prefer
    // previousClose, falling back to regularClose only if it's missing. (In REG
    // `regularClose` is unset; in PRE it already equals previousClose — so this
    // ordering only changes POST/CLOSED, which is exactly the fix.) Matches the
    // detail chart (anchors on quote.previousClose) and the SPY overlay baseline.
    const previousClose = quote?.previousClose || quote?.regularClose || null;
    res.json({ ticker, candles, previousClose });
  } catch (error: unknown) {
    console.error('[Market] getIntraday error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch intraday data' });
  }
}

export async function getHourlyCandles(req: Request, res: Response): Promise<void> {
  try {
    const parsedParams = tickerParamSchema.safeParse(req.params);
    const parsedQuery = hourlyCandlesQuerySchema.safeParse({
      period: typeof req.query.period === 'string' ? req.query.period.toUpperCase() : req.query.period,
    });
    if (!parsedParams.success || !parsedQuery.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { ticker } = parsedParams.data;
    const { period } = parsedQuery.data;
    const candles = await fetchHourlyCandles(ticker, period);
    res.json({ ticker, candles });
  } catch (error: unknown) {
    console.error('[Market] getHourlyCandles error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch hourly data' });
  }
}

export async function getDailyCandles(req: Request, res: Response): Promise<void> {
  try {
    const parsedParams = tickerParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const ticker = parsedParams.data.ticker;
    const period = (req.query.period as string)?.toUpperCase() || '3M';
    const daysMap: Record<string, number> = {
      '3M': 90,
      '6M': 180,
      'YTD': Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000),
      '1Y': 365, 'ALL': 365 * 5,
    };
    const days = daysMap[period] ?? 90;
    const candles = await fetchDailyCandles(ticker, days);
    res.json({ ticker, candles });
  } catch (error: unknown) {
    console.error('[Market] getDailyCandles error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch daily data' });
  }
}

export async function getCandles(req: Request, res: Response): Promise<void> {
  try {
    const parsedParams = tickerParamSchema.safeParse(req.params);
    const parsedQuery = candleQuerySchema.safeParse({
      period: typeof req.query.period === 'string' ? req.query.period.toUpperCase() : req.query.period,
      interval: normalizeCandleInterval(req.query.interval),
    });
    if (!parsedParams.success || !parsedQuery.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const { ticker } = parsedParams.data;
    const { period, interval } = parsedQuery.data;
    const candles = await fetchCandles(ticker, period, interval);
    res.json({ ticker, period, interval, candles });
  } catch (error: unknown) {
    console.error('[Market] getCandles error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch candles' });
  }
}

export async function searchSymbols(req: Request, res: Response): Promise<void> {
  try {
    const parsed = searchSymbolsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const query = parsed.data.q?.trim();
    const heldParam = parsed.data.held;

    // Parse held tickers from comma-separated list
    const heldTickers = heldParam
      ? heldParam.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
      : [];

    if (!query) {
      res.json({
        results: [],
        meta: { query: '', count: 0, partial: false, cached: false, advPending: [] },
      });
      return;
    }

    const response = await searchTickers(query, heldTickers);
    res.json(response);
  } catch (error: unknown) {
    console.error('[Market] searchSymbols error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to search symbols' });
  }
}

export async function getMarketNews(req: Request, res: Response): Promise<void> {
  try {
    const parsed = marketNewsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const limit = parsed.data.limit ?? 20;
    const news = await fetchMarketNews(limit);
    res.json(news);
  } catch (error: unknown) {
    console.error('[Market] getMarketNews error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch news' });
  }
}

export async function getTickerNews(req: Request, res: Response): Promise<void> {
  try {
    const parsedParams = tickerParamSchema.safeParse(req.params);
    const parsedQuery = tickerNewsQuerySchema.safeParse(req.query);
    if (!parsedParams.success || !parsedQuery.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { ticker } = parsedParams.data;
    const limit = parsedQuery.data.limit ?? 30;
    const news = await fetchTickerNews(ticker, limit);
    res.json(news);
  } catch (error: unknown) {
    console.error('[Market] getTickerNews error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch ticker news' });
  }
}

export async function getBenchmarkClosesHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = benchmarkParamSchema.safeParse({
      ticker: req.params.ticker?.toUpperCase(),
    });
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { ticker } = parsed.data;
    const data = getBenchmarkCandles(ticker);
    if (!data) {
      res.json({ ticker, candles: [] });
      return;
    }
    // Return paired date+close array
    const candles = data.dates.map((date, i) => ({
      date,
      time: new Date(date).getTime(),
      close: data.closes[i],
    }));
    res.json({ ticker, candles });
  } catch (error: unknown) {
    console.error('[Market] getBenchmarkCloses error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch benchmark data' });
  }
}

export async function getETFHoldingsHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = tickerParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { ticker } = parsed.data;

    const holdings = await getETFHoldings(ticker);
    if (!holdings) {
      res.json({ isETF: false });
      return;
    }

    res.json(holdings);
  } catch (error: unknown) {
    console.error('[Market] getETFHoldings error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch ETF holdings' });
  }
}

export async function getAIEventsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const parsedParams = tickerParamSchema.safeParse(req.params);
    const parsedQuery = aiEventsQuerySchema.safeParse(req.query);
    if (!parsedParams.success || !parsedQuery.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { ticker } = parsedParams.data;
    const days = parsedQuery.data.days ?? 90;
    const result = await getAIEvents(ticker, days, req.user.userId);
    res.json(result);
  } catch (error) {
    if (error instanceof EmailVerificationRequiredError) {
      res.status(403).json({ error: 'email_verification_required', message: 'Verify your email to use AI features' });
      return;
    }
    console.error('[Market] getAIEvents error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch AI events' });
  }
}

export async function getAssetAboutHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = tickerParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { ticker } = parsed.data;

    const about = await getAssetAbout(ticker);
    if (!about) {
      res.status(404).json({ error: 'About data not available for this ticker' });
      return;
    }

    res.json(about);
  } catch (error: unknown) {
    console.error('[Market] getAssetAbout error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch asset about data' });
  }
}

export async function askStockQuestionHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const parsedParams = tickerParamSchema.safeParse(req.params);
    const parsedBody = stockQuestionSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { ticker } = parsedParams.data;
    const { question } = parsedBody.data;

    const result = await askStockQuestion(ticker, question, req.user.userId);
    res.json(result);
  } catch (error: unknown) {
    if (error instanceof EmailVerificationRequiredError) {
      res.status(403).json({ error: 'email_verification_required', message: 'Verify your email to use AI features' });
      return;
    }
    if (error instanceof AxiosError && error.response?.status === 429) {
      res.status(429).json({ error: 'Rate limited. Please wait a moment.' });
      return;
    }
    console.error('[Market] stockQ&A error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to get answer' });
  }
}

export async function getHistoricalCAGRHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = historicalCagrQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { tickers } = parsed.data;

    const cagrs = await getHistoricalCAGRs(tickers);
    res.json({ cagrs });
  } catch (error: unknown) {
    console.error('[Market] getHistoricalCAGR error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch historical CAGR data' });
  }
}

export async function getHeatmapHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = heatmapQuerySchema.safeParse({
      period: typeof req.query.period === 'string' ? req.query.period.toUpperCase() : undefined,
      index: typeof req.query.index === 'string' ? req.query.index.toUpperCase() : undefined,
    });
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const period = (parsed.data.period || '1D') as HeatmapPeriod;
    const index = parsed.data.index as MarketIndex | undefined;

    const data = await getHeatmapData(period, index);
    res.json(data);
  } catch (error: unknown) {
    console.error('[Market] getHeatmap error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch heatmap data' });
  }
}

// ── Screener (broader universe than heatmap) ──────────────────
import { getScreenerData } from '../services/market-screener.service';

export async function getMarketScreenerHandler(_req: Request, res: Response): Promise<void> {
  try {
    const data = await getScreenerData();
    res.json(data);
  } catch (error: unknown) {
    console.error('[Market] getScreener error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch screener data' });
  }
}

export async function getMarketSentimentHandler(_req: Request, res: Response): Promise<void> {
  try {
    const sentiment = await getMarketSentiment();
    res.json(sentiment);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Sentiment] Error:', msg);
    res.status(500).json({ error: 'Failed to fetch market sentiment', detail: msg });
  }
}

// ── Nala Score ──────────────────────────────────────────────────
import { getNalaScore } from '../services/nala-score.service';

export async function getNalaScoreHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = tickerParamSchema.safeParse(req.params);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
    const { ticker } = parsed.data;
    const score = await getNalaScore(ticker);
    res.json(score);
  } catch (error: unknown) {
    console.error(`[Market] getNalaScore error for ${req.params.ticker}:`, error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to compute Nala Score' });
  }
}

// ── Themes Heatmap ──────────────────────────────────────────────
import { getThemesHeatmapData } from '../services/themes-heatmap.service';
import { getEtfHeatmapData } from '../services/etf-heatmap.service';

export async function getThemesHeatmapHandler(req: Request, res: Response): Promise<void> {
  try {
    const period = typeof req.query.period === 'string' ? req.query.period.toUpperCase() : '1D';
    const validPeriods = ['1D', '1W', '1M', '3M', '6M', '1Y'];
    const data = await getThemesHeatmapData(
      (validPeriods.includes(period) ? period : '1D') as import('../services/market-heatmap.service').HeatmapPeriod
    );
    res.json(data);
  } catch (error: unknown) {
    console.error('[Market] getThemesHeatmap error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch themes heatmap' });
  }
}

export async function getEtfHeatmapHandler(req: Request, res: Response): Promise<void> {
  try {
    const period = typeof req.query.period === 'string' ? req.query.period.toUpperCase() : '1D';
    const validPeriods = ['1D', '1W', '1M', '3M', '6M', '1Y'];
    const data = await getEtfHeatmapData(
      (validPeriods.includes(period) ? period : '1D') as import('../services/market-heatmap.service').HeatmapPeriod
    );
    res.json(data);
  } catch (error: unknown) {
    console.error('[Market] getEtfHeatmap error:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch ETF heatmap' });
  }
}

export async function getEarningsTrackHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = tickerParamSchema.safeParse(req.params);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
    const { ticker } = parsed.data;
    const track = await getEarningsTrack(ticker);
    res.json(track);
  } catch (error: unknown) {
    console.error(`[Market] getEarningsTrack error for ${req.params.ticker}:`, error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to compute earnings track record' });
  }
}

// ── Value Radar ─────────────────────────────────────────────────
import { getValueRadarData } from '../services/value-radar.service';

export async function getValueRadarHandler(_req: Request, res: Response): Promise<void> {
  try {
    const data = await getValueRadarData();
    res.json(data);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Value Radar] Error:', msg);
    res.status(500).json({ error: 'Failed to fetch value radar data', detail: msg });
  }
}
