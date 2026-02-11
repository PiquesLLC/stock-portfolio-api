import { Router } from 'express';
import {
  getHealthHandler,
  getAttributionHandler,
  getLeakDetectorHandler,
  getRiskForecastHandler,
  getIncomeInsightsHandler,
  getBriefingHandler,
  getBehaviorHandler,
  getDailyReportHandler,
  regenerateDailyReportHandler,
  explainBriefingHandler,
} from '../controllers/insights.controller';
import { heavyReadLimiter } from '../middleware/rateLimiter';

const router = Router();

router.get('/health', getHealthHandler);
router.get('/attribution', heavyReadLimiter, getAttributionHandler);
router.get('/leak-detector', heavyReadLimiter, getLeakDetectorHandler);
router.get('/risk-forecast', heavyReadLimiter, getRiskForecastHandler);
router.get('/income', heavyReadLimiter, getIncomeInsightsHandler);
router.get('/briefing', heavyReadLimiter, getBriefingHandler);
router.post('/briefing/explain', explainBriefingHandler);
router.get('/behavior', heavyReadLimiter, getBehaviorHandler);
router.get('/daily-report', heavyReadLimiter, getDailyReportHandler);
router.post('/daily-report/regenerate', regenerateDailyReportHandler);

export default router;
