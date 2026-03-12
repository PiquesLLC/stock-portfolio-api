import { Router } from 'express';
import { healthCheck, healthStatus, authMetrics, apiUsage, webhookMetrics, jobMetrics } from '../controllers/health.controller';

const router = Router();

router.get('/', healthCheck);
router.get('/status', healthStatus);
router.get('/webhook-metrics', webhookMetrics);
router.get('/job-metrics', jobMetrics);
if (process.env.NODE_ENV !== 'production') {
  router.get('/auth-metrics', authMetrics);
  router.get('/api-usage', apiUsage);
}

export default router;
