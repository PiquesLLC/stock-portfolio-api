import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';
import {
  listWatchlistsHandler,
  getWatchlistHandler,
  createWatchlistHandler,
  updateWatchlistHandler,
  deleteWatchlistHandler,
  addWatchlistHoldingHandler,
  updateWatchlistHoldingHandler,
  removeWatchlistHoldingHandler,
  getWatchlistChartHandler,
} from '../controllers/watchlist.controller';

const router = Router();

router.get('/', requireAuth, listWatchlistsHandler);
router.post('/', mutationLimiter, requireAuth, createWatchlistHandler);
router.get('/:id', requireAuth, getWatchlistHandler);
router.get('/:id/chart', requireAuth, getWatchlistChartHandler);
router.put('/:id', mutationLimiter, requireAuth, updateWatchlistHandler);
router.delete('/:id', mutationLimiter, requireAuth, deleteWatchlistHandler);
router.post('/:id/holdings', mutationLimiter, requireAuth, addWatchlistHoldingHandler);
router.put('/:id/holdings/:ticker', mutationLimiter, requireAuth, updateWatchlistHoldingHandler);
router.delete('/:id/holdings/:ticker', mutationLimiter, requireAuth, removeWatchlistHoldingHandler);

export default router;
