import { Response } from 'express';
import { getTaxHarvestSuggestions } from '../services/tax-harvest.service';
import { AuthRequest } from '../types/auth';
import { validatePortfolioOwnership } from '../utils/validatePortfolioOwnership';

export async function getTaxHarvestHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    await validatePortfolioOwnership(portfolioId, req.user!.userId);
    const result = await getTaxHarvestSuggestions(req.user!.userId, portfolioId);
    res.json(result);
  } catch (error: unknown) {
    const status = (error as any)?.status;
    if (status === 404) {
      res.status(404).json({ error: 'Portfolio not found' });
      return;
    }
    console.error('[Tax Harvest] Error:');
    res.status(500).json({ error: 'Failed to compute tax harvest suggestions' });
  }
}
