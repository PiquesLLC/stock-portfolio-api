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

// All alert routes require auth — user derived from token, not query params
router.get('/', requireAuth, getAlertsHandler);
router.get('/events', requireAuth, getEventsHandler);
router.get('/events/unread-count', requireAuth, getUnreadCountHandler);

// Mutations require authentication + rate limiting
router.put('/:id', mutationLimiter, requireAuth, updateAlertHandler);
router.post('/events/:id/read', mutationLimiter, requireAuth, markReadHandler);
router.post('/events/read-all', mutationLimiter, requireAuth, markAllReadHandler);

export default router;
