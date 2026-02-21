import { Router } from 'express';
import { healthCheck, healthStatus, authMetrics } from '../controllers/health.controller';

const router = Router();

router.get('/', healthCheck);
router.get('/status', healthStatus);
router.get('/auth-metrics', authMetrics);

export default router;
