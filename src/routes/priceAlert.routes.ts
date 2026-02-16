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
import { requireAuth, optionalAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

// Events routes (must come before :id to avoid conflict)
router.get('/events', optionalAuth, getPriceAlertEventsHandler);
router.get('/events/unread-count', optionalAuth, getUnreadCountHandler);
router.post('/events/:id/read', mutationLimiter, requireAuth, markEventReadHandler);

// CRUD routes
router.get('/', optionalAuth, getPriceAlertsHandler);
router.get('/:id', optionalAuth, getPriceAlertHandler);
router.post('/', mutationLimiter, requireAuth, createPriceAlertHandler);
router.put('/:id', mutationLimiter, requireAuth, updatePriceAlertHandler);
router.delete('/:id', mutationLimiter, requireAuth, deletePriceAlertHandler);

export default router;
