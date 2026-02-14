import { Router } from 'express';
import { healthCheck, healthStatus } from '../controllers/health.controller';

const router = Router();

router.get('/', healthCheck);
router.get('/status', healthStatus);

export default router;
