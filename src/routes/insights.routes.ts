import { Router } from 'express';
import {
  getHealthHandler,
  getAttributionHandler,
  getLeakDetectorHandler,
  getRiskForecastHandler,
} from '../controllers/insights.controller';

const router = Router();

router.get('/health', getHealthHandler);
router.get('/attribution', getAttributionHandler);
router.get('/leak-detector', getLeakDetectorHandler);
router.get('/risk-forecast', getRiskForecastHandler);

export default router;
