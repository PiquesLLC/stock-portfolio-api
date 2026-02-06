import { Router } from 'express';
import {
  getHealthHandler,
  getAttributionHandler,
  getLeakDetectorHandler,
  getRiskForecastHandler,
  getIncomeInsightsHandler,
  getBriefingHandler,
  getBehaviorHandler,
} from '../controllers/insights.controller';

const router = Router();

router.get('/health', getHealthHandler);
router.get('/attribution', getAttributionHandler);
router.get('/leak-detector', getLeakDetectorHandler);
router.get('/risk-forecast', getRiskForecastHandler);
router.get('/income', getIncomeInsightsHandler);
router.get('/briefing', getBriefingHandler);
router.get('/behavior', getBehaviorHandler);

export default router;
