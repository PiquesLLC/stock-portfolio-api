import { Router } from 'express';
import {
  getPortfolioHandler,
  addHolding,
  removeHolding,
  setCashBalance,
  getHistory,
  getProjectionsHandler,
  getMetricsHandler,
  getCurrentPaceHandler,
  getChartHandler,
  getPerformanceHandler,
  getTickerActivity,
} from '../controllers/portfolio.controller';
import { getSummaryHandler } from '../controllers/settings.controller';
import { heavyReadLimiter } from '../middleware/rateLimiter';
import { requireAuth, optionalAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/', optionalAuth, getPortfolioHandler);
router.post('/holdings', requireAuth, addHolding);
router.delete('/holdings/:ticker', requireAuth, removeHolding);
router.put('/cash', requireAuth, setCashBalance);
router.get('/history', heavyReadLimiter, getHistory);
router.get('/history/chart', heavyReadLimiter, getChartHandler);
router.get('/projections', getProjectionsHandler);
router.get('/projections/current-pace', getCurrentPaceHandler);
router.get('/metrics', getMetricsHandler);
router.get('/summary', getSummaryHandler);
router.get('/performance', heavyReadLimiter, getPerformanceHandler);
router.get('/activity/:ticker', requireAuth, getTickerActivity);

export default router;
