import { Router } from 'express';
import {
  getTransactionsHandler,
  addTransactionHandler,
  deleteTransactionHandler,
} from '../controllers/transaction.controller';
import { requireAuth, optionalAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/', optionalAuth, getTransactionsHandler);
router.post('/', requireAuth, addTransactionHandler);
router.delete('/:id', requireAuth, deleteTransactionHandler);

export default router;
