import { Response, NextFunction } from 'express';
import { config } from '../config';
import { AuthRequest } from '../types/auth';

/**
 * M-14 — one home for "is this caller an admin".
 *
 * Before this file the check existed in FOUR places (admin.routes.ts,
 * health.routes.ts, analytics.routes.ts, job-admin.routes.ts), each with its own
 * copy of the hardcoded id list and — more dangerously — three *different*
 * definitions of who counts:
 *
 *   admin.routes / health.routes : HARDCODED + waitlistAdminUserIds
 *   analytics.routes             : HARDCODED + waitlistAdminUserIds + creatorAdminUserIds
 *   job-admin.routes             : waitlistAdminUserIds + creatorAdminUserIds   (no HARDCODED)
 *
 * No route was missing a guard, so nothing was exploitable — but a divergent,
 * copy-pasted authorization rule is precisely where the next one gets it wrong.
 *
 * The two tiers below preserve the existing privilege boundaries rather than
 * collapsing them into a union, because widening who can reach /admin/set-plan
 * is a security decision, not a refactor. The only behavioural change is that
 * the hardcoded owner id now also passes the ops tier (it was the odd one out in
 * job-admin.routes, and "guaranteed bypass for the owner" is clearly the intent
 * of that constant everywhere else).
 */

// Owner account — a guaranteed bypass so an env-var mistake can never lock
// administration out of the running system.
const HARDCODED_ADMIN_IDS = ['237198da-612e-411c-9ef8-f267c887a9f1'];

/**
 * Full platform administration: editing users, setting plans, reading internal
 * health metrics. The narrower tier — keep it that way.
 */
export function isPlatformAdmin(userId?: string | null): boolean {
  if (!userId) return false;
  return HARDCODED_ADMIN_IDS.includes(userId) || config.waitlistAdminUserIds.includes(userId);
}

/**
 * Operational dashboards: job stats, analytics. Everyone with platform admin,
 * plus the creator-operations admins who need these read-only views without
 * being granted user administration.
 */
export function isOpsAdmin(userId?: string | null): boolean {
  if (!userId) return false;
  return isPlatformAdmin(userId) || config.creatorAdminUserIds.includes(userId);
}

/** Express guard for the full-administration tier. Use after requireAuth. */
export function requirePlatformAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!isPlatformAdmin(req.user?.userId)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

/** Express guard for the operational-dashboard tier. Use after requireAuth. */
export function requireOpsAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!isOpsAdmin(req.user?.userId)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
