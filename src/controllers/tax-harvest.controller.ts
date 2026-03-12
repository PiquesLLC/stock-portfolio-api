import { Response } from 'express';
import { getTaxHarvestSuggestions } from '../services/tax-harvest.service';
import { AuthRequest } from '../types/auth';

export async function getTaxHarvestHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    const result = await getTaxHarvestSuggestions(req.user!.userId, portfolioId);
    res.json(result);
  } catch (error: unknown) {
    console.error('[Tax Harvest] Error:');
    res.status(500).json({ error: 'Failed to compute tax harvest suggestions' });
  }
}
