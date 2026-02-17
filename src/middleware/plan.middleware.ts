import { NextFunction, Response } from 'express';
import { AuthRequest } from '../types/auth';
import prisma from '../utils/prisma';

type PlanTier = 'free' | 'pro' | 'premium';

const PLAN_LEVEL: Record<PlanTier, number> = {
  free: 0,
  pro: 1,
  premium: 2,
};

function normalizePlan(plan: string | null | undefined): PlanTier {
  if (plan === 'premium') return 'premium';
  if (plan === 'pro') return 'pro';
  return 'free';
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

      if (!req.user.plan) {
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
