import { Router } from 'express';
import { getFeedHandler, deleteActivityEventHandler } from '../controllers/social.controller';
import {
  getPerformanceCardHandler,
  getStockShareCardHandler,
} from '../controllers/share-card.controller';
import {
  submitAppealHandler,
  getMyStrikesHandler,
} from '../controllers/moderation.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/feed', requireAuth, getFeedHandler);
router.delete('/activity/:id', requireAuth, deleteActivityEventHandler);
router.get('/stock/:ticker/share-card', getStockShareCardHandler);

// User-facing moderation: appeal strikes, view own strikes
router.post('/appeal', requireAuth, submitAppealHandler);
router.get('/my-strikes', requireAuth, getMyStrikesHandler);

router.get('/:userId/performance-card', getPerformanceCardHandler);

export default router;
