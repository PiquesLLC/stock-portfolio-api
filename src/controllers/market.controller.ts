import { Request, Response } from 'express';
import { fetchPrices, fetchQuote, fetchFastQuote, searchTickers, fetchStockDetails, fetchIntradayCandles, fetchHourlyCandles, fetchDailyCandles } from '../services/market.service';
import { getBenchmarkCandles } from '../utils/candle-cache';
import { fetchMarketNews, fetchTickerNews } from '../services/news.service';
import { getETFHoldings, getAssetAbout } from '../utils/yahoo-finance';
import { getAIEvents } from '../services/perplexity-events.service';
import { askStockQuestion } from '../services/perplexity-qa.service';
import { getHistoricalCAGRs } from '../services/historical-cagr.service';
import { getHeatmapData, HeatmapPeriod } from '../services/market-heatmap.service';
import { getEarningsTrack } from '../services/earnings-track.service';
import { MarketIndex } from '../utils/sectors';
import { AxiosError } from 'axios';
import { AuthRequest } from '../types/auth';
import { EmailVerificationRequiredError } from '../services/email-verification-guard.service';
import {
  aiEventsQuerySchema,
  benchmarkParamSchema,
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
  } catch (_error) {
    console.error('Error fetching prices:');
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
  } catch (_error) {
    console.error('Error fetching quote:');
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
  } catch (_error) {
    console.error('Error fetching fast quote:');
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
  } catch (_error) {
    console.error('Error fetching stock details:');
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
    const candles = await fetchIntradayCandles(ticker);
    res.json({ ticker, candles });
  } catch (_error) {
    console.error('Error fetching intraday data:');
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
  } catch (_error) {
    console.error('Error fetching hourly candles:');
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
  } catch (_error) {
    console.error('Error fetching daily candles:');
    res.status(500).json({ error: 'Failed to fetch daily data' });
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
  } catch (_error) {
    console.error('Error searching symbols:');
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
  } catch (_error) {
    console.error('Error fetching market news:');
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
  } catch (_error) {
    console.error('Error fetching ticker news:');
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
  } catch (_error) {
    console.error('Error fetching benchmark closes:');
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
  } catch (_error) {
    console.error('Error fetching ETF holdings:');
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
    console.error('Error fetching AI events:');
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
  } catch (_error) {
    console.error('Error fetching asset about:');
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
    console.error('Error in stock Q&A:');
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
  } catch (_error) {
    console.error('Error fetching historical CAGR:');
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
  } catch (_error) {
    console.error('Error fetching heatmap data:');
    res.status(500).json({ error: 'Failed to fetch heatmap data' });
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
  } catch (_error) {
    console.error(`[Nala Score] Error for ${req.params.ticker}:`);
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
  } catch (_error) {
    console.error('Error fetching themes heatmap:');
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
  } catch (_error) {
    console.error('Error fetching ETF heatmap:');
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
  } catch (_error) {
    console.error(`[Earnings Track] Error for ${req.params.ticker}:`);
    res.status(500).json({ error: 'Failed to compute earnings track record' });
  }
}
