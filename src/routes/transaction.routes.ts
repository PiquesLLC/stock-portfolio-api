import { Router } from 'express';
import {
  getTransactionsHandler,
  addTransactionHandler,
  deleteTransactionHandler,
} from '../controllers/transaction.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

router.get('/', requireAuth, getTransactionsHandler);
router.post('/', mutationLimiter, requireAuth, addTransactionHandler);
router.delete('/:id', mutationLimiter, requireAuth, deleteTransactionHandler);

export default router;
