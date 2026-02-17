import { Router } from 'express';
import { askNalaHandler, getSuggestionsHandler } from '../controllers/nala.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';
import { requirePlan } from '../middleware/plan.middleware';

const router = Router();

router.post('/ask', mutationLimiter, requireAuth, requirePlan('pro'), askNalaHandler);
router.get('/suggestions', getSuggestionsHandler);

export default router;
