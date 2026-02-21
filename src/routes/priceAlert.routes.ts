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
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

// Events routes (must come before :id to avoid conflict)
router.get('/events', requireAuth, getPriceAlertEventsHandler);
router.get('/events/unread-count', requireAuth, getUnreadCountHandler);
router.post('/events/:id/read', mutationLimiter, requireAuth, markEventReadHandler);

// CRUD routes
router.get('/', requireAuth, getPriceAlertsHandler);
router.get('/:id', requireAuth, getPriceAlertHandler);
router.post('/', mutationLimiter, requireAuth, createPriceAlertHandler);
router.put('/:id', mutationLimiter, requireAuth, updatePriceAlertHandler);
router.delete('/:id', mutationLimiter, requireAuth, deletePriceAlertHandler);

export default router;
