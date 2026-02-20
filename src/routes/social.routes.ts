import { Router } from 'express';
import { getFeedHandler } from '../controllers/social.controller';
import { getShareCardHandler } from '../controllers/share-card.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/feed', requireAuth, getFeedHandler);
router.get('/:userId/share-card', getShareCardHandler);

export default router;
