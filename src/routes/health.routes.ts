import { Router } from 'express';
import { healthCheck, healthStatus, authMetrics, apiUsage, webhookMetrics, jobMetrics, providerMetrics } from '../controllers/health.controller';

const router = Router();

router.get('/', healthCheck);
router.get('/status', healthStatus);
router.get('/webhook-metrics', webhookMetrics);
router.get('/job-metrics', jobMetrics);
router.get('/provider-metrics', providerMetrics);
if (process.env.NODE_ENV !== 'production') {
  router.get('/auth-metrics', authMetrics);
  router.get('/api-usage', apiUsage);
}

export default router;
