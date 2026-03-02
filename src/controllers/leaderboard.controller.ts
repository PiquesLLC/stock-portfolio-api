import { Request, Response } from 'express';
import { getLeaderboard } from '../services/leaderboard.service';
import { LeaderboardWindow, LeaderboardRegion } from '../types';

const VALID_WINDOWS: LeaderboardWindow[] = ['1D', '1W', '1M', 'YTD', '1Y'];
const VALID_REGIONS: LeaderboardRegion[] = ['world', 'na', 'europe', 'apac'];

export async function getLeaderboardHandler(req: Request, res: Response): Promise<void> {
  try {
    const window = (req.query.window as string) || '1M';
    const region = ((req.query.region as string) || 'world').toLowerCase();

    if (!VALID_WINDOWS.includes(window as LeaderboardWindow)) {
      res.status(400).json({ error: `Invalid window. Must be one of: ${VALID_WINDOWS.join(', ')}` });
      return;
    }

    if (!VALID_REGIONS.includes(region as LeaderboardRegion)) {
      res.status(400).json({ error: `Invalid region. Must be one of: ${VALID_REGIONS.join(', ')}` });
      return;
    }

    const result = await getLeaderboard(window as LeaderboardWindow, region as LeaderboardRegion);
    // Strip sensitive fields from public response
    const sanitizedEntries = result.entries.map(({ flagReason: _flagReason, ...entry }) => ({
      ...entry,
      flagReason: entry.flagged ? 'Under review' : null,
    }));
    res.json({ ...result, entries: sanitizedEntries });
  } catch (_error) {
    console.error('Error fetching leaderboard:');
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
}
