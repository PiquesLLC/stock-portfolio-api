import { Router } from 'express';
import {
  followStockHandler,
  getMostFollowedStocksHandler,
  getMyStockFollowsHandler,
  getStockFollowStatusHandler,
  unfollowStockHandler,
} from '../controllers/stock-follow.controller';
import { optionalAuth, requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

router.get('/most-followed', getMostFollowedStocksHandler);
router.get('/mine', requireAuth, getMyStockFollowsHandler);
router.get('/:symbol/status', optionalAuth, getStockFollowStatusHandler);
router.post('/:symbol', mutationLimiter, requireAuth, followStockHandler);
router.delete('/:symbol', mutationLimiter, requireAuth, unfollowStockHandler);

export default router;

