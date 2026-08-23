import { NextFunction, Response } from 'express';
import { AuthRequest } from '../types/auth';
import prisma from '../utils/prisma';

type PlanTier = 'free' | 'pro' | 'premium' | 'elite';

const PLAN_LEVEL: Record<PlanTier, number> = {
  free: 0,
  pro: 1,
  premium: 2,
  elite: 3,
};

function normalizePlan(plan: string | null | undefined): PlanTier {
  if (plan === 'elite') return 'elite';
  if (plan === 'premium') return 'premium';
  if (plan === 'pro') return 'pro';
  return 'free';
}

/**
 * M-10 — programmatic plan check for handlers that must BRANCH on plan rather
 * than reject the whole request. `requirePlan` is the right tool when a route is
 * wholly gated; this one is for a route that stays open to everyone but contains
 * one paid-tier side effect (e.g. /portfolio/news serves the feed to all users
 * but only generates the paid LLM summary for entitled ones).
 *
 * Reads the DB rather than trusting the JWT `plan` claim, for the same reason
 * requirePlan does: a token minted before a downgrade would otherwise keep
 * spending on a cancelled subscription for the rest of its 15-minute life.
 */
export async function userMeetsPlan(userId: string, requiredPlan: PlanTier): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, planExpiresAt: true },
    });
    let plan = normalizePlan(user?.plan);
    if (user?.planExpiresAt && user.planExpiresAt < new Date()) plan = 'free';
    return PLAN_LEVEL[plan] >= PLAN_LEVEL[requiredPlan];
  } catch {
    // Fail CLOSED: this gates paid spend, so an unreadable plan must not
    // authorise the call.
    console.error('[Billing] userMeetsPlan check failed — denying paid side effect');
    return false;
  }
}

export function requirePlan(requiredPlan: PlanTier) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authorization required' });
        return;
      }

      let userPlan = normalizePlan(req.user.plan);
      let planExpiresAt = req.user.planExpiresAt ? new Date(req.user.planExpiresAt) : null;

      // Always check DB for paid-tier routes or when JWT plan is insufficient
      // This catches both upgrade lag AND revocation (refund/cancel) within JWT lifetime
      if (PLAN_LEVEL[requiredPlan] > 0 || !req.user.plan || PLAN_LEVEL[userPlan] < PLAN_LEVEL[requiredPlan]) {
        const user = await prisma.user.findUnique({
          where: { id: req.user.userId },
          select: { plan: true, planExpiresAt: true },
        });
        userPlan = normalizePlan(user?.plan);
        planExpiresAt = user?.planExpiresAt ?? null;
        req.user.plan = userPlan;
        req.user.planExpiresAt = planExpiresAt ? planExpiresAt.toISOString() : null;
      }

      if (planExpiresAt && planExpiresAt < new Date()) {
        userPlan = 'free';
        req.user.plan = 'free';
      }

      if (PLAN_LEVEL[userPlan] < PLAN_LEVEL[requiredPlan]) {
        res.status(403).json({ error: 'upgrade_required', requiredPlan });
        return;
      }

      next();
    } catch {
      console.error('[Billing] Plan check failed');
      res.status(500).json({ error: 'Failed to validate plan' });
    }
  };
}
