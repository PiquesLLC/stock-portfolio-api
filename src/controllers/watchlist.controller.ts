import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import prisma from '../utils/prisma';
import {
  getWatchlists,
  getWatchlistDetail,
  createWatchlist,
  updateWatchlist,
  deleteWatchlist,
  addWatchlistHolding,
  updateWatchlistHolding,
  removeWatchlistHolding,
} from '../services/watchlist.service';
import {
  reconstructPortfolioHistory,
  reconstructPortfolioHistoryHiRes,
} from '../services/snapshot.service';
import { fetchPrices } from '../services/market.service';
import { invalidateAllNewsCache, invalidateTickerNewsCache } from '../services/news.service';
import {
  addWatchlistHoldingSchema,
  createWatchlistSchema,
  updateWatchlistHoldingSchema,
  updateWatchlistSchema,
  watchlistChartQuerySchema,
  watchlistIdParamSchema,
  watchlistIdTickerParamSchema,
} from '../validators/watchlist.validators';
import { PlanLimitError } from '../utils/plan-limit.error';

export async function listWatchlistsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const data = await getWatchlists(req.user!.userId);
    res.json(data);
  } catch (error: unknown) {
    console.error('Watchlist list error:');
    res.status(500).json({ error: 'Failed to load watchlists' });
  }
}

export async function getWatchlistHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsedParams = watchlistIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { id } = parsedParams.data;
    const watchlist = await getWatchlistDetail(id, req.user!.userId);
    if (!watchlist) {
      res.status(404).json({ error: 'Watchlist not found' });
      return;
    }
    res.json(watchlist);
  } catch (error: unknown) {
    console.error('Watchlist detail error:');
    res.status(500).json({ error: 'Failed to load watchlist' });
  }
}

export async function createWatchlistHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsedBody = createWatchlistSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { name, description, color } = parsedBody.data;
    const watchlist = await createWatchlist(req.user!.userId, { name, description, color });
    res.status(201).json({
      id: watchlist.id,
      name: watchlist.name,
      description: watchlist.description,
      color: watchlist.color,
      holdingsCount: 0,
      createdAt: watchlist.createdAt,
    });
  } catch (error: unknown) {
    if (error instanceof PlanLimitError) {
      res.status(403).json({ error: 'limit_reached', limit: error.limit, plan: error.plan });
      return;
    }
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Watchlist name already exists' });
      return;
    }
    console.error('Watchlist create error:');
    res.status(500).json({ error: 'Failed to create watchlist' });
  }
}

export async function updateWatchlistHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsedParams = watchlistIdParamSchema.safeParse(req.params);
    const parsedBody = updateWatchlistSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { id } = parsedParams.data;
    const { name, description, color } = parsedBody.data;
    const updated = await updateWatchlist(id, req.user!.userId, { name, description, color });
    if (!updated) {
      res.status(404).json({ error: 'Watchlist not found' });
      return;
    }
    const holdingsCount = await prisma.watchlistHolding.count({ where: { watchlistId: updated.id } });
    res.json({
      id: updated.id,
      name: updated.name,
      description: updated.description,
      color: updated.color,
      holdingsCount,
      createdAt: updated.createdAt,
    });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Watchlist name already exists' });
      return;
    }
    console.error('Watchlist update error:');
    res.status(500).json({ error: 'Failed to update watchlist' });
  }
}

export async function deleteWatchlistHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsedParams = watchlistIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { id } = parsedParams.data;
    const removed = await deleteWatchlist(id, req.user!.userId);
    if (!removed) {
      res.status(404).json({ error: 'Watchlist not found' });
      return;
    }
    try {
      invalidateAllNewsCache();
    } catch { /* non-critical */ }
    res.status(204).send();
  } catch (error: unknown) {
    console.error('Watchlist delete error:');
    res.status(500).json({ error: 'Failed to delete watchlist' });
  }
}

export async function addWatchlistHoldingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsedParams = watchlistIdParamSchema.safeParse(req.params);
    const parsedBody = addWatchlistHoldingSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { id } = parsedParams.data;
    const { ticker, shares, averageCost } = parsedBody.data;

    const holding = await addWatchlistHolding(id, req.user!.userId, { ticker, shares, averageCost });
    if (!holding) {
      res.status(404).json({ error: 'Watchlist not found' });
      return;
    }
    try {
      invalidateTickerNewsCache(ticker);
    } catch { /* non-critical */ }
    res.status(201).json(holding);
  } catch (error: unknown) {
    console.error('Watchlist holding add error:');
    res.status(500).json({ error: 'Failed to add watchlist holding' });
  }
}

export async function updateWatchlistHoldingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsedParams = watchlistIdTickerParamSchema.safeParse(req.params);
    const parsedBody = updateWatchlistHoldingSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { id, ticker } = parsedParams.data;
    const { shares, averageCost } = parsedBody.data;

    const updated = await updateWatchlistHolding(id, req.user!.userId, ticker, { shares, averageCost });
    if (!updated) {
      res.status(404).json({ error: 'Watchlist holding not found' });
      return;
    }
    try {
      invalidateTickerNewsCache(ticker);
    } catch { /* non-critical */ }
    res.json(updated);
  } catch (error: unknown) {
    console.error('Watchlist holding update error:');
    res.status(500).json({ error: 'Failed to update watchlist holding' });
  }
}

export async function removeWatchlistHoldingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsedParams = watchlistIdTickerParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { id, ticker } = parsedParams.data;
    const removed = await removeWatchlistHolding(id, req.user!.userId, ticker);
    if (!removed) {
      res.status(404).json({ error: 'Watchlist holding not found' });
      return;
    }
    try {
      invalidateTickerNewsCache(ticker);
    } catch { /* non-critical */ }
    res.status(204).send();
  } catch (error: unknown) {
    console.error('Watchlist holding delete error:');
    res.status(500).json({ error: 'Failed to delete watchlist holding' });
  }
}

export async function getWatchlistChartHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsedParams = watchlistIdParamSchema.safeParse(req.params);
    const parsedQuery = watchlistChartQuerySchema.safeParse({
      period: typeof req.query.period === 'string' ? req.query.period.toUpperCase() : undefined,
    });
    if (!parsedParams.success || !parsedQuery.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { id } = parsedParams.data;
    const period = parsedQuery.data.period || '1D';

    const watchlist = await prisma.watchlist.findFirst({
      where: { id, userId: req.user!.userId },
      select: { id: true, holdings: { select: { ticker: true, shares: true } } },
    });

    if (!watchlist) {
      res.status(404).json({ error: 'Watchlist not found' });
      return;
    }

    const holdings = watchlist.holdings.map(h => ({ ticker: h.ticker, shares: h.shares }));
    if (holdings.length === 0) {
      res.json({ points: [], periodStartValue: 0, period });
      return;
    }

    let points: { time: number; value: number }[] = [];
    const now = Date.now();

    if (period === '1D') {
      points = await reconstructPortfolioHistoryHiRes(holdings, 0, 0, '1d', '5m');
    } else if (period === '1W') {
      points = await reconstructPortfolioHistoryHiRes(holdings, 0, 0, '5d', '15m');
    } else if (period === '1M') {
      points = await reconstructPortfolioHistoryHiRes(holdings, 0, 0, '1mo', '1h');
    } else if (period === 'YTD') {
      const ytdDays = Math.floor((now - new Date(new Date().getFullYear(), 0, 1).getTime()) / 86400000);
      if (ytdDays <= 90) {
        const yahooRange = ytdDays <= 30 ? '1mo' : '3mo';
        points = await reconstructPortfolioHistoryHiRes(holdings, 0, 0, yahooRange as any, '1h');
        const ytdStart = new Date(new Date().getFullYear(), 0, 1).getTime();
        points = points.filter(p => p.time >= ytdStart);
      } else {
        points = await reconstructPortfolioHistory(holdings, 0, ytdDays, 0);
      }
    } else {
      const periodDaysMap: Record<string, number> = {
        '3M': 90,
        '6M': 180,
        '1Y': 365,
        'ALL': 365 * 5,
      };
      const periodDays = periodDaysMap[period] ?? 30;
      points = await reconstructPortfolioHistory(holdings, 0, periodDays, 0);
    }

    // Fetch live quotes for offset normalization + live point append
    const tickers = holdings.map(h => h.ticker.toUpperCase());
    const { quotes } = await fetchPrices(tickers);
    let liveValue = 0;
    let previousCloseValue = 0;
    for (const h of holdings) {
      const q = quotes.get(h.ticker.toUpperCase());
      liveValue += h.shares * (q?.currentPrice ?? 0);
      previousCloseValue += h.shares * (q?.previousClose ?? q?.currentPrice ?? 0);
    }

    // Normalize candle-based chart points to match live portfolio value.
    // Candle prices (Yahoo) can differ from live quotes (Finnhub),
    // and some tickers may lack candle data entirely. Adding a constant offset
    // keeps the chart shape intact while aligning with the actual portfolio value.
    if (points.length > 0 && liveValue > 0) {
      const lastCandleVal = points[points.length - 1].value;
      const offset = liveValue - lastCandleVal;
      if (Math.abs(offset) > 1) {
        for (const p of points) p.value += offset;
      }
    }

    // Append live value so the chart line always reaches "now"
    if (points.length > 0 && (period === '1D' || period === '1W')) {
      const lastPt = points[points.length - 1];
      if (now - lastPt.time > 10_000 && liveValue > 0) {
        points.push({ time: now, value: liveValue });
      }
    }

    // For 1D, use previousCloseValue so chart change matches summary dayChange.
    // For other periods, use the first data point.
    const periodStartValue = period === '1D'
      ? (previousCloseValue || (points.length > 0 ? points[0].value : 0))
      : (points.length > 0 ? points[0].value : 0);
    res.json({ points, periodStartValue, period });
  } catch (error: unknown) {
    console.error('Watchlist chart error:');
    res.status(500).json({
      error: 'Failed to fetch watchlist chart',
    });
  }
}
