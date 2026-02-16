import { Router } from 'express';
import {
  getEconomicDashboardHandler,
  getInternationalEconomicHandler,
  getPortfolioMacroImpactHandler,
  getAVStatusHandler,
  getFundamentalsHandler,
  getEarningsHandler,
  getEarningsBatchHandler,
} from '../controllers/fundamentals.controller';

import { mutationLimiter } from '../middleware/rateLimiter';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/economic', getEconomicDashboardHandler);
router.get('/economic/international', getInternationalEconomicHandler);
router.get('/economic/portfolio-impact', getPortfolioMacroImpactHandler);
router.get('/status', getAVStatusHandler);
router.post('/earnings/batch', mutationLimiter, requireAuth, getEarningsBatchHandler);
router.get('/:ticker', getFundamentalsHandler);
router.get('/:ticker/earnings', getEarningsHandler);

export default router;
