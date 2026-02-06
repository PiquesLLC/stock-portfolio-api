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
import { requireAuth, optionalAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/', optionalAuth, getPortfolioHandler);
router.post('/holdings', requireAuth, addHolding);
router.delete('/holdings/:ticker', requireAuth, removeHolding);
router.put('/cash', requireAuth, setCashBalance);
router.get('/history', getHistory);
router.get('/history/chart', getChartHandler);
router.get('/projections', getProjectionsHandler);
router.get('/projections/current-pace', getCurrentPaceHandler);
router.get('/metrics', getMetricsHandler);
router.get('/summary', getSummaryHandler);
router.get('/performance', getPerformanceHandler);
router.get('/activity/:ticker', requireAuth, getTickerActivity);

export default router;
