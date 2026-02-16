import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { getEtfOverlap } from '../services/etf-overlap.service';

const SYSTEM_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';

export async function getEtfOverlapHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const data = await getEtfOverlap(SYSTEM_USER_ID);
    res.json(data);
  } catch (error) {
    console.error('Error fetching ETF overlap:', error);
    res.status(500).json({ error: 'Failed to fetch ETF overlap' });
  }
}
