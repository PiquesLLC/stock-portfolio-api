import { Router } from 'express';
import healthRoutes from './health.routes';
import marketRoutes from './market.routes';
import portfolioRoutes from './portfolio.routes';
import dividendRoutes from './dividend.routes';
import settingsRoutes from './settings.routes';
import insightsRoutes from './insights.routes';
import goalsRoutes from './goals.routes';
import intelligenceRoutes from './portfolioIntelligence.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/market', marketRoutes);
router.use('/portfolio', portfolioRoutes);
router.use('/dividends', dividendRoutes);
router.use('/settings', settingsRoutes);
router.use('/insights', insightsRoutes);
router.use('/goals', goalsRoutes);
router.use('/intelligence', intelligenceRoutes);

export default router;
