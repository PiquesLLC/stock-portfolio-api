import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';
import {
  listPortfoliosHandler,
  getPortfolioDetailHandler,
  createPortfolioHandler,
  updatePortfolioHandler,
  deletePortfolioHandler,
  setDefaultPortfolioHandler,
} from '../controllers/portfolio-management.controller';

const router = Router();

router.get('/', requireAuth, listPortfoliosHandler);
router.post('/', mutationLimiter, requireAuth, createPortfolioHandler);
router.get('/:id', requireAuth, getPortfolioDetailHandler);
router.put('/:id', mutationLimiter, requireAuth, updatePortfolioHandler);
router.delete('/:id', mutationLimiter, requireAuth, deletePortfolioHandler);
router.patch('/:id/default', mutationLimiter, requireAuth, setDefaultPortfolioHandler);

export default router;
