import { Router } from 'express';
import {
  getAnalystEventsHandler,
  getUnreadAnalystCountHandler,
  markAnalystEventReadHandler,
  markAllAnalystEventsReadHandler,
  getAnalystSnapshotHandler,
} from '../controllers/analyst.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { mutationLimiter } from '../middleware/rateLimiter';

const router = Router();

// Read endpoints — require auth (analyst events are system-wide but only logged-in users should read)
router.get('/events', requireAuth, getAnalystEventsHandler);
router.get('/events/unread-count', requireAuth, getUnreadAnalystCountHandler);

// Mutations — require auth + rate limiting
router.post('/events/:id/read', mutationLimiter, requireAuth, markAnalystEventReadHandler);
router.post('/events/read-all', mutationLimiter, requireAuth, markAllAnalystEventsReadHandler);

// Snapshots
router.get('/snapshot/:ticker', requireAuth, getAnalystSnapshotHandler);

export default router;
