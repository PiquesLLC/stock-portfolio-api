import { Router } from 'express';
import { getIntelligenceHandler } from '../controllers/portfolioIntelligence.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/', requireAuth, getIntelligenceHandler);

export default router;
