import { Request, Response } from 'express';
import { getEtfOverlap } from '../services/etf-overlap.service';

export async function getEtfOverlapHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.query;
    const data = await getEtfOverlap(userId as string | undefined ?? null);
    res.json(data);
  } catch (error) {
    console.error('Error fetching ETF overlap:', error);
    res.status(500).json({ error: 'Failed to fetch ETF overlap' });
  }
}
