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
import { fetchPortfolioNews, generateMacroSummary } from '../services/portfolio-news.service';
import { getSummaryHandler } from '../controllers/settings.controller';
import { heavyReadLimiter, mutationLimiter, aiLimiter } from '../middleware/rateLimiter';
import { requireAuth, optionalAuth } from '../middleware/auth.middleware';
import { AuthRequest } from '../types/auth';
import { requirePlan } from '../middleware/plan.middleware';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit
const uploadMapped = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

router.get('/', optionalAuth, getPortfolioHandler);
router.get('/news', heavyReadLimiter, aiLimiter, requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
    const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
    const portfolioId = req.query.portfolioId as string | undefined;
    const data = await fetchPortfolioNews(userId, limit, portfolioId);
    // Generate AI summary in parallel (non-blocking — returns null if AI unavailable)
    const includeSummary = req.query.summary !== '0';
    if (includeSummary) {
      try {
        const summary = await generateMacroSummary(userId, portfolioId);
        if (summary) data.summary = summary;
      } catch { /* AI summary is optional — don't block news */ }
    }
    res.json(data);
  } catch (err: any) {
    console.error('Portfolio news error:', err.message);
    res.status(500).json({ error: 'Failed to fetch portfolio news' });
  }
});
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
router.get('/report', heavyReadLimiter, requireAuth, requirePlan('elite'), getPerformanceReportHandler);
router.post('/report/email', mutationLimiter, requireAuth, requirePlan('elite'), emailPerformanceReportHandler);
router.get('/activity/:ticker', requireAuth, getTickerActivity);
router.post('/import/csv', mutationLimiter, requireAuth, upload.single('file'), importPortfolioCsvHandler);
router.post('/import/csv/mapped', mutationLimiter, requireAuth, uploadMapped.single('file'), importMappedCsvHandler);
router.post('/import/screenshot', mutationLimiter, requireAuth, upload.single('file'), importPortfolioScreenshotHandler);
router.post('/import/confirm', mutationLimiter, requireAuth, confirmPortfolioImportHandler);
router.post('/clear', mutationLimiter, requireAuth, clearPortfolioHandler);
router.post('/seed-sample', mutationLimiter, requireAuth, seedSamplePortfolio);

export default router;
