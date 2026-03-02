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
  getChartGapSummaryHandler,
  getPerformanceHandler,
  getTickerActivity,
  importPortfolioCsvHandler,
  importMappedCsvHandler,
  confirmPortfolioImportHandler,
  clearPortfolioHandler,
  importPortfolioScreenshotHandler,
  seedSamplePortfolio,
  getAccountHistoryHandler,
} from '../controllers/portfolio.controller';
import { getPerformanceReportHandler, emailPerformanceReportHandler } from '../controllers/performance-report.controller';
import { getEtfOverlapHandler } from '../controllers/etf-overlap.controller';
import { getSummaryHandler } from '../controllers/settings.controller';
import { heavyReadLimiter, mutationLimiter } from '../middleware/rateLimiter';
import { requireAuth, optionalAuth } from '../middleware/auth.middleware';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit
const uploadMapped = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

router.get('/', optionalAuth, getPortfolioHandler);
router.post('/holdings', mutationLimiter, requireAuth, addHolding);
router.delete('/holdings/:ticker', mutationLimiter, requireAuth, removeHolding);
router.put('/cash', mutationLimiter, requireAuth, setCashBalance);
router.get('/history', heavyReadLimiter, requireAuth, getHistory);
router.get('/history/chart', heavyReadLimiter, optionalAuth, getChartHandler);
router.get('/history/chart/gaps', heavyReadLimiter, requireAuth, getChartGapSummaryHandler);
router.get('/account-history', requireAuth, getAccountHistoryHandler);
router.get('/projections', requireAuth, getProjectionsHandler);
router.get('/projections/current-pace', requireAuth, getCurrentPaceHandler);
router.get('/metrics', requireAuth, getMetricsHandler);
router.get('/summary', requireAuth, getSummaryHandler);
router.get('/etf-overlap', heavyReadLimiter, requireAuth, getEtfOverlapHandler);
router.get('/performance', heavyReadLimiter, requireAuth, getPerformanceHandler);
router.get('/report', heavyReadLimiter, requireAuth, getPerformanceReportHandler);
router.post('/report/email', mutationLimiter, requireAuth, emailPerformanceReportHandler);
router.get('/activity/:ticker', requireAuth, getTickerActivity);
router.post('/import/csv', mutationLimiter, requireAuth, upload.single('file'), importPortfolioCsvHandler);
router.post('/import/csv/mapped', mutationLimiter, requireAuth, uploadMapped.single('file'), importMappedCsvHandler);
router.post('/import/screenshot', mutationLimiter, requireAuth, upload.single('file'), importPortfolioScreenshotHandler);
router.post('/import/confirm', mutationLimiter, requireAuth, confirmPortfolioImportHandler);
router.post('/clear', mutationLimiter, requireAuth, clearPortfolioHandler);
router.post('/seed-sample', mutationLimiter, requireAuth, seedSamplePortfolio);

export default router;
