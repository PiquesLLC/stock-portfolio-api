import { Router } from 'express';
import {
  getTransactionsHandler,
  addTransactionHandler,
  deleteTransactionHandler,
} from '../controllers/transaction.controller';

const router = Router();

router.get('/', getTransactionsHandler);
router.post('/', addTransactionHandler);
router.delete('/:id', deleteTransactionHandler);

export default router;
