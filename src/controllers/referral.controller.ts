import { Request, Response } from 'express';
import { getReferralStats, validateReferralCode } from '../services/referral.service';

/**
 * GET /referral/stats — Get referral stats for the authenticated user
 */
export async function getReferralStatsHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const stats = await getReferralStats(userId);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching referral stats:', error);
    res.status(500).json({ error: 'Failed to fetch referral stats' });
  }
}

/**
 * GET /referral/validate/:code — Check if a referral code is valid (public)
 */
export async function validateReferralCodeHandler(req: Request, res: Response): Promise<void> {
  try {
    const { code } = req.params;
    if (!code || code.length < 3) {
      res.json({ valid: false });
      return;
    }
    const result = await validateReferralCode(code);
    res.json(result);
  } catch (error) {
    console.error('Error validating referral code:', error);
    res.status(500).json({ error: 'Failed to validate referral code' });
  }
}
