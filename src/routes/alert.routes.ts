import { Router } from 'express';
import {
  getAlertsHandler,
  updateAlertHandler,
  getEventsHandler,
  getUnreadCountHandler,
  markReadHandler,
  markAllReadHandler,
} from '../controllers/alert.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

// GET endpoints (user-specific via query param)
router.get('/', getAlertsHandler);
router.get('/events', getEventsHandler);
router.get('/events/unread-count', getUnreadCountHandler);

// Mutations require authentication + rate limiting
router.put('/:id', mutationLimiter, requireAuth, updateAlertHandler);
router.post('/events/:id/read', mutationLimiter, requireAuth, markReadHandler);
router.post('/events/read-all', mutationLimiter, requireAuth, markAllReadHandler);

export default router;
