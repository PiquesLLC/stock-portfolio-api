import { Response } from 'express';
import { AuthRequest } from '../types/auth';
import { getEarningsPreviews } from '../services/earnings-preview.service';
import { EmailVerificationRequiredError } from '../services/email-verification-guard.service';

export async function getEarningsPreviewHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const result = await getEarningsPreviews(req.user.userId);
    res.json(result);
  } catch (error) {
    if (error instanceof EmailVerificationRequiredError) {
      res.status(403).json({ error: 'email_verification_required', message: 'Verify your email to use AI features' });
      return;
    }
    console.error('[Earnings Preview] Error');
    res.status(500).json({
      results: [],
      partial: true,
    });
  }
}
