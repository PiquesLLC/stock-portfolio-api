import { Request, Response } from 'express';
import { getDividendGrowthRates } from '../services/dividend-growth.service';

export async function getDividendGrowthRatesHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.query;
    const excludeCurrentYearParam = req.query.excludeCurrentYear as string | undefined;
    const excludeCurrentYear = excludeCurrentYearParam === undefined
      ? true
      : excludeCurrentYearParam.toLowerCase() !== 'false';
    const data = await getDividendGrowthRates(
      userId as string | undefined ?? null,
      { excludeCurrentYear }
    );
    res.json(data);
  } catch (error) {
    console.error('Error fetching dividend growth rates:', error);
    res.status(500).json({ error: 'Failed to fetch dividend growth rates' });
  }
}
