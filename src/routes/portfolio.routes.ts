import { Router } from 'express';
import {
  getPortfolioHandler,
  addHolding,
  removeHolding,
  setCashBalance,
  getHistory,
  getProjectionsHandler,
} from '../controllers/portfolio.controller';

const router = Router();

router.get('/', getPortfolioHandler);
router.post('/holdings', addHolding);
router.delete('/holdings/:ticker', removeHolding);
router.put('/cash', setCashBalance);
router.get('/history', getHistory);
router.get('/projections', getProjectionsHandler);

export default router;
