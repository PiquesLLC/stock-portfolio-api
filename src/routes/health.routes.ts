import { Router } from 'express';
import { healthCheck, healthStatus, authMetrics, apiUsage } from '../controllers/health.controller';

const router = Router();

router.get('/', healthCheck);
router.get('/status', healthStatus);
if (process.env.NODE_ENV !== 'production') {
  router.get('/auth-metrics', authMetrics);
  router.get('/api-usage', apiUsage);
}

export default router;
