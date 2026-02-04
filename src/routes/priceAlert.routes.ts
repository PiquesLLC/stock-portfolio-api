import { Router } from 'express';
import {
  getPriceAlertsHandler,
  getPriceAlertHandler,
  createPriceAlertHandler,
  updatePriceAlertHandler,
  deletePriceAlertHandler,
  getPriceAlertEventsHandler,
  markEventReadHandler,
  getUnreadCountHandler,
} from '../controllers/priceAlert.controller';

const router = Router();

// Events routes (must come before :id to avoid conflict)
router.get('/events', getPriceAlertEventsHandler);
router.get('/events/unread-count', getUnreadCountHandler);
router.post('/events/:id/read', markEventReadHandler);

// CRUD routes
router.get('/', getPriceAlertsHandler);
router.get('/:id', getPriceAlertHandler);
router.post('/', createPriceAlertHandler);
router.put('/:id', updatePriceAlertHandler);
router.delete('/:id', deletePriceAlertHandler);

export default router;
