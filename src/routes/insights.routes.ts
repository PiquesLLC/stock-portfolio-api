import { Router } from 'express';
import {
  getHealthHandler,
  getAttributionHandler,
  getLeakDetectorHandler,
  getRiskForecastHandler,
  getIncomeInsightsHandler,
} from '../controllers/insights.controller';

const router = Router();

router.get('/health', getHealthHandler);
router.get('/attribution', getAttributionHandler);
router.get('/leak-detector', getLeakDetectorHandler);
router.get('/risk-forecast', getRiskForecastHandler);
router.get('/income', getIncomeInsightsHandler);

export default router;
