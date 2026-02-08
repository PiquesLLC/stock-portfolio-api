import { Router } from 'express';
import { askNalaHandler, getSuggestionsHandler } from '../controllers/nala.controller';
import { optionalAuth } from '../middleware/auth.middleware';

const router = Router();

router.post('/ask', optionalAuth, askNalaHandler);
router.get('/suggestions', getSuggestionsHandler);

export default router;
