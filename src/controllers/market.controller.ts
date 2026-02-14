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
    const tickersParam = req.query.tickers as string;

    if (!tickersParam) {
      res.status(400).json({ error: 'Missing required query parameter: tickers' });
      return;
    }

    const tickers = tickersParam.split(',').map((t) => t.trim().toUpperCase());

    if (tickers.length === 0) {
      res.status(400).json({ error: 'No valid tickers provided' });
      return;
    }

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
  } catch (error) {
    console.error('Error fetching prices:', error);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
}

export async function getQuote(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();

    if (!ticker) {
      res.status(400).json({ error: 'Missing ticker parameter' });
      return;
    }

    const quote = await fetchQuote(ticker);
    res.json(quote);
  } catch (error) {
    console.error('Error fetching quote:', error);
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
}

/**
 * Fast quote endpoint using Yahoo Finance directly - no queue delays.
 * Used for progressive loading to show price immediately.
 */
export async function getFastQuote(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();

    if (!ticker) {
      res.status(400).json({ error: 'Missing ticker parameter' });
      return;
    }

    const quote = await fetchFastQuote(ticker);
    if (!quote) {
      res.status(404).json({ error: `No quote data available for ${ticker}` });
      return;
    }
    res.json(quote);
  } catch (error) {
    console.error('Error fetching fast quote:', error);
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
}

export async function getStockDetails(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    if (!ticker) {
      res.status(400).json({ error: 'Missing ticker parameter' });
      return;
    }
    const details = await fetchStockDetails(ticker);
    res.json(details);
  } catch (error) {
    console.error('Error fetching stock details:', error);
    res.status(500).json({ error: 'Failed to fetch stock details' });
  }
}

export async function getIntraday(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    if (!ticker) {
      res.status(400).json({ error: 'Missing ticker parameter' });
      return;
    }
    const candles = await fetchIntradayCandles(ticker);
    res.json({ ticker, candles });
  } catch (error) {
    console.error('Error fetching intraday data:', error);
    res.status(500).json({ error: 'Failed to fetch intraday data' });
  }
}

export async function getHourlyCandles(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    const period = req.query.period as string;
    if (!ticker) {
      res.status(400).json({ error: 'Missing ticker parameter' });
      return;
    }
    if (period !== '1W' && period !== '1M') {
      res.status(400).json({ error: 'Period must be 1W or 1M' });
      return;
    }
    const candles = await fetchHourlyCandles(ticker, period);
    res.json({ ticker, candles });
  } catch (error) {
    console.error('Error fetching hourly candles:', error);
    res.status(500).json({ error: 'Failed to fetch hourly data' });
  }
}

export async function getDailyCandles(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    const period = (req.query.period as string)?.toUpperCase() || '3M';
    if (!ticker) {
      res.status(400).json({ error: 'Missing ticker parameter' });
      return;
    }
    const daysMap: Record<string, number> = {
      '3M': 90, 'YTD': Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000),
      '1Y': 365, 'ALL': 365 * 5,
    };
    const days = daysMap[period] ?? 90;
    const candles = await fetchDailyCandles(ticker, days);
    res.json({ ticker, candles });
  } catch (error) {
    console.error('Error fetching daily candles:', error);
    res.status(500).json({ error: 'Failed to fetch daily data' });
  }
}

export async function searchSymbols(req: Request, res: Response): Promise<void> {
  try {
    const query = (req.query.q as string)?.trim();
    const heldParam = req.query.held as string | undefined;

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
  } catch (error) {
    console.error('Error searching symbols:', error);
    res.status(500).json({ error: 'Failed to search symbols' });
  }
}

export async function getMarketNews(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const news = await fetchMarketNews(limit);
    res.json(news);
  } catch (error) {
    console.error('Error fetching market news:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
}

export async function getTickerNews(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    if (!ticker) { res.status(400).json({ error: 'Ticker required' }); return; }
    const limit = Math.min(parseInt(req.query.limit as string) || 30, 50);
    const news = await fetchTickerNews(ticker, limit);
    res.json(news);
  } catch (error) {
    console.error('Error fetching ticker news:', error);
    res.status(500).json({ error: 'Failed to fetch ticker news' });
  }
}

export async function getBenchmarkClosesHandler(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    const validBenchmarks = ['SPY', 'QQQ', 'DIA'];
    if (!ticker || !validBenchmarks.includes(ticker)) {
      res.status(400).json({ error: `Invalid benchmark. Must be one of: ${validBenchmarks.join(', ')}` });
      return;
    }
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
  } catch (error) {
    console.error('Error fetching benchmark closes:', error);
    res.status(500).json({ error: 'Failed to fetch benchmark data' });
  }
}

export async function getETFHoldingsHandler(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    if (!ticker) {
      res.status(400).json({ error: 'Missing ticker parameter' });
      return;
    }

    const holdings = await getETFHoldings(ticker);
    if (!holdings) {
      res.json({ isETF: false });
      return;
    }

    res.json(holdings);
  } catch (error) {
    console.error('Error fetching ETF holdings:', error);
    res.status(500).json({ error: 'Failed to fetch ETF holdings' });
  }
}

export async function getAIEventsHandler(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    if (!ticker) { res.status(400).json({ error: 'Ticker required' }); return; }
    const days = Math.min(parseInt(req.query.days as string) || 90, 7300); // up to ~20 years for MAX
    const result = await getAIEvents(ticker, days);
    res.json(result);
  } catch (error) {
    console.error('Error fetching AI events:', error);
    res.status(500).json({ error: 'Failed to fetch AI events' });
  }
}

export async function getAssetAboutHandler(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    if (!ticker) {
      res.status(400).json({ error: 'Missing ticker parameter' });
      return;
    }

    const about = await getAssetAbout(ticker);
    if (!about) {
      res.status(404).json({ error: 'About data not available for this ticker' });
      return;
    }

    res.json(about);
  } catch (error) {
    console.error('Error fetching asset about:', error);
    res.status(500).json({ error: 'Failed to fetch asset about data' });
  }
}

export async function askStockQuestionHandler(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    if (!ticker) { res.status(400).json({ error: 'Ticker required' }); return; }

    const { question } = req.body;
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      res.status(400).json({ error: 'Question is required' });
      return;
    }
    if (question.length > 500) {
      res.status(400).json({ error: 'Question too long (max 500 characters)' });
      return;
    }

    const result = await askStockQuestion(ticker, question.trim());
    res.json(result);
  } catch (error: any) {
    if (error.response?.status === 429) {
      res.status(429).json({ error: 'Rate limited. Please wait a moment.' });
      return;
    }
    console.error('Error in stock Q&A:', error);
    res.status(500).json({ error: 'Failed to get answer' });
  }
}

export async function getHistoricalCAGRHandler(req: Request, res: Response): Promise<void> {
  try {
    const tickersParam = req.query.tickers as string;
    if (!tickersParam) {
      res.status(400).json({ error: 'Missing required query parameter: tickers' });
      return;
    }

    const tickers = tickersParam.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    if (tickers.length === 0) {
      res.status(400).json({ error: 'No valid tickers provided' });
      return;
    }
    if (tickers.length > 50) {
      res.status(400).json({ error: 'Too many tickers (max 50)' });
      return;
    }

    const cagrs = await getHistoricalCAGRs(tickers);
    res.json({ cagrs });
  } catch (error) {
    console.error('Error fetching historical CAGR:', error);
    res.status(500).json({ error: 'Failed to fetch historical CAGR data' });
  }
}

export async function getHeatmapHandler(req: Request, res: Response): Promise<void> {
  try {
    const validPeriods: HeatmapPeriod[] = ['1D', '1W', '1M', '3M', '6M', '1Y'];
    const periodParam = ((req.query.period as string) || '1D').toUpperCase() as HeatmapPeriod;
    const period = validPeriods.includes(periodParam) ? periodParam : '1D';

    const validIndexes: MarketIndex[] = ['SP500', 'DOW30', 'NASDAQ100'];
    const indexParam = (req.query.index as string)?.toUpperCase() as MarketIndex | undefined;
    const index = indexParam && validIndexes.includes(indexParam) ? indexParam : undefined;

    const data = await getHeatmapData(period, index);
    res.json(data);
  } catch (error) {
    console.error('Error fetching heatmap data:', error);
    res.status(500).json({ error: 'Failed to fetch heatmap data' });
  }
}

// ── Nala Score ──────────────────────────────────────────────────
import { getNalaScore } from '../services/nala-score.service';

export async function getNalaScoreHandler(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    if (!ticker) { res.status(400).json({ error: 'Missing ticker' }); return; }
    const score = await getNalaScore(ticker);
    res.json(score);
  } catch (error) {
    console.error(`[Nala Score] Error for ${req.params.ticker}:`, error);
    res.status(500).json({ error: 'Failed to compute Nala Score' });
  }
}

export async function getEarningsTrackHandler(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    if (!ticker) { res.status(400).json({ error: 'Missing ticker' }); return; }
    const track = await getEarningsTrack(ticker);
    res.json(track);
  } catch (error) {
    console.error(`[Earnings Track] Error for ${req.params.ticker}:`, error);
    res.status(500).json({ error: 'Failed to compute earnings track record' });
  }
}
