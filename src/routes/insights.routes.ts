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
import { getEarningsPreviewHandler } from '../controllers/earnings-preview.controller';
import {
  getAnomaliesHandler,
  getUnreadAnomalyCountHandler,
  markAnomalyReadHandler,
  markAllAnomaliesReadHandler,
} from '../controllers/anomaly.controller';
import { getTaxHarvestHandler } from '../controllers/tax-harvest.controller';
import { heavyReadLimiter, mutationLimiter, aiLimiter } from '../middleware/rateLimiter';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePlan } from '../middleware/plan.middleware';
const router = Router();

router.get('/health', heavyReadLimiter, requireAuth, getHealthHandler);
router.get('/attribution', heavyReadLimiter, requireAuth, getAttributionHandler);
router.get('/leak-detector', heavyReadLimiter, requireAuth, getLeakDetectorHandler);
router.get('/risk-forecast', heavyReadLimiter, requireAuth, getRiskForecastHandler);
router.get('/income', heavyReadLimiter, requireAuth, getIncomeInsightsHandler);
router.get('/briefing', aiLimiter, requireAuth, requirePlan('premium'), getBriefingHandler);
router.post('/briefing/explain', aiLimiter, requireAuth, requirePlan('premium'), explainBriefingHandler);
router.get('/behavior', aiLimiter, requireAuth, requirePlan('premium'), getBehaviorHandler);
router.get('/daily-report', aiLimiter, requireAuth, requirePlan('premium'), getDailyReportHandler);
router.post('/daily-report/regenerate', aiLimiter, requireAuth, requirePlan('premium'), regenerateDailyReportHandler);
router.get('/earnings-summary', heavyReadLimiter, requireAuth, getEarningsSummaryHandler);
router.get('/earnings-preview', aiLimiter, requireAuth, requirePlan('elite'), getEarningsPreviewHandler);

// Tax-Loss Harvesting
router.get('/tax-harvest', aiLimiter, requireAuth, requirePlan('premium'), getTaxHarvestHandler);

// Anomaly Detection
router.get('/anomalies', requireAuth, getAnomaliesHandler);
router.get('/anomalies/unread-count', requireAuth, getUnreadAnomalyCountHandler);
router.patch('/anomalies/:id/read', mutationLimiter, requireAuth, markAnomalyReadHandler);
router.post('/anomalies/mark-all-read', mutationLimiter, requireAuth, markAllAnomaliesReadHandler);

export default router;
