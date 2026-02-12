import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
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
router.post('/', requireAuth, createWatchlistHandler);
router.get('/:id', requireAuth, getWatchlistHandler);
router.get('/:id/chart', requireAuth, getWatchlistChartHandler);
router.put('/:id', requireAuth, updateWatchlistHandler);
router.delete('/:id', requireAuth, deleteWatchlistHandler);
router.post('/:id/holdings', requireAuth, addWatchlistHoldingHandler);
router.put('/:id/holdings/:ticker', requireAuth, updateWatchlistHoldingHandler);
router.delete('/:id/holdings/:ticker', requireAuth, removeWatchlistHoldingHandler);

export default router;
