import { Request, Response } from 'express';
import { generatePerformanceCard, generateStockShareCard } from '../services/share-card.service';

const VALID_PERIODS = new Set(['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', 'ALL']);

export async function getStockShareCardHandler(req: Request, res: Response): Promise<void> {
  try {
    const ticker = req.params.ticker?.toUpperCase();
    if (!ticker) {
      res.status(400).json({ error: 'ticker is required' });
      return;
    }

    const raw = typeof req.query.period === 'string' ? req.query.period.toUpperCase() : '1W';
    const period = raw === 'MAX' ? 'ALL' : raw;
    const tz = typeof req.query.tz === 'string' ? req.query.tz : undefined;
    const pngBuffer = await generateStockShareCard(ticker, period, tz);
    if (!pngBuffer) {
      res.status(404).json({ error: 'Stock data unavailable' });
      return;
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(pngBuffer);
  } catch (err) {
    console.error('Stock share card generation failed:', err);
    res.status(500).json({ error: 'Failed to generate stock share card' });
  }
}

export async function getPerformanceCardHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    const periodRaw = typeof req.query.period === 'string' ? req.query.period.toUpperCase() : '1M';
    if (!VALID_PERIODS.has(periodRaw)) {
      res.status(400).json({ error: 'period must be one of: 1D, 1W, 1M, 3M, 6M, YTD, 1Y, ALL' });
      return;
    }

    const tz = typeof req.query.tz === 'string' ? req.query.tz : undefined;
    const pngBuffer = await generatePerformanceCard(userId, periodRaw, tz);
    if (!pngBuffer) {
      res.status(404).json({ error: 'User not found or profile is private' });
      return;
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="nala-performance-${periodRaw}.png"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(pngBuffer);
  } catch (err) {
    console.error('Performance share card generation failed:', err);
    res.status(500).json({ error: 'Failed to generate performance share card' });
  }
}
