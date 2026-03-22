import { Router } from 'express';
import { healthCheck, healthStatus, authMetrics, apiUsage, webhookMetrics, jobMetrics, providerMetrics } from '../controllers/health.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// Basic health check — public (BetterStack uptime monitoring needs it)
router.get('/', healthCheck);
// Detailed health/metrics endpoints — require authentication
router.get('/status', requireAuth, healthStatus);
router.get('/webhook-metrics', requireAuth, webhookMetrics);
router.get('/job-metrics', requireAuth, jobMetrics);
router.get('/provider-metrics', requireAuth, providerMetrics);
if (process.env.NODE_ENV !== 'production') {
  router.get('/auth-metrics', requireAuth, authMetrics);
  router.get('/api-usage', requireAuth, apiUsage);
}

export default router;
