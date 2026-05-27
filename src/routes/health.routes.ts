import { Router, Response } from 'express';
import { healthCheck, healthStatus, authMetrics, apiUsage, webhookMetrics, jobMetrics, providerMetrics } from '../controllers/health.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { config } from '../config';
import { AuthRequest } from '../types/auth';

// Prod Jon hardcoded as guaranteed bypass; additional admins via env.
const HARDCODED_ADMIN_IDS = ['237198da-612e-411c-9ef8-f267c887a9f1'];
function requireAdmin(req: AuthRequest, res: Response, next: Function): void {
  const userId = req.user?.userId;
  if (!userId || (!HARDCODED_ADMIN_IDS.includes(userId) && !config.waitlistAdminUserIds.includes(userId))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

const router = Router();

// Basic health check — public (BetterStack uptime monitoring needs it)
router.get('/', healthCheck);
// Status endpoint — any authenticated user (UI uses this for health indicator)
router.get('/status', requireAuth, healthStatus);
// Detailed metrics — admin only (exposes internal data)
router.get('/webhook-metrics', requireAuth, requireAdmin, webhookMetrics);
router.get('/job-metrics', requireAuth, requireAdmin, jobMetrics);
router.get('/provider-metrics', requireAuth, requireAdmin, providerMetrics);
router.get('/api-usage', requireAuth, requireAdmin, apiUsage);
if (process.env.NODE_ENV !== 'production') {
  router.get('/auth-metrics', requireAuth, requireAdmin, authMetrics);
}

export default router;
