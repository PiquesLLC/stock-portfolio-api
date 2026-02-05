import { Router } from 'express';
import {
  getEconomicDashboardHandler,
  getInternationalEconomicHandler,
  getPortfolioMacroImpactHandler,
  getAVStatusHandler,
  getFundamentalsHandler,
  getEarningsHandler,
} from '../controllers/fundamentals.controller';

const router = Router();

router.get('/economic', getEconomicDashboardHandler);
router.get('/economic/international', getInternationalEconomicHandler);
router.get('/economic/portfolio-impact', getPortfolioMacroImpactHandler);
router.get('/status', getAVStatusHandler);
router.get('/:ticker', getFundamentalsHandler);
router.get('/:ticker/earnings', getEarningsHandler);

export default router;
