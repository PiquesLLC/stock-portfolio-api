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
  importPortfolioCsvHandler,
  confirmPortfolioImportHandler,
  clearPortfolioHandler,
  importPortfolioScreenshotHandler,
} from '../controllers/portfolio.controller';
import { getEtfOverlapHandler } from '../controllers/etf-overlap.controller';
import { getSummaryHandler } from '../controllers/settings.controller';
import { heavyReadLimiter, mutationLimiter } from '../middleware/rateLimiter';
import { requireAuth, optionalAuth } from '../middleware/auth.middleware';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/', optionalAuth, getPortfolioHandler);
router.post('/holdings', mutationLimiter, requireAuth, addHolding);
router.delete('/holdings/:ticker', mutationLimiter, requireAuth, removeHolding);
router.put('/cash', mutationLimiter, requireAuth, setCashBalance);
router.get('/history', heavyReadLimiter, getHistory);
router.get('/history/chart', heavyReadLimiter, getChartHandler);
router.get('/projections', getProjectionsHandler);
router.get('/projections/current-pace', getCurrentPaceHandler);
router.get('/metrics', getMetricsHandler);
router.get('/summary', getSummaryHandler);
router.get('/etf-overlap', requireAuth, getEtfOverlapHandler);
router.get('/performance', heavyReadLimiter, getPerformanceHandler);
router.get('/activity/:ticker', requireAuth, getTickerActivity);
router.post('/import/csv', mutationLimiter, requireAuth, upload.single('file'), importPortfolioCsvHandler);
router.post('/import/screenshot', mutationLimiter, requireAuth, upload.single('file'), importPortfolioScreenshotHandler);
router.post('/import/confirm', mutationLimiter, requireAuth, confirmPortfolioImportHandler);
router.post('/clear', mutationLimiter, requireAuth, clearPortfolioHandler);

export default router;
