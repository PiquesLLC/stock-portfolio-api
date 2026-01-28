import { Router } from 'express';
import { getIntelligenceHandler } from '../controllers/portfolioIntelligence.controller';

const router = Router();

router.get('/', getIntelligenceHandler);

export default router;
