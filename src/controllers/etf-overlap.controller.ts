import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { getEtfOverlap } from '../services/etf-overlap.service';
import { validatePortfolioOwnership } from '../utils/validatePortfolioOwnership';

export async function getEtfOverlapHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    await validatePortfolioOwnership(portfolioId, req.user!.userId);
    const data = await getEtfOverlap(req.user!.userId, portfolioId);
    res.json(data);
  } catch (error: unknown) {
    const status = (error as any)?.status;
    if (status === 404) {
      res.status(404).json({ error: 'Portfolio not found' });
      return;
    }
    console.error('Error fetching ETF overlap:');
    res.status(500).json({ error: 'Failed to fetch ETF overlap' });
  }
}
