import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { getPortfolioIntelligence, IntelligenceWindow } from '../services/portfolioIntelligence.service';

const VALID_WINDOWS: IntelligenceWindow[] = ['1d', '5d', '1m'];

export async function getIntelligenceHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const windowParam = req.query.window as string | undefined;
    let window: IntelligenceWindow = '1d';

    if (windowParam && VALID_WINDOWS.includes(windowParam as IntelligenceWindow)) {
      window = windowParam as IntelligenceWindow;
    }

    const intelligence = await getPortfolioIntelligence(req.user!.userId, window);
    res.json(intelligence);
  } catch (_error) {
    console.error('Error getting portfolio intelligence:');
    res.status(500).json({
      error: 'Failed to compute portfolio intelligence',
      partial: true,
    });
  }
}

export async function getUserIntelligenceHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    const windowParam = req.query.window as string | undefined;
    let window: IntelligenceWindow = '1d';

    if (windowParam && VALID_WINDOWS.includes(windowParam as IntelligenceWindow)) {
      window = windowParam as IntelligenceWindow;
    }

    const intelligence = await getPortfolioIntelligence(userId, window);
    res.json(intelligence);
  } catch (_error) {
    console.error('Error getting user intelligence:');
    res.status(500).json({
      error: 'Failed to compute portfolio intelligence',
      partial: true,
    });
  }
}
