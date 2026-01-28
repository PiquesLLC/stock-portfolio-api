import { Router } from 'express';
import healthRoutes from './health.routes';
import marketRoutes from './market.routes';
import portfolioRoutes from './portfolio.routes';
import dividendRoutes from './dividend.routes';
import settingsRoutes from './settings.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/market', marketRoutes);
router.use('/portfolio', portfolioRoutes);
router.use('/dividends', dividendRoutes);
router.use('/settings', settingsRoutes);

export default router;
