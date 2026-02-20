import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import {
  followStock,
  getMostFollowedStocks,
  getMyFollowedSymbols,
  getStockFollowStatus,
  isValidSymbol,
  unfollowStock,
} from '../services/stock-follow.service';

function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}

function parseSymbol(req: AuthRequest, res: Response): string | null {
  const symbol = normalizeSymbol(req.params.symbol || '');
  if (!symbol || !isValidSymbol(symbol)) {
    res.status(400).json({ error: 'Invalid symbol' });
    return null;
  }
  return symbol;
}

// POST /stock-follows/:symbol
export async function followStockHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const symbol = parseSymbol(req, res);
    if (!symbol) return;

    await followStock(userId, symbol);
    res.json({ ok: true, symbol });
  } catch (_error) {
    console.error('Error following stock:');
    res.status(500).json({ error: 'Failed to follow stock' });
  }
}

// DELETE /stock-follows/:symbol
export async function unfollowStockHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const symbol = parseSymbol(req, res);
    if (!symbol) return;

    await unfollowStock(userId, symbol);
    res.json({ ok: true, symbol });
  } catch (_error) {
    console.error('Error unfollowing stock:');
    res.status(500).json({ error: 'Failed to unfollow stock' });
  }
}

// GET /stock-follows/:symbol/status
export async function getStockFollowStatusHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const symbol = parseSymbol(req, res);
    if (!symbol) return;

    const status = await getStockFollowStatus(req.user?.userId, symbol);
    res.json(status);
  } catch (_error) {
    console.error('Error fetching stock follow status:');
    res.status(500).json({ error: 'Failed to fetch stock follow status' });
  }
}

// GET /stock-follows/most-followed
export async function getMostFollowedStocksHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
    const items = await getMostFollowedStocks(limit);
    res.json(items);
  } catch (_error) {
    console.error('Error fetching most-followed stocks:');
    res.status(500).json({ error: 'Failed to fetch most-followed stocks' });
  }
}

// GET /stock-follows/mine
export async function getMyStockFollowsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const symbols = await getMyFollowedSymbols(userId);
    res.json(symbols);
  } catch (_error) {
    console.error('Error fetching my stock follows:');
    res.status(500).json({ error: 'Failed to fetch followed symbols' });
  }
}

