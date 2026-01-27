import { Router } from 'express';
import healthRoutes from './health.routes';
import marketRoutes from './market.routes';
import portfolioRoutes from './portfolio.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/market', marketRoutes);
router.use('/portfolio', portfolioRoutes);

export default router;
