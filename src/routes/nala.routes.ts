import { Router } from 'express';
import { askNalaHandler, getSuggestionsHandler } from '../controllers/nala.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

router.post('/ask', mutationLimiter, requireAuth, askNalaHandler);
router.get('/suggestions', getSuggestionsHandler);

export default router;
