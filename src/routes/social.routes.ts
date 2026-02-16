import { Router } from 'express';
import { getFeedHandler } from '../controllers/social.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/feed', requireAuth, getFeedHandler);

export default router;
