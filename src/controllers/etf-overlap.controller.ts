import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { getEtfOverlap } from '../services/etf-overlap.service';

export async function getEtfOverlapHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const data = await getEtfOverlap(req.user!.userId);
    res.json(data);
  } catch (error: unknown) {
    console.error('Error fetching ETF overlap:');
    res.status(500).json({ error: 'Failed to fetch ETF overlap' });
  }
}
