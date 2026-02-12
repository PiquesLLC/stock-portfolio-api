import { Request, Response } from 'express';
import { AuthRequest } from '../types/auth';
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

const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

export async function listWatchlistsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const data = await getWatchlists(SYSTEM_USER_ID);
    res.json(data);
  } catch (error) {
    console.error('Watchlist list error:', error);
    res.status(500).json({ error: 'Failed to load watchlists' });
  }
}

export async function getWatchlistHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const watchlist = await getWatchlistDetail(id, SYSTEM_USER_ID);
    if (!watchlist) {
      res.status(404).json({ error: 'Watchlist not found' });
      return;
    }
    res.json(watchlist);
  } catch (error) {
    console.error('Watchlist detail error:', error);
    res.status(500).json({ error: 'Failed to load watchlist' });
  }
}

export async function createWatchlistHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { name, description, color } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const watchlist = await createWatchlist(SYSTEM_USER_ID, { name, description, color });
    res.status(201).json({
      id: watchlist.id,
      name: watchlist.name,
      description: watchlist.description,
      color: watchlist.color,
      holdingsCount: 0,
      createdAt: watchlist.createdAt,
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ error: 'Watchlist name already exists' });
      return;
    }
    console.error('Watchlist create error:', error);
    res.status(500).json({ error: 'Failed to create watchlist' });
  }
}

export async function updateWatchlistHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, description, color } = req.body;
    const updated = await updateWatchlist(id, SYSTEM_USER_ID, { name, description, color });
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
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ error: 'Watchlist name already exists' });
      return;
    }
    console.error('Watchlist update error:', error);
    res.status(500).json({ error: 'Failed to update watchlist' });
  }
}

export async function deleteWatchlistHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const removed = await deleteWatchlist(id, SYSTEM_USER_ID);
    if (!removed) {
      res.status(404).json({ error: 'Watchlist not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('Watchlist delete error:', error);
    res.status(500).json({ error: 'Failed to delete watchlist' });
  }
}

export async function addWatchlistHoldingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { ticker, shares, averageCost } = req.body;
    if (!ticker || typeof ticker !== 'string') {
      res.status(400).json({ error: 'ticker is required' });
      return;
    }
    if (typeof shares !== 'number' || shares <= 0) {
      res.status(400).json({ error: 'shares must be a positive number' });
      return;
    }
    if (typeof averageCost !== 'number' || averageCost < 0) {
      res.status(400).json({ error: 'averageCost must be non-negative' });
      return;
    }

    const holding = await addWatchlistHolding(id, SYSTEM_USER_ID, { ticker, shares, averageCost });
    if (!holding) {
      res.status(404).json({ error: 'Watchlist not found' });
      return;
    }
    res.status(201).json(holding);
  } catch (error) {
    console.error('Watchlist holding add error:', error);
    res.status(500).json({ error: 'Failed to add watchlist holding' });
  }
}

export async function updateWatchlistHoldingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, ticker } = req.params;
    const { shares, averageCost } = req.body;
    if (shares !== undefined && (typeof shares !== 'number' || shares <= 0)) {
      res.status(400).json({ error: 'shares must be a positive number' });
      return;
    }
    if (averageCost !== undefined && (typeof averageCost !== 'number' || averageCost < 0)) {
      res.status(400).json({ error: 'averageCost must be non-negative' });
      return;
    }

    const updated = await updateWatchlistHolding(id, SYSTEM_USER_ID, ticker, { shares, averageCost });
    if (!updated) {
      res.status(404).json({ error: 'Watchlist holding not found' });
      return;
    }
    res.json(updated);
  } catch (error) {
    console.error('Watchlist holding update error:', error);
    res.status(500).json({ error: 'Failed to update watchlist holding' });
  }
}

export async function removeWatchlistHoldingHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, ticker } = req.params;
    const removed = await removeWatchlistHolding(id, SYSTEM_USER_ID, ticker);
    if (!removed) {
      res.status(404).json({ error: 'Watchlist holding not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('Watchlist holding delete error:', error);
    res.status(500).json({ error: 'Failed to delete watchlist holding' });
  }
}
