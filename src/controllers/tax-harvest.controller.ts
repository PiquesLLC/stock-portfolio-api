import { Request, Response } from 'express';
import { getTaxHarvestSuggestions } from '../services/tax-harvest.service';

export async function getTaxHarvestHandler(_req: Request, res: Response): Promise<void> {
  try {
    const result = await getTaxHarvestSuggestions();
    res.json(result);
  } catch (error) {
    console.error('[Tax Harvest] Error:', error);
    res.status(500).json({ error: 'Failed to compute tax harvest suggestions' });
  }
}
