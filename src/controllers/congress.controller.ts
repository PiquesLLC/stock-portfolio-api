import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import {
  getRecentCongressTrades,
  getCongressTradesForPortfolio,
  getCongressTradesForTicker,
  getCongressStats,
} from '../services/congress.service';

// GET /signals/congress — list recent trades (paginated, filterable)
export async function listCongressTradesHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const ticker = typeof req.query.ticker === 'string' ? req.query.ticker : undefined;
    const chamber = typeof req.query.chamber === 'string' ? req.query.chamber : undefined;
    const transactionType = typeof req.query.type === 'string' ? req.query.type : undefined;
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 100);
    const offset = parseInt(String(req.query.offset)) || 0;

    const result = await getRecentCongressTrades({ ticker, chamber, transactionType, limit, offset });
    res.json(result);
  } catch (err) {
    console.error('Failed to list congress trades:', err);
    res.status(500).json({ error: 'Failed to fetch congress trades' });
  }
}

// GET /signals/congress/portfolio — trades matching user's holdings
export async function portfolioCongressTradesHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ error: 'Auth required' }); return; }
    const result = await getCongressTradesForPortfolio(req.user.userId);
    res.json(result);
  } catch (err) {
    console.error('Failed to get portfolio congress trades:', err);
    res.status(500).json({ error: 'Failed to fetch congress trades for portfolio' });
  }
}

// GET /signals/congress/ticker/:ticker — trades for a specific ticker
export async function tickerCongressTradesHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { ticker } = req.params;
    if (!ticker) { res.status(400).json({ error: 'ticker required' }); return; }
    const trades = await getCongressTradesForTicker(ticker);
    res.json({ trades, ticker: ticker.toUpperCase() });
  } catch (err) {
    console.error('Failed to get ticker congress trades:', err);
    res.status(500).json({ error: 'Failed to fetch congress trades for ticker' });
  }
}

// GET /signals/congress/stats — aggregate stats
export async function congressStatsHandler(_req: AuthRequest, res: Response): Promise<void> {
  try {
    const stats = await getCongressStats();
    res.json(stats);
  } catch (err) {
    console.error('Failed to get congress stats:', err);
    res.status(500).json({ error: 'Failed to fetch congress stats' });
  }
}
