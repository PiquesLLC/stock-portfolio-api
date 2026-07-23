import { Request, Response } from 'express';
import { getLeaderboard } from '../services/leaderboard.service';
import { LeaderboardWindow, LeaderboardRegion } from '../types';

const VALID_WINDOWS: LeaderboardWindow[] = ['1D', '1W', '1M', '6M', 'YTD', '1Y'];
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
    // B2: exclude ONLY anti-cheat detections (>300%/day, Sharpe>5) from the public
    // ranking — a manipulated return must not sit at #1 with a soft label. We
    // filter on `suspicious`, NOT `flagged`: benign composition-change flags
    // (F-M-15) belong to honest users who traded during the window and whose
    // return was accurately recomputed from snapshots — they stay ranked. Both
    // remain in LeaderboardCache for admin review, and the internal flagReason
    // is stripped from the public payload.
    const publicEntries = result.entries
      .filter((entry) => !entry.suspicious)
      .map(({ flagReason: _flagReason, ...entry }) => entry);
    res.json({ ...result, entries: publicEntries });
  } catch (error: unknown) {
    console.error('Error fetching leaderboard:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
}
