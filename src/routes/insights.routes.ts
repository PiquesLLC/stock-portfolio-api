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
} from '../controllers/insights.controller';

const router = Router();

router.get('/health', getHealthHandler);
router.get('/attribution', getAttributionHandler);
router.get('/leak-detector', getLeakDetectorHandler);
router.get('/risk-forecast', getRiskForecastHandler);
router.get('/income', getIncomeInsightsHandler);
router.get('/briefing', getBriefingHandler);
router.get('/behavior', getBehaviorHandler);
router.get('/daily-report', getDailyReportHandler);

export default router;
