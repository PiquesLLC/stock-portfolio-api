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
  explainBriefingHandler,
} from '../controllers/insights.controller';

const router = Router();

router.get('/health', getHealthHandler);
router.get('/attribution', getAttributionHandler);
router.get('/leak-detector', getLeakDetectorHandler);
router.get('/risk-forecast', getRiskForecastHandler);
router.get('/income', getIncomeInsightsHandler);
router.get('/briefing', getBriefingHandler);
router.post('/briefing/explain', explainBriefingHandler);
router.get('/behavior', getBehaviorHandler);
router.get('/daily-report', getDailyReportHandler);

export default router;
