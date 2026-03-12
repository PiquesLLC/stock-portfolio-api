import { Router } from 'express';
import { getFeedHandler, deleteActivityEventHandler } from '../controllers/social.controller';
import {
  getPerformanceCardHandler,
  getStockShareCardHandler,
} from '../controllers/share-card.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/feed', requireAuth, getFeedHandler);
router.delete('/activity/:id', requireAuth, deleteActivityEventHandler);
router.get('/stock/:ticker/share-card', getStockShareCardHandler);
router.get('/:userId/performance-card', getPerformanceCardHandler);

export default router;
