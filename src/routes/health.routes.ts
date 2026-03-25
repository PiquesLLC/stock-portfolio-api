import { Router, Response } from 'express';
import { healthCheck, healthStatus, authMetrics, apiUsage, webhookMetrics, jobMetrics, providerMetrics } from '../controllers/health.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { AuthRequest } from '../types/auth';

const ADMIN_USER_ID = '237198da-612e-411c-9ef8-f267c887a9f1';
function requireAdmin(req: AuthRequest, res: Response, next: Function): void {
  if (!req.user || req.user.userId !== ADMIN_USER_ID) { res.status(403).json({ error: 'Forbidden' }); return; }
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
