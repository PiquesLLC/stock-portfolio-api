import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { getDividendGrowthRates } from '../services/dividend-growth.service';

const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

export async function getDividendGrowthRatesHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const excludeCurrentYearParam = req.query.excludeCurrentYear as string | undefined;
    const excludeCurrentYear = excludeCurrentYearParam === undefined
      ? true
      : excludeCurrentYearParam.toLowerCase() !== 'false';
    const data = await getDividendGrowthRates(
      SYSTEM_USER_ID,
      { excludeCurrentYear }
    );
    res.json(data);
  } catch (error) {
    console.error('Error fetching dividend growth rates:', error);
    res.status(500).json({ error: 'Failed to fetch dividend growth rates' });
  }
}
