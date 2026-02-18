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
import { requireEmailVerifiedForAi } from '../middleware/email-verification.middleware';

const router = Router();

router.get('/health', getHealthHandler);
router.get('/attribution', heavyReadLimiter, getAttributionHandler);
router.get('/leak-detector', heavyReadLimiter, getLeakDetectorHandler);
router.get('/risk-forecast', heavyReadLimiter, getRiskForecastHandler);
router.get('/income', heavyReadLimiter, getIncomeInsightsHandler);
router.get('/briefing', heavyReadLimiter, requireAuth, requireEmailVerifiedForAi, requirePlan('premium'), getBriefingHandler);
router.post('/briefing/explain', mutationLimiter, requireAuth, requireEmailVerifiedForAi, requirePlan('pro'), explainBriefingHandler);
router.get('/behavior', heavyReadLimiter, requireAuth, requireEmailVerifiedForAi, requirePlan('premium'), getBehaviorHandler);
router.get('/daily-report', heavyReadLimiter, getDailyReportHandler);
router.post('/daily-report/regenerate', mutationLimiter, requireAuth, requirePlan('pro'), regenerateDailyReportHandler);
router.get('/earnings-summary', heavyReadLimiter, getEarningsSummaryHandler);

// Tax-Loss Harvesting
router.get('/tax-harvest', heavyReadLimiter, getTaxHarvestHandler);

// Anomaly Detection
router.get('/anomalies', getAnomaliesHandler);
router.get('/anomalies/unread-count', getUnreadAnomalyCountHandler);
router.patch('/anomalies/:id/read', mutationLimiter, requireAuth, markAnomalyReadHandler);
router.post('/anomalies/mark-all-read', mutationLimiter, requireAuth, markAllAnomaliesReadHandler);

export default router;
