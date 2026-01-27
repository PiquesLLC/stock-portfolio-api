import { Router } from 'express';
import {
  addDividend,
  getDividendsHandler,
  removeDividend,
} from '../controllers/dividend.controller';

const router = Router();

router.post('/', addDividend);
router.get('/', getDividendsHandler);
router.delete('/:id', removeDividend);

export default router;
