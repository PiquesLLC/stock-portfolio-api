import { Request, Response } from 'express';
import {
  getPortfolio,
  upsertHolding,
  deleteHolding,
  updateCashBalance,
} from '../services/portfolio.service';
import { createSnapshotIfNeeded, getAllSnapshots } from '../services/snapshot.service';
import {
  getSP500Projections,
  getRealizedProjections,
  getMetrics,
  getPaceProjection,
  getCurrentPaceProjection,
} from '../services/projection.service';
import { LookbackPeriod, ProjectionMode, PaceWindow } from '../types';

const VALID_MODES: ProjectionMode[] = ['sp500', 'realized'];
const VALID_LOOKBACKS: LookbackPeriod[] = ['1d', '1w', '1m', '6m', '1y', 'max'];

export async function getPortfolioHandler(req: Request, res: Response): Promise<void> {
  try {
    await createSnapshotIfNeeded();

    const portfolio = await getPortfolio();

    // Calculate pace projections (uses totalAssets - assets only, no margin)
    const paceProjection = await getPaceProjection(portfolio.totalAssets);

    res.json({
      ...portfolio,
      paceProjection,
    });
  } catch (error) {
    console.error('Error fetching portfolio:', error);
    res.status(500).json({ error: 'Failed to fetch portfolio' });
  }
}

export async function addHolding(req: Request, res: Response): Promise<void> {
  try {
    const { ticker, shares, averageCost } = req.body;

    if (!ticker || typeof ticker !== 'string') {
      res.status(400).json({ error: 'Missing or invalid ticker' });
      return;
    }

    if (typeof shares !== 'number' || shares <= 0) {
      res.status(400).json({ error: 'Invalid shares: must be a positive number' });
      return;
    }

    if (typeof averageCost !== 'number' || averageCost <= 0) {
      res.status(400).json({ error: 'Invalid averageCost: must be a positive number' });
      return;
    }

    const holding = await upsertHolding({ ticker, shares, averageCost });
    res.status(201).json(holding);
  } catch (error) {
    console.error('Error adding holding:', error);
    res.status(500).json({ error: 'Failed to add holding' });
  }
}

export async function removeHolding(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();

    if (!ticker) {
      res.status(400).json({ error: 'Missing ticker parameter' });
      return;
    }

    await deleteHolding(ticker);
    res.status(204).send();
  } catch (error: any) {
    if (error?.code === 'P2025') {
      res.status(404).json({ error: 'Holding not found' });
      return;
    }
    console.error('Error removing holding:', error);
    res.status(500).json({ error: 'Failed to remove holding' });
  }
}

export async function setCashBalance(req: Request, res: Response): Promise<void> {
  try {
    const { cashBalance } = req.body;

    if (typeof cashBalance !== 'number' || cashBalance < 0) {
      res.status(400).json({ error: 'Invalid cashBalance: must be a non-negative number' });
      return;
    }

    const settings = await updateCashBalance(cashBalance);
    res.json({ cashBalance: settings.cashBalance });
  } catch (error) {
    console.error('Error updating cash balance:', error);
    res.status(500).json({ error: 'Failed to update cash balance' });
  }
}

export async function getHistory(req: Request, res: Response): Promise<void> {
  try {
    const snapshots = await getAllSnapshots();
    res.json(snapshots);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
}

export async function getProjectionsHandler(req: Request, res: Response): Promise<void> {
  try {
    const mode = (req.query.mode as ProjectionMode) || 'sp500';
    const lookback = (req.query.lookback as LookbackPeriod) || '1y';

    // Validate mode
    if (!VALID_MODES.includes(mode)) {
      res.status(400).json({
        error: `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}`,
      });
      return;
    }

    // Validate lookback for realized mode
    if (mode === 'realized' && !VALID_LOOKBACKS.includes(lookback)) {
      res.status(400).json({
        error: `Invalid lookback. Must be one of: ${VALID_LOOKBACKS.join(', ')}`,
      });
      return;
    }

    let projections;
    if (mode === 'sp500') {
      projections = await getSP500Projections();
    } else {
      projections = await getRealizedProjections(lookback);
    }

    res.json(projections);
  } catch (error) {
    console.error('Error calculating projections:', error);
    res.status(500).json({ error: 'Failed to calculate projections' });
  }
}

export async function getMetricsHandler(req: Request, res: Response): Promise<void> {
  try {
    const lookback = (req.query.lookback as LookbackPeriod) || '1y';

    if (!VALID_LOOKBACKS.includes(lookback)) {
      res.status(400).json({
        error: `Invalid lookback. Must be one of: ${VALID_LOOKBACKS.join(', ')}`,
      });
      return;
    }

    const metrics = await getMetrics(lookback);
    res.json(metrics);
  } catch (error) {
    console.error('Error calculating metrics:', error);
    res.status(500).json({ error: 'Failed to calculate metrics' });
  }
}

const VALID_PACE_WINDOWS: PaceWindow[] = ['1D', '1M', '6M', '1Y', 'YTD'];

export async function getCurrentPaceHandler(req: Request, res: Response): Promise<void> {
  try {
    const window = ((req.query.window as string) || '1M').toUpperCase() as PaceWindow;

    if (!VALID_PACE_WINDOWS.includes(window)) {
      res.status(400).json({
        error: `Invalid window. Must be one of: ${VALID_PACE_WINDOWS.join(', ')}`,
      });
      return;
    }

    const ytdMode = ((req.query.mode as string) || 'holdings').toLowerCase() as 'holdings' | 'true';
    const result = await getCurrentPaceProjection(window, ytdMode);
    res.json(result);
  } catch (error) {
    console.error('Error calculating current pace:', error);
    res.status(500).json({ error: 'Failed to calculate current pace' });
  }
}
