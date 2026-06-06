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
import {
  blockUserHandler,
  unblockUserHandler,
  getBlockedUsersHandler,
} from '../controllers/block.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { shareCardLimiter } from '../middleware/rateLimiter';

const router = Router();

router.get('/feed', requireAuth, getFeedHandler);
router.delete('/activity/:id', requireAuth, deleteActivityEventHandler);
router.get('/stock/:ticker/share-card', shareCardLimiter, getStockShareCardHandler);

// User-facing moderation: appeal strikes, view own strikes
router.post('/appeal', requireAuth, submitAppealHandler);
router.get('/my-strikes', requireAuth, getMyStrikesHandler);

// User blocking
router.post('/block/:userId', requireAuth, blockUserHandler);
router.delete('/block/:userId', requireAuth, unblockUserHandler);
router.get('/blocked', requireAuth, getBlockedUsersHandler);

router.get('/:userId/performance-card', shareCardLimiter, getPerformanceCardHandler);

export default router;
