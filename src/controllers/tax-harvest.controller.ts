import { Request, Response } from 'express';
import { getTaxHarvestSuggestions } from '../services/tax-harvest.service';

export async function getTaxHarvestHandler(_req: Request, res: Response): Promise<void> {
  try {
    const result = await getTaxHarvestSuggestions();
    res.json(result);
  } catch (_error) {
    console.error('[Tax Harvest] Error:');
    res.status(500).json({ error: 'Failed to compute tax harvest suggestions' });
  }
}
