import { NextFunction, Response } from 'express';
import { AuthRequest } from '../types/auth';
import { ensureEmailVerifiedForAi, EmailVerificationRequiredError } from '../services/email-verification-guard.service';

export async function requireEmailVerifiedForAi(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    await ensureEmailVerifiedForAi(req.user.userId);
    next();
  } catch (error) {
    if (error instanceof EmailVerificationRequiredError) {
      res.status(403).json({ error: 'email_verification_required', message: 'Verify your email to use AI features' });
      return;
    }
    res.status(500).json({ error: 'Failed to verify email status' });
  }
}
