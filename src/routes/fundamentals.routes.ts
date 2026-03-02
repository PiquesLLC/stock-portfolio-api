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

import { mutationLimiter, heavyReadLimiter } from '../middleware/rateLimiter';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/economic', getEconomicDashboardHandler);
router.get('/economic/international', getInternationalEconomicHandler);
router.get('/economic/portfolio-impact', requireAuth, getPortfolioMacroImpactHandler);
router.get('/status', getAVStatusHandler);
router.post('/earnings/batch', mutationLimiter, requireAuth, getEarningsBatchHandler);
router.get('/:ticker', heavyReadLimiter, getFundamentalsHandler);
router.get('/:ticker/earnings', heavyReadLimiter, getEarningsHandler);

export default router;
