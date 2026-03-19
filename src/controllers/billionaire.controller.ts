import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import {
  getBillionaireLeaderboard,
  getBillionaireBySlug,
  getBillionaireChart,
  getBillionaireMovers,
} from '../services/billionaire.service';

// GET /billionaires — Full leaderboard
export async function getLeaderboardHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const data = await getBillionaireLeaderboard();
    res.json({ billionaires: data });
  } catch (error: unknown) {
    console.error('Error getting billionaire leaderboard:');
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
}

// GET /billionaires/movers — Biggest gainers/losers today
export async function getMoversHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const data = await getBillionaireMovers();
    res.json(data);
  } catch (error: unknown) {
    console.error('Error getting billionaire movers:');
    res.status(500).json({ error: 'Failed to get movers' });
  }
}

// GET /billionaires/:slug — Individual profile
export async function getProfileHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const data = await getBillionaireBySlug(req.params.slug);
    if (!data) { res.status(404).json({ error: 'Billionaire not found' }); return; }
    res.json(data);
  } catch (error: unknown) {
    console.error('Error getting billionaire profile:');
    res.status(500).json({ error: 'Failed to get profile' });
  }
}

// GET /billionaires/:slug/chart — Chart data for a billionaire
export async function getChartHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const period = (req.query.period as string) || '1M';
    const data = await getBillionaireChart(req.params.slug, period);
    if (!data) { res.status(404).json({ error: 'Billionaire not found' }); return; }
    res.json(data);
  } catch (error: unknown) {
    console.error('Error getting billionaire chart:');
    res.status(500).json({ error: 'Failed to get chart' });
  }
}

// GET /billionaires/wealth-context — FRED wealth distribution data
export async function getWealthContextHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    // Import prisma here to query WealthDistribution
    const prisma = (await import('../utils/prisma')).default;
    const data = await prisma.wealthDistribution.findMany({
      orderBy: { date: 'desc' },
      take: 10,
    });
    res.json({ distributions: data });
  } catch (error: unknown) {
    console.error('Error getting wealth context:');
    res.status(500).json({ error: 'Failed to get wealth context' });
  }
}
