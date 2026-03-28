import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { getDividendGrowthRates } from '../services/dividend-growth.service';
import { validatePortfolioOwnership } from '../utils/validatePortfolioOwnership';

export async function getDividendGrowthRatesHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const portfolioId = req.query.portfolioId as string | undefined;
    await validatePortfolioOwnership(portfolioId, req.user!.userId);
    const excludeCurrentYearParam = req.query.excludeCurrentYear as string | undefined;
    const excludeCurrentYear = excludeCurrentYearParam === undefined
      ? true
      : excludeCurrentYearParam.toLowerCase() !== 'false';
    const data = await getDividendGrowthRates(
      req.user!.userId,
      { excludeCurrentYear, portfolioId }
    );
    res.json(data);
  } catch (error: unknown) {
    const status = (error as any)?.status;
    if (status === 404) {
      res.status(404).json({ error: 'Portfolio not found' });
      return;
    }
    console.error('Error fetching dividend growth rates:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch dividend growth rates' });
  }
}
