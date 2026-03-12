import { Router } from 'express';
import { askNalaHandler, getSuggestionsHandler } from '../controllers/nala.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { aiLimiter } from '../middleware/rateLimiter';
import { requirePlan } from '../middleware/plan.middleware';

const router = Router();

router.post('/ask', aiLimiter, requireAuth, requirePlan('premium'), askNalaHandler);
router.get('/suggestions', getSuggestionsHandler);

export default router;
