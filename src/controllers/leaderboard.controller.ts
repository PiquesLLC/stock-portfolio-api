import { Request, Response } from 'express';
import { getLeaderboard } from '../services/leaderboard.service';
import { LeaderboardWindow } from '../types';

const VALID_WINDOWS: LeaderboardWindow[] = ['1D', '1W', '1M', 'YTD', '1Y'];

export async function getLeaderboardHandler(req: Request, res: Response): Promise<void> {
  try {
    const window = (req.query.window as string) || '1M';

    if (!VALID_WINDOWS.includes(window as LeaderboardWindow)) {
      res.status(400).json({ error: `Invalid window. Must be one of: ${VALID_WINDOWS.join(', ')}` });
      return;
    }

    const entries = await getLeaderboard(window as LeaderboardWindow);
    res.json(entries);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
}
