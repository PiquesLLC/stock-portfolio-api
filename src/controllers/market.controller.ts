import { Request, Response } from 'express';
import { fetchPrices, fetchQuote } from '../services/market.service';

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

    const { quotes, staleCount, failedTickers } = await fetchPrices(tickers);

    const result: Record<string, { price: number; change: number; changePercent: number; isStale?: boolean }> = {};
    for (const [ticker, quote] of quotes) {
      result[ticker] = {
        price: quote.currentPrice,
        change: quote.change,
        changePercent: quote.changePercent,
        isStale: quote.isStale,
      };
    }

    // Include metadata about staleness
    const response = {
      prices: result,
      meta: {
        staleCount,
        failedTickers,
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
