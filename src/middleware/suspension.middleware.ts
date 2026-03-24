import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types/auth';
import prisma from '../utils/prisma';

/**
 * Middleware that blocks suspended users from performing write operations.
 * Must be used AFTER requireAuth — relies on req.user being set.
 *
 * Returns 403 with suspension details and appeal information so the
 * client can display an appropriate message and link to the appeal flow.
 */
export function requireNotSuspended(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }

  // Look up suspension status from DB (not JWT) for real-time accuracy
  prisma.user.findUnique({
    where: { id: req.user.userId },
    select: {
      suspended: true,
      suspendedAt: true,
      contentStrikes: {
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        select: { reason: true, createdAt: true },
      },
    },
  }).then((user) => {
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    if (!user.suspended) {
      next();
      return;
    }

    const latestStrike = user.contentStrikes[0];
    res.status(403).json({
      error: 'Account suspended',
      code: 'ACCOUNT_SUSPENDED',
      suspendedAt: user.suspendedAt,
      latestStrikeReason: latestStrike?.reason ?? null,
      message: 'Your account has been suspended due to content policy violations. You can appeal your strikes at /social/my-strikes.',
    });
  }).catch((err) => {
    console.error('[Suspension Check] DB error:', err);
    // Fail closed — block write operations if we can't verify suspension status
    res.status(503).json({ error: 'Service temporarily unavailable' });
  });
}
