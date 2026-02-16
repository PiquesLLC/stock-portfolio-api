import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types/auth';
import prisma from '../utils/prisma';

const MFA_ASSURANCE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * MFA Assurance middleware for sensitive operations (e.g., Plaid Link, token exchange).
 *
 * If the user has MFA enabled, they must have completed an MFA challenge
 * within the last 30 minutes to proceed. This provides step-up authentication
 * for high-risk actions like linking a brokerage account.
 *
 * If the user has no MFA methods enabled, the request is allowed through
 * (MFA is opt-in; enforcement is at the user's discretion).
 *
 * Returns 403 with code 'MFA_STEP_UP_REQUIRED' if step-up is needed.
 */
export async function requireMfaAssurance(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    // Check if user has any enabled MFA methods
    const enabledMfaMethods = await prisma.mfaMethod.count({
      where: { userId: req.user.userId, enabled: true },
    });

    // If no MFA enabled, allow through (MFA is opt-in)
    if (enabledMfaMethods === 0) {
      next();
      return;
    }

    // User has MFA enabled — check for recent MFA verification
    const cutoff = new Date(Date.now() - MFA_ASSURANCE_WINDOW_MS);
    const recentChallenge = await prisma.mfaChallenge.findFirst({
      where: {
        userId: req.user.userId,
        usedAt: { gte: cutoff },
      },
      orderBy: { usedAt: 'desc' },
    });

    if (recentChallenge) {
      // MFA verified within the assurance window
      next();
      return;
    }

    // MFA step-up required
    res.status(403).json({
      error: 'MFA verification required for this operation',
      code: 'MFA_STEP_UP_REQUIRED',
    });
  } catch (err: any) {
    console.error('[MFA Assurance] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}
