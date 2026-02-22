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
  getEarningsSummaryHandler,
} from '../controllers/insights.controller';
import {
  getAnomaliesHandler,
  getUnreadAnomalyCountHandler,
  markAnomalyReadHandler,
  markAllAnomaliesReadHandler,
} from '../controllers/anomaly.controller';
import { getTaxHarvestHandler } from '../controllers/tax-harvest.controller';
import { heavyReadLimiter, mutationLimiter } from '../middleware/rateLimiter';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePlan } from '../middleware/plan.middleware';
const router = Router();

router.get('/health', requireAuth, getHealthHandler);
router.get('/attribution', heavyReadLimiter, requireAuth, getAttributionHandler);
router.get('/leak-detector', heavyReadLimiter, requireAuth, getLeakDetectorHandler);
router.get('/risk-forecast', heavyReadLimiter, requireAuth, getRiskForecastHandler);
router.get('/income', heavyReadLimiter, requireAuth, getIncomeInsightsHandler);
router.get('/briefing', heavyReadLimiter, requireAuth, requirePlan('premium'), getBriefingHandler);
router.post('/briefing/explain', mutationLimiter, requireAuth, requirePlan('pro'), explainBriefingHandler);
router.get('/behavior', heavyReadLimiter, requireAuth, requirePlan('premium'), getBehaviorHandler);
router.get('/daily-report', heavyReadLimiter, requireAuth, getDailyReportHandler);
router.post('/daily-report/regenerate', mutationLimiter, requireAuth, requirePlan('pro'), regenerateDailyReportHandler);
router.get('/earnings-summary', heavyReadLimiter, requireAuth, getEarningsSummaryHandler);

// Tax-Loss Harvesting
router.get('/tax-harvest', heavyReadLimiter, requireAuth, getTaxHarvestHandler);

// Anomaly Detection
router.get('/anomalies', requireAuth, getAnomaliesHandler);
router.get('/anomalies/unread-count', requireAuth, getUnreadAnomalyCountHandler);
router.patch('/anomalies/:id/read', mutationLimiter, requireAuth, markAnomalyReadHandler);
router.post('/anomalies/mark-all-read', mutationLimiter, requireAuth, markAllAnomaliesReadHandler);

export default router;
