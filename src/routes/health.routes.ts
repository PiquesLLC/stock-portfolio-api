import { Router } from 'express';
import { healthCheck, healthDeep, healthStatus, authMetrics, apiUsage, webhookMetrics, jobMetrics, providerMetrics } from '../controllers/health.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePlatformAdmin } from '../middleware/admin.middleware';
// M-14: shared implementation — see middleware/admin.middleware.ts. Same
// membership as the copy this replaced.
const requireAdmin = requirePlatformAdmin;

const router = Router();

// Basic health check — public (Railway's deploy healthcheck gates on this;
// it must stay pure liveness so a DB brownout can't block deploying a fix)
router.get('/', healthCheck);
// Deep health — public, probes an actual DB write with a short timeout and
// returns 503 when writes are failing. Point BetterStack at THIS path: during
// the 2026-07-14 write outage the shallow check stayed green for 4¾ hours.
router.get('/deep', healthDeep);
// Status endpoint — any authenticated user (UI uses this for health indicator)
router.get('/status', requireAuth, healthStatus);
// Detailed metrics — admin only (exposes internal data)
router.get('/webhook-metrics', requireAuth, requireAdmin, webhookMetrics);
router.get('/job-metrics', requireAuth, requireAdmin, jobMetrics);
router.get('/provider-metrics', requireAuth, requireAdmin, providerMetrics);
router.get('/api-usage', requireAuth, requireAdmin, apiUsage);
// Auth metrics (OAuth/login/signup/MFA/rate-limit counters). Admin-gated, so safe
// to expose in production too — needed at launch to watch auth-abuse signals.
router.get('/auth-metrics', requireAuth, requireAdmin, authMetrics);

export default router;
