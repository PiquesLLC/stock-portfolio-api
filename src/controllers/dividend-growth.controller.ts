import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { getDividendGrowthRates } from '../services/dividend-growth.service';

export async function getDividendGrowthRatesHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const excludeCurrentYearParam = req.query.excludeCurrentYear as string | undefined;
    const excludeCurrentYear = excludeCurrentYearParam === undefined
      ? true
      : excludeCurrentYearParam.toLowerCase() !== 'false';
    const data = await getDividendGrowthRates(
      req.user!.userId,
      { excludeCurrentYear }
    );
    res.json(data);
  } catch (error: unknown) {
    console.error('Error fetching dividend growth rates:');
    res.status(500).json({ error: 'Failed to fetch dividend growth rates' });
  }
}
