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
} from '../controllers/portfolio.controller';
import { getSummaryHandler } from '../controllers/settings.controller';

const router = Router();

router.get('/', getPortfolioHandler);
router.post('/holdings', addHolding);
router.delete('/holdings/:ticker', removeHolding);
router.put('/cash', setCashBalance);
router.get('/history', getHistory);
router.get('/projections', getProjectionsHandler);
router.get('/projections/current-pace', getCurrentPaceHandler);
router.get('/metrics', getMetricsHandler);
router.get('/summary', getSummaryHandler);

export default router;
