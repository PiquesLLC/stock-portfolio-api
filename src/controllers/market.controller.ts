import { Request, Response } from 'express';
import { fetchPrices, fetchQuote, searchTickers, fetchStockDetails, fetchIntradayCandles, fetchHourlyCandles } from '../services/market.service';
import { getBenchmarkCandles } from '../utils/candle-cache';
import { fetchMarketNews } from '../services/news.service';
import { getETFHoldings, getAssetAbout } from '../utils/yahoo-finance';

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
      res.status(404).json({ error: 'Holdings data not available for this ticker' });
      return;
    }

    res.json(holdings);
  } catch (error) {
    console.error('Error fetching ETF holdings:', error);
    res.status(500).json({ error: 'Failed to fetch ETF holdings' });
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
